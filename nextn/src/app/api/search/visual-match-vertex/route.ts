import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

import { GoogleAuth, ExternalAccountClient, type GoogleAuth as GoogleAuthType } from 'google-auth-library';

// Prefer explicit project id from env (set this in Vercel):
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';

function cosine(a: number[], b: number[]) {
  // Defensive: require equal-length vectors. If lengths differ, return 0 similarity
  // to avoid comparing only prefixes (which produced inconsistent scores).
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2normalize(vec: number[]) {
  if (!Array.isArray(vec) || vec.length === 0) return vec;
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]) || 0;
    sum += v * v;
  }
  const norm = Math.sqrt(sum) || 1;
  return vec.map((x) => (Number(x) || 0) / norm);
}

// Camel-cased alias used elsewhere in the codebase/tests: ensure l2Normalize exists
function l2Normalize(vec: number[]) {
  return l2normalize(vec);
}

async function computeEmbeddingWithVertex(buffer: Buffer) {
  // This function will call Vertex using Google Auth. It supports three modes:
  //  - Vercel/workload-identity (WIF) / ADC: google-auth-library will pick up credentials from the environment
  //  - Explicit JSON key injected via GCP_SERVICE_ACCOUNT_KEY env var (recommended for some hosts)
  //  - Local developer flow via GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`
  const model = process.env.VERTEX_MODEL_NAME;
  const location = process.env.VERTEX_LOCATION || 'us-central1';
  if (!model) throw new Error('VERTEX_MODEL_NAME not configured');

  // Use google-auth-library to obtain an access token. Prefer an explicit ExternalAccountClient
  // (WIF) when GOOGLE_WORKLOAD_IDENTITY_PROVIDER and GOOGLE_SERVICE_ACCOUNT_EMAIL are present,
  // otherwise fall back to Application Default Credentials (ADC).
  let auth: GoogleAuthType | undefined;
  let usedExplicitWif = false;
  let externalClient: any = null;

  // PRIORIDAD 1: Forzar el uso de ExternalAccountClient (WIF) si las variables estándar están presentes
  if (process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    try {
      externalClient = new (ExternalAccountClient as any)({
        // The provider/audience is provided via GOOGLE_WORKLOAD_IDENTITY_PROVIDER
        targetAudience: process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER,
        serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        // scopes needed to access GCP APIs
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      usedExplicitWif = true;
    } catch (e) {
      console.warn('Explicit ExternalAccountClient (WIF) failed, falling back to ADC:', String(e));
    }
  }

  // PRIORIDAD 2: Fallback a ADC si WIF falló
  if (!usedExplicitWif) {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  console.debug('computeEmbeddingWithVertex: project=', GCP_PROJECT_ID || '(not set)', 'model=', model, 'usedExplicitWif=', usedExplicitWif);


  

  let client: any;
  if (externalClient) {
    client = externalClient;
  } else if (auth) {
    client = await auth.getClient();
  } else {
    throw new Error('No authentication client available to call Vertex');
  }
  const tokenRes = await client.getAccessToken();
  const token = tokenRes?.token;

  const base64 = buffer.toString('base64');
  // Construct the REST predict URL using the configured model resource name.
  // model is expected to be a full resource path, e.g. projects/PROJECT/locations/us-central1/publishers/google/models/...
  const url = `https://${location}-aiplatform.googleapis.com/v1/${model}:predict`;
  const requestBodyObj = { instances: [{ image: { bytesBase64Encoded: base64 } }], parameters: {} };
  const requestBody = JSON.stringify(requestBodyObj);
  // Log a truncated preview of the payload (first 1k chars) and its length for verification — avoid printing full Base64.
  try {
    const preview = requestBody.slice(0, 1000);
    console.debug('Vertex payload preview (first 1k chars):', preview);
    console.debug('Vertex payload length:', requestBody.length);
  } catch (e) {
    // best-effort logging; don't fail the request if logging fails
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: requestBody
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Vertex predict failed: ' + res.status + ' ' + t);
  }
  const json = await res.json();
  if (json.predictions && json.predictions[0]) {
    const pred = json.predictions[0];
    if (Array.isArray(pred)) return pred;
    // Some Vertex publisher models return the vector under `imageEmbedding`.
    if (pred.imageEmbedding && Array.isArray(pred.imageEmbedding)) return pred.imageEmbedding as number[];
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
          if (Array.isArray(queryEmbedding)) queryEmbedding = l2Normalize(queryEmbedding as number[]);
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
      if (Array.isArray(queryEmbedding)) queryEmbedding = l2Normalize(queryEmbedding as number[]);
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
  // Parse index and defensively normalize embedding shapes so scoring always sees a flat number[]
  const rawIndex = JSON.parse(indexRaw) as Array<Record<string, any>>;

  function flattenEmbedding(e: any): number[] | null {
    if (!e) return null;
    if (Array.isArray(e)) return e.map((v) => Number(v));
    if (typeof e === 'object') {
  if (Array.isArray(e.imageEmbedding)) return e.imageEmbedding.map((v: any) => Number(v));
  if (Array.isArray(e.embedding)) return e.embedding.map((v: any) => Number(v));
  if (Array.isArray(e.vector)) return e.vector.map((v: any) => Number(v));
      // return the first array-valued property we find
      for (const k of Object.keys(e)) {
        if (Array.isArray(e[k])) return e[k].map((v) => Number(v));
      }
    }
    return null;
  }

  const index = rawIndex.map((r) => {
    const emb = flattenEmbedding(r.embedding || r);
    const normalized = Array.isArray(emb) && emb.length ? l2Normalize(emb) : [];
    return { filename: String(r.filename || r.file || ''), productId: r.productId ? String(r.productId) : undefined, embedding: normalized } as IndexEntry;
  });

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
  if (Array.isArray(queryEmbedding)) queryEmbedding = l2normalize(queryEmbedding as number[]);
    }

  // Brute-force cosine search
  const scored = index.map((e) => ({ ...e, score: cosine(queryEmbedding as number[], e.embedding) }));
  const sorted = scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Apply a minimum similarity threshold. Use a stricter threshold when Vertex produced the query
  // embedding, but allow a lower threshold for fallback heuristics so the API doesn't always return empty.
  const STRICT_THRESHOLD = Number(process.env.IMAGE_MATCH_SIMILARITY_THRESHOLD || '0.6');
  const FALLBACK_THRESHOLD = Number(process.env.IMAGE_MATCH_FALLBACK_SIMILARITY_THRESHOLD || '0.25');
  const effectiveThreshold = usedVertex ? STRICT_THRESHOLD : FALLBACK_THRESHOLD;
  const top = sorted.filter((s) => (s.score ?? 0) >= effectiveThreshold).slice(0, 10);

    // Map to products in local catalog if possible
    const dataFile = path.join(process.cwd(), 'src', 'lib', 'data.ts');
    // We won't import TS file here; we'll map productId to product by reading the existing JSON in data if present.

  const results = top.map((t) => ({ filename: t.filename, productId: t.productId, score: t.score }));
  const source = usedVertex ? 'vertex' : 'fallback';
  const topScore = sorted.length ? (sorted[0].score ?? 0) : 0;
  const resp: { results: { filename: string; productId?: string; score?: number }[]; source: string; vertexAttempted: boolean; usedVertex: boolean; topScore: number; vertexError?: string } = { results, source, vertexAttempted, usedVertex, topScore };
  if (vertexError) resp.vertexError = vertexError;

  return NextResponse.json(resp);
  } catch (err) {
    console.error('visual-match-vertex error', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
