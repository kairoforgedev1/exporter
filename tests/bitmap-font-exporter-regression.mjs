import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  analyzeGlyphMappings,
  buildGlyphMetric,
  buildOutputNames,
  createBitmapFontMetadata,
  createGlyphRecord,
  createVirtualSpaceGlyph,
  detectCharacterFromFilename,
  generateAssetsTsSnippet,
  generateFontIndexTS,
  isBMFontCharacterCodePoint,
  isUnicodeScalar,
  layoutBitmapText,
  parseCharacterMapping,
  parseBMFontJSON,
  parseBMFontXML,
  safeAssetKey,
  safeFileBase,
  safeFolderName,
  serializeBMFontJSON,
  serializeBMFontXML,
  verifyBitmapFontBuild,
  verifyFontMetadata,
} from '../renderer/js/font/fontCore.js';
import {
  buildFontAtlas,
  DEFAULT_FONT_ATLAS_SETTINGS,
} from '../renderer/js/font/fontAtlas.js';
import {
  extractFontGlyphs,
  initializeImportedGlyphAdjustments,
} from '../renderer/js/font/fontImport.js';
import { renderBitmapFontPreview } from '../renderer/js/font/fontPreview.js';
import { pack } from '../renderer/js/packer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleFontFixture = join(root, 'sample_font', 'mm_gold.xml');
const sampleFontTest = (name, fn) =>
  test(name, { skip: existsSync(sampleFontFixture) ? false : 'sample_font reference is not present' }, fn);
const require = createRequire(import.meta.url);
const fontWorkspace = require('../font/workspace.js');
const { encodePNG } = require('../pngenc.js');

// A deliberately small Canvas 2D implementation keeps these regressions pure
// Node while exercising the real computeTrim/buildAtlas code. Rotation throws:
// the bitmap-font layer must never ask its reused atlas compositor to rotate.
class FakeCanvas {
  constructor(width = 1, height = 1) {
    this._width = 1;
    this._height = 1;
    this._context = new FakeContext(this);
    this.width = width;
    this.height = height;
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = Math.max(1, Number(value) | 0);
    this._allocate();
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = Math.max(1, Number(value) | 0);
    this._allocate();
  }

  _allocate() {
    if (this._width && this._height) this.data = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext(type) {
    assert.equal(type, '2d');
    return this._context;
  }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.imageSmoothingEnabled = false;
    this.imageSmoothingQuality = 'low';
    this._state = { sx: 1, sy: 1, tx: 0, ty: 0 };
    this._stack = [];
  }

  save() {
    this._stack.push({ ...this._state });
  }

  restore() {
    this._state = this._stack.pop() ?? { sx: 1, sy: 1, tx: 0, ty: 0 };
  }

  translate(x, y) {
    this._state.tx += Number(x) * this._state.sx;
    this._state.ty += Number(y) * this._state.sy;
  }

  rotate(radians) {
    if (Number(radians) !== 0) throw new Error('Bitmap-font packing attempted texture rotation.');
  }

  setTransform(a, b, c, d, e, f) {
    assert.equal(Number(b), 0);
    assert.equal(Number(c), 0);
    this._state = { sx: Number(a), sy: Number(d), tx: Number(e), ty: Number(f) };
  }

  clearRect(x, y, width, height) {
    this._paintRect(x, y, width, height, [0, 0, 0, 0]);
  }

  fillRect() {}
  strokeRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}

  _paintRect(x, y, width, height, rgba) {
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.ceil(x + width);
    const bottom = Math.ceil(y + height);
    for (let py = top; py < bottom; py++) {
      for (let px = left; px < right; px++) {
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) continue;
        this.canvas.data.set(rgba, (py * this.canvas.width + px) * 4);
      }
    }
  }

  getImageData(x, y, width, height) {
    const w = Math.max(0, Number(width) | 0);
    const h = Math.max(0, Number(height) | 0);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const sourceX = (Number(x) | 0) + px;
        const sourceY = (Number(y) | 0) + py;
        if (
          sourceX < 0 ||
          sourceY < 0 ||
          sourceX >= this.canvas.width ||
          sourceY >= this.canvas.height
        ) {
          continue;
        }
        const sourceOffset = (sourceY * this.canvas.width + sourceX) * 4;
        data.set(this.canvas.data.subarray(sourceOffset, sourceOffset + 4), (py * w + px) * 4);
      }
    }
    return { data, width: w, height: h };
  }

  drawImage(source, ...args) {
    let sx = 0;
    let sy = 0;
    let sw = source.width;
    let sh = source.height;
    let dx;
    let dy;
    let dw;
    let dh;
    if (args.length === 2) {
      [dx, dy] = args;
      dw = sw;
      dh = sh;
    } else {
      assert.equal(args.length, 8);
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    }
    const transformedX = dx * this._state.sx + this._state.tx;
    const transformedY = dy * this._state.sy + this._state.ty;
    const transformedW = dw * this._state.sx;
    const transformedH = dh * this._state.sy;
    const outputW = Math.max(0, Math.round(Math.abs(transformedW)));
    const outputH = Math.max(0, Math.round(Math.abs(transformedH)));
    const left = Math.round(transformedX);
    const top = Math.round(transformedY);
    for (let py = 0; py < outputH; py++) {
      for (let px = 0; px < outputW; px++) {
        const sourceX = Math.floor(Number(sx) + (px / Math.max(1, outputW)) * Number(sw));
        const sourceY = Math.floor(Number(sy) + (py / Math.max(1, outputH)) * Number(sh));
        const destX = left + px;
        const destY = top + py;
        if (
          sourceX < 0 ||
          sourceY < 0 ||
          sourceX >= source.width ||
          sourceY >= source.height ||
          destX < 0 ||
          destY < 0 ||
          destX >= this.canvas.width ||
          destY >= this.canvas.height
        ) {
          continue;
        }
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const destOffset = (destY * this.canvas.width + destX) * 4;
        this.canvas.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), destOffset);
      }
    }
  }
}

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return new FakeCanvas();
  },
};

