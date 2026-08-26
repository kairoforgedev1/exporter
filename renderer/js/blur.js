// Blurred variants of STATIC symbol images, for use while reels are spinning.
//
// Two things make or break this:
//
//  1. Alpha halos. Blurring straight-alpha RGBA averages the colour of fully
//     transparent pixels (usually black) into the fringe, which rings the
//     symbol with a dark halo. Everything here blurs in PREMULTIPLIED space
//     and un-premultiplies at the end, so a red symbol stays pure red at every
//     alpha level instead of fading to black.
//
//  2. Alignment. The kernels are symmetric about the source pixel and any
//     padding is applied symmetrically per axis, so the alpha-weighted centre
//     of the artwork lands in exactly the same place relative to the canvas
//     centre. Swapping a sharp symbol for its blurred twin cannot shift it.

/** Blur styles offered to the user. */
export const BLUR_STYLES = { MOTION: 'motion', GAUSSIAN: 'gaussian' };

export const DEFAULT_BLUR = {
  style: BLUR_STYLES.MOTION,
  strength: 20, // motion streak length, or gaussian diameter, in pixels
  angle: 90, // 90° = vertical, the direction reels travel
  softness: 25, // % of strength applied as a gaussian, smooths the streak
  expand: true, // grow the canvas so the blur is never clipped
};

// ---------------------------------------------------------------------------
// Premultiplied buffers
// ---------------------------------------------------------------------------

function toPremultiplied(data, count) {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    out[o] = data[o] * a;
    out[o + 1] = data[o + 1] * a;
    out[o + 2] = data[o + 2] * a;
    out[o + 3] = data[o + 3];
  }
  return out;
}

function fromPremultiplied(buf, count) {
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const alpha = buf[o + 3];
    if (alpha <= 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    const a = alpha / 255;
    out[o] = buf[o] / a;
    out[o + 1] = buf[o + 1] / a;
    out[o + 2] = buf[o + 2] / a;
    out[o + 3] = alpha;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kernels. Out-of-bounds reads count as fully transparent (divide by the full
// window), which is what "the artwork ends here" actually means — clamping
// would smear the border pixels outward instead.
// ---------------------------------------------------------------------------

function boxBlurH(src, dst, w, h, radius) {
  if (radius < 1) {
    dst.set(src);
    return;
  }
  const window = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let x = 0; x <= radius && x < w; x++) {
      const o = row + x * 4;
      s0 += src[o];
      s1 += src[o + 1];
      s2 += src[o + 2];
      s3 += src[o + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      dst[o] = s0 / window;
      dst[o + 1] = s1 / window;
      dst[o + 2] = s2 / window;
      dst[o + 3] = s3 / window;
      const add = x + radius + 1;
      const drop = x - radius;
      if (add < w) {
        const a = row + add * 4;
        s0 += src[a];
        s1 += src[a + 1];
        s2 += src[a + 2];
        s3 += src[a + 3];
      }
      if (drop >= 0) {
        const d = row + drop * 4;
        s0 -= src[d];
        s1 -= src[d + 1];
        s2 -= src[d + 2];
        s3 -= src[d + 3];
      }
    }
  }
}

function boxBlurV(src, dst, w, h, radius) {
  if (radius < 1) {
    dst.set(src);
    return;
  }
  const window = radius * 2 + 1;
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    const col = x * 4;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let y = 0; y <= radius && y < h; y++) {
      const o = col + y * stride;
      s0 += src[o];
      s1 += src[o + 1];
      s2 += src[o + 2];
      s3 += src[o + 3];
    }
    for (let y = 0; y < h; y++) {
      const o = col + y * stride;
      dst[o] = s0 / window;
      dst[o + 1] = s1 / window;
      dst[o + 2] = s2 / window;
      dst[o + 3] = s3 / window;
      const add = y + radius + 1;
      const drop = y - radius;
      if (add < h) {
        const a = col + add * stride;
        s0 += src[a];
        s1 += src[a + 1];
        s2 += src[a + 2];
        s3 += src[a + 3];
      }
      if (drop >= 0) {
        const d = col + drop * stride;
        s0 -= src[d];
        s1 -= src[d + 1];
        s2 -= src[d + 2];
        s3 -= src[d + 3];
      }
    }
  }
}

/** Three box passes approximate a gaussian closely enough and stay O(n). */
function gaussianBlur(buf, w, h, radius) {
  if (radius < 1) return buf;
  const passes = [radius, Math.max(1, Math.round(radius * 0.75)), Math.max(1, Math.round(radius * 0.5))];
  let src = buf;
  let dst = new Float32Array(buf.length);
  for (const r of passes) {
    boxBlurH(src, dst, w, h, r);
    [src, dst] = [dst, src];
    boxBlurV(src, dst, w, h, r);
    [src, dst] = [dst, src];
  }
  return src;
}

/**
 * Linear motion blur along an arbitrary direction: every output pixel is the
 * average of samples taken along a line centred on it, which is what constant
 * velocity actually does to a frame.
 */
