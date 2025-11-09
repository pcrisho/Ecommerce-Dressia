const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(process.cwd(),'data','training_phashes.json');

async function computePHash(buffer) {
  const SIZE = 32;
  const SMALL = 8;
  const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
  const pixels = [];
  for (let y=0;y<SIZE;y++){ const row=[]; for (let x=0;x<SIZE;x++){ row.push(raw[y*SIZE + x]); } pixels.push(row); }
  function dct2D(matrix){ const N=SIZE; const out = Array.from({length:N},()=>new Array(N).fill(0)); const PI=Math.PI; for(let u=0;u<N;u++){ for(let v=0;v<N;v++){ let sum=0; for(let i=0;i<N;i++){ for(let j=0;j<N;j++){ sum+= matrix[i][j]* Math.cos(((2*i+1)*u*PI)/(2*N)) * Math.cos(((2*j+1)*v*PI)/(2*N)); } } const cu = u===0? Math.sqrt(1/N): Math.sqrt(2/N); const cv = v===0? Math.sqrt(1/N): Math.sqrt(2/N); out[u][v] = cu*cv*sum; } } return out; }
  const dct = dct2D(pixels);
  const vals = [];
  for (let y=0;y<SMALL;y++) for (let x=0;x<SMALL;x++) vals.push(dct[y][x]);
  const sorted = Array.from(vals).sort((a,b)=>a-b); const mid = Math.floor(sorted.length/2); const median = sorted.length%2===1? sorted[mid]: (sorted[mid-1]+sorted[mid])/2;
  const bits = vals.map(v=> v>median ? '1':'0').join('');
  const hex = BigInt('0b'+bits).toString(16).padStart(16,'0');
  return hex;
}

async function computeAHash(buffer) {
  const SIZE=8; const raw = await sharp(buffer).resize(SIZE,SIZE,{fit:'fill'}).grayscale().raw().toBuffer(); const vals=[]; for(let i=0;i<SIZE*SIZE;i++) vals.push(raw[i]); const mean = vals.reduce((a,b)=>a+b,0)/vals.length; const bits = vals.map(v=> v>mean ? '1':'0').join(''); const hex = BigInt('0b'+bits).toString(16).padStart(16,'0'); return hex;
}

async function computeColorHex(buffer){ const raw = await sharp(buffer).resize(64,64,{fit:'cover'}).removeAlpha().raw().toBuffer(); const bins = new Map(); const binSize=32; for (let i=0;i<raw.length;i+=3){ const r=raw[i], g=raw[i+1], b=raw[i+2]; const brightness = (r+g+b)/3; if (brightness<20 || brightness>235) continue; const binR=Math.floor(r/binSize)*binSize; const binG=Math.floor(g/binSize)*binSize; const binB=Math.floor(b/binSize)*binSize; const key=`${binR},${binG},${binB}`; const saturation = Math.max(r,g,b)-Math.min(r,g,b); const significance = saturation * (1 + Math.max(r/255,g/255,b/255)); if (!bins.has(key)) bins.set(key,{r:0,g:0,b:0,count:0,totalSignificance:0}); const bin=bins.get(key); bin.r += r*significance; bin.g += g*significance; bin.b += b*significance; bin.count++; bin.totalSignificance += significance; }
  let maxSign=0; let dom={r:0,g:0,b:0}; for (const bin of bins.values()){ if (bin.totalSignificance>maxSign){ maxSign=bin.totalSignificance; dom = { r: Math.round(bin.r/bin.totalSignificance), g: Math.round(bin.g/bin.totalSignificance), b: Math.round(bin.b/bin.totalSignificance) }; } }
  const hex = ((dom.r<<16)|(dom.g<<8)|dom.b).toString(16).padStart(6,'0'); return {hex, dom}; }

function hexToBin64(hex){ const h = hex.replace(/^0x/,'').padStart(16,'0').toLowerCase(); return h.split('').map(c=> parseInt(c,16).toString(2).padStart(4,'0')).join(''); }
function hamming(aHex,bHex){ const a=hexToBin64(aHex); const b=hexToBin64(bHex); let c=0; for (let i=0;i<a.length && i<b.length;i++) if (a[i]!==b[i]) c++; return c; }

function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,l=(max+min)/2; if (max!==min){ const d=max-min; s = l>0.5? d/(2-max-min): d/(max+min); switch(max){ case r: h=(g-b)/d + (g<b?6:0); break; case g: h=(b-r)/d + 2; break; case b: h=(r-g)/d + 4; break; } h/=6; } return {h:h*360,s:s*100,l:l*100}; }