function paintedCanvas(width, height, rect = { x: 0, y: 0, w: width, h: height }, color = [255, 200, 0, 255]) {
  const canvas = new FakeCanvas(width, height);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      canvas.data.set(color, (y * width + x) * 4);
    }
  }
  return canvas;
}

function metric(character, x, overrides = {}) {
  return {
    id: character.codePointAt(0),
    character,
    x,
    y: 0,
    width: 2,
    height: character === ' ' ? 1 : 4,
    xoffset: 0,
    yoffset: 0,
    xadvance: character === ' ' ? 3 : 5,
    yadvance: 0,
    page: 0,
    chnl: 15,
    ...overrides,
  };
}

test('filename mapping covers literals, aliases, named letters and Unicode conventions', () => {
  const cases = new Map([
    ['A.png', 'A'],
    ['0.png', '0'],
    ['question-mark.png', '?'],
    ['space.PNG', ' '],
    ['uppercase_a.png', 'A'],
    ['lowercase-Z.png', 'z'],
    ['digit_seven.png', '7'],
    ['U+1F600.png', '😀'],
    ['U_20AC.png', '€'],
    ['uni00A5.png', '¥'],
    ['unicode_1F4B0.png', '💰'],
    ['0x41.png', 'A'],
    ['65.png', 'A'],
    ['decimal_128512.png', '😀'],
    ['8364.png', '€'],
    ['?.png', '?'],
    ['#.png', '#'],
  ]);
  for (const [filename, expected] of cases) {
    const result = detectCharacterFromFilename(filename);
    assert.equal(result.status, 'mapped', filename);
    assert.equal(result.character, expected, filename);
    assert.equal(result.codePoint, expected.codePointAt(0), filename);
  }
  assert.equal(detectCharacterFromFilename('U+110000.png').status, 'invalid');
  assert.equal(detectCharacterFromFilename('U+D800.png').status, 'invalid');
  assert.equal(detectCharacterFromFilename('not-a-character.png').status, 'unmapped');
});

test('Unicode scalar validation rejects surrogates and accepts astral characters', () => {
  assert.equal(isUnicodeScalar(0), true);
  assert.equal(isUnicodeScalar(0xd7ff), true);
  assert.equal(isUnicodeScalar(0xd800), false);
  assert.equal(isUnicodeScalar(0xdfff), false);
  assert.equal(isUnicodeScalar(0xe000), true);
  assert.equal(isUnicodeScalar(0x10ffff), true);
  assert.equal(isUnicodeScalar(0x110000), false);
  assert.equal(isUnicodeScalar(1.5), false);
  assert.equal(isBMFontCharacterCodePoint(0), false);
  assert.equal(isBMFontCharacterCodePoint(0x1f600), true);
  assert.equal(isBMFontCharacterCodePoint(0xfffe), false);
  assert.equal(isBMFontCharacterCodePoint(0xffff), false);
  assert.equal(detectCharacterFromFilename('10.png').status, 'invalid');
  assert.equal(parseCharacterMapping(0).status, 'invalid');
  assert.equal(parseCharacterMapping('\t').status, 'invalid');
  assert.throws(
    () =>
      createBitmapFontMetadata({
        atlasWidth: 4,
        atlasHeight: 4,
        chars: [metric(' ', 0), metric('\u0001', 1)],
      }),
    /XML BMFont-safe/
  );
});

test('mapping analysis retains unmapped/invalid images, duplicates and expected misses', () => {
  const glyphs = [
    createGlyphRecord({ id: 'a1', sourceFilename: 'A.png', sourceWidth: 2, sourceHeight: 2 }),
    createGlyphRecord({ id: 'a2', sourceFilename: '65.png', sourceWidth: 2, sourceHeight: 2 }),
    createGlyphRecord({ id: 'unknown', sourceFilename: 'mystery-name.png', sourceWidth: 2, sourceHeight: 2 }),
    createGlyphRecord({ id: 'invalid', sourceFilename: 'bad.png', character: 'AB', sourceWidth: 2, sourceHeight: 2 }),
    createVirtualSpaceGlyph({ spaceWidth: 6, letterSpacing: 1 }),
  ];
  const analysis = analyzeGlyphMappings(glyphs, { expectedCharacters: 'ABC ' });
  assert.equal(analysis.canExport, false);
  assert.equal(analysis.duplicates.length, 1);
  assert.equal(analysis.duplicates[0].character, 'A');
  assert.equal(analysis.unmapped.length, 1);
  assert.equal(analysis.invalid.length, 1);
  assert.deepEqual(
    analysis.missing.map((entry) => entry.character),
    ['B', 'C']
  );
  assert.equal(glyphs[4].source, null);
  assert.equal(glyphs[4].virtual, true);
  assert.equal(glyphs[4].advanceAdjust, 4);
});

