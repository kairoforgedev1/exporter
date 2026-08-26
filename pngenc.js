'use strict';
// Lossless optimized PNG encoder (pure JS, no native deps).
// - Per-scanline adaptive filtering (min-sum-of-abs heuristic)
// - Max deflate compression, best of two zlib strategies
// - Automatic lossless palette (PNG-8) encoding when the image has <= 256
//   unique colors (common when the atlas came from a quantized source)
// - Strips the alpha channel when the image is fully opaque

const zlib = require('zlib');

const crc32 =
  typeof zlib.crc32 === 'function'
    ? (buf) => zlib.crc32(buf) >>> 0
    : (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c >>> 0;
        }
        return (buf) => {
          let c = 0xffffffff;
          for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
          return (c ^ 0xffffffff) >>> 0;
        };
      })();

function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Adaptive per-scanline filtering; returns the filtered byte stream. */
function filterScanlines(pixels, width, height, bpp) {
  const stride = width * bpp;
  const filtered = Buffer.allocUnsafe((stride + 1) * height);
  const cand = [];
  for (let i = 0; i < 5; i++) cand.push(Buffer.allocUnsafe(stride));
  const zeroRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zeroRow;

    for (let x = 0; x < stride; x++) {
      const raw = row[x];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prior[x];
      const ul = x >= bpp ? prior[x - bpp] : 0;
      cand[0][x] = raw;
      cand[1][x] = (raw - left) & 0xff;
      cand[2][x] = (raw - up) & 0xff;
      cand[3][x] = (raw - ((left + up) >> 1)) & 0xff;
      cand[4][x] = (raw - paeth(left, up, ul)) & 0xff;
    }

    let bestFilter = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = c[x];
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
      }
    }

    const off = y * (stride + 1);
    filtered[off] = bestFilter;
    cand[bestFilter].copy(filtered, off + 1);
  }
  return filtered;
}

function bestDeflate(data) {
  const a = zlib.deflateSync(data, { level: 9, memLevel: 9, chunkSize: 256 * 1024 });
  const b = zlib.deflateSync(data, {
    level: 9,
    memLevel: 9,
    chunkSize: 256 * 1024,
    strategy: zlib.constants.Z_FILTERED,
  });
  return a.length <= b.length ? a : b;
}

/** Build an exact palette if the image has <= 256 unique RGBA colors. */
function tryBuildPalette(rgba) {
  const seen = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    if (!seen.has(key)) {
      if (seen.size >= 256) return null;
      seen.set(key, seen.size);
    }
  }
  // Sort translucent colors first so the tRNS chunk can be truncated.
  const colors = [...seen.keys()].sort((a, b) => (a & 0xff) - (b & 0xff));
  const index = new Map();
  colors.forEach((key, i) => index.set(key, i));
  return { colors, index };
}

function encodeIndexed(rgba, width, height, palette) {
  const { colors, index } = palette;
  const pixels = Buffer.allocUnsafe(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    pixels[p] = index.get(key);
  }

  const plte = Buffer.allocUnsafe(colors.length * 3);
  let alphaCount = 0;
  colors.forEach((key, i) => {
    plte[i * 3] = (key >>> 24) & 0xff;
    plte[i * 3 + 1] = (key >>> 16) & 0xff;
    plte[i * 3 + 2] = (key >>> 8) & 0xff;
    if ((key & 0xff) !== 255) alphaCount = i + 1;
  });
  const trns = Buffer.allocUnsafe(alphaCount);
  for (let i = 0; i < alphaCount; i++) trns[i] = colors[i] & 0xff;

  const filtered = filterScanlines(pixels, width, height, 1);
  return { colorType: 3, bitDepth: 8, idat: bestDeflate(filtered), plte, trns };
}

function encodeTruecolor(rgba, width, height) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  let pixels;
  if (opaque) {
    pixels = Buffer.allocUnsafe(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      pixels[j] = rgba[i];
      pixels[j + 1] = rgba[i + 1];
      pixels[j + 2] = rgba[i + 2];
    }
  } else {
    pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  }
  const filtered = filterScanlines(pixels, width, height, opaque ? 3 : 4);
  return { colorType: opaque ? 2 : 6, bitDepth: 8, idat: bestDeflate(filtered) };
}

/**
 * @param {Uint8Array} rgba - raw RGBA pixel data (width*height*4 bytes)
 * @returns {Buffer} complete PNG file bytes (losslessly optimized)
 */
function encodePNG(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`pixel buffer size mismatch: ${rgba.length} != ${width * height * 4}`);
  }

  const palette = tryBuildPalette(rgba);
  const enc = palette ? encodeIndexed(rgba, width, height, palette) : encodeTruecolor(rgba, width, height);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = enc.bitDepth;
  ihdr[9] = enc.colorType;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (enc.plte) parts.push(chunk('PLTE', enc.plte));
  if (enc.trns && enc.trns.length) parts.push(chunk('tRNS', enc.trns));
  parts.push(chunk('IDAT', enc.idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { encodePNG };
