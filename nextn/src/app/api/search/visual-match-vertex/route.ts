import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

import type { GoogleAuth as GoogleAuthType } from 'google-auth-library';

// Prefer explicit project id from env (set this in Vercel):
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function computeEmbeddingWithVertex(buffer: Buffer) {
  // This function will call Vertex using Google Auth. It supports three modes:
  //  - Vercel/workload-identity (WIF) / ADC: google-auth-library will pick up credentials from the environment
  //  - Explicit JSON key injected via GCP_SERVICE_ACCOUNT_KEY env var (recommended for some hosts)
  //  - Local developer flow via GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`
  const model = process.env.VERTEX_MODEL_NAME;
  const location = process.env.VERTEX_LOCATION || 'us-central1';
  if (!model) throw new Error('VERTEX_MODEL_NAME not configured');

  // Use google-auth-library to obtain an access token. If GCP_SERVICE_ACCOUNT_KEY is provided
  // (e.g. stored as a Vercel Environment Variable) parse and use it; otherwise fall back to ADC.
  const { GoogleAuth } = await import('google-auth-library');
  let auth: GoogleAuthType;
  if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    try {
      const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
      auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    } catch (e) {
      console.warn('GCP_SERVICE_ACCOUNT_KEY is present but could not be parsed as JSON; falling back to ADC');
      auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    }
  } else {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  console.debug('computeEmbeddingWithVertex: project=', GCP_PROJECT_ID || '(not set)', 'model=', model);
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = tokenRes?.token;

  const base64 = buffer.toString('base64');
  // Construct the REST predict URL using the configured model resource name.
  // model is expected to be a full resource path, e.g. projects/PROJECT/locations/us-central1/publishers/google/models/...
  const url = `https://${location}-aiplatform.googleapis.com/v1/${model}:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ content: base64 }], parameters: {} })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Vertex predict failed: ' + res.status + ' ' + t);
  }
  const json = await res.json();
  if (json.predictions && json.predictions[0]) {
    const pred = json.predictions[0];
    if (Array.isArray(pred)) return pred;
    if (pred.embedding) return pred.embedding;
  }
  throw new Error('Unexpected Vertex response shape');
}

export async function POST(req: NextRequest) {
  try {
    // Accept multipart/form-data (file) or JSON with dataUri
    let fileBuffer: Buffer | null = null;
    const contentType = req.headers.get('content-type') || '';
    // We'll read multipart form data at most once and reuse it below (reading twice causes "Body has already been read").
    let multipartForm: FormData | null = null;
    if (contentType.startsWith('multipart/form-data')) {
      multipartForm = await req.formData();
      const file = multipartForm.get('file') || multipartForm.get('image');
      if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      // form.get() returns a File-like object with arrayBuffer(); use a structural cast to avoid `any`
      const fileLike = file as { arrayBuffer: () => Promise<ArrayBuffer> };
      const ab = await fileLike.arrayBuffer();
      fileBuffer = Buffer.from(ab);
    } else {
      const json = await req.json().catch(() => ({}));
      const dataUri = json?.dataUri || json?.image;
      if (!dataUri) return NextResponse.json({ error: 'No image provided' }, { status: 400 });
      const match = String(dataUri).match(/^data:(.+);base64,(.+)$/);
      if (!match) return NextResponse.json({ error: 'Invalid data URI' }, { status: 400 });
      fileBuffer = Buffer.from(match[2], 'base64');
    }

    const embeddingsPath = path.join(process.cwd(), 'data', 'training_embeddings.json');
    const hasLocalIndex = fs.existsSync(embeddingsPath);

    let queryEmbedding: number[] | null = null;
    // Determine preference (query param or form field)
    let prefer: string | null = req.nextUrl?.searchParams?.get('prefer') || null;
    if (multipartForm) {
      // prefer may be provided as a form field in multipart requests; use the already-read form
      const formPrefer = multipartForm.get('prefer');
      if (formPrefer) prefer = String(formPrefer);
    }

    let vertexAttempted = false;
    let vertexError: string | null = null;
    let usedVertex = false;

    // Try Vertex according to preference or if configured
    if (prefer === 'vertex') {
      if (process.env.VERTEX_MODEL_NAME) {
        vertexAttempted = true;
        try {
          queryEmbedding = await computeEmbeddingWithVertex(fileBuffer!);
          usedVertex = true;
        } catch (err) {
          vertexError = String(err);
          console.warn('Vertex embedding failed (preferred), will fallback to local index if available:', vertexError);
        }
      } else {
        vertexError = 'VERTEX_MODEL_NAME not configured';
      }
    } else {
      if (process.env.VERTEX_MODEL_NAME) {
        vertexAttempted = true;
        try {
          queryEmbedding = await computeEmbeddingWithVertex(fileBuffer!);
          usedVertex = true;
        } catch (err) {
          vertexError = String(err);
          console.warn('Vertex embedding failed, will fallback to local index if available:', vertexError);
        }
      }
    }

    if (!queryEmbedding && !hasLocalIndex) {
      return NextResponse.json({ error: 'No embeddings index found and Vertex not configured or failed' }, { status: 500 });
    }

  const indexRaw = hasLocalIndex ? fs.readFileSync(embeddingsPath, 'utf8') : '[]';
  type IndexEntry = { filename: string; productId?: string; embedding: number[]; score?: number };
  const index = JSON.parse(indexRaw) as IndexEntry[];

    if (!queryEmbedding) {
      // If we don't have Vertex, try to compute a simple fallback from bytes (not ideal)
      // We'll compute a tiny vector based on byte averages so it can be compared to fallback embeddings.
      const buf = fileBuffer!;
      const v = [];
      let r = 0, g = 0, b = 0, c = 0;
      for (let i = 0; i < buf.length; i += Math.max(1, Math.floor(buf.length / 1024))) {
        r = (r + buf[i]) % 256;
        g = (g + (buf[i + 1] || 0)) % 256;
        b = (b + (buf[i + 2] || 0)) % 256;
        c++;
      }
      v.push(Math.round(r / c)); v.push(Math.round(g / c)); v.push(Math.round(b / c));
      queryEmbedding = v;
    }

    // Brute-force cosine search
    const scored = index.map((e) => ({ ...e, score: cosine(queryEmbedding as number[], e.embedding) }));
    const top = scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 10);

    // Map to products in local catalog if possible
    const dataFile = path.join(process.cwd(), 'src', 'lib', 'data.ts');
    // We won't import TS file here; we'll map productId to product by reading the existing JSON in data if present.

  const results = top.map((t) => ({ filename: t.filename, productId: t.productId, score: t.score }));
  const source = usedVertex ? 'vertex' : 'fallback';
  const resp: { results: { filename: string; productId?: string; score?: number }[]; source: string; vertexAttempted: boolean; vertexError?: string } = { results, source, vertexAttempted };
  if (vertexError) resp.vertexError = vertexError;

  return NextResponse.json(resp);
  } catch (err) {
    console.error('visual-match-vertex error', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
