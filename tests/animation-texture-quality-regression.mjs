// The animation exporter's texture codec.
//
// These tests exist because the exporter used to route every page through a 2D
// canvas and label the result "lossless". Chromium's canvas backing store is
// premultiplied 8-bit, so that round trip quantized RGB by alpha/255 and quietly
// destroyed soft falloff and additive glow. Nothing here may claim losslessness
// without measuring it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacyWildFixture = join(root, 'sample_atlas', 'wild.webp');
const legacyWildTest = (name, fn) =>
  test(name, { skip: existsSync(legacyWildFixture) ? false : 'legacy wild fixture is not present' }, fn);
const require = createRequire(import.meta.url);
const {
  ANIM_TEXTURE_QUALITY,
  animQualityLevel,
  qualityLevels,
  measureTextureDeviation,
  decodeTextureBytes,
  encodeTexturePage,
} = require(join(root, 'spine', 'texture.js'));

/**
 * A page with the characteristics that broke before: colour held under every
 * alpha, including additive values where RGB exceeds alpha (pma glow).
 */
function glowPage(width = 256, height = 24) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = 220;
      rgba[i + 1] = 40 + (y * 3) % 200;
      rgba[i + 2] = 90;
      rgba[i + 3] = x; // every alpha 0..255
    }
  }
  return { rgba, width, height };
}

