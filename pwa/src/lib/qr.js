// QR code encoder (ISO/IEC 18004), byte mode, versions 1-40, written for
// Campfire. The construction follows the public specification and the
// structure popularised by Project Nayuki's "QR Code generator library"
// (MIT licence); no code from any library is bundled. Tested against an
// independent decoder (jsQR, dev-only) in test/unit/qr.test.mjs.

const ECL = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function numDataCodewords(ver, ecl) {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

class Matrix {
  constructor(ver) {
    this.version = ver;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFn(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFn[y][x] = true;
  }
  alignmentPositions() {
    const v = this.version;
    if (v === 1) return [];
    const na = Math.floor(v / 7) + 2;
    const step = Math.floor((v * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
    const r = [6];
    for (let pos = this.size - 7; r.length < na; pos -= step) r.splice(1, 0, pos);
    return r;
  }
  drawFunctionPatterns(ecl) {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(s - 4, 3);
    this.finder(3, s - 4);
    const ap = this.alignmentPositions();
    const n = ap.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.alignment(ap[i], ap[j]);
      }
    this.formatBits(ecl, 0);
    this.versionBits();
  }
  finder(x, y) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, d !== 2 && d !== 4);
      }
  }
  alignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  formatBits(ecl, mask) {
    const data = (ecl.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
    this.setFn(8, 7, bit(bits, 6));
    this.setFn(8, 8, bit(bits, 7));
    this.setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFn(s - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFn(8, s - 15 + i, bit(bits, i));
    this.setFn(8, s - 8, true);
  }
  versionBits() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const c = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, c);
      this.setFn(b, a, c);
    }
  }
  drawCodewords(data) {
    let i = 0;
    const s = this.size;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.isFn[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
    }
  }
  applyMask(mask) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        let inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFn[y][x] && inv) this.modules[y][x] = !this.modules[y][x];
      }
  }
  penalty() {
    const s = this.size;
    const m = this.modules;
    let result = 0;
    const addHist = (len, h) => {
      if (h[0] === 0) len += s;
      h.pop();
      h.unshift(len);
    };
    const countPat = (h) => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    const terminate = (color, len, h) => {
      if (color) {
        addHist(len, h);
        len = 0;
      }
      len += s;
      addHist(len, h);
      return countPat(h);
    };
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < s; a++) {
        let color = false;
        let run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < s; b++) {
          const c = pass === 0 ? m[a][b] : m[b][a];
          if (c === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            addHist(run, h);
            if (!color) result += countPat(h) * 40;
            color = c;
            run = 1;
          }
        }
        result += terminate(color, run, h) * 40;
      }
    for (let y = 0; y < s - 1; y++)
      for (let x = 0; x < s - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = s * s;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
  const raw = Math.floor(numRawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  return out;
}

/**
 * Encodes text (UTF-8, byte mode) into a QR matrix.
 * @returns {{size:number, version:number, ecl:string, mask:number, modules:boolean[][]}}
 */
export function encodeQr(text, { ecl: eclName = 'M', minVersion = 1, maxVersion = 40, boostEcl = true } = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let ecl = ECL[eclName];
  if (!ecl) throw new Error('bad ECC level');
  let ver;
  let bitsNeeded;
  for (ver = minVersion; ; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    bitsNeeded = 4 + ccBits + bytes.length * 8;
    if (bytes.length < 1 << ccBits && bitsNeeded <= numDataCodewords(ver, ecl) * 8) break;
    if (ver >= maxVersion) throw new RangeError('Too much data for a QR code');
  }
  if (boostEcl)
    for (const name of ['Q', 'H']) {
      const e = ECL[name];
      if (e.ordinal > ecl.ordinal && bitsNeeded <= numDataCodewords(ver, e) * 8) ecl = e;
    }
  const bb = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  };
  push(0x4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = numDataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capBits - bb.length));
  push(0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j];
    data.push(v);
  }
  const m = new Matrix(ver);
  m.drawFunctionPatterns(ecl);
  m.drawCodewords(addEccAndInterleave(data, ver, ecl));
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    m.applyMask(mask);
    m.formatBits(ecl, mask);
    const p = m.penalty();
    if (p < bestScore) {
      best = mask;
      bestScore = p;
    }
    m.applyMask(mask); // undo
  }
  m.applyMask(best);
  m.formatBits(ecl, best);
  const eclOut = Object.keys(ECL).find((k) => ECL[k] === ecl);
  return { size: m.size, version: ver, ecl: eclOut, mask: best, modules: m.modules };
}

/** SVG path data for the dark modules, with a quiet zone of `border` modules. */
export function qrSvgPath(qr, border = 4) {
  const parts = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
  return parts.join('');
}

/** RGBA pixels (black on white) for tests and canvas rendering. */
export function qrToRgba(qr, { scale = 4, border = 4 } = {}) {
  const dim = (qr.size + border * 2) * scale;
  const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + border) * scale + dy) * dim + (x + border) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }
  return { width: dim, height: dim, data: px };
}
