import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { vestidos as allDresses } from '@/lib/data';

const DATA_FILE = path.join(process.cwd(), 'data', 'training_phashes.json');
const VECTOR_BITS = 64; // aHash 8x8
const DEFAULT_THRESHOLD = 12; // Hamming distance threshold (hamming)
const HAMMING_WEIGHT = 0.8; // weight for hamming when combining with color
const COLOR_WEIGHT = 1 - HAMMING_WEIGHT; // weight for color
const DEFAULT_COMBINED_THRESHOLD = 0.25; // lower is stricter
const MAX_COLOR_DISTANCE = Math.sqrt(3 * 255 * 255);

// Convert hex (16 chars -> 64 bits) to a binary string of length 64
function hexToBigInt(hex: string): bigint {
  const h = hex.replace(/^0x/, '').padStart(16, '0').toLowerCase();
  return BigInt('0x' + h);
}

function popcount(n: bigint): number {
  let count = 0;
  while (n) {
    n &= n - BigInt(1);
    count++;
  }
  return count;
}

function hammingDistanceHex(aHex: string, bHex: string): number {
  try {
    const a = hexToBigInt(aHex);
    const b = hexToBigInt(bHex);
    const x = a ^ b;
    return popcount(x);
  } catch (e) {
    // fallback to string-based method (shouldn't happen)
    const aBin = aHex.replace(/^0x/, '').padStart(16, '0').split('').map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
    const bBin = bHex.replace(/^0x/, '').padStart(16, '0').split('').map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
    let count = 0;
    for (let i = 0; i < aBin.length && i < bBin.length; i++) if (aBin[i] !== bBin[i]) count++;
    return count;
  }
}

async function computeAHashFromBuffer(buffer: Buffer): Promise<string> {
  const raw = await sharp(buffer).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  const pixels = Array.from(raw);
  // ignore almost-white pixels (likely background) when computing average threshold
  const fg = pixels.filter((v) => v < 250);
  const used = fg.length ? fg : pixels;
  const avg = used.reduce((s, v) => s + v, 0) / used.length;
  const bits = pixels.map((v) => (v > avg ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}

async function computeAvgColorFromBuffer(buffer: Buffer) {
  // compute average RGB ignoring near-white background
  const size = 32;
  const { data, info } = await sharp(buffer).resize(size, size, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const pixels = data;
  const channels = info.channels || 3;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const pr = pixels[i];
    const pg = pixels[i + 1];
    const pb = pixels[i + 2];
    if (pr > 240 && pg > 240 && pb > 240) continue;
    r += pr; g += pg; b += pb; count++;
  }
  if (count === 0) {
    for (let i = 0; i < pixels.length; i += channels) {
      r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; count++;
    }
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
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

    const queryPhash = await computeAHashFromBuffer(fileBuffer!);

    // Compare against dataset
    const threshold = Number(req.nextUrl.searchParams.get('threshold') ?? DEFAULT_THRESHOLD);
    // Compute distances and color similarity for all entries
    const queryColor = await computeAvgColorFromBuffer(fileBuffer!);
    const scored = phashes.map((entry) => {
      const distance = hammingDistanceHex(queryPhash, entry.phash);
      const entryColor = (entry as any).avgColor ?? null;
      let colorDist = MAX_COLOR_DISTANCE;
      if (entryColor) {
        const dr = (queryColor.r ?? 0) - (entryColor.r ?? 0);
        const dg = (queryColor.g ?? 0) - (entryColor.g ?? 0);
        const db = (queryColor.b ?? 0) - (entryColor.b ?? 0);
        colorDist = Math.sqrt(dr * dr + dg * dg + db * db);
      }
      const normH = distance / VECTOR_BITS;
      const normC = colorDist / MAX_COLOR_DISTANCE;
      const combined = normH * HAMMING_WEIGHT + normC * COLOR_WEIGHT;
      return { ...entry, distance, colorDist, combined };
    });

    // Filter by combined score and original hamming threshold
    const combinedThreshold = Number(req.nextUrl.searchParams.get('combinedThreshold') ?? DEFAULT_COMBINED_THRESHOLD);
    const filtered = scored.filter((s) => s.combined <= combinedThreshold && s.distance <= threshold);

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

    // Convert to array and sort by distance, limit to 10 unique products
  const unique = Array.from(byProduct.values()).sort((a, b) => a.distance - b.distance).slice(0, 10);

    // Map to products when possible
    const mapped = unique.map((r) => {
      const id = r.productId ?? r.filename.replace(/\..+$/, '');
      const product = allDresses.find((d) => String(d.id) === String(id));
      return {
        filename: r.filename,
        product: product ?? null,
        distance: r.distance,
        colorDist: (r as any).colorDist ?? null,
      };
    });

    return NextResponse.json({ queryPhash, results: mapped });
  } catch (err) {
    console.error('visual-match error', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
