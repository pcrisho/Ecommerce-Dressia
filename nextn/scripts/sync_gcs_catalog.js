#!/usr/bin/env node
/*
sync_gcs_catalog.js

List objects in a GCS bucket and merge missing image entries into data/gcp_product_catalog.csv.
Usage (PowerShell):
  $env:GOOGLE_APPLICATION_CREDENTIALS='C:\path\to\sa.json'
  node .\scripts\sync_gcs_catalog.js --bucket product-search-images-b38a3360 --out .\data\gcp_product_catalog.csv --dry-run

Options:
  --bucket   (required) GCS bucket name or full gs://... (if gs:// prefix provided, bucket is parsed)
  --prefix   (optional) object prefix to list (e.g., "Bembella/")
  --out      (optional) output CSV path (default: ./data/gcp_product_catalog.csv)
  --dry-run  (optional) if provided, do not write, only print actions
  --project  (optional) GCP project id, forwarded to Storage client

Behavior:
 - Reads existing CSV and builds a map of image_uri -> row
 - Builds a folder->product_id map from current CSV (first path segment)
 - Lists objects in the bucket (optionally under prefix)
 - For any gs:// object not present in CSV, it will propose a new row with inferred product_id (from folder map) and display name like: Blusa "<folder>"
 - If --dry-run, prints proposed lines. Otherwise it writes a backup and appends new rows to the CSV.

Note: Requires @google-cloud/storage installed and valid GOOGLE_APPLICATION_CREDENTIALS or ADC.
*/

const {Storage} = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

function quoteCsv(s) {
  if (s == null) return '""';
  return '"' + String(s).replace(/"/g, '""') + '"';
}

async function listBucketObjects(storage, bucketName, prefix) {
  const bucket = storage.bucket(bucketName);
  const options = {};
  if (prefix) options.prefix = prefix;
  const [files] = await bucket.getFiles(options);
  return files.map(f => `gs://${bucketName}/${f.name}`);
}

function inferDisplayNameFromGsUri(gsUri) {
  if (!gsUri || !gsUri.startsWith('gs://')) return '';
  const noPrefix = gsUri.replace(/^gs:\/\//, '');
  const parts = noPrefix.split('/');
  const folder = parts[1] || parts.slice(0, -1).join('/');
  return folder ? `Blusa \"${folder}\"` : '';
}

(async function main() {
  const argv = minimist(process.argv.slice(2));
  let bucket = argv.bucket || argv.b;
  if (!bucket) {
    console.error('Error: --bucket is required');
    process.exit(1);
  }
  // Allow passing full gs://bucket or bucket name
  if (bucket.startsWith('gs://')) bucket = bucket.replace(/^gs:\/\//, '').split('/')[0];

  const prefix = argv.prefix || argv.p || '';
  const outPath = argv.out || path.join(process.cwd(), 'data', 'gcp_product_catalog.csv');
  const dryRun = Boolean(argv['dry-run'] || argv.dryrun || argv.d);
  const project = argv.project || process.env.GOOGLE_CLOUD_PROJECT || undefined;

  // Read existing CSV if exists
  const existing = new Map();
  const folderMap = new Map();
  if (fs.existsSync(outPath)) {
    const txt = fs.readFileSync(outPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const rows = lines.slice(1); // skip header
    for (const l of rows) {
      // naive CSV parse matching format: "gs://...",product_id,product_category,"display"
      const parts = l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/); // split on commas not inside quotes
      const image_uri = (parts[0] || '').replace(/^"|"$/g, '').trim();
      const product_id = (parts[1] || '').replace(/^"|"$/g, '').trim();
      existing.set(image_uri, { image_uri, product_id, raw: l });

      // build folder->product_id map
      try {
        if (image_uri.startsWith('gs://')) {
          const noPrefix = image_uri.replace(/^gs:\/\//, '');
          const p = noPrefix.split('/');
          const folder = p[1] || null;
          if (folder && product_id) {
            if (!folderMap.has(folder)) folderMap.set(folder, product_id);
          }
        }
      } catch (e) {
        // ignore
      }
    }
  } else {
    console.warn('CSV not found at', outPath, '- will create a new file if not dry-run');
  }

  const storage = new Storage({ projectId: project });
  console.log('Listing objects in bucket:', bucket, 'prefix=', prefix || '<all>');
  let objects;
  try {
    objects = await listBucketObjects(storage, bucket, prefix);
  } catch (e) {
    console.error('Failed to list bucket objects:', e.message || e);
    process.exit(1);
  }

  console.log('Found', objects.length, 'objects in bucket');
  const toAppend = [];
  for (const gs of objects) {
    if (!existing.has(gs)) {
      // infer product id from folder
      let folder = '';
      try {
        const noPrefix = gs.replace(/^gs:\/\//, '');
        folder = noPrefix.split('/')[1] || '';
      } catch (e) {
        folder = '';
      }
      const productId = folderMap.get(folder) || '';
      const display = inferDisplayNameFromGsUri(gs);
      const product_category = 'apparel-v2';
      const row = [quoteCsv(gs), quoteCsv(productId), quoteCsv(product_category), quoteCsv(display)].join(',');
      toAppend.push({ gs, row, productId });
    }
  }

  if (toAppend.length === 0) {
    console.log('No new objects to append. CSV is up to date.');
    process.exit(0);
  }

  console.log('New objects to add:', toAppend.length);
  for (const t of toAppend.slice(0, 20)) {
    console.log('  ', t.gs, '-> productId=', t.productId || '<none>');
  }
  if (toAppend.length > 20) console.log('  ...and', toAppend.length - 20, 'more');

  if (dryRun) {
    console.log('\nDRY RUN - NOT WRITING. To write, re-run without --dry-run.');
    process.exit(0);
  }

  // Backup current CSV
  try {
    if (fs.existsSync(outPath)) {
      const bak = outPath + '.bak.' + Date.now();
      fs.copyFileSync(outPath, bak);
      console.log('Backup of CSV saved to', bak);
    } else {
      // create header
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, 'image_uri,product_id,product_category,display_name\n', 'utf8');
      console.log('Created new CSV with header at', outPath);
    }
  } catch (e) {
    console.error('Failed to backup or create CSV:', e.message || e);
    process.exit(1);
  }

  // Append rows
  try {
    const stream = fs.createWriteStream(outPath, { flags: 'a', encoding: 'utf8' });
    for (const t of toAppend) {
      stream.write(t.row + '\n');
    }
    stream.end();
    console.log('Appended', toAppend.length, 'rows to', outPath);
  } catch (e) {
    console.error('Failed to append rows:', e.message || e);
    process.exit(1);
  }

  process.exit(0);
})();
