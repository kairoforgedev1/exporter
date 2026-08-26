// Small shared helpers for the renderer.

export class Emitter {
  constructor() {
    this._map = new Map();
  }
  on(event, fn) {
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(fn);
    return () => this._map.get(event).delete(fn);
  }
  emit(event, payload) {
    const set = this._map.get(event);
    if (set) for (const fn of [...set]) fn(payload);
  }
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

export function dirname(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(0, i) : '';
}

export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

let uidCounter = 0;
export const uid = () => ++uidCounter;

export function nextPowerOfTwo(v) {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/** Decode image bytes into a canvas (our universal working-image format). */
export async function bytesToCanvas(bytes) {
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}

/** High-quality resize of a canvas to exact target dimensions. */
export function scaleCanvas(src, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, c.width, c.height);
  return c;
}

/** Wrap a raw RGBA buffer in a canvas (no extra premultiply round trip). */
export function rgbaToCanvas(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = new ImageData(
    rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer ?? rgba),
    width,
    height
  );
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/**
 * Encode a canvas to WebP at maximum quality.
 *
 * Chromium's canvas encoder only produces LOSSY WebP — quality 1.0 means
 * "quality 100", not lossless — so the result is decoded back and measured
 * rather than assumed. `maxOpaque` is the metric that matters: deviation on
 * pixels that are actually visible. Errors under a near-zero alpha are
 * invisible and are where lossy codecs concentrate their noise.
 */
export async function canvasToWebpBytes(canvas, { verify = true, alphaFloor = 200 } = {}) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('WebP encoding failed'))), 'image/webp', 1.0);
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let quality = null;
  if (verify) {
    try {
      const decoded = await bytesToCanvas(bytes);
      const a = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
      const b = decoded.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, decoded.width, decoded.height).data;
      if (a.length === b.length) {
        let max = 0;
        let maxOpaque = 0;
        let sum = 0;
        for (let i = 0; i < a.length; i += 4) {
          const visible = a[i + 3] >= alphaFloor;
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(a[i + c] - b[i + c]);
            sum += d;
            if (d > max) max = d;
            if (visible && d > maxOpaque) maxOpaque = d;
          }
        }
        quality = { lossless: max === 0, max, maxOpaque, mean: sum / a.length };
      }
    } catch {
      quality = null;
    }
  }
  return { bytes, quality };
}

export function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('toBlob failed'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}