function motionBlurSampled(buf, w, h, length, angleDeg) {
  const out = new Float32Array(buf.length);
  const rad = (angleDeg * Math.PI) / 180;
  // Screen space: y grows downward, so 90° reads as "vertical".
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const samples = Math.max(2, Math.ceil(length) + 1);
  const half = length / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let k = 0; k < samples; k++) {
        const t = (k / (samples - 1) - 0.5) * 2 * half;
        const sx = x + dx * t;
        const sy = y + dy * t;
        // Bilinear sample, zero outside.
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        for (let j = 0; j < 2; j++) {
          const yy = y0 + j;
          if (yy < 0 || yy >= h) continue;
          const wy = j === 0 ? 1 - fy : fy;
          if (wy === 0) continue;
          for (let i = 0; i < 2; i++) {
            const xx = x0 + i;
            if (xx < 0 || xx >= w) continue;
            const wx = i === 0 ? 1 - fx : fx;
            if (wx === 0) continue;
            const weight = wx * wy;
            const o = (yy * w + xx) * 4;
            a0 += buf[o] * weight;
            a1 += buf[o + 1] * weight;
            a2 += buf[o + 2] * weight;
            a3 += buf[o + 3] * weight;
          }
        }
      }
      const o = (y * w + x) * 4;
      out[o] = a0 / samples;
      out[o + 1] = a1 / samples;
      out[o + 2] = a2 / samples;
      out[o + 3] = a3 / samples;
    }
  }
  return out;
}

const nearly = (a, b) => Math.abs(a - b) < 0.5;

/** Padding needed on each axis so nothing is clipped. */
export function blurPadding(options) {
  const o = { ...DEFAULT_BLUR, ...options };
  const strength = Math.max(0, o.strength);
  if (strength <= 0) return { x: 0, y: 0 };
  if (o.style === BLUR_STYLES.GAUSSIAN) {
    const r = Math.ceil(strength / 2);
    return { x: r + 1, y: r + 1 };
  }
  const rad = (o.angle * Math.PI) / 180;
  const half = strength / 2;
  const soft = Math.ceil((strength * Math.max(0, o.softness)) / 100 / 2);
  return {
    x: Math.ceil(half * Math.abs(Math.cos(rad))) + soft + 1,
    y: Math.ceil(half * Math.abs(Math.sin(rad))) + soft + 1,
  };
}

/**
 * Blur one static image.
 *
 * @param {HTMLCanvasElement} source
 * @param {object} options  see DEFAULT_BLUR
 * @returns {{canvas, padding:{x,y}, clipped:boolean, edgeAlpha:number,
 *            width:number, height:number}}
 */
export function blurImage(source, options = {}) {
  const o = { ...DEFAULT_BLUR, ...options };
  const strength = Math.max(0, o.strength);
  const pad = o.expand ? blurPadding(o) : { x: 0, y: 0 };

  const w = source.width + pad.x * 2;
  const h = source.height + pad.y * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, pad.x, pad.y);

  if (strength <= 0) {
    return { canvas, padding: pad, clipped: false, edgeAlpha: 0, width: w, height: h };
  }

  const imageData = ctx.getImageData(0, 0, w, h);
  const count = w * h;
  let buf = toPremultiplied(imageData.data, count);

  if (o.style === BLUR_STYLES.GAUSSIAN) {
    buf = gaussianBlur(buf, w, h, Math.max(1, Math.round(strength / 2)));
  } else {
    const angle = ((o.angle % 360) + 360) % 360;
    const axisVertical = nearly(angle, 90) || nearly(angle, 270);
    const axisHorizontal = nearly(angle, 0) || nearly(angle, 180);
    const radius = Math.max(1, Math.round(strength / 2));
    if (axisVertical) {
      const dst = new Float32Array(buf.length);
      boxBlurV(buf, dst, w, h, radius);
      buf = dst;
    } else if (axisHorizontal) {
      const dst = new Float32Array(buf.length);
      boxBlurH(buf, dst, w, h, radius);
      buf = dst;
    } else {
      buf = motionBlurSampled(buf, w, h, strength, angle);
    }
    const soft = Math.round((strength * Math.max(0, o.softness)) / 100 / 2);
    if (soft >= 1) buf = gaussianBlur(buf, w, h, soft);
  }

  const outData = fromPremultiplied(buf, count);
  ctx.putImageData(new ImageData(outData, w, h), 0, 0);

  // How much signal is sitting on the outermost ring? Anything meaningful
  // there means the blur wanted more room than the canvas allows.
  let edgeAlpha = 0;
  const alphaAt = (x, y) => outData[(y * w + x) * 4 + 3];
  for (let x = 0; x < w; x++) {
    edgeAlpha = Math.max(edgeAlpha, alphaAt(x, 0), alphaAt(x, h - 1));
  }
  for (let y = 0; y < h; y++) {
    edgeAlpha = Math.max(edgeAlpha, alphaAt(0, y), alphaAt(w - 1, y));
  }

  return {
    canvas,
    padding: pad,
    clipped: edgeAlpha > 8,
    edgeAlpha,
    width: w,
    height: h,
  };
}

/**
 * Alpha-weighted centroid, measured from the canvas centre. Comparing this
 * between a sharp symbol and its blurred twin is how "no visible jump" is
 * checked rather than assumed.
 */
export function alphaCentroidOffset(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const a = data[(y * canvas.width + x) * 4 + 3];
      if (!a) continue;
      sum += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
    }
  }
  if (!sum) return { x: 0, y: 0, empty: true };
  return {
    x: sx / sum - canvas.width / 2,
    y: sy / sum - canvas.height / 2,
    empty: false,
  };
}

/** `h1.png` -> `h1_blur.png`. Extension and casing are left alone. */
export function blurredName(name, suffix = '_blur') {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}${suffix}`;
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}
