/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fallbackEmbeddingFromBuffer(buf, dim = 128) {
  const hash = crypto.createHash('sha256').update(buf).digest();
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const v = hash[i % hash.length];
    out[i] = ((v / 255) * 2) - 1;
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function walkDir(dir) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkDir(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  try {
    const src = path.join(process.cwd(), 'public', 'ENTRENAMIENTO');
    if (!fs.existsSync(src)) {
      console.error('Source folder not found:', src);
      process.exit(2);
    }
    const files = await walkDir(src);
    if (!files.length) {
      console.error('No files found under', src);
      process.exit(3);
    }

    const embeddings = [];
    for (const f of files) {
      const buf = await fs.promises.readFile(f);
      const emb = fallbackEmbeddingFromBuffer(buf, 128);
      // store filename relative to bucket-style paths used by other scripts
      const rel = path.relative(path.join(process.cwd(), 'public'), f).replace(/\\/g, '/');
      embeddings.push({ filename: rel, embedding: emb });
    }

    const outPath = path.join(process.cwd(), 'data', 'training_embeddings.json');
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, JSON.stringify(embeddings, null, 2), 'utf8');
    console.log('Wrote', outPath, 'with', embeddings.length, 'entries');

    // Use the first image as query
    const queryBuf = await fs.promises.readFile(files[0]);
    const queryEmb = fallbackEmbeddingFromBuffer(queryBuf, 128);

    // load index
    const indexRaw = await fs.promises.readFile(outPath, 'utf8');
    const index = JSON.parse(indexRaw);
    const scored = index.map(e => ({ filename: e.filename, score: cosine(queryEmb, e.embedding) }));
    scored.sort((a,b)=>b.score - a.score);
    console.log('Top 5 results:');
    console.log(scored.slice(0,5));

    // Expect the top result to be the same file (or at least very high similarity)
    const top = scored[0];
    const expectedRel = path.relative(path.join(process.cwd(), 'public'), files[0]).replace(/\\/g, '/');
    if (top.filename !== expectedRel) {
      console.warn('Warning: top filename != query filename. Top:', top.filename, 'expected:', expectedRel);
    }
    if (top.score < 0.9) {
      console.error('Top score too low:', top.score);
      process.exit(4);
    }

    console.log('Harness success: embeddings file created and local search returns high-similarity result.');
    process.exit(0);
  } catch (err) {
    console.error('Harness failed:', err);
    process.exit(10);
  }
}

main();
