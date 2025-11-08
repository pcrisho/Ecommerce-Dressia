const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Directory with training images (relative to repo root)
const TRAIN_DIR = path.join(process.cwd(), 'public', 'entrenamiento');
const OUT_FILE = path.join(process.cwd(), 'data', 'training_phashes.json');
const DATA_TS = path.join(process.cwd(), 'src', 'lib', 'data.ts');

// Compute pHash (perceptual hash) from buffer.
// Algorithm: resize to 32x32 grayscale, compute 2D DCT, keep top-left 8x8, compute median and
// produce 64-bit hash based on values > median.
async function computePHash(buffer) {
  const SIZE = 32;
  const SMALL = 8;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
  // raw is a Uint8Array-like buffer of length SIZE*SIZE
  const pixels = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      row.push(raw[y * SIZE + x]);
    }
    pixels.push(row);
  }

  // 2D DCT (naive implementation) on SIZE x SIZE
  function dct2D(matrix) {
    const N = SIZE;
    const out = Array.from({ length: N }, () => new Array(N).fill(0));
    const PI = Math.PI;
    for (let u = 0; u < N; u++) {
      for (let v = 0; v < N; v++) {
        let sum = 0;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            sum +=
              matrix[i][j] *
              Math.cos(((2 * i + 1) * u * PI) / (2 * N)) *
              Math.cos(((2 * j + 1) * v * PI) / (2 * N));
          }
        }
        const cu = u === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
        const cv = v === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
        out[u][v] = cu * cv * sum;
      }
    }
    return out;
  }

  const dct = dct2D(pixels);

  // take top-left SMALL x SMALL block
  const vals = [];
  for (let y = 0; y < SMALL; y++) {
    for (let x = 0; x < SMALL; x++) {
      vals.push(dct[y][x]);
    }
  }

  // compute median
  const sorted = Array.from(vals).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const bits = vals.map((v) => (v > median ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}

// Compute aHash (average hash) from buffer.
// Algorithm: resize to 8x8 grayscale, compute mean and produce 64-bit hash based on values > mean.
async function computeAHash(buffer) {
  const SIZE = 8;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
  const vals = [];
  for (let i = 0; i < SIZE * SIZE; i++) vals.push(raw[i]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const bits = vals.map((v) => (v > mean ? '1' : '0')).join('');
  const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return hex;
}
 
// Compute dominant color (RGB) using color quantization and dominant color detection
async function computeAvgColor(buffer) {
  const size = 64; // Increased size for better sampling
  
  // Convert to raw pixels with more accurate color processing
  const raw = await sharp(buffer)
    .resize(size, size, { fit: 'cover' })
    .removeAlpha()  // Ensure we're working with RGB only
    .raw()
    .toBuffer();

  // Create bins for color clustering
  const bins = new Map();
  const binSize = 32; // Color quantization level
  
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    
    // Skip very dark or very light colors (likely background)
    const brightness = (r + g + b) / 3;
    if (brightness < 20 || brightness > 235) continue;
    
    // Quantize colors into bins
    const binR = Math.floor(r / binSize) * binSize;
    const binG = Math.floor(g / binSize) * binSize;
    const binB = Math.floor(b / binSize) * binSize;
    
    const key = `${binR},${binG},${binB}`;
    
    // Calculate color significance
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const significance = saturation * (1 + Math.max(r/255, g/255, b/255)); // Consider both saturation and intensity
    
    if (!bins.has(key)) {
      bins.set(key, { r: 0, g: 0, b: 0, count: 0, totalSignificance: 0 });
    }
    
    const bin = bins.get(key);
    bin.r += r * significance;
    bin.g += g * significance;
    bin.b += b * significance;
    bin.count++;
    bin.totalSignificance += significance;
  }
  
  // Find the most significant color cluster
  let maxSignificance = 0;
  let dominantColor = { r: 0, g: 0, b: 0 };
  
  for (const bin of bins.values()) {
    if (bin.totalSignificance > maxSignificance) {
      maxSignificance = bin.totalSignificance;
      dominantColor = {
        r: Math.round(bin.r / bin.totalSignificance),
        g: Math.round(bin.g / bin.totalSignificance),
        b: Math.round(bin.b / bin.totalSignificance)
      };
    }
  }
  
  const hex = ((dominantColor.r << 16) | (dominantColor.g << 8) | dominantColor.b).toString(16).padStart(6, '0');
  return { ...dominantColor, hex };
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
  const phash = await computePHash(buf);
  const ahash = await computeAHash(buf);
  const avg = await computeAvgColor(buf);
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

  out.push({ filename: rel, phash, ahash, color: avg.hex, productId });
  console.log('Processed', rel, '->', phash, ahash, avg.hex, 'productId=', productId);
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
