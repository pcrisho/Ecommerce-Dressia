const fs = require('fs');
const path = require('path');

function flattenEmbedding(e) {
  if (!e) return null;
  if (Array.isArray(e)) return e.map(Number);
  if (typeof e === 'object') {
    // common keys we might find
    if (Array.isArray(e.imageEmbedding)) return e.imageEmbedding.map(Number);
    if (Array.isArray(e.embedding)) return e.embedding.map(Number);
    if (Array.isArray(e.vector)) return e.vector.map(Number);
    // try to find the first array value
    for (const k of Object.keys(e)) {
      if (Array.isArray(e[k])) return e[k].map(Number);
    }
  }
  return null;
}

function cosine(a, b) {
  if (!a || !b) return -1;
  const n = Math.min(a.length, b.length);
  if (n === 0) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

(async function main(){
  const p = path.join(process.cwd(), 'data', 'training_embeddings.json');
  if (!fs.existsSync(p)) {
    console.error('training_embeddings.json not found at', p);
    process.exit(1);
  }
  const raw = fs.readFileSync(p,'utf8');
  const idx = JSON.parse(raw);
  console.log('Loaded', idx.length, 'entries');

  // pick a Malva image
  const malva = idx.find(x => x.filename && x.filename.includes('/Malva/')) || idx.find(x => x.productId === '3');
  if (!malva) {
    console.error('No Malva entry found');
    process.exit(1);
  }
  console.log('Chosen probe:', malva.filename, 'productId=', malva.productId);
  const probeVec = flattenEmbedding(malva.embedding);
  if (!probeVec) {
    console.error('Probe embedding missing or unrecognized shape', typeof malva.embedding);
    process.exit(1);
  }
  // compute similarities
  const sims = [];
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const v = flattenEmbedding(e.embedding);
    if (!v) continue;
    const s = cosine(probeVec, v);
    sims.push({ i, filename: e.filename, productId: e.productId, score: s });
  }
  sims.sort((a,b)=>b.score - a.score);
  console.log('Top 10 matches for probe:');
  console.table(sims.slice(0,10).map(x=>({score:x.score.toFixed(4), productId:x.productId, filename: x.filename})));

  // show distribution of top-50 productIds
  const top50 = sims.slice(0,50);
  const counts = {};
  for (const t of top50) counts[t.productId] = (counts[t.productId]||0)+1;
  console.log('Top-50 productId counts:', counts);
})();