function colorDist(a,b){ const hslA=rgbToHsl(a.r,a.g,a.b), hslB=rgbToHsl(b.r,b.g,b.b); const dh = Math.min(Math.abs(hslA.h - hslB.h), 360 - Math.abs(hslA.h - hslB.h)) / 180.0; const ds = Math.abs(hslA.s - hslB.s) / 100.0; const dl = Math.abs(hslA.l - hslB.l) / 100.0; const saturationWeight = (hslA.s + hslB.s) / 200.0; const hueWeight = 2.0 * saturationWeight; return Math.sqrt((dh*dh*hueWeight) + (ds*ds*1.0) + (dl*dl*0.5)) * 255; }

(async ()=>{
  const args = process.argv.slice(2);
  if (args.length===0){ console.log('Usage: node simulate_query.js <image>'); process.exit(1);} 
  const imgPath = args[0]; if (!fs.existsSync(imgPath)){ console.error('File not found', imgPath); process.exit(1);} const buf = fs.readFileSync(imgPath);
  const qphash = await computePHash(buf); const qahash = await computeAHash(buf); const qcolor = await computeColorHex(buf);
  console.log('Query phash', qphash, 'ahash', qahash, 'color', qcolor.hex, qcolor.dom);
  const data = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
  const weightP=0.4, weightA=0.3, weightC=0.3; const VECTOR_BITS=64; const maxColorDist=Math.sqrt(3*255*255);
  const scored = data.map(entry=>{
    const dp = hamming(qphash, entry.phash);
    const entryA = entry.ahash ?? entry.phash;
    const da = hamming(qahash, entryA);
    const entryColorHex = entry.color ?? entry.phash.slice(0,6);
    const eq = { r: parseInt(qcolor.hex.slice(0,2),16), g: parseInt(qcolor.hex.slice(2,4),16), b: parseInt(qcolor.hex.slice(4,6),16) };
    const ee = { r: parseInt(entryColorHex.slice(0,2),16), g: parseInt(entryColorHex.slice(2,4),16), b: parseInt(entryColorHex.slice(4,6),16) };
    const colorD = colorDist(eq,ee);
    const colorNorm = Math.round((colorD / maxColorDist) * VECTOR_BITS);
    let combined = Math.round(dp * weightP + da * weightA + colorNorm * weightC);

    // Hue-based gating similar to server: penalize large hue differences when both colors are saturated
    try {
      const hslQ = rgbToHsl(eq.r, eq.g, eq.b);
      const hslE = rgbToHsl(ee.r, ee.g, ee.b);
      const hueDiff = Math.min(Math.abs(hslQ.h - hslE.h), 360 - Math.abs(hslQ.h - hslE.h));
      // strict gating thresholds to mimic server behavior
      const strictSaturationThreshold = 45;
      const strictHueThreshold = 30;
      const bothSat = hslQ.s > 25 && hslE.s > 25;
      const strictCheck = hslQ.s > strictSaturationThreshold;
      if ((strictCheck && bothSat && hueDiff > strictHueThreshold) || (!strictCheck && bothSat && hueDiff > 45)) {
        combined += 100;
      }
      return { filename: entry.filename, phash: entry.phash, productId: entry.productId, dp, da, colorD: Math.round(colorD), colorNorm, hueDiff: Math.round(hueDiff), satQ: Math.round(hslQ.s), satE: Math.round(hslE.s), combined };
    } catch (e) {
      return { filename: entry.filename, phash: entry.phash, productId: entry.productId, dp, da, colorD: Math.round(colorD), colorNorm, combined };
    }
  });
    // Apply same filtering logic as server to simulate results for non-clothing inputs
    const PHASH_STRICT = 20;
    const AHASH_STRICT = 20;
    const COLOR_DIST_ACCEPT = 110;
    const QUERY_SAT_MIN = 30;
    const filtered = scored.filter(s => {
      if (s.combined > (Number(process.env.SIM_THRESHOLD) || 24)) return false;
      const passHash = (typeof s.dp === 'number' && s.dp <= PHASH_STRICT) || (typeof s.da === 'number' && s.da <= AHASH_STRICT);
      const passColor = (qcolor && qcolor.dom && ( ( (Math.max(qcolor.dom.r,qcolor.dom.g,qcolor.dom.b) - Math.min(qcolor.dom.r,qcolor.dom.g,qcolor.dom.b) )/255*100) ) > QUERY_SAT_MIN) && (typeof s.colorD === 'number' && s.colorD <= COLOR_DIST_ACCEPT);
      return passHash || passColor;
    }).sort((a,b)=>a.combined - b.combined).slice(0,20);
  console.log('Top results:');
  console.table(filtered.map(f=> ({filename: f.filename, combined: f.combined, dp: f.dp, da: f.da, colorD: f.colorD, hueDiff: f.hueDiff ?? null, satQ: f.satQ ?? null, satE: f.satE ?? null}))); 
})();