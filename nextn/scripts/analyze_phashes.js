const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TRAIN_DIR = path.join(process.cwd(), 'public', 'ENTRENAMIENTO');

// pHash implementation (same approach as generate_phashes)
async function computePHash(buffer) {
    const SIZE = 32;
    const SMALL = 8;
    const raw = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
    const pixels = [];
    for (let y = 0; y < SIZE; y++) {
        const row = [];
        for (let x = 0; x < SIZE; x++) {
            row.push(raw[y * SIZE + x]);
        }
        pixels.push(row);
    }

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
    const vals = [];
    for (let y = 0; y < SMALL; y++) {
        for (let x = 0; x < SMALL; x++) {
            vals.push(dct[y][x]);
        }
    }
    const sorted = Array.from(vals).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const bits = vals.map((v) => (v > median ? '1' : '0')).join('');
    const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
    return hex;
}

function hexToBin64(hex) {
    const h = hex.replace(/^0x/, '').padStart(16, '0').toLowerCase();
    return h.split('').map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

function hammingDistanceHex(aHex, bHex) {
    const aBin = hexToBin64(aHex);
    const bBin = hexToBin64(bHex);
    let count = 0;
    for (let i = 0; i < aBin.length && i < bBin.length; i++) if (aBin[i] !== bBin[i]) count++;
    return count;
}

function walkDir(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
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
        console.error('Training dir not found:', TRAIN_DIR);
        process.exit(1);
    }

    const files = walkDir(TRAIN_DIR);
    const entries = [];
    for (const f of files) {
        try {
            const buf = fs.readFileSync(f);
            const phash = await computePHash(buf);
            const rel = path.relative(TRAIN_DIR, f).replace(/\\/g, '/');
            const parts = rel.split('/');
            const folder = parts.length > 1 ? parts[0] : null;
            entries.push({ filename: rel, phash, folder });
        } catch (err) {
            console.error('err', f, err);
        }
    }

    // compute intra (same folder) and inter (different folder) distances
    const intra = [];
    const inter = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i];
            const b = entries[j];
            const dist = hammingDistanceHex(a.phash, b.phash);
            if (a.folder && b.folder && a.folder === b.folder) intra.push(dist);
            else inter.push(dist);
        }
    }

    function stats(arr) {
        if (!arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        const sum = arr.reduce((s, v) => s + v, 0);
        const mean = sum / arr.length;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const pct = (p) => {
            const idx = Math.floor((p / 100) * (sorted.length - 1));
            return sorted[idx];
        };
        return { count: arr.length, min, max, mean, p50: pct(50), p90: pct(90), p95: pct(95), p05: pct(5) };
    }

    const sIntra = stats(intra);
    const sInter = stats(inter);
    console.log('Samples:', entries.length);
    console.log('Intra stats:', sIntra);
    console.log('Inter stats:', sInter);

    if (sIntra && sInter) {
        if (sIntra.max < sInter.min) {
            const suggested = Math.round((sIntra.max + sInter.min) / 2);
            console.log('Clear gap found between intra.max and inter.min. Suggested threshold:', suggested);
        } else {
            // fallback: take midpoint between 95th intra and 5th inter
            const suggested = Math.round((sIntra.p95 + sInter.p05) / 2);
            console.log('No clear gap. Suggested threshold (avg of 95th intra and 5th inter):', suggested);
        }
    }

    // Optionally, write a training_phashes.json with computed phashes
    const outPath = path.join(process.cwd(), 'data', 'training_phashes.json');
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(entries.map(e => ({ filename: e.filename, phash: e.phash })), null, 2), 'utf8');
    console.log('Wrote', outPath);
})();