test('high quality is lossless on every rendered pixel, for PNG and WebP alike', async () => {
  const page = glowPage();
  const res = await encodeTexturePage({
    ...page,
    formats: { png: true, webp: true },
    quality: 'high',
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.quality, 'high');

  // PNG has no lossy mode: it must be bit-exact, not merely rendered-exact.
  assert.equal(res.png.quality.verified, true);
  assert.equal(res.png.quality.lossless, true, 'PNG must be bit-exact');
  assert.equal(res.png.quality.max, 0);

  // Lossless WebP may canonicalize RGB beneath a zero alpha, which never
  // reaches the screen, so the contract is rendered-losslessness.
  assert.equal(res.webp.quality.verified, true);
  assert.equal(res.webp.quality.renderedLossless, true, 'WebP must be rendered-exact');
  assert.equal(res.webp.quality.maxOpaque, 0);
});

test('the exact decoder preserves colour under a low alpha', async () => {
  const page = glowPage(256, 4);
  const encoded = await encodeTexturePage({
    ...page,
    formats: { png: true },
    quality: 'high',
  });
  assert.equal(encoded.ok, true, encoded.error);

  const decoded = await decodeTextureBytes(encoded.png.bytes);
  assert.equal(decoded.ok, true, decoded.error);
  assert.equal(decoded.width, page.width);
  assert.equal(decoded.height, page.height);

  // A canvas round trip returns roughly `round(round(rgb*a/255)*255/a)` here,
  // which is visibly wrong at a low alpha. The exact decoder returns the bytes.
  assert.deepEqual(
    Buffer.from(decoded.rgba),
    page.rgba,
    'decoding must return the stored bytes, not a premultiplied approximation'
  );
});

test('a lossy level is never reported as lossless, and PNG stays lossless at every level', async () => {
  const page = glowPage();
  const results = {};
  for (const level of ['high', 'medium', 'low']) {
    results[level] = await encodeTexturePage({
      ...page,
      formats: { png: true, webp: true },
      quality: level,
    });
    assert.equal(results[level].ok, true, results[level].error);
    // PNG has no lossy mode, so the level must not weaken it.
    assert.equal(results[level].png.quality.lossless, true, `${level} PNG must stay lossless`);
  }

  assert.equal(results.high.webp.quality.renderedLossless, true);
  for (const level of ['medium', 'low']) {
    assert.equal(
      results[level].webp.quality.renderedLossless,
      false,
      `${level} is lossy and must not claim losslessness`
    );
    assert.ok(
      results[level].webp.quality.maxOpaque > 0,
      `${level} must report its measured deviation on visible pixels`
    );
  }
});

test('an unknown or missing quality level falls back to lossless, never to lossy', async () => {
  assert.equal(animQualityLevel(undefined), 'high');
  assert.equal(animQualityLevel(null), 'high');
  assert.equal(animQualityLevel('ultra'), 'high');
  assert.equal(animQualityLevel('LOW'), 'high');
  assert.equal(animQualityLevel('low'), 'low');
  assert.equal(ANIM_TEXTURE_QUALITY.high.webp.lossless, true);

  const page = glowPage(64, 4);
  const res = await encodeTexturePage({ ...page, formats: { webp: true }, quality: 'nonsense' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.quality, 'high');
  assert.equal(res.webp.quality.renderedLossless, true);
});

test('the level list the UI renders matches the encoder settings', () => {
  const levels = qualityLevels();
  assert.deepEqual(
    levels.map((l) => l.id),
    ['high', 'medium', 'low']
  );
  assert.equal(levels[0].webpLossless, true);
  assert.equal(levels[0].webpQuality, null);
  for (const level of levels.slice(1)) {
    assert.equal(level.webpLossless, false);
    assert.ok(level.webpQuality > 0 && level.webpQuality <= 100);
  }
});

test('malformed encode requests are refused instead of writing a broken page', async () => {
  const page = glowPage(8, 8);
  const cases = [
    [{ ...page, width: 0, formats: { png: true } }, /invalid texture dimensions/i],
    [{ ...page, formats: {} }, /at least one PNG or WebP/i],
    [{ ...page, rgba: null, formats: { png: true } }, /no raw RGBA pixel buffer/i],
    [
      { ...page, rgba: Buffer.alloc(16), formats: { png: true } },
      /RGBA size mismatch/i,
    ],
  ];
  for (const [request, expected] of cases) {
    const res = await encodeTexturePage(request);
    assert.equal(res.ok, false, `expected a refusal for ${expected}`);
    assert.match(res.error, expected);
  }
});

test('deviation measurement separates rendered error from invisible error', () => {
  const expected = Buffer.from([10, 20, 30, 0, 200, 100, 50, 255]);
  // Pixel 1 is fully transparent and its RGB was canonicalized to zero; pixel 2
  // renders and is untouched.
  const actual = Buffer.from([0, 0, 0, 0, 200, 100, 50, 255]);
  const m = measureTextureDeviation(expected, actual);
  assert.equal(m.lossless, false, 'bytes differ, so it is not bit-lossless');
  assert.equal(m.renderedLossless, true, 'no rendered pixel changed');
  assert.equal(m.maxOpaque, 0);
  assert.equal(m.max, 30);

  // A change to a visible pixel must not be forgiven.
  const visibleChange = Buffer.from([10, 20, 30, 0, 200, 108, 50, 255]);
  const worse = measureTextureDeviation(expected, visibleChange);
  assert.equal(worse.renderedLossless, false);
  assert.equal(worse.maxOpaque, 8);

  assert.equal(measureTextureDeviation(expected, Buffer.alloc(4)), null);
});

test('on a premultiplied page, colour under a zero alpha is never forgiven', () => {
  // The exact case that let a broken WebP pass verification: RGB beneath a
  // fully transparent pixel was rewritten. Invisible under straight alpha,
  // added straight to the screen under premultiplied alpha.
  const expected = Buffer.from([0, 0, 0, 0, 200, 100, 50, 255]);
  const rewritten = Buffer.from([255, 0, 0, 0, 200, 100, 50, 255]);

  const straight = measureTextureDeviation(expected, rewritten, { pma: false });
  assert.equal(straight.renderedLossless, true, 'straight alpha multiplies it away');

  const premultiplied = measureTextureDeviation(expected, rewritten, { pma: true });
  assert.equal(premultiplied.renderedLossless, false, 'pma adds it to the screen');
  assert.equal(premultiplied.maxRendered, 255);
  assert.equal(premultiplied.pma, true);
});

test('a premultiplied page gets a WebP whose transparent areas were not rewritten', async () => {
  // Large enough that libwebp's transparent-area optimisation has something to
  // gain; a tiny image would not exercise it.
  const width = 256;
  const height = 128;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x > 60 && x < 196 && y > 30 && y < 98;
      const a = inside ? 255 : 0;
      // Premultiplied: rgb <= alpha, and exactly zero where alpha is zero.
      rgba[i] = inside ? 200 : 0;
      rgba[i + 1] = inside ? 90 : 0;
      rgba[i + 2] = inside ? 40 : 0;
      rgba[i + 3] = a;
    }
  }

  for (const quality of ['high', 'medium', 'low']) {
    const res = await encodeTexturePage({
      width,
      height,
      rgba,
      formats: { webp: true },
      quality,
      pma: true,
    });
    assert.equal(res.ok, true, `${quality}: ${res.error}`);
    assert.equal(
      res.webp.quality.renderedLossless,
      true,
      `${quality} must not rewrite colour under transparent pixels on a pma page`
    );

    // Decode and check the transparent field is still black, which is what
    // keeps the symbol quad invisible under `dst = src.rgb + dst.rgb*(1-a)`.
    const back = await decodeTextureBytes(res.webp.bytes);
    assert.equal(back.ok, true, back.error);
    let additiveLift = 0;
    for (let i = 0; i < back.rgba.length; i += 4) {
      if (rgba[i + 3] !== 0) continue;
      additiveLift = Math.max(additiveLift, back.rgba[i], back.rgba[i + 1], back.rgba[i + 2]);
    }
    assert.equal(additiveLift, 0, `${quality} left ${additiveLift} of additive light in the quad`);

    // Medium and low cannot be honoured for WebP here, and must say so.
    assert.equal(res.webp.forcedLossless, quality !== 'high');
  }
});

