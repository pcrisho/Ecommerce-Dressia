import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// No local FS/index search here any more - we call the Vector Search Cloud Function.

export const runtime = 'nodejs';

import type { GoogleAuth as GoogleAuthType } from 'google-auth-library';

// Prefer explicit project id from env (set this in Vercel):
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';

// Note: we no longer perform local similarity search in this route.

async function computeEmbeddingWithVertex(buffer: Buffer) {
  // This function will call Vertex using Google Auth. It supports three modes:
  //  - Vercel/workload-identity (WIF) / ADC: google-auth-library will pick up credentials from the environment
  //  - Explicit JSON key injected via GCP_SERVICE_ACCOUNT_KEY env var (recommended for some hosts)
  //  - Local developer flow via GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`
  const model = process.env.VERTEX_MODEL_NAME;
  const location = process.env.VERTEX_LOCATION || 'us-central1';
  if (!model) throw new Error('VERTEX_MODEL_NAME not configured');

  // Use google-auth-library to obtain an access token. If GCP_SERVICE_ACCOUNT_KEY is provided
  // (workaround: WIF JSON stored in this env var), parse and use it; otherwise fall back to ADC.
  let auth: GoogleAuthType;

  // Dynamically import GoogleAuth class (keeps serverless bundles small)
  const { GoogleAuth } = await import('google-auth-library');

  // PRIORIDAD 1: Cargar credenciales WIF explícitas desde GCP_SERVICE_ACCOUNT_KEY (el workaround)
  if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    try {
      const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
      auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    } catch (e) {
      console.warn('GCP_SERVICE_ACCOUNT_KEY is present but could not be parsed as JSON; falling back to ADC:', String(e));
      auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    }
  } 
  // PRIORIDAD 2: Fallback a Detección Automática de Credenciales (ADC)
  else {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  console.debug('computeEmbeddingWithVertex: project=', GCP_PROJECT_ID || '(not set)', 'model=', model);


  

  // Ensure we have an auth client instance and request an access token
  const client = await auth.getClient();
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

async function findNeighborsWithCF(queryEmbedding: number[]) {
  const cfUrl = process.env.VECTOR_SEARCH_CF_URL;
  const cfAudience = process.env.VECTOR_SEARCH_CF_AUDIENCE;
  if (!cfUrl) throw new Error('VECTOR_SEARCH_CF_URL not configured');
  const audience = cfAudience || cfUrl;

  // Use google-auth-library to obtain an ID token for the Cloud Function audience
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth();
  // getIdTokenClient returns a client that will provide ID tokens suitable for authenticating to the targetAudience
  const idClient = await auth.getIdTokenClient(audience);
  const headers = await idClient.getRequestHeaders();

  const res = await fetch(cfUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature_vector: queryEmbedding })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '<no body>');
    throw new Error('Vector search CF failed: ' + res.status + ' ' + t);
  }
  return await res.json();
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

    if (!queryEmbedding) {
      return NextResponse.json({ error: 'Vertex embedding not produced and no fallback available', vertexAttempted, vertexError }, { status: 500 });
    }

    // Ensure numeric array and L2-normalize before sending to the Cloud Function
    const numeric = (queryEmbedding as any[]).map((v) => Number(v) || 0);
    const sumsq = numeric.reduce((s, x) => s + x * x, 0);
    const norm = Math.sqrt(sumsq) || 1;
    const normalized = numeric.map((x) => x / norm);

    // Debug: log vector length + head so we can validate what the CF receives
    try {
      const head = normalized.slice(0, 8);
      console.debug('visual-match-vertex: sending feature_vector length=', normalized.length, 'head=', head.map((n) => Number(n).toFixed(6)).join(','));
    } catch (e) {
      // no-op
    }

    // Call Cloud Function to perform the search using an authenticated ID token
    let cfJson: any;
    try {
      cfJson = await findNeighborsWithCF(normalized);
    } catch (err) {
      console.error('Error calling vector search Cloud Function:', err);
      return NextResponse.json({ error: 'Vector search Cloud Function call failed', detail: String(err), vertexAttempted, vertexError }, { status: 502 });
    }

    // Merge diagnostics and return the Cloud Function response
    const resp = { ...cfJson, vertexAttempted, usedVertex } as any;
    if (vertexError) resp.vertexError = vertexError;
    return NextResponse.json(resp);
  } catch (err) {
    console.error('visual-match-vertex error', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