sampleFontTest('the supplied XML/JSON quirks are diagnosed and malformed ?.png is repaired to ID 63', () => {
  const xmlText = readFileSync(join(root, 'sample_font', 'mm_gold.xml'), 'utf8');
  const jsonText = readFileSync(join(root, 'sample_font', 'mm_gold.json'), 'utf8');
  const xml = parseBMFontXML(xmlText);
  const json = parseBMFontJSON(jsonText);

  assert.equal(xml.chars.length, 58);
  assert.equal(json.chars.length, 58);
  assert.equal(xml.chars.find((char) => char.character === '?').id, 63);
  assert.equal(json.chars.find((char) => char.character === '?').id, 63);
  assert.ok(xml.warnings.some((entry) => entry.code === 'repaired-filename-id'));
  assert.ok(xml.warnings.some((entry) => entry.code === 'fractional-metric'));
  assert.ok(xml.warnings.some((entry) => entry.code === 'missing-char-count'));
  assert.ok(json.warnings.some((entry) => entry.code === 'missing-page-file'));
  assert.ok(json.warnings.some((entry) => entry.code === 'char-count-mismatch'));
  assert.equal(json.declaredCharCount, 57);
  assert.equal(json.pages[0].file, '');
});

test('parsers retain invalid entries instead of silently dropping them', () => {
  const parsed = parseBMFontXML(`<?xml version="1.0"?>
<font>
  <info face="Broken" size="12"/>
  <common lineHeight="12" base="12" scaleW="8" scaleH="8" pages="1"/>
  <pages><page id="0" file="broken.webp"/></pages>
  <chars count="1"><char id="not-an-id" x="0" y="0" width="1" height="1" xoffset="0" yoffset="0" xadvance="1"/></chars>
</font>`);
  assert.equal(parsed.chars.length, 1);
  assert.equal(parsed.invalidChars.length, 1);
  assert.equal(parsed.chars[0].rawId, 'not-an-id');
  assert.ok(parsed.warnings.some((entry) => entry.code === 'invalid-character-id'));
});

test('XML and legacy JSON serialization are coherent, integer-only and astral-safe', () => {
  const metadata = createBitmapFontMetadata({
    fontName: `Rock & "Gold"`,
    fontSize: 18,
    lineHeight: 20,
    baseline: 16,
    atlasWidth: 64,
    atlasHeight: 32,
    textureFile: 'rock_gold.webp',
    chars: [
      metric(' ', 0),
      metric('<', 4, { xoffset: -1 }),
      metric('😀', 8, { width: 6, xadvance: 7 }),
    ],
  });
  const xmlText = serializeBMFontXML(metadata);
  const jsonText = serializeBMFontJSON(metadata);
  assert.match(xmlText, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<font>\n/);
  assert.match(xmlText, /face="Rock &amp; &quot;Gold&quot;"/);
  assert.match(xmlText, /id="128512" letter="😀"/);
  assert.match(xmlText, /id="60" letter="&lt;"/);
  assert.match(xmlText, /<common lineHeight="20" base="20".* pages="1"/);
  assert.match(xmlText, /<chars count="3">/);
  assert.doesNotMatch(xmlText, /\b(?:x|y|width|height|xoffset|yoffset|xadvance)="[^"]*\.[^"]*"/);

  const xml = parseBMFontXML(xmlText);
  const json = parseBMFontJSON(jsonText);
  assert.equal(xml.info.face, `Rock & "Gold"`);
  assert.equal(xml.chars.find((char) => char.id === 128512).character, '😀');
  assert.equal(xml.declaredCharCount, 3);
  assert.equal(json.declaredCharCount, 3);
  assert.equal(xml.common.pages, 1);
  assert.equal(json.common.pages, 1);
  assert.equal(xml.pages[0].file, 'rock_gold.webp');
  assert.equal(json.pages[0].file, 'rock_gold.webp');
  assert.deepEqual(
    xml.chars.map((char) => char.id),
    json.chars.map((char) => char.id)
  );
  for (const char of [...xml.chars, ...json.chars]) {
    for (const field of ['x', 'y', 'width', 'height', 'xoffset', 'yoffset', 'xadvance']) {
      assert.equal(Number.isInteger(char[field]), true, `${char.id}.${field}`);
    }
  }
});

sampleFontTest('serializing the supplied reference corrects count, page and fractional runtime values', () => {
  const original = parseBMFontXML(
    readFileSync(join(root, 'sample_font', 'mm_gold.xml'), 'utf8')
  );
  const correctedXml = serializeBMFontXML(original, { textureFile: 'mm_gold.webp' });
  const correctedJson = serializeBMFontJSON(original, { textureFile: 'mm_gold.webp' });
  const xml = parseBMFontXML(correctedXml);
  const json = parseBMFontJSON(correctedJson);
  assert.equal(xml.declaredCharCount, 58);
  assert.equal(json.declaredCharCount, 58);
  assert.equal(xml.pages[0].file, 'mm_gold.webp');
  assert.equal(json.pages[0].file, 'mm_gold.webp');
  assert.equal(xml.chars.find((char) => char.id === 32).width, 39);
  assert.equal(xml.chars.find((char) => char.id === 32).xadvance, 39);
  assert.equal(xml.chars.find((char) => char.id === 63).character, '?');
  assert.equal(xml.warnings.length, 0);
  assert.equal(json.warnings.length, 0);
});

test('glyph metric formula preserves trim placement and variable source widths', () => {
  const glyph = createGlyphRecord({
    sourceFilename: 'W.png',
    sourceWidth: 11,
    sourceHeight: 9,
    xAdjust: -2,
    yAdjust: 3,
    advanceAdjust: 4,
  });
  const output = buildGlyphMetric({
    glyph,
    trim: { x: 2, y: 1, w: 8, h: 7 },
    placement: { x: 20, y: 30 },
    artworkBaseline: 8,
    letterSpacing: 1,
  });
  assert.deepEqual(
    {
      x: output.x,
      y: output.y,
      width: output.width,
      height: output.height,
      xoffset: output.xoffset,
      yoffset: output.yoffset,
      xadvance: output.xadvance,
    },
    { x: 20, y: 30, width: 8, height: 7, xoffset: 0, yoffset: 3, xadvance: 16 }
  );
});

