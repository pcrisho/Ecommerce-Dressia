/*
Rebuilds nextn/data/gcp_product_catalog.csv from nextn/data/training_embeddings.json
Usage (PowerShell):
  node .\nextn\scripts\rebuild_catalog_from_embeddings.js
This will overwrite nextn/data/gcp_product_catalog.csv with a deduped list of image_uri,product_id,product_category,display_name
display_name is inferred as: Blusa "<folder>" where <folder> is the immediate folder under the bucket in the gs:// path.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const embeddingsPath = path.join(ROOT, 'data', 'training_embeddings.json');
const outCsvPath = path.join(ROOT, 'data', 'gcp_product_catalog.csv');

function quoteCsv(s) {
  if (s == null) return '""';
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function inferDisplayNameFromGsUri(gsUri) {
  // gs://bucket/Folder/.../filename
  if (!gsUri || !gsUri.startsWith('gs://')) return '';
  const noPrefix = gsUri.replace(/^gs:\/\//, '');
  const parts = noPrefix.split('/');
  // parts[0] = bucket, parts[1] = top-level folder (e.g., product folder)
  const folder = parts[1] || parts.slice(0, -1).join('/');
  // Make a friendly Blusa "<folder>" display name like existing CSV
  return folder ? `Blusa "${folder}"` : '';
}

function main() {
  if (!fs.existsSync(embeddingsPath)) {
    console.error('training_embeddings.json not found at', embeddingsPath);
    process.exit(1);
  }

  console.log('Reading', embeddingsPath);
  const raw = fs.readFileSync(embeddingsPath, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse JSON:', e);
    process.exit(1);
  }

  const seen = new Map(); // filename -> { productId }
  for (const item of arr) {
    const filename = item.filename || item.image_uri || item.gcs_uri || item.gs_uri;
    const productId = item.productId || item.product_id || item.productId?.toString() || '';
    if (!filename) continue;
    if (!seen.has(filename)) {
      seen.set(filename, { productId: String(productId) });
    }
  }

  console.log(`Found ${seen.size} unique image entries in embeddings index`);

  const header = 'image_uri,product_id,product_category,display_name\n';
  const lines = [header];
  for (const [filename, meta] of seen) {
    const product_id = meta.productId || '';
    const product_category = 'apparel-v2';
    const display_name = inferDisplayNameFromGsUri(filename);
    const row = [quoteCsv(filename), quoteCsv(product_id), quoteCsv(product_category), quoteCsv(display_name)].join(',') + '\n';
    lines.push(row);
  }

  fs.writeFileSync(outCsvPath, lines.join(''));
  console.log('Wrote updated CSV to', outCsvPath);
}

main();
