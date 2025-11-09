#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/*
 Generate embeddings for images listed in data/gcp_product_catalog.csv using Vertex AI.
 This script downloads each image from GCS, and (optionally) sends it to Vertex AI to get an embedding.

 Requirements:
 - Set GOOGLE_APPLICATION_CREDENTIALS to a service account with Storage and Vertex permissions
 - Install dependencies: npm i @google-cloud/storage minimist

 Usage (PowerShell):
  $env:GOOGLE_APPLICATION_CREDENTIALS='C:\path\sa.json'
  node ./scripts/gcp_generate_embeddings_vertex.js --project project-b38a3360-bca8-40b5-826 --bucket project-b38a3360-bucket-entrenamiento --location us-central1 --model projects/PROJECT/locations/us-central1/publishers/google/models/clip-vit-base-patch32

 Notes:
 - If --model is not provided, the script will download images and save a placeholder embedding (simple color average) so you can test the search locally.
 - The output is written to nextn/data/training_embeddings.json
*/

const fs = require('fs');
const path = require('path');
const {Storage} = require('@google-cloud/storage');
const minimist = require('minimist');

async function readCsv(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const rows = lines.slice(1).map((l) => {
    // naive CSV parse for our known format
    const parts = l.split(',');
    const image_uri = parts[0].replace(/^"|"$/g, '');
    const product_id = parts[1];
    return { image_uri, product_id };
  });
  return rows;
}

function avgColorFromBuffer(buf) {
  // very small heuristic: sample some bytes to create a deterministic vector
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < buf.length; i += Math.max(1, Math.floor(buf.length / 1000))) {
    const val = buf[i];
    r = (r + val) % 256;
    g = (g + ((buf[i + 1] || 0))) % 256;
    b = (b + ((buf[i + 2] || 0))) % 256;
    count++;
  }
  if (count === 0) return [0,0,0];
  return [Math.round(r/count), Math.round(g/count), Math.round(b/count)];
}

