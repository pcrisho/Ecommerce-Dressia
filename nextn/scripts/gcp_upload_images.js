#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/*
 Upload images from public/ENTRENAMIENTO to a GCS bucket preserving folder structure.
 Usage (PowerShell):
  $env:GOOGLE_APPLICATION_CREDENTIALS='C:\path\sa.json'
  node ./scripts/gcp_upload_images.js --bucket project-b38a3360-bucket-entrenamiento

 This script uses @google-cloud/storage and requires GOOGLE_APPLICATION_CREDENTIALS to be set.
*/

const {Storage} = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

function walkDir(dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) results.push(...walkDir(full));
    else if (it.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(it.name)) results.push(full);
  }
  return results;
}

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  const bucketName = argv.bucket;
  const project = argv.project || process.env.GOOGLE_CLOUD_PROJECT;
  if (!bucketName) {
    console.error('Please pass --bucket <bucket-name>');
    process.exit(1);
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS not set. Export your service account JSON path.');
    process.exit(1);
  }

  // Initialize Storage client; prefer credentials from GCP_SERVICE_ACCOUNT_KEY if provided
  const storageOpts = { projectId: project };
  if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    try { storageOpts.credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY); } catch (e) { console.warn('Failed to parse GCP_SERVICE_ACCOUNT_KEY, falling back to ADC'); }
  }
  const storage = new Storage(storageOpts);
  const bucket = storage.bucket(bucketName);

  // create bucket if not exists
  try {
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log('Creating bucket', bucketName);
      await storage.createBucket(bucketName, { location: argv.location || 'US' });
    }
  } catch (err) {
    console.error('Error accessing/creating bucket:', err.message || err);
    process.exit(1);
  }

  const root = path.join(process.cwd(), 'public', 'ENTRENAMIENTO');
  if (!fs.existsSync(root)) {
    console.error('Training folder not found:', root);
    process.exit(1);
  }

  const files = walkDir(root);
  console.log('Found', files.length, 'images to upload');

  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const dest = rel; // keep same structure inside bucket
    const gcsPath = dest;
    try {
      await bucket.upload(f, { destination: gcsPath, metadata: { cacheControl: 'public, max-age=31536000' } });
      console.log('Uploaded', rel, '-> gs://' + bucketName + '/' + gcsPath);
    } catch (err) {
      console.error('Failed to upload', f, err.message || err);
    }
  }
  console.log('Done.');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
