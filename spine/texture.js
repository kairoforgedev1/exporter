'use strict';
// Animation texture codec.
//
// Animation pages must never travel through a 2D canvas. Chromium's canvas
// backing store is premultiplied 8-bit, so every drawImage/getImageData and
// putImageData/toBlob hop re-quantizes RGB by a factor of alpha/255. Measured
// on the 3697x907 pma:true sample page, a single decode+encode round trip moved
// ~24% of the non-transparent pixels, by up to 57/255 of RGB — and it lands
// squarely on the soft falloff and additive glow that Spine symbol art is made
// of. Decoding and encoding here keeps the pixels in straight RGBA from the
// animator's file to the exported one.

const { encodePNG } = require('../pngenc');

let sharpModule;
/** Lazily load Sharp so normal atlas editing never pays the native startup cost. */
function loadSharp(feature = 'Bitmap font PNG/WebP verification') {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = require('sharp');
    return sharpModule;
  } catch (error) {
    throw new Error(
      `${feature} requires the optional Sharp encoder. ` +
      `Install/rebuild the project's "sharp" dependency and try again. (${error.message})`
    );
  }
}

/**
 * Texture quality levels. PNG has no lossy mode, so it stays lossless at every
 * level and what the level actually picks is the WebP encoder. Measured on the
 * sample page: lossless 2.49 MB, quality 95 1.23 MB, quality 80 1.05 MB.
 */
const ANIM_TEXTURE_QUALITY = {
  high: { label: 'High', webp: { lossless: true, effort: 6 } },
  medium: { label: 'Medium', webp: { quality: 95, alphaQuality: 100, effort: 5 } },
  low: { label: 'Low', webp: { quality: 80, alphaQuality: 100, effort: 4 } },
};

/** Unknown or missing level names fall back to the lossless one, never to a lossy one. */
function animQualityLevel(name) {
  return ANIM_TEXTURE_QUALITY[name] ? name : 'high';
}

function qualityLevels() {
  return Object.entries(ANIM_TEXTURE_QUALITY).map(([id, level]) => ({
    id,
    label: level.label,
    webpLossless: !!level.webp.lossless,
    webpQuality: level.webp.quality ?? null,
  }));
}

function toRgbaBuffer(value, expectedBytes, label = 'Animation texture') {
  let buffer;
  if (Buffer.isBuffer(value)) {
    buffer = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof ArrayBuffer) {
    buffer = Buffer.from(value);
  } else if (Array.isArray(value)) {
    buffer = Buffer.from(value);
  } else {
    throw new Error(`${label} has no raw RGBA pixel buffer.`);
  }
  if (buffer.length !== expectedBytes) {
    throw new Error(`${label} RGBA size mismatch: ${buffer.length} != ${expectedBytes}.`);
  }
  return buffer;
}

/**
 * Deviation between the pixels we asked for and the pixels a codec produced.
 *
 * `maxOpaque` is error on solidly visible pixels. `renderedLossless` is the
 * contract that matters, and it depends on how the page is blended:
 *
 * - straight alpha: `out = src.rgb * src.a + dst.rgb * (1 - src.a)`, so RGB
 *   beneath a zero alpha is multiplied away and genuinely cannot be seen. A
 *   lossless codec is allowed to canonicalize it.
 * - premultiplied:  `out = src.rgb + dst.rgb * (1 - src.a)`, so RGB beneath a
 *   zero alpha is *added straight to the screen*. Nothing may be forgiven.
 *
 * Forgiving it unconditionally is what let a broken WebP pass verification.
 */
function measureTextureDeviation(expected, actual, options = {}) {
  if (!actual || expected.length !== actual.length) return null;
  const alphaFloor = options.alphaFloor ?? 200;
  const pma = !!options.pma;
  let max = 0;
  let maxOpaque = 0;
  let maxRendered = 0;
  let sum = 0;
  for (let i = 0; i < expected.length; i += 4) {
    const alpha = expected[i + 3];
    const visible = alpha >= alphaFloor;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(expected[i + c] - actual[i + c]);
      sum += d;
      if (d > max) max = d;
      if (visible && d > maxOpaque) maxOpaque = d;
      const invisible = !pma && c < 3 && alpha === 0 && actual[i + 3] === 0;
      if (d > maxRendered && !invisible) maxRendered = d;
    }
  }
  return {
    verified: true,
    pma,
    lossless: max === 0,
    renderedLossless: maxRendered === 0,
    max,
    maxOpaque,
    maxRendered,
    mean: sum / expected.length,
  };
}

