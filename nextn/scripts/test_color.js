/* eslint-disable @typescript-eslint/no-require-imports */
const sharp = require('sharp');
const fs = require('fs');

async function computeDominant(buffer) {
  const size = 64;
  const raw = await sharp(buffer).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  const bins = new Map();
  const binSize = 32;
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i+1];
    const b = raw[i+2];
    const brightness = (r+g+b)/3;
    if (brightness < 20 || brightness > 235) continue;
    const binR = Math.floor(r / binSize) * binSize;
    const binG = Math.floor(g / binSize) * binSize;
    const binB = Math.floor(b / binSize) * binSize;
    const key = `${binR},${binG},${binB}`;
    const saturation = Math.max(r,g,b) - Math.min(r,g,b);
    const significance = saturation * (1 + Math.max(r/255,g/255,b/255));
    if (!bins.has(key)) bins.set(key, {r:0,g:0,b:0,count:0,totalSignificance:0});
    const bin = bins.get(key);
    bin.r += r * significance; bin.g += g * significance; bin.b += b * significance;
    bin.count++; bin.totalSignificance += significance;
  }
  let maxSign = 0; let dom = {r:0,g:0,b:0};
  for (const [k,bin] of bins.entries()){
    if (bin.totalSignificance > maxSign) { maxSign = bin.totalSignificance; dom = { r: Math.round(bin.r/bin.totalSignificance), g: Math.round(bin.g/bin.totalSignificance), b: Math.round(bin.b/bin.totalSignificance) }; }
  }
  const hex = ((dom.r<<16)|(dom.g<<8)|dom.b).toString(16).padStart(6,'0');
  return {dom, hex};
}

async function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,l=(max+min)/2; if(max!==min){ const d=max-min; s = l>0.5? d/(2-max-min): d/(max+min); switch(max){case r: h=(g-b)/d + (g<b?6:0); break; case g: h=(b-r)/d+2; break; case b: h=(r-g)/d+4; break;} h/=6;} return {h:h*360,s:s*100,l:l*100}; }

async function test(path){
  if (!fs.existsSync(path)) { console.error('File not found:', path); return; }
  const buf = fs.readFileSync(path);
  const res = await computeDominant(buf);
  const hsl = await rgbToHsl(res.dom.r,res.dom.g,res.dom.b);
  console.log('File:', path);
  console.log('Dominant RGB:', res.dom, 'HEX:#'+res.hex);
  console.log('HSL:', hsl);
}

const paths = process.argv.slice(2);
(async ()=>{
  if (paths.length===0) return console.log('Usage: node test_color.js <image1> [image2]...');
  for (const p of paths) await test(p);
})();