// payloadImage can be either { imageBytes: '<base64>' } or { imageUri: 'gs://...' }
async function callVertexPredict(payloadImage, modelName, project, location) {
  // Minimal example using REST Predict API. The exact request shape depends on model.
  // This function expects MODEL_NAME like 'projects/PROJECT/locations/us-central1/publishers/google/models/clip-vit-base-patch32'
  // You may need to adjust payload for the chosen model.
  const url = `https://${location}-aiplatform.googleapis.com/v1/${modelName}:predict`;
  const token = await getAccessToken();
  // Build candidate bodies based on payloadImage
  const candidateBodies = [];

  // Prefer sending Base64 image bytes (imageBytes) as this model requires bytes.
  // Use the FLAT structure first (imageBytes directly in the instance) because
  // this environment's model requires that shape. Keep the nested shape as a
  // secondary attempt.
  if (payloadImage && payloadImage.imageBytes) {
    // 0: FLAT payload (preferred)
    candidateBodies.push({ instances: [ { imageBytes: payloadImage.imageBytes } ], parameters: {} });
    // 1: nested payload (alternative) - try alternative key used by some Vertex integrations
    candidateBodies.push({ 
      instances: [ { image: { bytesBase64Encoded: payloadImage.imageBytes } } ],
      parameters: {} 
    });
  }

  // keep imageUri as a lower-priority fallback (if provided)
  if (payloadImage && payloadImage.imageUri) {
    candidateBodies.push({ instances: [ { image: { imageUri: payloadImage.imageUri } } ], parameters: {} });
    candidateBodies.push({ instances: [ { imageUri: payloadImage.imageUri } ], parameters: {} });
  }

  if (candidateBodies.length === 0) {
    throw new Error('No imageBytes or imageUri provided for Vertex predict');
  }

  console.debug('Vertex predict URL:', url);
  let lastErrorText = null;
  for (let i = 0; i < candidateBodies.length; i++) {
    const body = candidateBodies[i];
    try {
      // Log the exact payload we are sending for easier debugging (truncate long base64)
      try {
        const s = JSON.stringify(body);
        console.debug('Vertex payload (first 1k chars):', s.slice(0, 1000));
        if (s.length > 1000) console.debug('Vertex payload length:', s.length);
      } catch (e) {
        // ignore stringify errors
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const txt = await res.text();
      if (!res.ok) {
        // Save last error and continue to next candidate
        lastErrorText = `status=${res.status} body=${txt}`;
        console.warn(`Vertex payload attempt ${i} failed:`, lastErrorText);
        continue;
      }
      const json = JSON.parse(txt || '{}');
      // attempt to extract embedding vector (model dependent)
      if (json.predictions && json.predictions[0]) {
        const pred = json.predictions[0];
        if (Array.isArray(pred)) return pred;
        if (pred.embedding) return pred.embedding;
      }
      // Some models return `outputs` or `outputs[0].embedding`
      if (json.outputs && Array.isArray(json.outputs) && json.outputs[0]) {
        const out = json.outputs[0];
        if (Array.isArray(out)) return out;
        if (out.embedding) return out.embedding;
      }
      // Nothing useful found but request succeeded — return full predictions if present
      if (json.predictions) return json.predictions[0];
      return json;
    } catch (err) {
      lastErrorText = String(err);
      console.warn('Vertex payload attempt error:', lastErrorText);
      continue;
    }
  }
  // All attempts failed
  throw new Error('Vertex predict failed (all payload attempts): ' + (lastErrorText || 'no response'));
}

async function getAccessToken() {
  // Use Google ADC to get access token via metadata
  // When running locally with service account, request a token from googleapis
  const {GoogleAuth} = require('google-auth-library');
  // Prefer explicit service account credentials from env var in hosted environments
  let auth;
  if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  } else {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  return tokenRes.token;
}

async function main() {
  const argv = minimist(process.argv.slice(2));
  const project = argv.project || process.env.GOOGLE_CLOUD_PROJECT;
  const location = argv.location || 'us-central1';
  const model = argv.model || process.env.VERTEX_MODEL_NAME;

  const catalog = path.join(process.cwd(), 'data', 'gcp_product_catalog.csv');
  if (!fs.existsSync(catalog)) {
    console.error('CSV catalog not found at', catalog);
    process.exit(1);
  }

  const rows = await readCsv(catalog);
  if (!rows.length) {
    console.error('No rows found in catalog');
    process.exit(1);
  }

  // Prefer explicit GOOGLE_APPLICATION_CREDENTIALS when present, but allow
  // Application Default Credentials (ADC) to be used when it's not set. ADC
  // can be provided via `gcloud auth application-default login` (what you ran)
  // or via the environment on hosted runtimes. Do not force exit here so the
  // google-auth-library can fall back through its normal credential chain.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('GOOGLE_APPLICATION_CREDENTIALS not set — will attempt to use Application Default Credentials (ADC) or other configured auth methods.');
  }

  // Initialize Storage client; if running in hosted env, prefer credentials from GCP_SERVICE_ACCOUNT_KEY
  const storageOpts = { projectId: project };
  if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    try {
      storageOpts.credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    } catch (e) {
      console.warn('Failed to parse GCP_SERVICE_ACCOUNT_KEY, falling back to ADC');
    }
  }
  const storage = new Storage(storageOpts);
  const out = [];

  for (const r of rows) {
    try {
      // parse gs://bucket/path
      const m = r.image_uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
      if (!m) {
        console.warn('Skipping non-gs URI', r.image_uri);
        continue;
      }
      const b = storage.bucket(m[1]);
      const file = b.file(m[2]);
      const [exists] = await file.exists();
      if (!exists) {
        console.warn('File not found in bucket:', r.image_uri);
        continue;
      }
      const [buf] = await file.download();

      // Validate download
      if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
        console.error('Downloaded empty or invalid buffer for', r.image_uri);
        continue;
      }

      let embedding = null;
      if (model) {
        // The model requires image bytes. Encode downloaded buffer to Base64
        const imageBase64 = buf.toString('base64');
        console.log('Calling Vertex (imageBytes) for', r.image_uri, `bytes=${buf.length} base64Len=${imageBase64.length}`);
        try {
          embedding = await callVertexPredict({ imageBytes: imageBase64 }, model, project, location);
        } catch (err) {
          console.error('Vertex call failed for', r.image_uri, err.message || err);
        }
      }

      if (!embedding) {
        // fallback: small handcrafted vector from image bytes (NOT a real embedding)
        embedding = avgColorFromBuffer(buf);
      }

      out.push({ filename: r.image_uri, productId: r.product_id, embedding });
      console.log('Processed', r.image_uri);
    } catch (err) {
      console.error('Failed processing', r.image_uri, err.message || err);
    }
  }

  const outPath = path.join(process.cwd(), 'data', 'training_embeddings.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outPath);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