/** Decode an animator's texture page to exact straight-alpha RGBA. */
async function decodeTextureBytes(bytes) {
  let sharp;
  try {
    sharp = loadSharp('Exact animation texture decoding');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    const decoded = await sharp(Buffer.from(bytes), { failOn: 'error' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      width: decoded.info.width,
      height: decoded.info.height,
      rgba: decoded.data,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Decode encoded bytes back and measure them against what we handed the encoder. */
async function verifyEncodedPage(bytes, expected, width, height, pma = false) {
  let sharp;
  try {
    sharp = loadSharp('Animation texture verification');
  } catch {
    return { verified: false, lossless: null, renderedLossless: null };
  }
  try {
    const decoded = await sharp(bytes, { failOn: 'error' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== width || decoded.info.height !== height) {
      return { verified: true, lossless: false, renderedLossless: false, dimensionsMatch: false };
    }
    return {
      ...measureTextureDeviation(expected, decoded.data, { pma }),
      dimensionsMatch: true,
    };
  } catch {
    return { verified: false, lossless: null, renderedLossless: null };
  }
}

/**
 * Pick WebP encoder settings for a page.
 *
 * libwebp rewrites RGB underneath fully transparent pixels to whatever
 * compresses best. That is free on a straight-alpha page, where those bytes are
 * multiplied away, and destructive on a premultiplied one, where the runtime
 * adds them straight to the screen and draws a box around every symbol quad.
 * libwebp can be told not to (its `exact` flag) but libvips/sharp does not
 * expose it, so on a premultiplied page the only usable setting is lossless at
 * effort 0 — measured on the 3697x907 sample page, effort 0 rewrites nothing
 * while effort 1 rewrites 345,458 pixels with values up to 255, and every lossy
 * mode rewrites 115,000+ at any effort.
 *
 * This is why a premultiplied page ignores the Medium/Low levels for WebP.
 */
function webpSettingsFor(quality, pma) {
  if (!pma) return { settings: ANIM_TEXTURE_QUALITY[quality].webp, forcedLossless: false };
  return { settings: { lossless: true, effort: 0 }, forcedLossless: quality !== 'high' };
}

/**
 * Encode one output page from exact RGBA, then decode it back and measure it.
 * Nothing here is described as lossless without having been checked.
 */
async function encodeTexturePage(request = {}) {
  const width = Number(request.width) | 0;
  const height = Number(request.height) | 0;
  if (width < 1 || height < 1) {
    return { ok: false, error: `Invalid texture dimensions ${width}x${height}.` };
  }
  const wantPng = !!request.formats?.png;
  const wantWebp = !!request.formats?.webp;
  if (!wantPng && !wantWebp) {
    return { ok: false, error: 'Request at least one PNG or WebP texture output.' };
  }

  let expected;
  try {
    expected = toRgbaBuffer(request.rgba, width * height * 4);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const quality = animQualityLevel(request.quality);
  const pma = !!request.pma;
  const out = { ok: true, quality, pma };

  if (wantPng) {
    let bytes;
    try {
      // Sharp's PNG is lossless and fast; pngenc is the no-native-module
      // fallback and is lossless too, just slower on large pages.
      const sharp = loadSharp('PNG texture encoding');
      bytes = await sharp(expected, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
    } catch {
      try {
        bytes = encodePNG(expected, width, height);
      } catch (error) {
        return { ok: false, error: `Could not encode the PNG texture: ${error.message}` };
      }
    }
    out.png = { bytes, quality: await verifyEncodedPage(bytes, expected, width, height, pma) };
  }

  if (wantWebp) {
    let sharp;
    try {
      sharp = loadSharp('WebP texture encoding');
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const { settings, forcedLossless } = webpSettingsFor(quality, pma);
    let bytes;
    try {
      bytes = await sharp(expected, { raw: { width, height, channels: 4 } })
        .webp(settings)
        .toBuffer();
    } catch (error) {
      return { ok: false, error: `Could not encode the WebP texture: ${error.message}` };
    }
    const measured = await verifyEncodedPage(bytes, expected, width, height, pma);
    // Never ship a premultiplied page whose transparent areas the encoder
    // rewrote: that is exactly the defect this path exists to prevent, and a
    // future libwebp change must fail loudly rather than regress in silence.
    if (pma && measured.verified && !measured.renderedLossless) {
      return {
        ok: false,
        error:
          `The WebP encoder rewrote colour underneath transparent pixels (deviation ` +
          `${measured.maxRendered}). On a premultiplied page the runtime adds that straight to the ` +
          `screen as a box around every symbol, so the texture was not written. Export PNG instead.`,
      };
    }
    out.webp = { bytes, quality: measured, forcedLossless };
  }

  return out;
}

module.exports = {
  ANIM_TEXTURE_QUALITY,
  animQualityLevel,
  qualityLevels,
  measureTextureDeviation,
  decodeTextureBytes,
  encodeTexturePage,
  loadSharp,
};