test('compatible layout uses Pixi baseline offset, kerning, Unicode scalars and missing tracking', () => {
  const metadata = createBitmapFontMetadata({
    fontName: 'Layout',
    fontSize: 10,
    lineHeight: 12,
    atlasWidth: 64,
    atlasHeight: 16,
    textureFile: 'layout.webp',
    chars: [
      metric(' ', 0),
      metric('A', 4, { xoffset: 1, yoffset: 2, xadvance: 6 }),
      metric('V', 8),
      metric('😀', 12, { width: 6, xadvance: 8 }),
    ],
    kernings: [{ first: 65, second: 86, amount: -1 }],
  });
  const layout = layoutBitmapText(metadata, 'AV? 😀\nA');
  assert.equal(layout.glyphs[0].character, 'A');
  assert.equal(layout.glyphs[0].x, 1);
  assert.equal(layout.glyphs[1].character, 'V');
  assert.equal(layout.glyphs[1].x, 5);
  assert.equal(layout.glyphs.find((run) => run.character === '😀').sourceIndex, 4);
  // Pixi advances a missing '?' using SPACE, then advances the real SPACE.
  assert.equal(layout.width, 24);
  assert.equal(layout.lines.length, 2);
  assert.deepEqual(layout.missingCharacters, ['?']);
  assert.equal(layout.missing[0].sourceIndex, 2);

  const importedOffset = parseBMFontXML(`<?xml version="1.0"?>
<font><info face="Offset" size="10"/><common lineHeight="12" base="10" scaleW="4" scaleH="4" pages="1"/>
<pages><page id="0" file="offset.webp"/></pages>
<chars count="2">
<char id="32" letter="space" x="0" y="0" width="1" height="1" xoffset="0" yoffset="0" xadvance="3"/>
<char id="65" letter="A" x="1" y="0" width="2" height="4" xoffset="0" yoffset="2" xadvance="3"/>
</chars></font>`);
  assert.equal(layoutBitmapText(importedOffset, 'A').glyphs[0].y, 4);
  assert.equal(layoutBitmapText(importedOffset, 'A').baseLineOffset, 2);
});

test('compatible layout matches Pixi 8.8.1 CR/LF and empty-line behavior', () => {
  const metadata = createBitmapFontMetadata({
    fontName: 'Line Breaks',
    fontSize: 10,
    lineHeight: 12,
    atlasWidth: 16,
    atlasHeight: 8,
    textureFile: 'line_breaks.webp',
    chars: [
      metric(' ', 0),
      metric('A', 4, { xadvance: 6 }),
    ],
  });

  const emptyLf = layoutBitmapText(metadata, '\n');
  assert.equal(emptyLf.lines.length, 1);
  assert.equal(emptyLf.height, 12);

  const consecutiveLf = layoutBitmapText(metadata, 'A\n\nA');
  assert.equal(consecutiveLf.lines.length, 2);
  assert.equal(consecutiveLf.height, 24);
  assert.deepEqual(consecutiveLf.glyphs.map((glyph) => glyph.line), [0, 1]);
  assert.deepEqual(consecutiveLf.glyphs.map((glyph) => glyph.y), [0, 12]);

  const standaloneCr = layoutBitmapText(metadata, 'A\rA');
  assert.equal(standaloneCr.lines.length, 2);
  assert.equal(standaloneCr.height, 24);
  assert.deepEqual(standaloneCr.glyphs.map((glyph) => glyph.line), [0, 1]);

  const crlf = layoutBitmapText(metadata, 'A\r\nA');
  assert.equal(crlf.lines.length, 2);
  assert.equal(crlf.height, 24);
  assert.deepEqual(crlf.glyphs.map((glyph) => glyph.line), [0, 1]);
});

