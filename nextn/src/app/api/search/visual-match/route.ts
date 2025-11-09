import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { vestidos as allDresses } from '@/lib/data';

const DATA_FILE = path.join(process.cwd(), 'data', 'training_phashes.json');
const VECTOR_BITS = 64; // pHash 8x8 -> 64 bits
const DEFAULT_THRESHOLD = 24; // more permissive by default (combined score)

// Convert hex (16 chars -> 64 bits) to a binary string of length 64
function hexToBin64(hex: string): string {
  // normalize
  const h = hex.replace(/^0x/, '').padStart(16, '0').toLowerCase();
  return h.split('').map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

function hammingDistanceHex(aHex: string, bHex: string): number {
  const aBin = hexToBin64(aHex);
  const bBin = hexToBin64(bHex);
  let count = 0;
  for (let i = 0; i < aBin.length && i < bBin.length; i++) {
    if (aBin[i] !== bBin[i]) count++;
  }
  return count;
}

// Compute pHash from buffer: resize to 32x32 grayscale, DCT, keep top-left 8x8 block
async function computePHashFromBuffer(buffer: Buffer): Promise<string> {
  const SIZE = 32;
  const SMALL = 8;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
  const pixels: number[][] = [];
  for (let y = 0; y < SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < SIZE; x++) {
      row.push(raw[y * SIZE + x]);
    }
    pixels.push(row);
  }

  // naive 2D DCT
  function dct2D(matrix: number[][]) {
    const N = SIZE;
    const out: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    const PI = Math.PI;
    for (let u = 0; u < N; u++) {
      for (let v = 0; v < N; v++) {
        let sum = 0;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            sum +=
              matrix[i][j] *
              Math.cos(((2 * i + 1) * u * PI) / (2 * N)) *
              Math.cos(((2 * j + 1) * v * PI) / (2 * N));
          }
        }
        const cu = u === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
        const cv = v === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
        out[u][v] = cu * cv * sum;
      }
    }
    return out;
  }

  const dct = dct2D(pixels);
  const vals: number[] = [];
  for (let y = 0; y < SMALL; y++) {
    for (let x = 0; x < SMALL; x++) {
      vals.push(dct[y][x]);
    }
  }
  const sorted = Array.from(vals).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const bits = vals.map((v) => (v > median ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}

// Compute aHash (average hash) from buffer: resize to 8x8 grayscale, mean threshold
async function computeAHashFromBuffer(buffer: Buffer): Promise<string> {
  const SIZE = 8;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
  const vals: number[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) vals.push(raw[i]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const bits = vals.map((v) => (v > mean ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}

// Compute average color hex from buffer (RGB) using 1x1 resize
async function computeAvgColorHex(buffer: Buffer): Promise<string> {
  const SIZE = 1;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer();
  const r = raw[0];
  const g = raw[1];
  const b = raw[2];
  const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  return hex;
}

function hexToRgb(hex: string) {
  const h = hex.replace(/^#/, '').padStart(6, '0');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function colorDistanceRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  // Convert both colors to HSL
  const hslA = rgbToHsl(a.r, a.g, a.b);
  const hslB = rgbToHsl(b.r, b.g, b.b);
  
  // Compute weighted distance in HSL space
  const dh = Math.min(Math.abs(hslA.h - hslB.h), 360 - Math.abs(hslA.h - hslB.h)) / 180.0;
  const ds = Math.abs(hslA.s - hslB.s) / 100.0;
  const dl = Math.abs(hslA.l - hslB.l) / 100.0;
  
  // Give more weight to hue differences for saturated colors
  const saturationWeight = (hslA.s + hslB.s) / 200.0;
  const hueWeight = 2.0 * saturationWeight;
  
  return Math.sqrt(
    (dh * dh * hueWeight) +
    (ds * ds * 1.0) +
    (dl * dl * 0.5)
  ) * 255; // Scale to similar range as RGB distance
}

export async function POST(req: NextRequest) {
  try {
    // Load precomputed phashes
    if (!fs.existsSync(DATA_FILE)) {
      return NextResponse.json({ error: 'Training phashes not found. Run generate_phashes.js' }, { status: 500 });
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const phashes: Array<{ filename: string; phash: string; productId: string | null }> = JSON.parse(raw);

    // Accept multipart/form-data (file) or JSON with dataUri
    let fileBuffer: Buffer | null = null;
    const contentType = req.headers.get('content-type') || '';
    if (contentType.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file') || form.get('image');
      if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      const ab = await (file as any).arrayBuffer();
      fileBuffer = Buffer.from(ab);
    } else {
      // try JSON body with dataUri
      const json = await req.json().catch(() => ({}));
      const dataUri = json?.dataUri || json?.image;
      if (!dataUri) return NextResponse.json({ error: 'No image provided' }, { status: 400 });
      const match = String(dataUri).match(/^data:(.+);base64,(.+)$/);
      if (!match) return NextResponse.json({ error: 'Invalid data URI' }, { status: 400 });
      fileBuffer = Buffer.from(match[2], 'base64');
    }

    const queryPhash = await computePHashFromBuffer(fileBuffer!);
    const queryAhash = await computeAHashFromBuffer(fileBuffer!);
    const queryColorHex = await computeAvgColorHex(fileBuffer!);
  const queryRgb = hexToRgb(queryColorHex);
  const queryHsl = rgbToHsl(queryRgb.r, queryRgb.g, queryRgb.b);

    // Compare against dataset
    const threshold = Number(req.nextUrl.searchParams.get('threshold') ?? DEFAULT_THRESHOLD);
    // Combine pHash + aHash + color distances (weighted)
    const weightP = 0.4;  // reduced pHash weight
    const weightA = 0.3;  // kept aHash weight
    const weightC = 0.3;  // increased color weight
    const maxColorDist = Math.sqrt(3 * 255 * 255); // ~441.67
    const scored = phashes.map((entry) => {
      const dp = hammingDistanceHex(queryPhash, entry.phash);
      const entryA = (entry as any).ahash ?? entry.phash;
      const da = hammingDistanceHex(queryAhash, entryA);
      const entryColorHex = (entry as any).color ?? entry.phash.slice(0, 6);
      const rgbQ = hexToRgb(queryColorHex);
      const rgbE = hexToRgb(entryColorHex);
      const colorDist = colorDistanceRgb(rgbQ, rgbE);

      // normalize color dist to 0..VECTOR_BITS (so scales are similar to hamming on 64-bit)
      const colorNorm = Math.round((colorDist / maxColorDist) * VECTOR_BITS);
      let combined = Math.round(dp * weightP + da * weightA + colorNorm * weightC);

      // Additional hue-based gating: when both colors are saturated, large hue differences
      // usually mean different garments (e.g., red vs black/white). Penalize heavily to
      // avoid returning structurally-similar but color-mismatched items.
      try {
        const hslQ = rgbToHsl(rgbQ.r, rgbQ.g, rgbQ.b);
        const hslE = rgbToHsl(rgbE.r, rgbE.g, rgbE.b);
        const hueDiff = Math.min(Math.abs(hslQ.h - hslE.h), 360 - Math.abs(hslQ.h - hslE.h));
        // If the query is strongly saturated (a clear color like red), be stricter
        // about acceptable hue differences. This avoids returning similar-structure
        // items with a clearly different dominant color.
        const strictSaturationThreshold = 45; // query must be fairly saturated
        const strictHueThreshold = 30; // degrees
        const bothSaturated = hslQ.s > 25 && hslE.s > 25;
        const strictCheck = hslQ.s > strictSaturationThreshold;
        if ((strictCheck && bothSaturated && hueDiff > strictHueThreshold) || (!strictCheck && bothSaturated && hueDiff > 45)) {
          // big penalty to push this candidate out of threshold
          combined += 100;
        }
        return { ...entry, distance: combined, rawDistanceP: dp, rawDistanceA: da, rawColorDist: Math.round(colorDist), rawHueDiff: Math.round(hueDiff), rawSaturationQ: Math.round(hslQ.s), rawSaturationE: Math.round(hslE.s) };
      } catch (e) {
        return { ...entry, distance: combined, rawDistanceP: dp, rawDistanceA: da, rawColorDist: Math.round(colorDist) };
      }
    });

    // Filter by threshold + extra sanity gates to reduce false positives on non-clothing images
    // Rules:
    //  - distance <= threshold
    //  AND at least one of:
    //    * pHash very similar (dp <= PHASH_STRICT)
    //    * aHash very similar (da <= AHASH_STRICT)
    //    * query is saturated (likely colored garment) AND color distance small
    const PHASH_STRICT = 20;
    const AHASH_STRICT = 20;
    const COLOR_DIST_ACCEPT = 110; // perceptual HSL-based distance threshold
    const QUERY_SAT_MIN = 30; // require query to be reasonably saturated to trust color

    const filtered = scored.filter((s) => {
      if (s.distance > threshold) return false;
      const passHash = (typeof s.rawDistanceP === 'number' && s.rawDistanceP <= PHASH_STRICT) || (typeof s.rawDistanceA === 'number' && s.rawDistanceA <= AHASH_STRICT);
      const passColor = queryHsl.s > QUERY_SAT_MIN && typeof s.rawColorDist === 'number' && s.rawColorDist <= COLOR_DIST_ACCEPT;
      return passHash || passColor;
    });

    // Deduplicate by product key (prefer productId; fallback to filename base)
    const byProduct = new Map<string, { filename: string; phash: string; productId: string | null; distance: number }>();
    for (const e of filtered) {
      // Prefer productId when available; otherwise use folder name (first segment) so different
      // variants stored in different folders are treated as separate products.
      const key = e.productId ?? (e.filename.includes('/') ? e.filename.split('/')[0] : e.filename.replace(/\..+$/, ''));
      const existing = byProduct.get(key);
      if (!existing || e.distance < existing.distance) {
        byProduct.set(key, { filename: e.filename, phash: e.phash, productId: e.productId, distance: e.distance });
      }
    }

  // Convert to array and sort by distance, limit to 3 unique products (top-3 results only)
  const unique = Array.from(byProduct.values()).sort((a, b) => a.distance - b.distance).slice(0, 3);

    // Map to products when possible
    const mapped = unique.map((r) => {
      const id = r.productId ?? r.filename.replace(/\..+$/, '');
      const product = allDresses.find((d) => String(d.id) === String(id));
      return {
        filename: r.filename,
        product: product ?? null,
        distance: r.distance,
      };
    });

    return NextResponse.json({ queryPhash, results: mapped });
  } catch (err) {
    console.error('visual-match error', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