legacyWildTest('the verifier rejects the encoder settings that shipped the broken texture', async () => {
  // Reproduces the defect directly: lossless WebP above effort 0 lets libwebp
  // rewrite RGB under transparent pixels. The old verification forgave that
  // unconditionally and certified the file; it must not any more.
  //
  // This uses the real page on purpose. libwebp only rewrites a transparent
  // area when doing so helps it compress, so a simple synthetic image does not
  // trigger the bug and would make this test pass for the wrong reason.
  const sharp = require('sharp');
  const decoded = await decodeTextureBytes(readFileSync(join(root, 'sample_atlas', 'wild.webp')));
  assert.equal(decoded.ok, true, decoded.error);

  const rgba = Buffer.from(decoded.rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    for (let c = 0; c < 3; c++) if (rgba[i + c] > a) rgba[i + c] = a;
  }

  const unsafe = await sharp(rgba, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
  })
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
  const back = await sharp(unsafe).ensureAlpha().raw().toBuffer();

  const asPma = measureTextureDeviation(rgba, back, { pma: true });
  const asStraight = measureTextureDeviation(rgba, back, { pma: false });

  // Visible pixels were always fine, which is exactly why this went unnoticed.
  assert.equal(asPma.maxOpaque, 0, 'the defect never touched solidly visible pixels');
  assert.equal(asStraight.renderedLossless, true, 'harmless on a straight-alpha page');
  assert.equal(asPma.renderedLossless, false, 'must be rejected on a premultiplied page');
  assert.ok(asPma.maxRendered > 0, 'the rewritten transparent colour must be measured');

  // And the shipped encoder path must not produce that file in the first place.
  const safe = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba,
    formats: { webp: true },
    quality: 'high',
    pma: true,
  });
  assert.equal(safe.ok, true, safe.error);
  assert.equal(safe.webp.quality.renderedLossless, true);
  assert.notEqual(
    safe.webp.bytes.length,
    unsafe.length,
    'the safe path must not be using the settings that caused the defect'
  );
});

legacyWildTest('a straight-alpha page still gets the smaller lossy WebP it asked for', async () => {
  const source = readFileSync(join(root, 'sample_atlas', 'wild.webp'));
  const decoded = await decodeTextureBytes(source);
  assert.equal(decoded.ok, true, decoded.error);

  const lossless = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    formats: { webp: true },
    quality: 'high',
    pma: false,
  });
  const lossy = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    formats: { webp: true },
    quality: 'low',
    pma: false,
  });
  assert.equal(lossless.ok, true, lossless.error);
  assert.equal(lossy.ok, true, lossy.error);
  assert.equal(lossy.webp.forcedLossless, false, 'straight alpha has no reason to force lossless');
  assert.ok(
    lossy.webp.bytes.length < lossless.webp.bytes.length,
    'the level must still buy size on a straight-alpha page'
  );
});

legacyWildTest('the real sample page, cleaned and premultiplied, exports a WebP with no additive residue', async () => {
  const source = readFileSync(join(root, 'sample_atlas', 'wild.webp'));
  const decoded = await decodeTextureBytes(source);
  assert.equal(decoded.ok, true, decoded.error);

  // Apply the same premultiplied cleanup the conversion does per region.
  const rgba = Buffer.from(decoded.rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    for (let c = 0; c < 3; c++) if (rgba[i + c] > a) rgba[i + c] = a;
  }

  const res = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba,
    formats: { webp: true },
    quality: 'high',
    pma: true,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.webp.quality.renderedLossless, true);

  const back = await decodeTextureBytes(res.webp.bytes);
  assert.equal(back.ok, true, back.error);
  let worst = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 0) continue;
    worst = Math.max(worst, back.rgba[i], back.rgba[i + 1], back.rgba[i + 2]);
  }
  assert.equal(worst, 0, `exported WebP still adds ${worst}/255 of light across every symbol quad`);
});

legacyWildTest('the real sample page survives a full high-quality round trip exactly', async () => {
  const source = readFileSync(join(root, 'sample_atlas', 'wild.webp'));
  const decoded = await decodeTextureBytes(source);
  assert.equal(decoded.ok, true, decoded.error);

  const res = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    formats: { png: true, webp: true },
    quality: 'high',
  });
  assert.equal(res.ok, true, res.error);

  // This page is pma:true — exactly the artwork the canvas path degraded.
  assert.equal(res.png.quality.lossless, true);
  assert.equal(res.webp.quality.renderedLossless, true);

  const reread = await decodeTextureBytes(res.png.bytes);
  assert.equal(reread.ok, true, reread.error);
  assert.deepEqual(Buffer.from(reread.rgba), Buffer.from(decoded.rgba));

  // On real artwork the lossy levels have to actually buy something, otherwise
  // the control is only a way to make the export worse.
  const smaller = await encodeTexturePage({
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    formats: { webp: true },
    quality: 'medium',
  });
  assert.equal(smaller.ok, true, smaller.error);
  assert.ok(
    smaller.webp.bytes.length < res.webp.bytes.length,
    `medium (${smaller.webp.bytes.length}) should be smaller than high (${res.webp.bytes.length})`
  );
});