test('safe naming and Stake registration helpers cannot emit unsafe paths or keys', () => {
  assert.equal(safeFileBase('../CON.png'), 'bitmap_font');
  assert.equal(safeFileBase('  MM Gold!!  '), 'MM_Gold');
  assert.equal(safeFolderName('../../Gold Font'), 'Gold_Font');
  assert.equal(safeAssetKey('123 gold font'), 'font123GoldFont');
  assert.equal(safeAssetKey('default'), 'defaultFont');
  const names = buildOutputNames({
    fontName: 'MM Gold',
    folderName: '../goldFont',
    runtimeTexture: 'webp',
  });
  assert.equal(names.fileBase, 'MM_Gold');
  assert.equal(names.folderName, 'goldFont');
  assert.equal(names.assetKey, 'goldFont');
  assert.deepEqual(names.files, [
    'MM_Gold.png',
    'MM_Gold.webp',
    'MM_Gold.json',
    'MM_Gold.xml',
    'index.ts',
  ]);
  const indexTs = generateFontIndexTS({
    textureFile: 'mm_gold.webp',
    jsonFile: 'mm_gold.json',
  });
  assert.equal(
    indexTs,
    `import { createAsset } from 'pixi-svelte';\n\n` +
      `import img from './mm_gold.webp';\n` +
      `import font from './mm_gold.json?raw';\n\n` +
      `export default createAsset({ img, font });\n`
  );
  const snippet = generateAssetsTsSnippet({
    assetKey: 'goldFont',
    folderName: 'goldFont',
    xmlFile: 'mm_gold.xml',
  });
  assert.match(snippet, /goldFont: \{/);
  assert.match(snippet, /type: 'font'/);
  assert.match(snippet, /\.\.\/\.\.\/assets\/fonts\/goldFont\/mm_gold\.xml/);
});

test('atlas build is unrotated, trims artwork, extrudes edges and keeps virtual space transparent', () => {
  assert.equal(DEFAULT_FONT_ATLAS_SETTINGS.extrude, 1);
  const glyphs = [
    createGlyphRecord({
      id: 'A',
      sourceFilename: 'A.png',
      source: paintedCanvas(3, 5, { x: 1, y: 1, w: 1, h: 3 }),
    }),
    createGlyphRecord({
      id: 'W',
      sourceFilename: 'W.png',
      source: paintedCanvas(5, 4),
    }),
    createVirtualSpaceGlyph({ id: 'space', spaceWidth: 4, letterSpacing: 1 }),
  ];
  const result = buildFontAtlas({
    glyphs,
    font: {
      fontName: 'Packed',
      fontSize: 6,
      lineHeight: 6,
      baseline: 5,
      letterSpacing: 1,
      kernings: [{ first: 65, second: 87, amount: -2 }],
      textureFile: 'packed.webp',
    },
    settings: { padding: 2, maxWidth: 64, maxHeight: 64, allowRotation: true },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.settings.allowRotation, false);
  assert.equal(result.settings.extrude, 1);
  assert.ok(result.placed.every((entry) => entry.rotated === false));
  assert.equal(result.alpha.hasTransparency, true);
  assert.equal(result.alpha.hasVisiblePixels, true);
  const a = result.chars.find((char) => char.character === 'A');
  const w = result.chars.find((char) => char.character === 'W');
  const space = result.chars.find((char) => char.character === ' ');
  assert.equal(a.width, 1);
  assert.equal(a.height, 3);
  assert.equal(a.xoffset, 1);
  assert.equal(a.yoffset, 1);
  assert.equal(a.xadvance, 4);
  assert.equal(w.width, 5);
  assert.equal(w.xadvance, 6);
  assert.equal(space.width, 1);
  assert.equal(space.height, 1);
  assert.equal(space.xadvance, 4);
  assert.deepEqual(result.metadata.kernings, [{ first: 65, second: 87, amount: -2 }]);
  const spacePlacement = result.placed.find((entry) => entry.glyph.character === ' ');
  const pixel = result.atlasCanvas
    .getContext('2d')
    .getImageData(spacePlacement.x, spacePlacement.y, 1, 1).data;
  assert.equal(pixel[3], 0, 'packed space must remain fully transparent');
});

test('power-of-two and square packing never rounds beyond configured maxima', () => {
  const base = {
    padding: 0,
    border: 0,
    maxWidth: 3000,
    maxHeight: 3000,
    powerOfTwo: true,
    square: false,
    allowRotation: false,
  };
  const fits = pack([{ id: 1, w: 1800, h: 20 }], base);
  assert.equal(fits.ok, true);
  assert.equal(fits.width, 2048);
  assert.ok(fits.width <= base.maxWidth && fits.height <= base.maxHeight);

  const tooWide = pack([{ id: 1, w: 2500, h: 20 }], base);
  assert.equal(tooWide.ok, false);
  assert.ok(tooWide.width <= base.maxWidth && tooWide.height <= base.maxHeight);

  const square = pack(
    [{ id: 1, w: 900, h: 20 }],
    { ...base, maxWidth: 3000, maxHeight: 1800, square: true }
  );
  assert.equal(square.ok, true);
  assert.equal(square.width, square.height);
  assert.ok(square.width <= 1800);
});

test('mapping/image/packing failures block atlas creation instead of exporting partial fonts', () => {
  const duplicate = buildFontAtlas({
    glyphs: [
      createGlyphRecord({ id: 1, sourceFilename: 'A.png', source: paintedCanvas(2, 2) }),
      createGlyphRecord({ id: 2, sourceFilename: '65.png', source: paintedCanvas(2, 2) }),
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.stage, 'mapping');
  assert.equal(duplicate.atlasCanvas, null);

  const tooLarge = buildFontAtlas({
    glyphs: [
      createGlyphRecord({ id: 'X', sourceFilename: 'X.png', source: paintedCanvas(40, 40) }),
    ],
    settings: { maxWidth: 16, maxHeight: 16 },
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.stage, 'packing');
  assert.deepEqual(tooLarge.failedIds, ['X']);
  assert.equal(tooLarge.atlasCanvas, null);
});

test('existing-font extraction preserves effective offsets/advance through repacking', () => {
  const original = buildFontAtlas({
    glyphs: [
      createGlyphRecord({
        id: 'A',
        sourceFilename: 'A.png',
        source: paintedCanvas(3, 5, { x: 1, y: 1, w: 1, h: 3 }),
      }),
      createVirtualSpaceGlyph({ spaceWidth: 4, letterSpacing: 1 }),
    ],
    font: {
      fontName: 'Imported',
      fontSize: 6,
      lineHeight: 6,
      baseline: 5,
      letterSpacing: 1,
      textureFile: 'imported.webp',
    },
    settings: { maxWidth: 64, maxHeight: 64 },
  });
  assert.equal(original.ok, true, original.error);
  const imported = extractFontGlyphs({
    metadata: original.metadata,
    pageCanvases: new Map([['imported.webp', original.atlasCanvas]]),
    baseline: 5,
    letterSpacing: 1,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.glyphs.length, 2);
  assert.equal(imported.glyphs.find((glyph) => glyph.character === ' ').virtual, true);

  const repacked = buildFontAtlas({
    glyphs: imported.glyphs,
    font: { ...imported.font, textureFile: 'imported.webp' },
    settings: { maxWidth: 64, maxHeight: 64 },
  });
  assert.equal(repacked.ok, true, repacked.error);
  for (const character of ['A', ' ']) {
    const before = original.chars.find((entry) => entry.character === character);
    const after = repacked.chars.find((entry) => entry.character === character);
    assert.deepEqual(
      [after.xoffset, after.yoffset, after.xadvance],
      [before.xoffset, before.yoffset, before.xadvance],
      character
    );
  }

  const adjustment = initializeImportedGlyphAdjustments({
    metric: { xoffset: 2, yoffset: 3, xadvance: 9 },
    trim: { x: 1, y: 1 },
    sourceWidth: 5,
    sourceHeight: 6,
    baseline: 8,
    lineHeight: 10,
    commonBase: 8,
    letterSpacing: 1,
  });
  assert.deepEqual(adjustment, {
    xAdjust: 1,
    yAdjust: 2,
    advanceAdjust: 3,
    yAdvance: 0,
    importedBaseLineOffset: 2,
  });

  const visiblePage = paintedCanvas(2, 1);
  const visibleSpaceMetadata = createBitmapFontMetadata({
    fontName: 'Legacy Space',
    fontSize: 5,
    lineHeight: 6,
    atlasWidth: 2,
    atlasHeight: 1,
    textureFile: 'visible.webp',
    chars: [metric(' ', 0, { width: 2, height: 1, xadvance: 7 })],
  });
  const repaired = extractFontGlyphs({
    metadata: visibleSpaceMetadata,
    pageCanvases: new Map([['visible.webp', visiblePage]]),
    baseline: 5,
  });
  assert.equal(repaired.glyphs[0].virtual, true);
  assert.equal(repaired.glyphs[0].source, null);
  assert.ok(repaired.warnings.some((entry) => entry.code === 'repaired-visible-space'));
  assert.equal(
    1 + repaired.glyphs[0].advanceAdjust,
    7,
    'visible legacy space keeps parsed integer advance'
  );
});

test('preview rendering shares exact layout and exposes missing characters', () => {
  const packed = buildFontAtlas({
    glyphs: [
      createGlyphRecord({ sourceFilename: 'A.png', source: paintedCanvas(2, 4) }),
      createVirtualSpaceGlyph({ spaceWidth: 3 }),
    ],
    font: {
      fontName: 'Preview',
      fontSize: 5,
      lineHeight: 6,
      baseline: 5,
      textureFile: 'preview.webp',
    },
    settings: { maxWidth: 32, maxHeight: 32 },
  });
  assert.equal(packed.ok, true, packed.error);
  const preview = renderBitmapFontPreview({
    atlasCanvas: packed.atlasCanvas,
    metadata: packed.metadata,
    text: 'A A?',
    padding: 0,
    showGuides: false,
  });
  assert.deepEqual(preview.missingCharacters, ['?']);
  assert.equal(preview.layout.glyphs.length, 3);
  assert.ok(preview.canvas.width > 0);
  assert.ok(preview.canvas.height > 0);
  assert.ok(preview.canvas.data.some((value, index) => index % 4 === 3 && value > 0));
});

test('metadata/build verification checks space, bounds, pages, registration and transparency', () => {
  const packed = buildFontAtlas({
    glyphs: [
      createGlyphRecord({ sourceFilename: 'A.png', source: paintedCanvas(2, 4) }),
      createVirtualSpaceGlyph({ spaceWidth: 3 }),
    ],
    font: {
      fontName: 'Verify',
      fontSize: 5,
      lineHeight: 6,
      baseline: 5,
      textureFile: 'verify.webp',
    },
    settings: { maxWidth: 32, maxHeight: 32 },
  });
  assert.equal(packed.ok, true, packed.error);
  const xml = serializeBMFontXML(packed.metadata);
  const json = serializeBMFontJSON(packed.metadata);
  const indexTs = generateFontIndexTS({
    textureFile: 'verify.webp',
    jsonFile: 'verify.json',
  });
  const assetsTsSnippet = generateAssetsTsSnippet({
    assetKey: 'verifyFont',
    folderName: 'verifyFont',
    xmlFile: 'verify.xml',
  });
  const result = verifyBitmapFontBuild({
    xml,
    json,
    atlasWidth: packed.width,
    atlasHeight: packed.height,
    textureFile: 'verify.webp',
    jsonFile: 'verify.json',
    xmlFile: 'verify.xml',
    indexTs,
    assetsTsSnippet,
    assetKey: 'verifyFont',
    expectedCharacters: 'AZ',
    sampleText: 'A?',
    texturePixels: {
      data: packed.atlasCanvas.data,
      width: packed.width,
      height: packed.height,
    },
  });
  assert.equal(result.ok, true, result.errors.map((entry) => entry.message).join('; '));
  assert.equal(result.checks.spaceGlyph, true);
  assert.equal(result.checks.jsonMatchesXml, true);
  assert.equal(result.checks.registration, true);
  assert.equal(result.checks.assetsTsRegistration, true);
  assert.equal(result.checks.transparency, true);
  assert.equal(result.checks.spaceTransparency, true);
  assert.equal(result.checks.coloredArtwork, true);
  const tintGuidance = result.warnings.find(
    (entry) => entry.code === 'pixi-bitmap-font-white-tint'
  );
  assert.ok(tintGuidance, 'colored bitmap artwork should include Pixi tint guidance');
  assert.match(tintGuidance.message, /style\.fill/);
  assert.match(tintGuidance.message, /fill: 0xffffff/);
  assert.deepEqual(result.checks.sampleMissing, ['?']);
  assert.ok(result.warnings.some((entry) => entry.code === 'missing-expected-character'));
  assert.ok(result.warnings.some((entry) => entry.code === 'sample-missing-characters'));

  const withoutSpace = createBitmapFontMetadata({
    fontName: 'Broken',
    fontSize: 5,
    lineHeight: 6,
    atlasWidth: 8,
    atlasHeight: 8,
    textureFile: 'broken.webp',
    chars: [metric('A', 7, { width: 2 })],
  });
  const broken = verifyFontMetadata(withoutSpace);
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((entry) => entry.code === 'missing-space-glyph'));
  assert.ok(broken.errors.some((entry) => entry.code === 'glyph-out-of-bounds'));

  const legacyOverload = verifyBitmapFontBuild(packed.metadata, packed.atlasCanvas);
  assert.equal(legacyOverload.ok, true);
  assert.equal(legacyOverload.checks.spaceTransparency, true);
});

function workspaceFixtureXml({ face, page = 'page.png' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<font>
  <info face="${face}" size="2" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="0,0,0,0" spacing="0,0" outline="0"/>
  <common lineHeight="2" base="2" scaleW="2" scaleH="2" pages="1" packed="0" alphaChnl="1" redChnl="0" greenChnl="0" blueChnl="0"/>
  <pages>
    <page id="0" file="${page}"/>
  </pages>
  <chars count="2">
    <char id="32" letter=" " x="0" y="0" width="1" height="1" xoffset="0" yoffset="0" xadvance="1" page="0" chnl="15"/>
    <char id="65" letter="A" x="1" y="0" width="1" height="2" xoffset="0" yoffset="0" xadvance="1" page="0" chnl="15"/>
  </chars>
</font>
`;
}

function writeWorkspaceFont(fontDir, fileBase, face) {
  mkdirSync(fontDir, { recursive: true });
  const pixels = new Uint8Array([
    0, 0, 0, 0, 255, 210, 20, 255,
    0, 0, 0, 0, 180, 80, 255, 255,
  ]);
  writeFileSync(join(fontDir, `${fileBase}.png`), encodePNG(pixels, 2, 2));
  writeFileSync(
    join(fontDir, `${fileBase}.xml`),
    workspaceFixtureXml({ face, page: `${fileBase}.png` }),
    'utf8'
  );
  return join(fontDir, `${fileBase}.xml`);
}

sampleFontTest('native font workspace scans references and registers only verified exact assets', async () => {
  const reference = await fontWorkspace.inspectSourceRoot(join(root, 'sample_font'));
  assert.equal(reference.ok, true);
  assert.equal(reference.mode, 'package');
  assert.equal(reference.selectedMetadata.format, 'xml');
  assert.equal(reference.selectedMetadata.face, 'gold');
  assert.ok(reference.packageFiles.some((entry) => entry.name === 'mm_gold.webp'));
  // The supplied legacy XML contains one unusual nonnumeric ID. The native
  // final-boundary verifier rejects it; the renderer importer repairs it for
  // editing before generating clean metadata.
  assert.ok(reference.selectedMetadata.invalidCharacterIds.includes('?.png'));
  assert.equal(reference.verification.ok, false);

  const tempRoot = mkdtempSync(join(tmpdir(), 'atlas-font-workspace-test-'));
  try {
    const looseDir = join(tempRoot, 'loose');
    mkdirSync(looseDir, { recursive: true });
    copyFileSync(join(root, 'sample_font', 'mm_gold.png'), join(looseDir, 'A.png'));
    copyFileSync(join(root, 'sample_font', 'mm_gold.png'), join(looseDir, 'comma.png'));
    const loose = await fontWorkspace.inspectSourceRoot(looseDir);
    assert.equal(loose.mode, 'glyphs');
    assert.deepEqual(loose.glyphs.map((entry) => entry.name), ['A.png', 'comma.png']);
    assert.ok(loose.glyphs.every((entry) => entry.image?.format === 'png'));

    const appDir = join(tempRoot, 'apps', 'smoke');
    const manifest = join(appDir, 'src', 'game', 'assets.ts');
    const fontsRoot = join(appDir, 'static', 'assets', 'fonts');
    mkdirSync(dirname(manifest), { recursive: true });
    mkdirSync(fontsRoot, { recursive: true });
    writeFileSync(manifest, 'export default {\n};\n', 'utf8');

    const primaryDir = join(fontsRoot, 'smokeFont');
    writeWorkspaceFont(primaryDir, 'smoke_font', 'SmokeFace');
    const inspectedFolder = fontWorkspace.inspectFontFolder(primaryDir);
    assert.equal(inspectedFolder.verification.ok, true);
    assert.equal(inspectedFolder.primaryMetadata.characterCount, 2);
    assert.equal(inspectedFolder.pageFormat, 'png');

    const first = fontWorkspace.registerFontAsset({
      appDir,
      key: 'smokeFont',
      xmlRel: 'fonts/smokeFont/smoke_font.xml',
    });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.added, ['smokeFont']);
    assert.ok(first.backup);
    assert.match(readFileSync(manifest, 'utf8'), /smokeFont:\s*\{/);
    assert.match(readFileSync(manifest, 'utf8'), /type:\s*'font'/);
    assert.match(readFileSync(manifest, 'utf8'), /fonts\/smokeFont\/smoke_font\.xml/);

    const exact = fontWorkspace.registerFontAsset({
      appDir,
      key: 'smokeFont',
      xmlRel: 'fonts/smokeFont/smoke_font.xml',
    });
    assert.equal(exact.ok, true, exact.error);
    assert.deepEqual(exact.added, []);
    assert.equal(exact.alreadyRegistered.length, 1);

    const otherDir = join(fontsRoot, 'otherFont');
    writeWorkspaceFont(otherDir, 'other_font', 'OtherFace');
    const keyCollision = fontWorkspace.registerFontAsset({
      appDir,
      key: 'smokeFont',
      xmlRel: 'fonts/otherFont/other_font.xml',
    });
    assert.equal(keyCollision.ok, false);
    assert.match(keyCollision.error, /key.*already exists/i);

    writeWorkspaceFont(otherDir, 'same_face', 'SmokeFace');
    const faceCollision = fontWorkspace.registerFontAsset({
      appDir,
      key: 'otherFont',
      xmlRel: 'fonts/otherFont/same_face.xml',
    });
    assert.equal(faceCollision.ok, false);
    assert.match(faceCollision.error, /face.*already registered/i);

    const unsafe = fontWorkspace.registerFontAsset({
      appDir,
      key: 'unsafeFont',
      xmlRel: '../outside.xml',
    });
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error, /unsafe|escapes/i);

    const app = fontWorkspace.inspectApp(appDir);
    assert.equal(app.ok, true);
    assert.equal(app.registrationStyle, 'assets.ts');
    assert.equal(app.registeredFonts.length, 1);
    assert.equal(app.registeredFonts[0].face, 'SmokeFace');
    assert.equal(app.registeredFonts[0].verification.ok, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('registering an existing font key updates it instead of refusing it', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'atlas-font-update-test-'));
  try {
    const appDir = join(tempRoot, 'apps', 'game');
    const manifest = join(appDir, 'src', 'game', 'assets.ts');
    const fontsRoot = join(appDir, 'static', 'assets', 'fonts');
    mkdirSync(dirname(manifest), { recursive: true });
    writeWorkspaceFont(join(fontsRoot, 'goldFont'), 'gold_font', 'gold');
    // A hand-written CRLF manifest whose font key does not match its folder.
    const original = [
      'export default {',
      '\tbackground: {',
      "\t\ttype: 'sprites',",
      "\t\tsrc: new URL('../../assets/sprites/bg/bg.json', import.meta.url).href,",
      '\t},',
      '\tmmGold: {',
      "\t\ttype: 'font',",
      "\t\tsrc: new URL('../../assets/fonts/goldFont/gold_font.xml', import.meta.url).href,",
      '\t\tpreload: true,',
      '\t},',
      '};',
      '',
    ].join('\r\n');
    writeFileSync(manifest, original, 'utf8');

    // Overwriting the package in place (here with a renamed face) needs no
    // manifest change, even without replaceExisting.
    writeWorkspaceFont(join(fontsRoot, 'goldFont'), 'gold_font', 'goldNew');
    const inPlace = fontWorkspace.registerFontAsset({
      appDir,
      key: 'mmGold',
      xmlRel: 'fonts/goldFont/gold_font.xml',
    });
    assert.equal(inPlace.ok, true, inPlace.error);
    assert.deepEqual(inPlace.added, []);
    assert.deepEqual(inPlace.updated, []);
    assert.equal(inPlace.alreadyRegistered.length, 1);
    assert.equal(readFileSync(manifest, 'utf8'), original);

    const nonFontKey = fontWorkspace.registerFontAsset({
      appDir,
      key: 'background',
      xmlRel: 'fonts/goldFont/gold_font.xml',
      replaceExisting: true,
    });
    assert.equal(nonFontKey.ok, false);
    assert.match(nonFontKey.error, /not a type: 'font'/);

    const otherKeySamePath = fontWorkspace.registerFontAsset({
      appDir,
      key: 'goldFont',
      xmlRel: 'fonts/goldFont/gold_font.xml',
      replaceExisting: true,
    });
    assert.equal(otherKeySamePath.ok, false);
    assert.match(otherKeySamePath.error, /already registered as mmGold/);

    writeWorkspaceFont(join(fontsRoot, 'goldFontV2'), 'gold_v2', 'goldNew');
    const withoutOptIn = fontWorkspace.registerFontAsset({
      appDir,
      key: 'mmGold',
      xmlRel: 'fonts/goldFontV2/gold_v2.xml',
    });
    assert.equal(withoutOptIn.ok, false);
    assert.match(withoutOptIn.error, /key.*already exists/i);
    assert.equal(readFileSync(manifest, 'utf8'), original);

    // The face is owned by mmGold itself, which is the entry being updated.
    const repointed = fontWorkspace.registerFontAsset({
      appDir,
      key: 'mmGold',
      xmlRel: 'fonts/goldFontV2/gold_v2.xml',
      replaceExisting: true,
    });
    assert.equal(repointed.ok, true, repointed.error);
    assert.deepEqual(repointed.added, []);
    assert.deepEqual(repointed.updated, ['mmGold']);
    assert.equal(repointed.updatedEntries[0].previousXmlRel, 'fonts/goldFont/gold_font.xml');
    assert.equal(repointed.reloadRequired, true);
    assert.ok(repointed.backup);
    assert.equal(readFileSync(repointed.backup, 'utf8'), original);
    const updatedSource = readFileSync(manifest, 'utf8');
    assert.equal(
      updatedSource,
      original.replace('fonts/goldFont/gold_font.xml', 'fonts/goldFontV2/gold_v2.xml')
    );
    assert.equal(updatedSource.match(/\bmmGold\s*:/g).length, 1);

    writeWorkspaceFont(join(fontsRoot, 'otherFont'), 'other_font', 'goldNew');
    const faceOwnedElsewhere = fontWorkspace.registerFontAsset({
      appDir,
      key: 'otherFont',
      xmlRel: 'fonts/otherFont/other_font.xml',
      replaceExisting: true,
    });
    assert.equal(faceOwnedElsewhere.ok, false);
    assert.match(faceOwnedElsewhere.error, /face.*already registered by mmGold/i);

    const app = fontWorkspace.inspectApp(appDir);
    assert.equal(app.registeredFonts.length, 1);
    assert.equal(app.registeredFonts[0].key, 'mmGold');
    assert.equal(app.registeredFonts[0].xmlRel, 'fonts/goldFontV2/gold_v2.xml');
    assert.equal(app.registeredFonts[0].verification.ok, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
