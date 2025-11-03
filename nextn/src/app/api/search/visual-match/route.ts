import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { vestidos as allDresses } from '@/lib/data';

const DATA_FILE = path.join(process.cwd(), 'data', 'training_phashes.json');
const VECTOR_BITS = 64; // aHash 8x8
const DEFAULT_THRESHOLD = 12; // Hamming distance threshold

function hexToBigInt(hex: string): bigint {
  return BigInt('0x' + hex);
}

function hammingDistanceHex(aHex: string, bHex: string): number {
  const a = hexToBigInt(aHex);
  const b = hexToBigInt(bHex);
  let x = a ^ b;
  let count = 0;
  const ONE = BigInt(1);
  while (x) {
    count += Number(x & ONE);
    x = x >> ONE;
  }
  return count;
}

async function computeAHashFromBuffer(buffer: Buffer): Promise<string> {
  const raw = await sharp(buffer).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  const pixels = Array.from(raw);
  const avg = pixels.reduce((s, v) => s + v, 0) / pixels.length;
  const bits = pixels.map((v) => (v > avg ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
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
    const results = phashes
      .map((entry) => {
        const dist = hammingDistanceHex(queryPhash, entry.phash);
        return { ...entry, distance: dist };
      })
      .filter((r) => r.distance <= threshold)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    // Map to products when possible
    const mapped = results.map((r) => {
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
