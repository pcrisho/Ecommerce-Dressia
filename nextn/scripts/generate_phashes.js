const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Directory with training images (relative to repo root)
const TRAIN_DIR = path.join(process.cwd(), 'public', 'entrenamiento');
const OUT_FILE = path.join(process.cwd(), 'data', 'training_phashes.json');
const DATA_TS = path.join(process.cwd(), 'src', 'lib', 'data.ts');

async function computeAHash(buffer) {
  // Resize to 8x8, grayscale, raw pixels
  const raw = await sharp(buffer).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  const pixels = Array.from(raw);
  const avg = pixels.reduce((s, v) => s + v, 0) / pixels.length;
  const bits = pixels.map((v) => (v > avg ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}

function readProductMapping() {
  // Try to read src/lib/data.ts and extract { id, nombre } pairs so we can map folder names -> product ids
  if (!fs.existsSync(DATA_TS)) return [];
  const src = fs.readFileSync(DATA_TS, 'utf8');
  const entries = [];
  // crude regex to find blocks with id: 'X' and nombre: 'Name'
  const re = /\{[^}]*id:\s*'([^']+)'[^}]*nombre:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({ id: m[1], nombre: m[2] });
  }
  return entries;
}

function walkDir(dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      results.push(...walkDir(full));
    } else if (it.isFile() && /\.(jpe?g|png|webp)$/i.test(it.name)) {
      results.push(full);
    }
  }
  return results;
}

(async () => {
  if (!fs.existsSync(TRAIN_DIR)) {
    console.error('Training directory not found:', TRAIN_DIR);
    process.exit(1);
  }

  const products = readProductMapping();
  if (products.length === 0) {
    console.warn('Could not parse product list from', DATA_TS, '- product mapping will be null');
  }

  const files = walkDir(TRAIN_DIR);
  const out = [];
  for (const p of files) {
    try {
      const buf = fs.readFileSync(p);
      const phash = await computeAHash(buf);
      const rel = path.relative(TRAIN_DIR, p).replace(/\\/g, '/');
      const parts = rel.split('/');
      const folder = parts.length > 1 ? parts[0] : null;

      // Attempt to map folder -> product id by substring match against product nombre
      let productId = null;
      if (folder && products.length) {
        const lowFolder = folder.toLowerCase();
        const found = products.find((prd) => prd.nombre.toLowerCase().includes(lowFolder));
        if (found) productId = found.id;
      }

      out.push({ filename: rel, phash, productId });
      console.log('Processed', rel, '->', phash, 'productId=', productId);
    } catch (err) {
      console.error('Failed to process', p, err);
    }
  }

  // Ensure output dir
  const outDir = path.dirname(OUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', OUT_FILE);
})();
