// Bitmap Font Exporter
//
// This is intentionally an independent workflow. It borrows the Atlas
// Editor's proven canvas, trim and MaxRects packing code, but never places
// glyphs in the normal sprite-library state.

import { state as atlasState } from './state.js';
import { pack } from './packer.js';
import { computeTrim, buildAtlas as composeAtlas } from './atlasio.js';
import {
  basename,
  dirname,
  stripExt,
  joinPath,
  formatBytes,
  escapeHtml,
  bytesToCanvas,
} from './util.js';
import * as FontCore from './font/fontCore.js';
import * as FontAtlas from './font/fontAtlas.js';
import * as FontImport from './font/fontImport.js';
import * as FontPreview from './font/fontPreview.js';

const native = window.native;
const $ = (id) => document.getElementById(id);
const STEPS = ['glyphs', 'layout', 'preview', 'export'];
const decoder = new TextDecoder();

const EXPECTED_PRESETS = {
  none: '',
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  numbers: '0123456789.,+-×÷=%$€£¥₹₩₽₺₫฿',
};

const SAMPLE_PRESETS = {
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz',
  numbers: '0123456789  1,234,567.89',
  currency: '$1,250.00  €99.95  £72  ¥5000  ₹250',
  labels: 'BIG WIN\nTOTAL BET 25\nGOOD LUCK',
  long: 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG\nThe quick brown fox jumps over the lazy dog 0123456789',
  mixed: 'A-Z a-z 0-9  ! ? # % & + - × ÷ =\n$ € £ ¥ ₹  ( ) [ ] { }',
};

const CHAR_ALIASES = new Map(Object.entries({
  space: ' ',
  whitespace: ' ',
  comma: ',',
  period: '.',
  dot: '.',
  fullstop: '.',
  question: '?',
  questionmark: '?',
  exclamation: '!',
  exclamationmark: '!',
  bang: '!',
  colon: ':',
  semicolon: ';',
  apostrophe: "'",
  singlequote: "'",
  quote: '"',
  doublequote: '"',
  slash: '/',
  forwardslash: '/',
  backslash: '\\',
  pipe: '|',
  bar: '|',
  plus: '+',
  minus: '-',
  hyphen: '-',
  dash: '-',
  underscore: '_',
  equals: '=',
  equal: '=',
  percent: '%',
  ampersand: '&',
  hash: '#',
  pound: '#',
  at: '@',
  asterisk: '*',
  star: '*',
  multiply: '×',
  times: '×',
  divide: '÷',
  lparen: '(',
  leftparen: '(',
  openparen: '(',
  rparen: ')',
  rightparen: ')',
  closeparen: ')',
  lbracket: '[',
  rbracket: ']',
  lbrace: '{',
  rbrace: '}',
  dollar: '$',
  dollar_sign: '$',
  euro: '€',
  poundsterling: '£',
  sterling: '£',
  yen: '¥',
  yuan: '¥',
  rupee: '₹',
  won: '₩',
  ruble: '₽',
  rouble: '₽',
  cent: '¢',
  copyright: '©',
  registered: '®',
  trademark: '™',
  degree: '°',
}));

let glyphSequence = 0;

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function positiveInt(value, fallback = 1) {
  return Math.max(1, int(value, fallback));
}

function scalarFromCodePoint(codePoint) {
  const n = Number(codePoint);
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return null;
  }
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

function oneScalar(value) {
  const parts = Array.from(String(value ?? ''));
  if (parts.length !== 1 || !scalarFromCodePoint(parts[0].codePointAt(0))) return null;
  const isExportable = FontCore.isBMFontCharacterCodePoint;
  return typeof isExportable !== 'function' || isExportable(parts[0].codePointAt(0))
    ? parts[0]
    : null;
}

function normalizeAlias(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseCharacterInput(value) {
  const coreParser = FontCore.parseCharacterMapping;
  if (typeof coreParser === 'function') {
    try {
      const parsed = coreParser(value);
      const char = parsed?.status === 'mapped' ? oneScalar(parsed.character) : null;
      return {
        char,
        valid: !!char,
        empty: parsed?.status === 'unmapped' && !String(value ?? '').trim(),
        reason: parsed?.reason || null,
      };
    } catch (error) {
      console.warn('Bitmap font character parser fell back:', error);
    }
  }
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  if (raw === ' ' || trimmed.toLowerCase() === 'space') return { char: ' ', valid: true };
  if (!trimmed) return { char: null, valid: false, empty: true };

  const alias = CHAR_ALIASES.get(normalizeAlias(trimmed));
  if (alias) return { char: alias, valid: true };

  let match = trimmed.match(/^(?:u\+|uni(?:code)?[_-]?|u[_-]?)([0-9a-f]{2,6})$/i);
  if (!match) match = trimmed.match(/^0x([0-9a-f]{2,6})$/i);
  if (match) {
    const char = scalarFromCodePoint(Number.parseInt(match[1], 16));
    return { char, valid: !!char };
  }
  match = trimmed.match(/^(?:id|char|codepoint|decimal)[_-]?(\d{2,7})$/i);
  if (!match && /^\d{2,7}$/.test(trimmed)) match = [trimmed, trimmed];
  if (match) {
    const char = scalarFromCodePoint(Number.parseInt(match[1], 10));
    return { char, valid: !!char };
  }

  const char = oneScalar(trimmed);
  return { char, valid: !!char };
}

function localDetectCharacter(filename) {
  const stem = stripExt(basename(filename)).trim();
  if (!stem) return { char: null, confidence: 'none', reason: 'empty filename' };

  // A literal scalar is the least surprising and keeps A/a and numeric glyph
  // artwork distinct.
  const literal = oneScalar(stem);
  if (literal) return { char: literal, confidence: 'exact', reason: 'literal filename' };

  const alias = CHAR_ALIASES.get(normalizeAlias(stem));
  if (alias) return { char: alias, confidence: 'alias', reason: 'known character name' };

  let m = stem.match(/^(?:u\+|uni(?:code)?[_-]?|u[_-]?)([0-9a-f]{2,6})$/i);
  if (!m) m = stem.match(/^0x([0-9a-f]{2,6})$/i);
  if (m) {
    const char = scalarFromCodePoint(Number.parseInt(m[1], 16));
    return { char, confidence: char ? 'unicode' : 'none', reason: 'Unicode filename' };
  }
  m = stem.match(/^(?:id|char|codepoint|decimal)[_-]?(\d{2,7})$/i);
  if (m || /^\d{2,7}$/.test(stem)) {
    const digits = m ? m[1] : stem;
    const char = scalarFromCodePoint(Number.parseInt(digits, 10));
    return { char, confidence: char ? 'unicode' : 'none', reason: 'decimal Unicode filename' };
  }
  m = stem.match(/^(?:capital|uppercase|upper)[_-]?([a-z])$/i);
  if (m) return { char: m[1].toUpperCase(), confidence: 'alias', reason: 'uppercase letter name' };
  m = stem.match(/^(?:lowercase|lower)[_-]?([a-z])$/i);
  if (m) return { char: m[1].toLowerCase(), confidence: 'alias', reason: 'lowercase letter name' };

  return { char: null, confidence: 'none', reason: 'filename was not recognized' };
}

function detectCharacter(filename) {
  const fn =
    FontCore.detectCharacterFromFilename ||
    FontCore.detectFilenameCharacter ||
    FontCore.detectCharacter;
  if (typeof fn === 'function') {
    try {
      const found = fn(filename);
      const raw = typeof found === 'string' ? found : found?.char ?? found?.character;
      const char = oneScalar(raw);
      if (char) {
        return {
          char,
          confidence: found?.confidence || found?.kind || 'detected',
          reason: found?.reason || 'detected from filename',
        };
      }
      if (found && typeof found === 'object') {
        return {
          char: null,
          confidence: found.status === 'invalid' ? 'invalid' : 'none',
          reason: found.reason || 'filename was not recognized',
          invalid: found.status === 'invalid',
        };
      }
    } catch (error) {
      console.warn('Bitmap font filename detector fell back:', error);
    }
  }
  return localDetectCharacter(filename);
}

function unicodeLabel(char) {
  if (!char) return '—';
  const cp = char.codePointAt(0);
  return `U+${cp.toString(16).toUpperCase().padStart(cp > 0xffff ? 6 : 4, '0')}`;
}

function shownCharacter(char) {
  if (!char) return 'Unmapped';
  if (char === ' ') return 'Space';
  if (char === '\t') return 'Tab';
  if (char === '\n') return 'Line feed';
  return char;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeFileBase(value, fallback = 'bitmap_font') {
  const candidate = String(value || '')
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100);
  return candidate || fallback;
}

function safeFolderName(value, fallback = 'bitmapFont') {
  return safeFileBase(value, fallback);
}

function assetKeyFrom(value) {
  const words = String(value || '')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let key = words
    .map((word, i) =>
      i === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join('');
  if (!key) key = 'bitmapFont';
  if (!/^[A-Za-z_$]/.test(key)) key = `font${key}`;
  return key.replace(/[^A-Za-z0-9_$]/g, '');
}

// Same rule the main process applies before writing assets.ts.
const VALID_ASSET_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The Asset key field keeps any valid identifier exactly as typed, so an
 * existing assets.ts key such as `MMGold` or `mm_gold` can be matched.
 */
function assetKeyInput(value) {
  const trimmed = String(value || '').trim();
  return VALID_ASSET_KEY.test(trimmed) ? trimmed : assetKeyFrom(trimmed);
}

function makeTransparentCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.getContext('2d').clearRect(0, 0, 1, 1);
  return canvas;
}

function makeGlyph({
  name,
  canvas,
  char = null,
  virtual = false,
  xAdjust = 0,
  yAdjust = 0,
  advanceAdjust = 0,
  detection = null,
  imported = false,
  warning = null,
}) {
  const source = canvas || makeTransparentCanvas();
  return {
    id: ++glyphSequence,
    sourceName: name || (char ? `${unicodeLabel(char)}.png` : `glyph_${glyphSequence}.png`),
    source,
    sw: source.width,
    sh: source.height,
    char: oneScalar(char),
    codePoint: oneScalar(char)?.codePointAt(0) ?? null,
    virtual: !!virtual,
    xAdjust: int(xAdjust),
    yAdjust: int(yAdjust),
    advanceAdjust: int(advanceAdjust),
    detection,
    mappingError: detection?.invalid ? detection.reason || 'This mapping cannot be exported as BMFont XML.' : null,
    imported,
    warning,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function rawAttr(record, name, fallback = undefined) {
  if (record == null) return fallback;
  if (record[name] != null) return record[name];
  if (record.$?.[name] != null) return record.$[name];
  if (record._attributes?.[name] != null) return record._attributes[name];
  return fallback;
}

function parseXmlLocally(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError || !doc.querySelector('font')) {
    throw new Error(parserError?.textContent?.trim() || 'Not a BMFont XML document');
  }
  const info = doc.querySelector('info');
  const common = doc.querySelector('common');
  const pages = [...doc.querySelectorAll('pages > page')].map((node) => ({
    id: int(node.getAttribute('id')),
    file: node.getAttribute('file') || '',
  }));
  const chars = [...doc.querySelectorAll('chars > char')].map((node) => {
    const idRaw = node.getAttribute('id');
    return {
      id: /^-?\d+$/.test(idRaw || '') ? Number(idRaw) : idRaw,
      letter: node.getAttribute('letter') || null,
      x: int(node.getAttribute('x')),
      y: int(node.getAttribute('y')),
      width: int(node.getAttribute('width')),
      height: int(node.getAttribute('height')),
      xoffset: int(node.getAttribute('xoffset')),
      yoffset: int(node.getAttribute('yoffset')),
      xadvance: int(node.getAttribute('xadvance')),
      page: int(node.getAttribute('page')),
      chnl: int(node.getAttribute('chnl'), 15),
    };
  });
  return {
    face: info?.getAttribute('face') || 'bitmapFont',
    size: positiveInt(info?.getAttribute('size'), 64),
    lineHeight: positiveInt(common?.getAttribute('lineHeight'), 64),
    base: int(common?.getAttribute('base'), positiveInt(common?.getAttribute('lineHeight'), 64)),
    scaleW: positiveInt(common?.getAttribute('scaleW'), 1),
    scaleH: positiveInt(common?.getAttribute('scaleH'), 1),
    pages,
    chars,
    warnings: [],
  };
}

function unwrapJsonSection(value) {
  let current = value;
  while (Array.isArray(current) && current.length === 1) current = current[0];
  return current?.$ || current?._attributes || current || {};
}

function parseJsonLocally(text) {
  const rootValue = typeof text === 'string' ? JSON.parse(text) : text;
  const root = rootValue.font || rootValue;
  const info = unwrapJsonSection(root.info);
  const common = unwrapJsonSection(root.common);

  let pages = root.pages;
  while (Array.isArray(pages) && pages.length === 1) pages = pages[0];
  pages = pages?.page || pages || [];
  pages = asArray(pages).map((page, i) => ({
    id: int(rawAttr(page, 'id'), i),
    file: String(rawAttr(page, 'file', typeof page === 'string' ? page : '')),
  }));

  let chars = root.chars;
  while (Array.isArray(chars) && chars.length === 1) chars = chars[0];
  chars = chars?.char || chars || [];
  chars = asArray(chars).map((record) => ({
    id: rawAttr(record, 'id'),
    letter: rawAttr(record, 'letter', rawAttr(record, 'char', null)),
    x: int(rawAttr(record, 'x')),
    y: int(rawAttr(record, 'y')),
    width: int(rawAttr(record, 'width')),
    height: int(rawAttr(record, 'height')),
    xoffset: int(rawAttr(record, 'xoffset')),
    yoffset: int(rawAttr(record, 'yoffset')),
    xadvance: int(rawAttr(record, 'xadvance')),
    page: int(rawAttr(record, 'page')),
    chnl: int(rawAttr(record, 'chnl'), 15),
  }));
  return {
    face: String(info.face || 'bitmapFont'),
    size: positiveInt(info.size, 64),
    lineHeight: positiveInt(common.lineHeight, 64),
    base: int(common.base, positiveInt(common.lineHeight, 64)),
    scaleW: positiveInt(common.scaleW, 1),
    scaleH: positiveInt(common.scaleH, 1),
    pages,
    chars,
    warnings: [],
  };
}

function normalizeParsedFont(parsed) {
  const source = parsed?.font || parsed || {};
  const info = unwrapJsonSection(source.info);
  const common = unwrapJsonSection(source.common);
  const pagesSource = source.pages?.page || source.pages || parsed?.pageFiles || [];
  const charsSource = source.chars?.char || source.chars || source.characters || parsed?.characters || [];
  return {
    face: String(source.face ?? info.face ?? parsed?.face ?? 'bitmapFont'),
    size: positiveInt(source.size ?? info.size ?? parsed?.size, 64),
    lineHeight: positiveInt(source.lineHeight ?? common.lineHeight ?? parsed?.lineHeight, 64),
    base: int(source.base ?? common.base ?? parsed?.base, positiveInt(source.lineHeight ?? common.lineHeight, 64)),
    scaleW: positiveInt(source.scaleW ?? common.scaleW ?? parsed?.scaleW, 1),
    scaleH: positiveInt(source.scaleH ?? common.scaleH ?? parsed?.scaleH, 1),
    pages: asArray(pagesSource).map((page, i) => ({
      id: int(rawAttr(page, 'id'), i),
      file: String(rawAttr(page, 'file', rawAttr(page, 'name', typeof page === 'string' ? page : ''))),
      path: rawAttr(page, 'path', null),
    })),
    chars: asArray(charsSource).map((record) => ({
      id: rawAttr(record, 'id', rawAttr(record, 'codePoint', null)),
      letter: rawAttr(record, 'letter', rawAttr(record, 'char', rawAttr(record, 'character', null))),
      x: int(rawAttr(record, 'x')),
      y: int(rawAttr(record, 'y')),
      width: int(rawAttr(record, 'width', rawAttr(record, 'w'))),
      height: int(rawAttr(record, 'height', rawAttr(record, 'h'))),
      xoffset: int(rawAttr(record, 'xoffset', rawAttr(record, 'xOffset'))),
      yoffset: int(rawAttr(record, 'yoffset', rawAttr(record, 'yOffset'))),
      xadvance: int(rawAttr(record, 'xadvance', rawAttr(record, 'xAdvance'))),
      page: int(rawAttr(record, 'page')),
      chnl: int(rawAttr(record, 'chnl'), 15),
    })),
    warnings: asArray(source.warnings || parsed?.warnings),
  };
}

function parseMetadata(text, format) {
  const fn =
    FontCore.parseBitmapFont ||
    FontCore.parseFontMetadata ||
    (String(format).toLowerCase() === 'xml' ? FontCore.parseBMFontXml || FontCore.parseXml : FontCore.parseBMFontJson || FontCore.parseJson);
  if (typeof fn === 'function') {
    try {
      return normalizeParsedFont(fn(text, { format }));
    } catch (firstError) {
      try {
        return normalizeParsedFont(fn(text, format));
      } catch {
        console.warn('Bitmap font parser fell back:', firstError);
      }
    }
  }
  return String(format).toLowerCase() === 'xml' ? parseXmlLocally(text) : parseJsonLocally(text);
}

function resolveCharacter(record) {
  let char = oneScalar(record.letter);
  const rawId = record.id;
  if (!char && Number.isInteger(Number(rawId))) {
    char = oneScalar(scalarFromCodePoint(Number(rawId)));
  }
  let repaired = false;
  if (!char && typeof rawId === 'string' && /\.png$/i.test(rawId)) {
    char = oneScalar(stripExt(basename(rawId)));
    repaired = !!char;
  }
  if (!char && typeof record.letter === 'string' && /\.png$/i.test(record.letter)) {
    char = oneScalar(stripExt(basename(record.letter)));
    repaired = !!char;
  }
  return { char, repaired };
}

function fallbackBuildFontAtlas(glyphs, settings) {
  const valid = glyphs.filter((glyph) => oneScalar(glyph.char));
  const extrude = Math.max(0, int(settings.extrude));
  const prepared = valid.map((glyph) => {
    const trim = settings.trim ? computeTrim(glyph.source) : {
      x: 0,
      y: 0,
      w: glyph.source.width,
      h: glyph.source.height,
      trimmed: false,
    };
    return { glyph, trim };
  });
  const packed = pack(
    prepared.map(({ glyph, trim }) => ({
      id: glyph.id,
      w: trim.w + extrude * 2,
      h: trim.h + extrude * 2,
    })),
    {
      padding: Math.max(1, int(settings.padding, 2)),
      border: Math.max(0, int(settings.border, 2)),
      maxWidth: positiveInt(settings.maxWidth, 4096),
      maxHeight: positiveInt(settings.maxHeight, 4096),
      powerOfTwo: !!settings.powerOfTwo,
      square: false,
      allowRotation: false,
    }
  );
  const byId = new Map(prepared.map((item) => [item.glyph.id, item]));
  const placed = packed.placed.map((entry) => {
    const item = byId.get(entry.id);
    return {
      sprite: {
        id: item.glyph.id,
        name: item.glyph.sourceName,
        source: item.glyph.source,
        sw: item.glyph.source.width,
        sh: item.glyph.source.height,
      },
      glyph: item.glyph,
      trim: item.trim,
      x: entry.x + extrude,
      y: entry.y + extrude,
      rotated: false,
    };
  });
  const atlasCanvas = composeAtlas(placed, packed.width, packed.height, { extrude });
  const chars = placed.map((entry) => {
    const glyph = entry.glyph;
    const isSpace = glyph.char === ' ';
    return {
      id: glyph.char.codePointAt(0),
      letter: glyph.char,
      x: int(entry.x),
      y: int(entry.y),
      width: int(entry.trim.w),
      height: int(entry.trim.h),
      xoffset: int(entry.trim.x + glyph.xAdjust),
      yoffset: int(settings.baseline - glyph.source.height + entry.trim.y + glyph.yAdjust),
      xadvance: isSpace
        ? positiveInt(settings.spaceWidth, 1)
        : int(glyph.source.width + settings.letterSpacing + glyph.advanceAdjust),
      page: 0,
      chnl: 15,
      glyphId: glyph.id,
      sourceName: glyph.sourceName,
      virtual: glyph.virtual,
    };
  });
  const contentArea = prepared.reduce((sum, item) => sum + item.trim.w * item.trim.h, 0);
  return {
    ok: packed.ok,
    width: packed.width,
    height: packed.height,
    atlasCanvas,
    canvas: atlasCanvas,
    chars,
    glyphs: chars,
    placed,
    failedIds: packed.failedIds,
    usedPct: packed.width && packed.height ? (contentArea / (packed.width * packed.height)) * 100 : 0,
    settings: { ...settings },
  };
}

function normalizeBuild(result, settings) {
  const canvas = result?.atlasCanvas || result?.canvas || result?.texture || result?.page?.canvas;
  const chars = result?.chars || result?.characters || result?.glyphs || result?.metadata?.chars || [];
  return {
    ...result,
    ok: result?.ok !== false && !!canvas,
    width: int(result?.width ?? result?.scaleW ?? canvas?.width),
    height: int(result?.height ?? result?.scaleH ?? canvas?.height),
    atlasCanvas: canvas,
    canvas,
    chars: asArray(chars).map((record) => ({
      ...record,
      id: int(rawAttr(record, 'id', rawAttr(record, 'codePoint'))),
      letter:
        oneScalar(rawAttr(record, 'letter', rawAttr(record, 'char', rawAttr(record, 'character')))) ||
        scalarFromCodePoint(int(rawAttr(record, 'id', rawAttr(record, 'codePoint')))),
      x: int(rawAttr(record, 'x')),
      y: int(rawAttr(record, 'y')),
      width: int(rawAttr(record, 'width', rawAttr(record, 'w'))),
      height: int(rawAttr(record, 'height', rawAttr(record, 'h'))),
      xoffset: int(rawAttr(record, 'xoffset', rawAttr(record, 'xOffset'))),
      yoffset: int(rawAttr(record, 'yoffset', rawAttr(record, 'yOffset'))),
      xadvance: int(rawAttr(record, 'xadvance', rawAttr(record, 'xAdvance'))),
      page: int(rawAttr(record, 'page')),
      chnl: int(rawAttr(record, 'chnl'), 15),
      glyphId: rawAttr(record, 'glyphId', rawAttr(record, 'sourceId', null)),
    })),
    failedIds: asArray(result?.failedIds || result?.failed),
    usedPct: Number(result?.usedPct ?? result?.occupancy ?? 0),
    settings,
  };
}

function localXml(build, settings, textureName) {
  const chars = [...build.chars].sort((a, b) => a.id - b.id);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<font>',
    `  <info face="${xmlEscape(settings.face)}" size="${int(settings.size)}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="0,0,0,0" spacing="0,0" outline="0"/>`,
    `  <common lineHeight="${int(settings.lineHeight)}" base="${int(settings.lineHeight)}" scaleW="${build.width}" scaleH="${build.height}" pages="1" packed="0" alphaChnl="0" redChnl="4" greenChnl="4" blueChnl="4"/>`,
    '  <pages>',
    `    <page id="0" file="${xmlEscape(textureName)}"/>`,
    '  </pages>',
    `  <chars count="${chars.length}">`,
    ...chars.map((char) =>
      `    <char id="${char.id}" letter="${xmlEscape(char.letter)}" x="${char.x}" y="${char.y}" width="${char.width}" height="${char.height}" xoffset="${char.xoffset}" yoffset="${char.yoffset}" xadvance="${char.xadvance}" page="0" chnl="15"/>`
    ),
    '  </chars>',
    '  <kernings count="0"/>',
    '</font>',
    '',
  ];
  return lines.join('\n');
}

function localJson(build, settings, textureName) {
  return JSON.stringify({
    pages: [{ page: [{ $: { id: '0', file: textureName } }] }],
    chars: [{
      $: { count: String(build.chars.length) },
      char: [...build.chars]
        .sort((a, b) => a.id - b.id)
        .map((char) => ({
          $: {
            id: String(char.id),
            letter: char.letter,
            x: String(char.x),
            y: String(char.y),
            width: String(char.width),
            height: String(char.height),
            xoffset: String(char.xoffset),
            yoffset: String(char.yoffset),
            xadvance: String(char.xadvance),
            page: '0',
            chnl: '15',
          },
        })),
    }],
    info: [{
      $: {
        face: settings.face,
        size: String(int(settings.size)),
        bold: '0',
        italic: '0',
        charset: '',
        unicode: '1',
        stretchH: '100',
        smooth: '1',
        aa: '1',
        padding: '0,0,0,0',
        spacing: '0,0',
        outline: '0',
      },
    }],
    common: [{
      $: {
        lineHeight: String(int(settings.lineHeight)),
        base: String(int(settings.lineHeight)),
        scaleW: String(build.width),
        scaleH: String(build.height),
        pages: '1',
        packed: '0',
        alphaChnl: '0',
        redChnl: '4',
        greenChnl: '4',
        blueChnl: '4',
      },
    }],
    kernings: [{ $: { count: '0' } }],
  }, null, 2) + '\n';
}

function callSerializer(kind, build, settings, textureName, fileBase) {
  const names = kind === 'xml'
    ? ['serializeBMFontXml', 'serializeBmFontXml', 'serializeFontXml', 'serializeXml']
    : kind === 'json'
      ? ['serializeBMFontJson', 'serializeBmFontJson', 'serializeFontJson', 'serializeJson']
      : kind === 'index'
        ? ['serializeIndexTs', 'createIndexTs', 'generateIndexTs']
        : ['serializeAssetsSnippet', 'createAssetsSnippet', 'generateAssetsSnippet'];
  const fn = names.map((name) => FontCore[name]).find((candidate) => typeof candidate === 'function');
  if (fn) {
    const payload = {
      build,
      chars: build.chars,
      face: settings.face,
      size: settings.size,
      lineHeight: settings.lineHeight,
      base: settings.lineHeight,
      width: build.width,
      height: build.height,
      textureName,
      pageFile: textureName,
      fileBase,
      settings,
    };
    try {
      const value = fn(payload);
      if (typeof value === 'string') return value;
    } catch (firstError) {
      try {
        const value = fn(build, { ...settings, textureName, pageFile: textureName, fileBase });
        if (typeof value === 'string') return value;
      } catch {
        console.warn(`Bitmap font ${kind} serializer fell back:`, firstError);
      }
    }
  }
  if (kind === 'xml') return localXml(build, settings, textureName);
  if (kind === 'json') return localJson(build, settings, textureName);
  if (kind === 'index') {
    return (
      `// Legacy pixi-svelte createAsset compatibility. Current Web SDK apps load the XML from assets.ts.\n` +
      `import { createAsset } from 'pixi-svelte';\n\n` +
      `import img from './${textureName}';\n` +
      `import font from './${fileBase}.json?raw';\n\n` +
      `export default createAsset({ img, font });\n`
    );
  }
  return '';
}

export class BitmapFontExporter {
  constructor({ toast, choiceDialog }) {
    this.toast = toast || ((message) => console.log(message));
    this.choiceDialog = choiceDialog;
    this.step = 'glyphs';
    this._bound = false;
    this._buildTimer = null;
    this._building = null;
    this._open = false;
    this._exporting = false;
    this._importing = false;
    this._revision = 0;
    this.reset();
    this._bind();
  }

  reset() {
    this._revision += 1;
    this.glyphs = [];
    this.kernings = [];
    this.selectedGlyphId = null;
    this.source = null;
    this.sourceWarnings = [];
    this.target = null;
    this.outputParent = '';
    this.build = null;
    this.verification = null;
    this.exported = null;
    this.dirty = false;
    this.settings = {
      face: 'bitmapFont',
      size: 64,
      lineHeight: 64,
      baseline: 64,
      letterSpacing: 0,
      spaceWidth: 32,
      padding: 2,
      extrude: 1,
      border: 2,
      maxWidth: 4096,
      maxHeight: 4096,
      trim: true,
      powerOfTwo: false,
    };
    this.expectedPreset = 'none';
    this.expectedCharacters = '';
    this.samplePreset = 'alphabet';
    this.sampleText = SAMPLE_PRESETS.alphabet;
    this.previewScale = 1;
    this.naming = {
      fileBase: 'bitmap_font',
      folderName: 'bitmapFont',
      assetKey: 'bitmapFont',
    };
    this.formats = {
      png: true,
      webp: true,
      xml: true,
      json: true,
      index: true,
      runtimeTexture: 'webp',
      registerAfter: false,
    };
    this.ensureSpace(false);
  }

  get isOpen() {
    return this._open && $('fontRoot')?.classList.contains('visible');
  }

  get mappedGlyphs() {
    return this.glyphs.filter((glyph) => oneScalar(glyph.char));
  }

  get selectedGlyph() {
    return this.glyphs.find((glyph) => glyph.id === this.selectedGlyphId) || null;
  }

  /** Live workflow state exposed for the built-in smoke harness. */
  get state() {
    return {
      step: this.step,
      glyphs: this.glyphs,
      kernings: this.kernings,
      settings: this.settings,
      expectedCharacters: this.expectedCharacters,
      sampleText: this.sampleText,
      naming: this.naming,
      formats: this.formats,
      source: this.source,
      target: this.target,
      build: this.build,
      verification: this.verification,
      exported: this.exported,
      dirty: this.dirty,
    };
  }

  open() {
    this._open = true;
    $('fontRoot').classList.add('visible');
    $('fontRoot').setAttribute('aria-hidden', 'false');
    native.setDirty(this.dirty || !!atlasState.dirty);
    this.syncControls();
    this.renderAll();
    this.goto(this.step || 'glyphs');
  }

  async close({ force = false } = {}) {
    if (this._exporting || this._importing) {
      this.toast('Wait for the current bitmap-font operation to finish.', 'info', 4500);
      return false;
    }
    let discard = false;
    if (!force && this.dirty) {
      const answer = this.choiceDialog
        ? await this.choiceDialog({
            title: 'Close Bitmap Font?',
            message: 'This font has changes that have not been exported. The normal atlas project is not affected.',
            buttons: [
              { label: 'Keep Editing', value: 'keep', primary: true },
              { label: 'Discard Font Changes', value: 'discard' },
            ],
          })
        : (window.confirm('Discard the unexported bitmap-font changes?') ? 'discard' : 'keep');
      if (answer !== 'discard') return false;
      discard = true;
    }
    this._open = false;
    $('fontRoot').classList.remove('visible', 'dragging');
    $('fontRoot').setAttribute('aria-hidden', 'true');
    native.setDirty(!!atlasState.dirty);
    await this.cleanupSource(this.source);
    if (discard) this.reset();
    return true;
  }

  markDirty({ invalidate = true } = {}) {
    this._revision += 1;
    this.dirty = true;
    this.exported = null;
    if (invalidate) {
      this.build = null;
      this.verification = null;
    }
    $('fontDirty')?.classList.remove('hidden');
    if (this.isOpen) native.setDirty(true);
    if ($('fontExportResult')) this.renderExportResult();
    this.renderFooter();
    if (invalidate && (this.step === 'preview' || this.step === 'export')) this.scheduleBuild();
  }

  markClean(expectedRevision = null) {
    if (expectedRevision != null && expectedRevision !== this._revision) return false;
    this.dirty = false;
    $('fontDirty')?.classList.add('hidden');
    if (this.isOpen) native.setDirty(!!atlasState.dirty);
    this.renderFooter();
    return true;
  }

  setExporting(value) {
    this._exporting = !!value;
    this.updateInteractionLock();
    if (!this._exporting) {
      this.syncControls();
      this.renderFooter();
    }
  }

  setImporting(value) {
    this._importing = !!value;
    this.updateInteractionLock();
    if (!this._importing) {
      this.syncControls();
      this.renderFooter();
    }
  }

  updateInteractionLock() {
    const root = $('fontRoot');
    const busy = this._exporting || this._importing;
    if (root) {
      root.inert = busy;
      root.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  refreshBuildVerification() {
    if (!this.build?.ok) {
      this.verification = null;
    } else {
      this.build.audit = this.audit();
      this.verification = this.verifyBuild(this.build);
    }
    this.renderVerification();
    this.renderGlyphSummary();
    this.renderGlyphWarnings();
    this.renderFooter();
  }

  _bind() {
    if (this._bound) return;
    this._bound = true;

    $('fontClose').addEventListener('click', () => this.close());
    $('fontBack').addEventListener('click', () => this.back());
    $('fontNext').addEventListener('click', () => this.next());
    $('fontRoot').addEventListener('click', (event) => {
      if (event.target === $('fontRoot')) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (!this.isOpen || event.key !== 'Escape' || document.querySelector('.choice-overlay')) return;
      if (this._exporting || this._importing) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });

    for (const step of STEPS) {
      $(`fontTab_${step}`).addEventListener('click', () => this.goto(step));
    }

    $('fontImportFolder').addEventListener('click', () => this.pickGlyphFolder());
    $('fontAddImages').addEventListener('click', () => this.pickAdditionalImages());
    $('fontOpenPackage').addEventListener('click', () => this.pickExistingPackage());
    $('fontAddSpace').addEventListener('click', () => {
      const glyph = this.ensureSpace(true);
      this.selectedGlyphId = glyph.id;
      this.renderAll();
    });

    $('fontGlyphTable').addEventListener('click', (event) => this.onGlyphTableClick(event));
    $('fontGlyphTable').addEventListener('input', (event) => this.onGlyphTableInput(event));
    $('fontGlyphTable').addEventListener('change', (event) => this.onGlyphTableChange(event));

    const numericSettings = {
      fontSize: ['size', 1],
      fontLineHeight: ['lineHeight', 1],
      fontBaseline: ['baseline', null],
      fontLetterSpacing: ['letterSpacing', null],
      fontSpaceWidth: ['spaceWidth', 1],
      fontPadding: ['padding', 1],
      fontExtrude: ['extrude', 0],
      fontBorder: ['border', 0],
      fontMaxW: ['maxWidth', 64],
      fontMaxH: ['maxHeight', 64],
    };
    for (const [id, [property, minimum]] of Object.entries(numericSettings)) {
      $(id).addEventListener('change', () => {
        let value = int($(id).value, this.settings[property]);
        if (minimum != null) value = Math.max(minimum, value);
        this.settings[property] = value;
        $(id).value = String(value);
        this.markDirty();
        this.renderAll();
      });
    }
    $('fontFace').addEventListener('input', () => {
      this.settings.face = $('fontFace').value;
      this.markDirty();
      this.renderGlyphSummary();
      this.renderTarget();
      this.renderExportSummary();
    });
    $('fontTrim').addEventListener('change', () => {
      this.settings.trim = $('fontTrim').checked;
      this.markDirty();
      this.renderAll();
    });
    $('fontPOT').addEventListener('change', () => {
      this.settings.powerOfTwo = $('fontPOT').checked;
      this.markDirty();
      this.renderAll();
    });

    $('fontExpectedPreset').addEventListener('change', () => {
      this.expectedPreset = $('fontExpectedPreset').value;
      if (this.expectedPreset !== 'custom') {
        this.expectedCharacters = EXPECTED_PRESETS[this.expectedPreset] || '';
        $('fontExpectedChars').value = this.expectedCharacters;
      }
      this.markDirty({ invalidate: false });
      this.refreshBuildVerification();
      this.renderAll();
    });
    $('fontExpectedChars').addEventListener('input', () => {
      this.expectedPreset = 'custom';
      this.expectedCharacters = $('fontExpectedChars').value;
      $('fontExpectedPreset').value = 'custom';
      this.markDirty({ invalidate: false });
      this.refreshBuildVerification();
      this.renderAll();
    });

    $('fontMetricGlyph').addEventListener('change', () => {
      this.selectedGlyphId = int($('fontMetricGlyph').value, null);
      this.renderMetricEditor();
      this.renderGlyphTable();
    });
    for (const [id, property] of [
      ['fontXAdjust', 'xAdjust'],
      ['fontYAdjust', 'yAdjust'],
      ['fontAdvanceAdjust', 'advanceAdjust'],
    ]) {
      $(id).addEventListener('change', () => {
        const glyph = this.selectedGlyph;
        if (!glyph || glyph.virtual) return;
        glyph[property] = int($(id).value);
        this.markDirty();
        this.renderAll();
      });
    }
    $('fontMetricReset').addEventListener('click', () => {
      const glyph = this.selectedGlyph;
      if (!glyph || glyph.virtual) return;
      glyph.xAdjust = 0;
      glyph.yAdjust = 0;
      glyph.advanceAdjust = 0;
      this.markDirty();
      this.renderAll();
    });

    $('fontSamplePreset').addEventListener('change', () => {
      this.samplePreset = $('fontSamplePreset').value;
      if (this.samplePreset !== 'custom') {
        this.sampleText = SAMPLE_PRESETS[this.samplePreset] || '';
        $('fontSampleText').value = this.sampleText;
      }
      this.refreshBuildVerification();
      this.renderPreview();
    });
    $('fontSampleText').addEventListener('input', () => {
      this.samplePreset = 'custom';
      this.sampleText = $('fontSampleText').value;
      $('fontSamplePreset').value = 'custom';
      this.refreshBuildVerification();
      this.renderPreview();
      this.renderVerification();
    });
    $('fontPreviewScale').addEventListener('change', () => {
      this.previewScale = Math.min(4, Math.max(0.25, Number($('fontPreviewScale').value) || 1));
      $('fontPreviewScale').value = String(this.previewScale);
      this.renderPreview();
    });

    $('fontPickProject').addEventListener('click', () => this.pickProject());
    $('fontClearProject').addEventListener('click', () => {
      this.target = null;
      this.outputParent = '';
      this.formats.registerAfter = false;
      this.syncControls();
      this.markDirty({ invalidate: false });
      this.renderAll();
    });
    $('fontChooseOutput').addEventListener('click', () => this.chooseOutputParent());

    for (const [id, property, transform] of [
      ['fontFileBase', 'fileBase', safeFileBase],
      ['fontFolderName', 'folderName', safeFolderName],
      ['fontAssetKey', 'assetKey', assetKeyInput],
    ]) {
      $(id).addEventListener('change', () => {
        this.naming[property] = transform($(id).value, this.naming[property]);
        // Show the name the export will actually use, after the shared
        // output-naming rules, so it can be compared with assets.ts.
        this.naming[property] = this.outputNames()[property] || this.naming[property];
        $(id).value = this.naming[property];
        this.markDirty({ invalidate: false });
        this.renderTarget();
        this.renderExportSummary();
      });
    }
    $('fontExistingFont').addEventListener('change', () => {
      const key = $('fontExistingFont').value;
      if (key) {
        this.adoptRegisteredFont(key);
      } else if (this.registrationPlan()?.entry) {
        this.toast(
          'To add a separate font instead, change the asset key, folder name and runtime face.',
          'info',
          7000
        );
      }
      this.renderTarget();
    });

    for (const [id, property] of [
      ['fontFormatPng', 'png'],
      ['fontFormatWebp', 'webp'],
      ['fontFormatXml', 'xml'],
      ['fontFormatJson', 'json'],
      ['fontFormatIndex', 'index'],
      ['fontRegisterAfter', 'registerAfter'],
    ]) {
      $(id).addEventListener('change', () => {
        this.formats[property] = $(id).checked;
        this.coerceFormats(property);
        this.syncControls();
        this.markDirty({ invalidate: false });
        this.renderExportSummary();
      });
    }
    $('fontRuntimeTexture').addEventListener('change', () => {
      this.formats.runtimeTexture = $('fontRuntimeTexture').value;
      this.coerceFormats('runtimeTexture');
      this.syncControls();
      this.markDirty({ invalidate: false });
      this.renderExportSummary();
    });
    $('fontOpenExportFolder').addEventListener('click', () => {
      if (this.exported?.firstFile) native.showInFolder(this.exported.firstFile);
    });
    $('fontRegisterNow').addEventListener('click', () => this.registerInProject());
  }

  syncControls() {
    const values = {
      fontFace: this.settings.face,
      fontSize: this.settings.size,
      fontLineHeight: this.settings.lineHeight,
      fontBaseline: this.settings.baseline,
      fontLetterSpacing: this.settings.letterSpacing,
      fontSpaceWidth: this.settings.spaceWidth,
      fontPadding: this.settings.padding,
      fontExtrude: this.settings.extrude,
      fontBorder: this.settings.border,
      fontMaxW: this.settings.maxWidth,
      fontMaxH: this.settings.maxHeight,
      fontExpectedPreset: this.expectedPreset,
      fontExpectedChars: this.expectedCharacters,
      fontSamplePreset: this.samplePreset,
      fontSampleText: this.sampleText,
      fontPreviewScale: this.previewScale,
      fontFileBase: this.naming.fileBase,
      fontFolderName: this.naming.folderName,
      fontAssetKey: this.naming.assetKey,
      fontOutputParent: this.outputParent,
      fontRuntimeTexture: this.formats.runtimeTexture,
    };
    for (const [id, value] of Object.entries(values)) {
      if ($(id)) $(id).value = String(value ?? '');
    }
    $('fontTrim').checked = this.settings.trim;
    $('fontPOT').checked = this.settings.powerOfTwo;
    $('fontFormatPng').checked = this.formats.png;
    $('fontFormatWebp').checked = this.formats.webp;
    $('fontFormatXml').checked = this.formats.xml;
    $('fontFormatJson').checked = this.formats.json;
    $('fontFormatIndex').checked = this.formats.index;
    $('fontRegisterAfter').checked = this.formats.registerAfter;
    $('fontRegisterAfter').disabled = !this.target || !this.formats.xml;
    $('fontFormatXml').checked = true;
    $('fontFormatXml').disabled = true;
    $('fontFormatXml').title = 'BMFont XML is the authoritative format required by the Stake/Pixi runtime';
    $('fontRuntimeTexture').querySelector('option[value="webp"]').disabled = !this.formats.webp;
    $('fontRuntimeTexture').querySelector('option[value="png"]').disabled = !this.formats.png;
    $('fontDirty').classList.toggle('hidden', !this.dirty);
  }

  coerceFormats(changed) {
    this.formats.xml = true;
    if (!this.formats.png && !this.formats.webp) {
      if (changed === 'png') this.formats.webp = true;
      else this.formats.png = true;
    }
    if (!this.formats[this.formats.runtimeTexture]) {
      this.formats.runtimeTexture = this.formats.webp ? 'webp' : 'png';
    }
    // index.ts imports the compatibility JSON and is not a registration file
    // in current Web SDK projects.
    if (this.formats.index && !this.formats.json) this.formats.json = true;
    if (!this.formats.xml) this.formats.registerAfter = false;
  }

  goto(step, { force = false } = {}) {
    if (!force && (this._exporting || this._importing)) return;
    if (!STEPS.includes(step)) return;
    this.step = step;
    for (const name of STEPS) {
      $(`fontStep_${name}`).classList.toggle('hidden', name !== step);
      $(`fontTab_${name}`).classList.toggle('active', name === step);
      $(`fontTab_${name}`).classList.toggle('done', STEPS.indexOf(name) < STEPS.indexOf(step));
      $(`fontTab_${name}`).setAttribute('aria-selected', name === step ? 'true' : 'false');
    }
    if (step === 'preview' || step === 'export') {
      this.buildNow().then(() => {
        if (step === 'preview') this.renderPreview();
        else this.renderExportSummary();
        this.renderFooter();
      });
    }
    this.renderAll();
  }

  back() {
    if (this._exporting || this._importing) return;
    const index = STEPS.indexOf(this.step);
    if (index > 0) this.goto(STEPS[index - 1]);
  }

  async next() {
    if (this._exporting || this._importing) return;
    const index = STEPS.indexOf(this.step);
    if (this.step === 'glyphs') {
      const audit = this.audit();
      if (audit.mappedVisibleCount < 1) {
        this.toast('Map at least one visible glyph before continuing.', 'error', 6000);
        return;
      }
      if (audit.duplicates.length) {
        this.toast('Resolve duplicate character assignments before continuing.', 'error', 6000);
        return;
      }
    }
    if (this.step === 'layout') {
      const result = await this.buildNow();
      if (!result?.ok) {
        this.toast('The glyphs do not fit the selected maximum atlas size.', 'error', 7000);
        return;
      }
    }
    if (this.step === 'preview') {
      const result = await this.buildNow();
      if (!result?.ok || this.verification?.blocking?.length) {
        this.toast('Resolve the blocking verification errors before export.', 'error', 7000);
        return;
      }
    }
    if (this.step === 'export') {
      if (this.exported) return this.close();
      return this.exportNow();
    }
    this.goto(STEPS[index + 1]);
  }

  // -----------------------------------------------------------------------
  // Source import and glyph editing
  // -----------------------------------------------------------------------

  async pickGlyphFolder() {
    const folder = await native.pickDirectory({ title: 'Select a folder of static PNG glyphs' });
    if (folder) await this.loadSourcePath(folder);
  }

  async pickAdditionalImages() {
    const paths = await native.pickFiles({
      title: 'Add static PNG glyph images',
      filters: [{ name: 'PNG glyph images', extensions: ['png'] }],
      multi: true,
    });
    if (paths?.length) await this.addImagePaths(paths);
  }

  async pickExistingPackage() {
    let mode = 'file';
    if (this.choiceDialog) {
      mode = await this.choiceDialog({
        title: 'Open an existing bitmap font',
        message: 'Open a font folder, a ZIP package, or its BMFont XML/JSON metadata. The original files remain unchanged.',
        buttons: [
          { label: 'Choose Folder…', value: 'folder', primary: true },
          { label: 'Choose ZIP / XML / JSON…', value: 'file' },
          { label: 'Cancel', value: null },
        ],
      });
      if (!mode) return;
    }
    let sourcePath;
    if (mode === 'folder') {
      sourcePath = await native.pickDirectory({ title: 'Select the bitmap font package folder' });
    } else {
      const files = await native.pickFiles({
        title: 'Select a bitmap font package or metadata file',
        filters: [
          { name: 'Bitmap font packages', extensions: ['zip', 'xml', 'json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      sourcePath = files?.[0];
    }
    if (sourcePath) await this.loadSourcePath(sourcePath, { expectPackage: true });
  }

  async importDroppedFiles(files) {
    if (this._exporting || this._importing) {
      this.toast('Wait for the current bitmap-font operation to finish.', 'info', 4500);
      return null;
    }
    const dropped = asArray(files).filter(Boolean);
    if (!dropped.length) return;
    const pathFor = (file) => {
      if (typeof file === 'string') return file;
      try {
        return native.getPathForFile?.(file) || file?.path || '';
      } catch {
        return file?.path || '';
      }
    };
    const paths = dropped.map(pathFor).filter(Boolean);
    const pngFiles = dropped.filter((file) => /\.png$/i.test(file.name || basename(pathFor(file))));
    const packageLike = dropped.find((file) =>
      /\.(zip|xml|json)$/i.test(file.name || basename(pathFor(file)))
    );
    if (packageLike && dropped.length === 1) {
      return this.loadSourcePath(pathFor(packageLike), { expectPackage: true });
    }
    if (pngFiles.length === dropped.length) return this.addImagePaths(pngFiles);
    if (paths.length === 1) {
      // A dropped directory has no useful MIME type. Let the guarded native
      // scanner decide whether it is a loose glyph folder or font package.
      return this.loadSourcePath(paths[0]);
    }
    this.toast('Drop PNG glyphs together, or one font folder/ZIP/XML/JSON package.', 'warn', 6000);
  }

  async cleanupSource(source) {
    if (!source?.tempWorkspace) return;
    try {
      await native.fontCleanup(source.root || source);
      source.tempWorkspace = null;
    } catch (error) {
      console.warn('Could not clean bitmap-font temporary workspace:', error);
    }
  }

  sourceStateSnapshot() {
    return {
      glyphs: this.glyphs,
      kernings: this.kernings.map((entry) => ({ ...entry })),
      selectedGlyphId: this.selectedGlyphId,
      source: this.source,
      sourceWarnings: this.sourceWarnings,
      settings: { ...this.settings },
      naming: { ...this.naming },
      build: this.build,
      verification: this.verification,
      exported: this.exported,
      dirty: this.dirty,
      step: this.step,
      revision: this._revision,
    };
  }

  restoreSourceState(snapshot) {
    this.glyphs = snapshot.glyphs;
    this.kernings = snapshot.kernings;
    this.selectedGlyphId = snapshot.selectedGlyphId;
    this.source = snapshot.source;
    this.sourceWarnings = snapshot.sourceWarnings;
    this.settings = snapshot.settings;
    this.naming = snapshot.naming;
    this.build = snapshot.build;
    this.verification = snapshot.verification;
    this.exported = snapshot.exported;
    this.dirty = snapshot.dirty;
    this.step = snapshot.step;
    this._revision = snapshot.revision;
    this.syncControls();
    this.renderAll();
  }

  normalizedSourceDiagnostic(warning) {
    const message = warning?.message || warning?.error || String(warning);
    const unresolved =
      /missing texture|missing page|unsafe texture|could not decode|not found|outside (?:the )?(?:texture|page)|out[- ]of[- ]bounds|was skipped|not extracted|undeclared texture page|no (?:positive |visible )?glyph/i.test(
        message
      );
    if (unresolved) return { ...warning, level: 'error', message };
    return {
      ...warning,
      level: warning?.level === 'info' ? 'info' : 'warn',
      message: /^Normalized source:/i.test(message) ? message : `Normalized source: ${message}`,
    };
  }

  /**
   * Public/smoke-friendly source entry point. It accepts a loose folder,
   * existing folder, ZIP archive, or BMFont XML/JSON path.
   */
  async loadSourcePath(sourcePath, { expectPackage = false, replaceCurrent = false } = {}) {
    if (!sourcePath) return null;
    if (this._exporting || this._importing) {
      this.toast('Wait for the current bitmap-font operation to finish.', 'info', 4500);
      return null;
    }
    const hasDirtyArtwork = this.dirty && this.glyphs.some((glyph) => !glyph.virtual);
    if (hasDirtyArtwork && !replaceCurrent) {
      const replace = this.choiceDialog
        ? await this.choiceDialog({
            title: 'Replace the current bitmap font?',
            message:
              'The current font has changes that have not been exported. Opening another source will discard those font-only changes.',
            buttons: [
              { label: 'Keep Editing', value: false, primary: true },
              { label: 'Discard and Open Source', value: true },
            ],
          })
        : window.confirm('Discard the current unexported bitmap-font changes and open another source?');
      if (!replace) return null;
    }
    this.setImporting(true);
    try {
      if (this._building) await this._building;
    } catch (error) {
      this.setImporting(false);
      this.toast(`Could not finish the current font build: ${error?.message || error}`, 'error', 7000);
      return null;
    }
    clearTimeout(this._buildTimer);
    const previous = this.sourceStateSnapshot();
    let scan = null;
    $('fontSourceStatus').textContent = 'Scanning and decoding…';
    try {
      scan = await native.fontOpenSource(sourcePath);
      if (!scan?.ok) throw new Error(scan?.error || 'The source could not be scanned.');
      this.source = scan;
      this.sourceWarnings = asArray(scan.verification?.warnings).map((warning) =>
        this.normalizedSourceDiagnostic(warning)
      );
      if (scan.mode === 'package' || scan.selectedMetadata || scan.metadata) {
        await this.loadExistingPackage(scan);
      } else {
        const entries = scan.glyphs || scan.directPngs || scan.pngFiles || [];
        if (!entries.length) {
          throw new Error(
            expectPackage
              ? 'No compatible BMFont metadata and texture were found.'
              : 'No direct-child PNG glyph images were found in that folder.'
          );
        }
        await this.loadLooseEntries(entries, { replace: true, strict: true });
        this.applyNamesFromSource(scan);
      }
      const hasVisibleArtwork = this.glyphs.some((glyph) => {
        if (glyph.virtual || !glyph.source?.width || !glyph.source?.height) return false;
        const pixels = glyph.source
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, glyph.source.width, glyph.source.height).data;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] > 0) return true;
        }
        return false;
      });
      if (!hasVisibleArtwork) {
        throw new Error('The source did not contain any visible PNG glyph artwork that could be decoded.');
      }
      if (previous.source && previous.source !== scan) await this.cleanupSource(previous.source);
      if (this.target) this.autoAdoptRegistration();
      $('fontSourceStatus').textContent = `${scan.fromArchive ? 'Extracted' : 'Loaded'} ${this.glyphs.length - 1} artwork glyph${this.glyphs.length - 1 === 1 ? '' : 's'}.`;
      this.markDirty();
      this.goto('glyphs', { force: true });
      this.renderAll();
      return scan;
    } catch (error) {
      console.error(error);
      if (scan && scan !== previous.source) await this.cleanupSource(scan);
      this.restoreSourceState(previous);
      $('fontSourceStatus').textContent = '';
      this.toast(`Could not import bitmap-font source: ${error?.message || error}`, 'error', 9000);
      return null;
    } finally {
      this.setImporting(false);
    }
  }

  async entryBytes(entry) {
    if (
      entry?.bytes instanceof ArrayBuffer ||
      ArrayBuffer.isView(entry?.bytes) ||
      Array.isArray(entry?.bytes)
    ) {
      return entry.bytes;
    }
    if (entry instanceof File) return new Uint8Array(await entry.arrayBuffer());
    const path = entry?.path || entry;
    if (!path) throw new Error('A selected image has no readable path.');
    return native.readFile(path);
  }

  entryName(entry) {
    return entry?.name || basename(entry?.path || entry);
  }

  async loadLooseEntries(entries, { replace = false, strict = false } = {}) {
    const decoded = [];
    const failures = [];
    for (const entry of asArray(entries)) {
      const name = this.entryName(entry);
      if (!/\.png$/i.test(name)) continue;
      try {
        const canvas = await bytesToCanvas(await this.entryBytes(entry));
        const detection = detectCharacter(name);
        decoded.push(makeGlyph({
          name,
          canvas,
          char: detection.char,
          detection,
          imported: true,
        }));
      } catch (error) {
        failures.push(`${name}: ${error?.message || error}`);
      }
    }
    if (strict && failures.length) {
      throw new Error(
        `${failures.length} PNG glyph${failures.length === 1 ? '' : 's'} could not be decoded: ${failures.join('; ')}`
      );
    }
    if (replace) {
      this.glyphs = [];
      this.kernings = [];
      this.selectedGlyphId = null;
      this.ensureSpace(false);
    }
    this.glyphs.push(...decoded);
    if (!this.selectedGlyphId && decoded.length) this.selectedGlyphId = decoded[0].id;
    this.autoMetricsFromArtwork(decoded);
    if (failures.length) {
      this.sourceWarnings.push(...failures.map((message) => ({ level: 'warn', message })));
      this.toast(`${failures.length} PNG glyph${failures.length === 1 ? '' : 's'} could not be decoded.`, 'warn', 7000);
    }
    return decoded;
  }

  async addImagePaths(entries) {
    $('fontSourceStatus').textContent = 'Decoding PNG glyphs…';
    const added = await this.loadLooseEntries(entries, { replace: false });
    if (!added.length) {
      $('fontSourceStatus').textContent = '';
      this.toast('No readable PNG glyph images were selected.', 'warn', 5000);
      return [];
    }
    $('fontSourceStatus').textContent = `Added ${added.length} glyph image${added.length === 1 ? '' : 's'}.`;
    this.markDirty();
    this.renderAll();
    return added;
  }

  autoMetricsFromArtwork(newGlyphs) {
    const visible = asArray(newGlyphs).filter((glyph) => !glyph.virtual);
    if (!visible.length) return;
    const maxHeight = Math.max(...visible.map((glyph) => glyph.source.height));
    const onlyDefaults =
      this.glyphs.filter((glyph) => !glyph.virtual).length === visible.length &&
      this.settings.size === 64 &&
      this.settings.lineHeight === 64 &&
      this.settings.baseline === 64;
    if (onlyDefaults) {
      this.settings.size = maxHeight;
      this.settings.lineHeight = maxHeight;
      this.settings.baseline = maxHeight;
      this.settings.spaceWidth = Math.max(1, Math.round(maxHeight * 0.38));
    } else {
      this.settings.lineHeight = Math.max(this.settings.lineHeight, maxHeight);
      this.settings.baseline = Math.max(this.settings.baseline, maxHeight);
    }
    this.syncControls();
  }

  /**
   * Store derived names in the exact form the export will use, so the naming
   * fields show the real file, folder and asset key (e.g. `goldFont`, not a
   * `gold_font` that the output rules would silently re-case).
   */
  normalizeNaming() {
    const names = this.sanitizedOutputNames(this.naming);
    this.naming.fileBase = names.fileBase;
    this.naming.folderName = names.folderName;
    this.naming.assetKey = names.assetKey;
  }

  applyNamesFromSource(scan) {
    const sourceRoot = scan.packageDir || scan.root || scan.originalPath || '';
    const sourceName = safeFolderName(basename(sourceRoot), 'bitmapFont');
    const fileBase = safeFileBase(sourceName, 'bitmap_font');
    this.settings.face = sourceName;
    this.naming.fileBase = fileBase;
    this.naming.folderName = sourceName;
    this.naming.assetKey = assetKeyFrom(sourceName);
    this.normalizeNaming();
    this.syncControls();
  }

  async loadExistingPackage(scan) {
    const selected = scan.selectedMetadata || scan.metadata;
    if (!selected?.text) throw new Error('The package metadata could not be read.');
    const unsafePages = asArray(scan.verification?.unsafePages);
    if (unsafePages.length) {
      throw new Error(
        `The font metadata contains unsafe texture-page paths: ${unsafePages.join(', ')}.`
      );
    }
    const format = String(selected.format || '').toLowerCase() ||
      (/\.json$/i.test(selected.path || selected.name || '') ? 'json' : 'xml');
    let canonical;
    try {
      canonical =
        format === 'json'
          ? (FontCore.parseBMFontJSON || FontCore.parseFontJSON)(selected.text)
          : (FontCore.parseBMFontXML || FontCore.parseFontXML)(selected.text);
    } catch {
      canonical = null;
    }
    const parsed = canonical ? normalizeParsedFont(canonical) : parseMetadata(selected.text, format);
    if (!parsed.chars.length) throw new Error('The BMFont metadata contains no glyph records.');

    const pageCanvases = await this.loadPackagePages(scan, parsed, selected);
    if (!pageCanvases.size) throw new Error('The texture page declared by the font metadata was not found.');

    const imported = [];
    const warnings = [...asArray(parsed.warnings)];
    const importer =
      FontImport.importBitmapFontPackage ||
      FontImport.openBitmapFontPackage ||
      FontImport.importExistingBitmapFont;
    let coreImport = null;
    if (canonical && typeof importer === 'function') {
      const companionJson = asArray(scan.metadataCandidates).find(
        (candidate) => candidate !== selected && candidate.format === 'json'
      );
      coreImport = importer({
        metadata: canonical,
        jsonText: companionJson?.text,
        pages: pageCanvases,
        // Imported metrics are translated from the old Pixi base offset to a
        // line-height artwork guide, preserving draw positions after repack.
        artworkBaseline: parsed.lineHeight,
        letterSpacing: 0,
      });
      const extractionFailures = asArray(coreImport.failures);
      const invalidEntries = asArray(coreImport.invalidEntries);
      if (extractionFailures.length || invalidEntries.length) {
        const firstFailure =
          extractionFailures[0]?.reason ||
          (invalidEntries.length
            ? `character ID ${invalidEntries[0]?.rawId ?? invalidEntries[0]?.id ?? 'unknown'} is invalid`
            : '');
        throw new Error(
          `The existing font could not be extracted completely${firstFailure ? `: ${firstFailure}` : '.'}`
        );
      }
      warnings.push(...asArray(coreImport.warnings));
    }

    if (coreImport) {
      for (const coreGlyph of coreImport.glyphs) {
        const character = oneScalar(coreGlyph.character);
        const virtual = !!coreGlyph.virtual || character === ' ';
        const source = virtual ? makeTransparentCanvas() : coreGlyph.source;
        if (!source) continue;
        imported.push(makeGlyph({
          name: coreGlyph.sourceFilename,
          canvas: source,
          char: character,
          virtual,
          xAdjust: coreGlyph.xAdjust,
          yAdjust: coreGlyph.yAdjust,
          advanceAdjust: coreGlyph.advanceAdjust,
          imported: true,
        }));
        if (virtual) {
          this.settings.spaceWidth = Math.max(
            1,
            int(source.width + coreGlyph.advanceAdjust)
          );
        }
      }
    } else {
      // Compatibility fallback for a future parser variant: perform the same
      // baseLineOffset/trim translation explicitly.
      const oldBaseLineOffset = parsed.lineHeight - parsed.base;
      for (const record of parsed.chars) {
        const { char, repaired } = resolveCharacter(record);
        if (repaired) {
          warnings.push({
            level: 'warn',
            message: `Repaired the nonstandard character ID "${record.id}" as ${shownCharacter(char)} (${unicodeLabel(char)}).`,
          });
        }
        const page = pageCanvases.get(int(record.page)) || pageCanvases.values().next().value;
        const width = Math.max(1, int(record.width, 1));
        const height = Math.max(1, int(record.height, 1));
        const virtual = char === ' ';
        let canvas = makeTransparentCanvas();
        if (!virtual) {
          if (
            record.x < 0 ||
            record.y < 0 ||
            record.x + width > page.width ||
            record.y + height > page.height
          ) {
            warnings.push({
              level: 'error',
              message: `${shownCharacter(char) || record.id} has texture coordinates outside the page and was skipped.`,
            });
            continue;
          }
          canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(
            page,
            int(record.x),
            int(record.y),
            width,
            height,
            0,
            0,
            width,
            height
          );
        }
        const trim = virtual
          ? { x: 0, y: 0 }
          : (this.settings.trim ? computeTrim(canvas) : { x: 0, y: 0 });
        const name = virtual
          ? 'space.virtual.png'
          : `${char ? safeFileBase(unicodeLabel(char), 'glyph') : `unmapped_${imported.length + 1}`}.png`;
        imported.push(makeGlyph({
          name,
          canvas,
          char,
          virtual,
          xAdjust: virtual ? 0 : int(record.xoffset) - trim.x,
          yAdjust:
            virtual
              ? 0
              : oldBaseLineOffset + int(record.yoffset) - (parsed.lineHeight - height + trim.y),
          advanceAdjust: virtual ? 0 : int(record.xadvance) - width,
          imported: true,
          warning: !char ? `Invalid original character ID: ${record.id}` : null,
        }));
        if (virtual) this.settings.spaceWidth = Math.max(1, int(record.xadvance, this.settings.spaceWidth));
      }
    }

    this.glyphs = imported;
    this.kernings = asArray(canonical?.kernings)
      .filter((entry) => entry?.valid !== false)
      .map((entry) => ({
        first: int(entry.first),
        second: int(entry.second),
        amount: int(entry.amount),
        valid: true,
      }));
    this.ensureSpace(false);
    this.selectedGlyphId = this.glyphs.find((glyph) => !glyph.virtual)?.id || this.glyphs[0]?.id || null;
    this.settings.face = parsed.face || this.settings.face;
    this.settings.size = positiveInt(parsed.size, this.settings.size);
    this.settings.lineHeight = positiveInt(parsed.lineHeight, this.settings.lineHeight);
    this.settings.baseline = this.settings.lineHeight;
    this.settings.letterSpacing = 0;
    const metadataName = selected.name || basename(selected.path || '');
    const base = safeFileBase(stripExt(metadataName), safeFileBase(this.settings.face));
    this.naming.fileBase = base;
    this.naming.folderName = safeFolderName(basename(scan.packageDir || scan.root), assetKeyFrom(this.settings.face));
    this.naming.assetKey = assetKeyFrom(this.naming.folderName);
    this.normalizeNaming();
    this.sourceWarnings = [
      ...this.sourceWarnings,
      ...warnings.map((warning) => this.normalizedSourceDiagnostic(warning)),
    ];
    this.syncControls();
  }

  async loadPackagePages(scan, parsed, selected) {
    const packageFiles = asArray(scan.packageFiles);
    const pageDetails = asArray(scan.verification?.pageDetails);
    const byDeclaredName = new Map();
    // Only paths resolved and validated by the main-process scanner, or
    // direct package files it enumerated itself, may reach native.readFile.
    for (const file of [...pageDetails, ...packageFiles]) {
      const path = file?.path || file;
      const name = file?.file || file?.name || basename(path);
      if (!path || !name) continue;
      byDeclaredName.set(String(name).replace(/\\/g, '/').toLowerCase(), path);
      byDeclaredName.set(basename(name).toLowerCase(), path);
    }
    const result = new Map();
    const declared = parsed.pages.length ? parsed.pages : asArray(selected.pages).map((page, i) => ({
      id: int(page?.id, i),
      file: page?.file || page?.name || page,
      path: page?.path,
    }));
    for (const [index, page] of declared.entries()) {
      const pageName = String(page.file || page.name || '');
      const normalizedPageName = pageName.replace(/\\/g, '/');
      const unsafePageName =
        !normalizedPageName ||
        /^[A-Za-z]:/.test(normalizedPageName) ||
        normalizedPageName.startsWith('/') ||
        normalizedPageName.split('/').some((part) => !part || part === '.' || part === '..');
      if (unsafePageName) {
        this.sourceWarnings.push({
          level: 'error',
          message: `Unsafe texture page "${pageName}" was not opened.`,
        });
        continue;
      }
      const pagePath =
        byDeclaredName.get(normalizedPageName.toLowerCase()) ||
        byDeclaredName.get(basename(normalizedPageName).toLowerCase()) ||
        joinPath(scan.packageDir || dirname(selected.path || ''), normalizedPageName);
      if (!pagePath) continue;
      try {
        const canvas = await bytesToCanvas(await native.readFile(pagePath));
        result.set(int(page.id, index), canvas);
        result.set(String(int(page.id, index)), canvas);
        if (pageName) result.set(String(pageName), canvas);
      } catch (error) {
        this.sourceWarnings.push({
          level: 'error',
          message: `Could not decode texture page "${pageName}": ${error?.message || error}`,
        });
      }
    }
    return result;
  }

  ensureSpace(mark = false) {
    let glyph = this.glyphs.find((entry) => entry.char === ' ');
    if (glyph) {
      // A space from questionable metadata may point at visible atlas pixels.
      // The exporter always gives it its own transparent cell.
      if (!glyph.virtual) {
        glyph.virtual = true;
        glyph.source = makeTransparentCanvas();
        glyph.sw = 1;
        glyph.sh = 1;
      }
      return glyph;
    }
    const factory = FontCore.createVirtualSpaceGlyph;
    if (typeof factory === 'function') {
      try {
        const coreGlyph = factory({
          id: ++glyphSequence,
          spaceWidth: this.settings.spaceWidth,
          letterSpacing: this.settings.letterSpacing,
          source: makeTransparentCanvas(),
        });
        glyph = makeGlyph({
          name: coreGlyph.sourceFilename || 'space.virtual.png',
          canvas: coreGlyph.source || makeTransparentCanvas(),
          char: ' ',
          virtual: true,
          advanceAdjust: coreGlyph.advanceAdjust,
        });
      } catch {
        glyph = null;
      }
    }
    if (!glyph) {
      glyph = makeGlyph({
        name: 'space.virtual.png',
        canvas: makeTransparentCanvas(),
        char: ' ',
        virtual: true,
      });
    }
    this.glyphs.unshift(glyph);
    if (mark) this.markDirty();
    return glyph;
  }

  async replaceGlyphImage(glyph) {
    if (!glyph || glyph.virtual) {
      this.toast('Space is virtual and does not need visible PNG artwork.', 'info', 5000);
      return;
    }
    const paths = await native.pickFiles({
      title: `Replace artwork for ${shownCharacter(glyph.char)}`,
      filters: [{ name: 'PNG glyph image', extensions: ['png'] }],
    });
    if (!paths?.[0]) return;
    try {
      const previousAdvance = glyph.source.width + glyph.advanceAdjust;
      const canvas = await bytesToCanvas(await native.readFile(paths[0]));
      glyph.source = canvas;
      glyph.sw = canvas.width;
      glyph.sh = canvas.height;
      glyph.sourceName = basename(paths[0]);
      glyph.advanceAdjust = previousAdvance - canvas.width;
      glyph.imported = true;
      this.settings.lineHeight = Math.max(this.settings.lineHeight, canvas.height);
      this.markDirty();
      this.renderAll();
    } catch (error) {
      this.toast(`Could not replace glyph image: ${error?.message || error}`, 'error', 7000);
    }
  }

  removeGlyph(glyph) {
    if (!glyph) return;
    this.glyphs = this.glyphs.filter((entry) => entry.id !== glyph.id);
    if (glyph.char === ' ') this.ensureSpace(false);
    this.selectedGlyphId = this.glyphs.find((entry) => entry.id !== glyph.id)?.id || null;
    this.markDirty();
    this.renderAll();
  }

  onGlyphTableClick(event) {
    const row = event.target.closest('[data-glyph-id]');
    if (!row) return;
    const glyph = this.glyphs.find((entry) => entry.id === int(row.dataset.glyphId));
    if (!glyph) return;
    this.selectedGlyphId = glyph.id;
    if (event.target.closest('[data-action="replace"]')) {
      this.replaceGlyphImage(glyph);
      return;
    }
    if (event.target.closest('[data-action="remove"]')) {
      this.removeGlyph(glyph);
      return;
    }
    this.renderGlyphTable();
    this.renderGlyphDetail();
    this.renderMetricEditor();
  }

  onGlyphTableInput(event) {
    const row = event.target.closest('[data-glyph-id]');
    if (!row) return;
    const glyph = this.glyphs.find((entry) => entry.id === int(row.dataset.glyphId));
    if (!glyph) return;
    if (event.target.matches('[data-field="character"]')) {
      const parsed = parseCharacterInput(event.target.value);
      glyph.char = parsed.valid ? parsed.char : null;
      glyph.codePoint = glyph.char?.codePointAt(0) ?? null;
      glyph.mappingInput = event.target.value;
      glyph.mappingError =
        !parsed.valid && !parsed.empty
          ? parsed.reason || 'Enter one Unicode character, alias, U+XXXX, or decimal ID.'
          : null;
      glyph.detection = parsed.valid
        ? { confidence: 'manual', reason: 'manually assigned' }
        : { confidence: 'unmapped', reason: 'manual mapping is empty or invalid' };
      if (glyph.virtual && glyph.char !== ' ') glyph.virtual = false;
      this.markDirty();
      this.renderGlyphSummary();
      this.renderGlyphWarnings();
      this.renderFooter();
    } else if (event.target.matches('[data-field="name"]')) {
      glyph.sourceName = event.target.value;
      this.markDirty({ invalidate: false });
    }
  }

  onGlyphTableChange(event) {
    if (!event.target.matches('[data-field="character"], [data-field="name"]')) return;
    const row = event.target.closest('[data-glyph-id]');
    const glyph = this.glyphs.find((entry) => entry.id === int(row?.dataset.glyphId));
    if (!glyph) return;
    if (event.target.matches('[data-field="name"]')) {
      glyph.sourceName = basename(event.target.value.trim()) || `glyph_${glyph.id}.png`;
      event.target.value = glyph.sourceName;
    }
    if (event.target.matches('[data-field="character"]')) this.renderAll();
  }

  // -----------------------------------------------------------------------
  // Mapping audit, packing and runtime-compatible preview
  // -----------------------------------------------------------------------

  audit() {
    const mapped = [];
    const unmapped = [];
    const invalid = [];
    const byCharacter = new Map();
    for (const glyph of this.glyphs) {
      const character = oneScalar(glyph.char);
      if (!character) {
        if (glyph.mappingError) invalid.push({ glyph, message: glyph.mappingError });
        else unmapped.push(glyph);
        continue;
      }
      mapped.push(glyph);
      if (!byCharacter.has(character)) byCharacter.set(character, []);
      byCharacter.get(character).push(glyph);
    }
    const duplicates = [...byCharacter.entries()]
      .filter(([, glyphs]) => glyphs.length > 1)
      .map(([character, glyphs]) => ({ character, glyphs }));
    const present = new Set(mapped.map((glyph) => glyph.char));
    const missing = [...new Set(Array.from(this.expectedCharacters || ''))].filter(
      (character) => character !== '\n' && character !== '\r' && !present.has(character)
    );
    const space = mapped.find((glyph) => glyph.char === ' ');
    return {
      mapped,
      mappedCount: mapped.length,
      mappedVisibleCount: mapped.filter((glyph) => glyph.char !== ' ').length,
      unmapped,
      invalid,
      duplicates,
      missing,
      space,
      ok: duplicates.length === 0 && invalid.length === 0 && !!space,
      canExport: duplicates.length === 0 && mapped.some((glyph) => glyph.char !== ' ') && !!space,
    };
  }

  coreGlyphs() {
    return this.glyphs.map((glyph) => {
      const virtualSpaceAdjust =
        glyph.virtual && glyph.char === ' '
          ? positiveInt(this.settings.spaceWidth, 1) - 1 - int(this.settings.letterSpacing)
          : glyph.advanceAdjust;
      return {
        ...glyph,
        sourceFilename: glyph.sourceName,
        filename: glyph.sourceName,
        sourceWidth: glyph.source.width,
        sourceHeight: glyph.source.height,
        character: glyph.char,
        codePoint: glyph.char?.codePointAt(0) ?? null,
        mappingStatus: glyph.char ? 'mapped' : glyph.mappingError ? 'invalid' : 'unmapped',
        advanceAdjust: virtualSpaceAdjust,
      };
    });
  }

  scheduleBuild() {
    clearTimeout(this._buildTimer);
    this._buildTimer = setTimeout(() => this.buildNow(), 90);
  }

  /**
   * Public/smoke-friendly synchronous-input build. Multiple callers share one
   * in-flight build, which keeps rapid metric input from racing the preview.
   */
  async buildNow() {
    if (this.build) return this.build;
    if (this._building) return this._building;
    clearTimeout(this._buildTimer);
    this._building = Promise.resolve().then(() => {
      this.ensureSpace(false);
      const audit = this.audit();
      const fileBase = safeFileBase(this.naming.fileBase);
      const textureName = `${fileBase}.${this.formats.runtimeTexture}`;
      const font = {
        fontName: this.settings.face.trim() || 'bitmapFont',
        name: this.settings.face.trim() || 'bitmapFont',
        fontSize: positiveInt(this.settings.size, 1),
        size: positiveInt(this.settings.size, 1),
        lineHeight: positiveInt(this.settings.lineHeight, 1),
        baseline: int(this.settings.baseline),
        artworkBaseline: int(this.settings.baseline),
        letterSpacing: int(this.settings.letterSpacing),
        kernings: this.kernings,
        textureFile: textureName,
        pageFile: textureName,
      };
      const packing = {
        padding: Math.max(1, int(this.settings.padding, 2)),
        border: Math.max(0, int(this.settings.border, 2)),
        maxWidth: positiveInt(this.settings.maxWidth, 4096),
        maxHeight: positiveInt(this.settings.maxHeight, 4096),
        powerOfTwo: !!this.settings.powerOfTwo,
        square: false,
        trim: !!this.settings.trim,
        extrude: Math.max(0, int(this.settings.extrude, 1)),
        allowRotation: false,
      };
      const fn =
        FontAtlas.buildFontAtlas ||
        FontAtlas.buildBitmapFontAtlas ||
        FontAtlas.packBitmapFont;
      let result;
      if (typeof fn === 'function') {
        result = fn({
          glyphs: this.coreGlyphs(),
          font,
          settings: packing,
          expectedCharacters: this.expectedCharacters,
          // Unmapped artwork remains visible in the review table but is not
          // packed. Duplicate mappings still block Next/export in this class.
          strictMappings: false,
        });
      } else {
        result = fallbackBuildFontAtlas(this.glyphs.filter((glyph) => glyph.char), {
          ...this.settings,
          ...packing,
        });
      }
      this.build = normalizeBuild(result, { ...this.settings, ...packing });
      this.build.audit = audit;
      this.verification = this.verifyBuild(this.build);
      this.renderAtlasPreview();
      this.renderPreview();
      this.renderVerification();
      this.renderExportSummary();
      this.renderFooter();
      return this.build;
    }).finally(() => {
      this._building = null;
    });
    return this._building;
  }

  verifyBuild(build) {
    const audit = this.audit();
    const blocking = [];
    const warnings = [];
    const checks = [];
    const pass = (label, detail) => checks.push({ ok: true, label, detail });
    const fail = (label, detail, block = true) => {
      checks.push({ ok: false, label, detail, block });
      (block ? blocking : warnings).push(detail);
    };

    if (!build?.ok) {
      fail('Atlas packing', build?.error || 'The atlas could not be built.');
      return { ok: false, blocking, warnings, checks, missingSample: [] };
    }
    pass('Atlas packing', `${build.width} × ${build.height}, one unrotated page`);

    if (audit.duplicates.length) {
      fail(
        'Unique mappings',
        `${audit.duplicates.length} duplicate character assignment${audit.duplicates.length === 1 ? '' : 's'} must be resolved.`
      );
    } else {
      pass('Unique mappings', `${audit.mappedCount} Unicode character IDs are unique`);
    }

    const space = build.chars.find((char) => char.id === 32);
    if (!space) {
      fail('Space glyph', 'A space glyph is required by the Pixi bitmap-font runtime.');
    } else {
      const pixels = build.atlasCanvas
        .getContext('2d', { willReadFrequently: true })
        .getImageData(space.x, space.y, Math.max(1, space.width), Math.max(1, space.height)).data;
      const transparent = pixels.every((value, index) => index % 4 !== 3 || value === 0);
      if (transparent) pass('Space glyph', `Transparent cell with ${space.xadvance}px advance`);
      else fail('Space glyph', 'The space region unexpectedly contains visible pixels.');
    }

    const coordinateErrors = [];
    const ids = new Set();
    for (const char of build.chars) {
      if (
        !Number.isInteger(char.id) ||
        !scalarFromCodePoint(char.id) ||
        ids.has(char.id) ||
        [char.x, char.y, char.width, char.height, char.xoffset, char.yoffset, char.xadvance].some(
          (value) => !Number.isInteger(value)
        ) ||
        char.x < 0 ||
        char.y < 0 ||
        char.width < 1 ||
        char.height < 1 ||
        char.x + char.width > build.width ||
        char.y + char.height > build.height
      ) {
        coordinateErrors.push(char);
      }
      ids.add(char.id);
    }
    if (coordinateErrors.length) {
      fail('Metadata coordinates', `${coordinateErrors.length} glyph record${coordinateErrors.length === 1 ? '' : 's'} are invalid or outside the texture.`);
    } else {
      pass('Metadata coordinates', `All ${build.chars.length} records are integer and inside the texture`);
    }

    if (!coordinateErrors.length) {
      const atlasContext = build.atlasCanvas.getContext('2d', { willReadFrequently: true });
      const transparentGlyphs = [];
      let visibleGlyphCount = 0;
      for (const char of build.chars) {
        if (char.id === 32) continue;
        const pixels = atlasContext.getImageData(char.x, char.y, char.width, char.height).data;
        let visible = false;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] > 0) {
            visible = true;
            break;
          }
        }
        const character = char.letter || scalarFromCodePoint(char.id);
        if (visible) visibleGlyphCount += 1;
        else transparentGlyphs.push(`${shownCharacter(character)} (${unicodeLabel(character)})`);
      }
      if (transparentGlyphs.length) {
        fail(
          'Per-glyph alpha',
          `${transparentGlyphs.length} mapped non-space glyph${transparentGlyphs.length === 1 ? ' has' : 's have'} a fully transparent packed frame: ${transparentGlyphs.join(', ')}.`,
          false
        );
      } else {
        pass('Per-glyph alpha', `All ${visibleGlyphCount} mapped non-space glyph frames contain visible pixels`);
      }
    }

    const alpha = build.atlasCanvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, build.width, build.height).data;
    let hasTransparent = false;
    let hasVisible = false;
    let hasColoredArtwork = false;
    for (let offset = 0; offset + 3 < alpha.length; offset += 4) {
      const pixelAlpha = alpha[offset + 3];
      if (pixelAlpha < 255) hasTransparent = true;
      if (pixelAlpha > 0) hasVisible = true;
      if (
        pixelAlpha >= 8 &&
        Math.max(alpha[offset], alpha[offset + 1], alpha[offset + 2]) -
          Math.min(alpha[offset], alpha[offset + 1], alpha[offset + 2]) >
          3
      ) {
        hasColoredArtwork = true;
      }
      if (hasTransparent && hasVisible && hasColoredArtwork) break;
    }
    if (!hasTransparent) fail('Transparency', 'The packed texture has no transparent pixels.', false);
    else if (!hasVisible) fail('Transparency', 'The packed texture contains no visible glyph pixels.');
    else pass('Transparency', 'Alpha transparency and visible glyph artwork are present');
    if (hasColoredArtwork) {
      fail(
        'Pixi 8 color tint',
        FontCore.PIXI_BITMAP_FONT_STYLE_GUIDANCE ||
          'Pixi 8 compatibility: keep BitmapText style stable and use fill: 0xffffff when replacing it.',
        false
      );
    }

    const available = new Set(build.chars.map((char) => char.letter || scalarFromCodePoint(char.id)));
    const missingSample = [...new Set(Array.from(this.sampleText || ''))].filter(
      (character) => !['\n', '\r', '\t'].includes(character) && !available.has(character)
    );
    if (missingSample.length) {
      fail(
        'Sample text',
        `${missingSample.length} sample character${missingSample.length === 1 ? ' is' : 's are'} missing: ${missingSample.map(shownCharacter).join(' ')}`,
        false
      );
    } else {
      pass('Sample text', 'Every character in the current sample is mapped');
    }

    if (audit.unmapped.length) {
      warnings.push(`${audit.unmapped.length} unmapped image${audit.unmapped.length === 1 ? '' : 's'} will be excluded.`);
    }
    if (audit.missing.length) {
      warnings.push(`${audit.missing.length} expected character${audit.missing.length === 1 ? ' is' : 's are'} missing.`);
    }

    // The core verifier mirrors the actual Pixi fields. Keep any additional
    // useful diagnostics without making this UI depend on its exact shape.
    const coreVerify = FontCore.verifyFontMetadata;
    if (typeof coreVerify === 'function') {
      try {
        const metadata = build.metadata || {
          info: { face: this.settings.face, size: this.settings.size },
          common: {
            lineHeight: this.settings.lineHeight,
            base: this.settings.lineHeight,
            scaleW: build.width,
            scaleH: build.height,
          },
          pages: [{ id: 0, file: `${this.naming.fileBase}.${this.formats.runtimeTexture}` }],
          chars: build.chars,
        };
        const result = coreVerify(metadata, {
          atlasWidth: build.width,
          atlasHeight: build.height,
          textureFile: `${safeFileBase(this.naming.fileBase)}.${this.formats.runtimeTexture}`,
          sampleText: this.sampleText,
          expectedCharacters: this.expectedCharacters,
          requireZeroBaseLineOffset: true,
        });
        for (const message of asArray(result?.warnings)) {
          const text = message?.message || String(message);
          if (!warnings.includes(text)) warnings.push(text);
        }
        for (const message of asArray(result?.errors)) {
          const text = message?.message || String(message);
          if (!blocking.includes(text)) blocking.push(text);
        }
      } catch (error) {
        console.warn('Core bitmap-font verifier could not run:', error);
      }
    }

    return {
      ok: blocking.length === 0,
      blocking,
      warnings,
      checks,
      missingSample,
    };
  }

  renderAtlasPreview() {
    const target = $('fontAtlasCanvas');
    const build = this.build;
    if (!build?.atlasCanvas) {
      target.width = 600;
      target.height = 300;
      target.getContext('2d').clearRect(0, 0, target.width, target.height);
      $('fontAtlasInfo').textContent = 'Not packed';
      return;
    }
    target.width = build.width;
    target.height = build.height;
    const context = target.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(build.atlasCanvas, 0, 0);
    $('fontAtlasInfo').textContent =
      `${build.width} × ${build.height} · ${build.chars.length} glyphs` +
      (Number.isFinite(build.usedPct) ? ` · ${build.usedPct.toFixed(1)}% used` : '');
  }

  renderPreview() {
    const target = $('fontTextCanvas');
    const build = this.build;
    if (!build?.ok) {
      target.width = 900;
      target.height = 300;
      const context = target.getContext('2d');
      context.fillStyle = '#10131a';
      context.fillRect(0, 0, target.width, target.height);
      context.fillStyle = '#8d96a8';
      context.font = '14px sans-serif';
      context.fillText('Pack the font to preview sample text.', 24, 36);
      $('fontTextInfo').textContent = '';
      return;
    }

    const renderer =
      FontPreview.renderBitmapFontPreview ||
      FontPreview.renderFontPreview;
    if (typeof renderer === 'function') {
      try {
        const result = renderer({
          canvas: target,
          atlasCanvas: build.atlasCanvas,
          metadata: build.metadata,
          chars: build.chars,
          text: this.sampleText,
          scale: this.previewScale,
          background: '#10131a',
        });
        if (result !== false) {
          $('fontTextInfo').textContent = `${Array.from(this.sampleText).length} sample characters · ${this.previewScale}×`;
          return;
        }
      } catch (error) {
        console.warn('Bitmap font preview helper fell back:', error);
      }
    }

    const scale = this.previewScale;
    const lineHeight = positiveInt(this.settings.lineHeight, 1);
    const chars = new Map(build.chars.map((char) => [char.letter || scalarFromCodePoint(char.id), char]));
    const fallbackAdvance = chars.get(' ')?.xadvance || this.settings.spaceWidth;
    const lines = String(this.sampleText || '').replace(/\r/g, '').split('\n');
    const widths = lines.map((line) =>
      Array.from(line).reduce((sum, character) => sum + (chars.get(character)?.xadvance || fallbackAdvance), 0)
    );
    const contentWidth = Math.max(1, ...widths);
    const margin = 24;
    target.width = Math.max(900, Math.ceil(contentWidth * scale + margin * 2));
    target.height = Math.max(300, Math.ceil(lines.length * lineHeight * scale + margin * 2));
    const context = target.getContext('2d');
    context.fillStyle = '#10131a';
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = false;
    context.save();
    context.translate(margin, margin);
    context.scale(scale, scale);

    let missing = 0;
    lines.forEach((line, lineIndex) => {
      let penX = 0;
      const lineY = lineIndex * lineHeight;
      context.strokeStyle = 'rgba(71, 191, 255, .28)';
      context.beginPath();
      context.moveTo(0, lineY + this.settings.baseline + 0.5);
      context.lineTo(contentWidth, lineY + this.settings.baseline + 0.5);
      context.stroke();
      for (const character of Array.from(line)) {
        const glyph = chars.get(character);
        if (!glyph) {
          context.strokeStyle = '#ef6b79';
          context.strokeRect(penX + 1, lineY + 1, Math.max(4, fallbackAdvance - 2), Math.max(4, lineHeight - 2));
          penX += fallbackAdvance;
          missing++;
          continue;
        }
        context.drawImage(
          build.atlasCanvas,
          glyph.x,
          glyph.y,
          glyph.width,
          glyph.height,
          penX + glyph.xoffset,
          lineY + (lineHeight - lineHeight) + glyph.yoffset,
          glyph.width,
          glyph.height
        );
        penX += glyph.xadvance;
      }
    });
    context.restore();
    $('fontTextInfo').textContent =
      `${contentWidth} × ${lines.length * lineHeight} design px · ${scale}×` +
      (missing ? ` · ${missing} missing` : ' · all sample characters mapped');
  }

  renderMetricCanvas(glyph) {
    const canvas = $('fontMetricCanvas');
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#10131a';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!glyph) return;

    const lineHeight = positiveInt(this.settings.lineHeight, 1);
    const fitScale = Math.min(
      3,
      (canvas.height - 36) / Math.max(lineHeight, glyph.source.height, 1),
      (canvas.width - 60) / Math.max(glyph.source.width + Math.abs(glyph.xAdjust), 1)
    );
    const scale = Math.max(0.25, fitScale);
    const originX = 30;
    const originY = 18;
    context.save();
    context.translate(originX, originY);
    context.scale(scale, scale);
    context.fillStyle = 'rgba(80, 130, 220, .08)';
    context.fillRect(0, 0, Math.max(glyph.source.width, this.effectiveAdvance(glyph)), lineHeight);
    context.strokeStyle = 'rgba(95, 183, 255, .5)';
    context.strokeRect(0.5, 0.5, Math.max(1, this.effectiveAdvance(glyph)) - 1, lineHeight - 1);
    context.strokeStyle = '#f0a54b';
    context.beginPath();
    context.moveTo(-10, this.settings.baseline + 0.5);
    context.lineTo(Math.max(glyph.source.width, this.effectiveAdvance(glyph)) + 10, this.settings.baseline + 0.5);
    context.stroke();
    const xoffset = glyph.xAdjust;
    const yoffset = this.settings.baseline - glyph.source.height + glyph.yAdjust;
    context.imageSmoothingEnabled = false;
    context.drawImage(glyph.source, xoffset, yoffset);
    context.restore();
  }

  effectiveAdvance(glyph) {
    if (!glyph) return 0;
    if (glyph.char === ' ') return positiveInt(this.settings.spaceWidth, 1);
    return int(glyph.source.width + this.settings.letterSpacing + glyph.advanceAdjust);
  }

  // -----------------------------------------------------------------------
  // Renderer
  // -----------------------------------------------------------------------

  renderAll() {
    this.syncControls();
    this.renderGlyphSummary();
    this.renderGlyphWarnings();
    this.renderGlyphTable();
    this.renderGlyphDetail();
    this.renderMetricEditor();
    this.renderTarget();
    this.renderVerification();
    this.renderExportSummary();
    this.renderFooter();
  }

  renderGlyphSummary() {
    const audit = this.audit();
    $('fontGlyphSummary').innerHTML =
      `<span class="font-kpi"><b>${audit.mappedCount}</b> mapped</span>` +
      `<span class="font-kpi"><b>${audit.unmapped.length + audit.invalid.length}</b> unmapped / invalid</span>` +
      `<span class="font-kpi ${audit.duplicates.length ? 'err' : ''}"><b>${audit.duplicates.length}</b> duplicates</span>` +
      `<span class="font-kpi ${audit.missing.length ? 'warn' : ''}"><b>${audit.missing.length}</b> expected missing</span>`;
  }

  renderGlyphWarnings() {
    const audit = this.audit();
    const messages = [];
    for (const duplicate of audit.duplicates) {
      messages.push({
        level: 'error',
        text:
          `${shownCharacter(duplicate.character)} (${unicodeLabel(duplicate.character)}) is assigned to ` +
          duplicate.glyphs.map((glyph) => glyph.sourceName).join(', '),
      });
    }
    if (audit.unmapped.length) {
      messages.push({
        level: 'warn',
        text: `${audit.unmapped.length} image${audit.unmapped.length === 1 ? ' is' : 's are'} unmapped and will be excluded from the packed font.`,
      });
    }
    for (const entry of audit.invalid) {
      messages.push({ level: 'error', text: `${entry.glyph.sourceName}: ${entry.message}` });
    }
    if (audit.missing.length) {
      const shown = audit.missing.slice(0, 30).map(shownCharacter).join(' ');
      messages.push({
        level: 'warn',
        text: `Expected but missing: ${shown}${audit.missing.length > 30 ? ` … and ${audit.missing.length - 30} more` : ''}`,
      });
    }
    for (const warning of this.sourceWarnings) {
      messages.push({
        level: warning?.level || 'warn',
        text: warning?.message || warning?.error || String(warning),
      });
    }
    $('fontGlyphWarnings').innerHTML = messages.length
      ? `<ul class="tight">${messages
          .map((message) =>
            `<li class="small ${message.level === 'error' ? 'err' : 'warn'}">${escapeHtml(message.text)}</li>`
          )
          .join('')}</ul>`
      : `<div class="small ok">Mappings are unique and valid.</div>`;
  }

  glyphStatus(glyph, audit = this.audit()) {
    if (glyph.mappingError) return { label: 'invalid', className: 'badge-error' };
    if (!glyph.char) return { label: 'unmapped', className: 'badge-warn' };
    if (audit.duplicates.some((entry) => entry.glyphs.includes(glyph))) {
      return { label: 'duplicate', className: 'badge-error' };
    }
    if (glyph.virtual) return { label: 'virtual space', className: 'badge-added' };
    if (glyph.warning) return { label: 'review', className: 'badge-warn' };
    return { label: glyph.detection?.confidence || 'mapped', className: 'badge-added' };
  }

  renderGlyphTable() {
    const root = $('fontGlyphTable');
    root.replaceChildren();
    const audit = this.audit();
    for (const glyph of this.glyphs) {
      const status = this.glyphStatus(glyph, audit);
      const row = document.createElement('div');
      const problematic = glyph.mappingError || !glyph.char
        ? ' invalid'
        : audit.duplicates.some((entry) => entry.glyphs.includes(glyph))
          ? ' duplicate'
          : '';
      row.className = `font-glyph-row${glyph.id === this.selectedGlyphId ? ' selected' : ''}${problematic}`;
      row.dataset.glyphId = glyph.id;

      const artwork = document.createElement('span');
      artwork.className = `font-thumb${glyph.virtual ? ' space' : ''}`;
      const preview = document.createElement('canvas');
      preview.width = 52;
      preview.height = 52;
      const context = preview.getContext('2d');
      context.imageSmoothingEnabled = false;
      const scale = Math.min(1, 44 / glyph.source.width, 44 / glyph.source.height);
      const width = Math.max(1, glyph.source.width * scale);
      const height = Math.max(1, glyph.source.height * scale);
      context.drawImage(glyph.source, (52 - width) / 2, (52 - height) / 2, width, height);
      if (glyph.virtual) {
        context.strokeStyle = '#7b8498';
        context.setLineDash([3, 2]);
        context.strokeRect(11.5, 20.5, 29, 11);
      }
      artwork.appendChild(preview);

      const source = document.createElement('span');
      const sourceInput = document.createElement('input');
      sourceInput.type = 'text';
      sourceInput.className = 'font-cell-input mono';
      sourceInput.dataset.field = 'name';
      sourceInput.value = glyph.sourceName;
      sourceInput.disabled = glyph.virtual;
      sourceInput.title = 'Editable source label used for review';
      source.appendChild(sourceInput);

      const mapping = document.createElement('span');
      const characterInput = document.createElement('input');
      characterInput.type = 'text';
      characterInput.className = `font-cell-input font-cell-char${glyph.mappingError ? ' invalid' : ''}`;
      characterInput.dataset.field = 'character';
      characterInput.value = glyph.mappingInput ?? (glyph.char === ' ' ? 'space' : glyph.char || '');
      characterInput.disabled = glyph.virtual;
      characterInput.spellcheck = false;
      characterInput.title = 'One character, alias, U+XXXX, or decimal Unicode ID';
      mapping.appendChild(characterInput);

      const unicode = document.createElement('span');
      unicode.className = 'font-code';
      unicode.textContent = unicodeLabel(glyph.char);

      const size = document.createElement('span');
      size.className = 'mono small';
      size.textContent = glyph.virtual ? '1 × 1 transparent' : `${glyph.source.width} × ${glyph.source.height}`;

      const metrics = document.createElement('span');
      metrics.className = 'font-metric-values';
      const xoffset = glyph.xAdjust;
      const yoffset = this.settings.baseline - glyph.source.height + glyph.yAdjust;
      metrics.textContent = `x ${xoffset} · y ${yoffset} · adv ${this.effectiveAdvance(glyph)}`;

      const statusCell = document.createElement('span');
      statusCell.className =
        status.className === 'badge-error'
          ? 'font-status-bad'
          : status.className === 'badge-warn'
            ? 'font-status-warn'
            : 'font-status-ok';
      statusCell.innerHTML = `<span class="badge ${status.className}">${escapeHtml(status.label)}</span>`;

      const actions = document.createElement('span');
      actions.className = 'font-row-actions';
      const replace = document.createElement('button');
      replace.className = 'btn';
      replace.dataset.action = 'replace';
      replace.textContent = 'Replace';
      replace.disabled = glyph.virtual;
      replace.title = glyph.virtual ? 'Virtual space uses a generated transparent cell' : 'Replace PNG artwork';
      const remove = document.createElement('button');
      remove.className = 'btn danger';
      remove.dataset.action = 'remove';
      remove.textContent = 'Remove';
      remove.disabled = glyph.virtual;
      remove.title = glyph.virtual ? 'A space glyph is required and is always included' : 'Remove glyph image';
      actions.append(replace, remove);

      row.append(artwork, source, mapping, unicode, size, metrics, statusCell, actions);
      root.appendChild(row);
    }
    if (!this.glyphs.length) {
      root.innerHTML = `<div class="font-empty">Import a folder of static PNG glyph images to begin.</div>`;
    }
  }

  renderGlyphDetail() {
    const root = $('fontGlyphDetail');
    const glyph = this.selectedGlyph;
    root.replaceChildren();
    const title = document.createElement('div');
    title.className = 'sub';
    title.textContent = glyph ? `${shownCharacter(glyph.char)} · ${unicodeLabel(glyph.char)}` : 'Selected glyph';
    root.appendChild(title);
    if (!glyph) {
      const empty = document.createElement('div');
      empty.className = 'dim small';
      empty.textContent = 'Select a glyph to inspect it.';
      root.appendChild(empty);
      return;
    }
    const previewWrap = document.createElement('div');
    previewWrap.className = 'font-detail-preview';
    const preview = document.createElement('canvas');
    preview.width = 220;
    preview.height = 160;
    const context = preview.getContext('2d');
    context.fillStyle = '#10131a';
    context.fillRect(0, 0, preview.width, preview.height);
    context.imageSmoothingEnabled = false;
    const scale = Math.min(1.5, 190 / glyph.source.width, 130 / glyph.source.height);
    const width = glyph.source.width * scale;
    const height = glyph.source.height * scale;
    context.drawImage(glyph.source, (preview.width - width) / 2, (preview.height - height) / 2, width, height);
    previewWrap.appendChild(preview);
    root.appendChild(previewWrap);

    const details = document.createElement('div');
    details.className = 'font-mono-block small';
    details.innerHTML =
      `<div><span class="dim">Source</span> ${escapeHtml(glyph.sourceName)}</div>` +
      `<div><span class="dim">Artwork</span> ${glyph.source.width} × ${glyph.source.height}px${glyph.virtual ? ' · transparent virtual cell' : ''}</div>` +
      `<div><span class="dim">xoffset</span> ${glyph.xAdjust}</div>` +
      `<div><span class="dim">yoffset</span> ${this.settings.baseline - glyph.source.height + glyph.yAdjust}</div>` +
      `<div><span class="dim">xadvance</span> ${this.effectiveAdvance(glyph)}</div>`;
    root.appendChild(details);
    if (glyph.detection?.reason) {
      const note = document.createElement('div');
      note.className = 'dim small';
      note.textContent = `Detection: ${glyph.detection.reason}`;
      root.appendChild(note);
    }
  }

  renderMetricEditor() {
    const select = $('fontMetricGlyph');
    const previous = this.selectedGlyphId;
    select.replaceChildren();
    for (const glyph of this.glyphs.filter((entry) => entry.char)) {
      const option = document.createElement('option');
      option.value = String(glyph.id);
      option.textContent = `${shownCharacter(glyph.char)}  ${unicodeLabel(glyph.char)}  —  ${glyph.sourceName}`;
      select.appendChild(option);
    }
    if (!this.selectedGlyph && this.glyphs.length) {
      this.selectedGlyphId = this.glyphs.find((glyph) => !glyph.virtual)?.id || this.glyphs[0].id;
    }
    if (this.selectedGlyphId != null) select.value = String(this.selectedGlyphId);
    if (select.selectedIndex < 0 && select.options.length) {
      select.selectedIndex = 0;
      this.selectedGlyphId = int(select.value);
    }
    const glyph = this.selectedGlyph;
    const disabled = !glyph || glyph.virtual;
    for (const id of ['fontXAdjust', 'fontYAdjust', 'fontAdvanceAdjust', 'fontMetricReset']) {
      $(id).disabled = disabled;
    }
    $('fontXAdjust').value = glyph?.xAdjust ?? 0;
    $('fontYAdjust').value = glyph?.yAdjust ?? 0;
    $('fontAdvanceAdjust').value = glyph?.advanceAdjust ?? 0;
    this.renderMetricCanvas(glyph);
    $('fontMetricReadout').innerHTML = glyph
      ? `<div><span class="dim">Character</span> ${escapeHtml(shownCharacter(glyph.char))} <span class="mono">${unicodeLabel(glyph.char)}</span></div>` +
        `<div><span class="dim">Source</span> ${glyph.source.width} × ${glyph.source.height}</div>` +
        `<div><span class="dim">Effective xoffset</span> ${glyph.xAdjust}</div>` +
        `<div><span class="dim">Effective yoffset</span> ${this.settings.baseline - glyph.source.height + glyph.yAdjust}</div>` +
        `<div><span class="dim">Effective xadvance</span> ${this.effectiveAdvance(glyph)}</div>` +
        (glyph.virtual ? `<div class="dim small">Space always uses a transparent 1 × 1 texture cell.</div>` : '')
      : '<span class="dim">No mapped glyph selected.</span>';
    if (previous !== this.selectedGlyphId) this.renderGlyphTable();
  }

  renderVerification() {
    const root = $('fontVerification');
    const verification = this.verification;
    if (!verification) {
      root.innerHTML = '<div class="dim small">The checks run when the atlas is packed.</div>';
      return;
    }
    root.innerHTML =
      `${verification.checks
        .map((check) =>
          `<div class="font-check ${check.ok ? 'pass' : check.block ? 'fail' : 'warn'}">` +
          `<span><strong>${escapeHtml(check.label)}</strong><br><small>${escapeHtml(check.detail)}</small></span>` +
          `</div>`
        )
        .join('')}` +
      (verification.warnings.length
        ? `<div class="font-message-list"><ul class="tight">${verification.warnings
            .map((message) => `<li class="warn small">${escapeHtml(message)}</li>`)
            .join('')}</ul></div>`
        : '');
  }

  renderFooter() {
    const audit = this.audit();
    $('fontBack').disabled = STEPS.indexOf(this.step) === 0;
    const next = $('fontNext');
    if (this.step === 'export') next.textContent = this.exported ? 'Done' : 'Export Package…';
    else next.textContent = 'Next →';
    if (this.step === 'glyphs') {
      next.disabled = audit.mappedVisibleCount < 1 || audit.duplicates.length > 0;
    } else if (this.step === 'layout' || this.step === 'preview') {
      next.disabled = this.build ? !this.build.ok || !!this.verification?.blocking?.length : false;
    } else {
      next.disabled = !this.canExport();
    }
    const status = [];
    if (this.dirty) status.push('font has unexported changes');
    if (audit.unmapped.length) status.push(`${audit.unmapped.length} unmapped excluded`);
    if (audit.missing.length) status.push(`${audit.missing.length} expected missing`);
    if (this.build?.ok) status.push(`${this.build.width} × ${this.build.height} atlas`);
    $('fontFooterStatus').textContent = status.join(' · ');
  }

  // -----------------------------------------------------------------------
  // Stake project target, output and registration
  // -----------------------------------------------------------------------

  async pickProject() {
    const root = await native.pickDirectory({
      title: 'Select the Stake Engine project (or one app folder)',
    });
    if (!root) return;
    try {
      const apps = await native.fontFindApps(root);
      if (!apps?.length) {
        this.toast('No Web SDK app with src/game/assets.ts was found under that folder.', 'error', 7000);
        return;
      }
      let appDir = apps[0].dir;
      if (apps.length > 1) {
        if (!this.choiceDialog) {
          this.toast('Select an individual app folder when a project contains multiple apps.', 'warn', 7000);
          return;
        }
        const selected = await this.choiceDialog({
          title: 'Select the game app',
          message: 'This project contains several Web SDK apps. Choose the font target.',
          buttons: [
            ...apps.map((app, index) => ({
              label: app.name,
              value: app.dir,
              primary: index === 0,
            })),
            { label: 'Cancel', value: null },
          ],
        });
        if (!selected) return;
        appDir = selected;
      }
      const target = await native.fontInspectApp(appDir);
      if (!target?.ok) throw new Error(target?.error || 'The app could not be inspected.');
      this.target = target;
      this.outputParent = target.fontsRoot;
      if (target.preferredTextureFormat === 'png' || target.preferredTextureFormat === 'webp') {
        this.formats.runtimeTexture = target.preferredTextureFormat;
      }
      if (target.createAssetAvailable === false) this.formats.index = false;
      this.formats.registerAfter = !!this.formats.xml;
      this.coerceFormats();
      this.autoAdoptRegistration();
      this.syncControls();
      this.markDirty({ invalidate: false });
      this.renderAll();
    } catch (error) {
      this.toast(`Could not inspect the Web SDK project: ${error?.message || error}`, 'error', 9000);
    }
  }

  async chooseOutputParent() {
    const folder = await native.pickDirectory({
      title: this.target
        ? 'Choose an output parent (registration requires this app’s fonts folder)'
        : 'Choose where to create the bitmap font package folder',
    });
    if (!folder) return;
    this.outputParent = folder;
    if (this.target && !this.outputTargetsProject()) this.formats.registerAfter = false;
    this.syncControls();
    this.markDirty({ invalidate: false });
    this.renderAll();
  }

  samePath(a, b) {
    const normalize = (value) =>
      String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(a) === normalize(b);
  }

  outputTargetsProject() {
    return !!this.target && this.samePath(this.outputParent, this.target.fontsRoot);
  }

  desiredXmlRel(names = this.outputNames()) {
    return `fonts/${names.folderName}/${names.xmlFile}`;
  }

  registeredFontEntries() {
    return asArray(this.target?.registeredFonts || this.target?.fontEntries);
  }

  /**
   * How this export relates to assets.ts: `add` a new key, `update` the font
   * already registered at the same XML, or `repoint` an existing key at a new
   * XML path. The asset key identifies the font being updated.
   */
  registrationPlan(names = this.outputNames()) {
    if (!this.target) return null;
    const entry = this.registeredFontEntries().find((item) => String(item.key) === names.assetKey);
    if (!entry) return { mode: 'add', entry: null };
    const samePath =
      String(entry.xmlRel || '').toLowerCase() === this.desiredXmlRel(names).toLowerCase();
    return { mode: samePath ? 'update' : 'repoint', entry };
  }

  registrationPlanText(plan, names = this.outputNames()) {
    if (!plan) return '';
    if (plan.mode === 'update') {
      return `Updates registered font "${plan.entry.key}" in place; its package files are overwritten and assets.ts is unchanged.`;
    }
    if (plan.mode === 'repoint') {
      return `Updates registered font "${plan.entry.key}": assets.ts will point at ${this.desiredXmlRel(names)} instead of ${plan.entry.xmlRel}.`;
    }
    return `Adds a new font registration "${names.assetKey}".`;
  }

  targetCollisions(names = this.outputNames()) {
    if (!this.target) return [];
    const desiredPath = this.desiredXmlRel(names).toLowerCase();
    const desiredKey = names.assetKey;
    const desiredFace = this.settings.face.trim();
    const entries = this.registeredFontEntries();
    const issues = [];
    // The entry with the same key is the font being updated, so its old path
    // and face are replaced rather than collided with. Only other keys can
    // own this XML path or runtime face.
    for (const entry of entries) {
      if (String(entry.key) === desiredKey) continue;
      if (String(entry.xmlRel || '').toLowerCase() === desiredPath) {
        issues.push({
          level: 'error',
          message: `${this.desiredXmlRel(names)} is already registered as "${entry.key}". Choose "${entry.key}" under Update registered font to overwrite it.`,
        });
      }
      if (entry.face === desiredFace) {
        issues.push({
          level: 'error',
          message: `Runtime face "${desiredFace}" is already registered by "${entry.key}". Pixi caches bitmap fonts by face, so update "${entry.key}" or rename the face.`,
        });
      }
    }
    // existingKeys also contains non-font assets, which a font must not replace.
    if (
      asArray(this.target.existingKeys).includes(desiredKey) &&
      !entries.some((entry) => String(entry.key) === desiredKey)
    ) {
      issues.push({
        level: 'error',
        message: `Asset key "${desiredKey}" is already used by a non-font asset in src/game/assets.ts.`,
      });
    }
    return issues;
  }

  /**
   * Naming that reproduces a registered font's exact XML path and key, or
   * null when the exporter cannot write there (e.g. a nested folder).
   */
  adoptableNaming(entry) {
    const match = /^fonts\/([^/]+)\/([^/]+)\.xml$/i.exec(String(entry?.xmlRel || ''));
    if (!match) return null;
    const naming = { fileBase: match[2], folderName: match[1], assetKey: String(entry.key) };
    const names = this.outputNames(naming);
    const samePath =
      this.desiredXmlRel(names).toLowerCase() === String(entry.xmlRel).toLowerCase();
    return samePath && names.assetKey === naming.assetKey ? naming : null;
  }

  /** Point the export at a registered font so the next export overwrites it. */
  adoptRegisteredFont(key) {
    const entry = this.registeredFontEntries().find((item) => String(item.key) === key);
    const naming = entry ? this.adoptableNaming(entry) : null;
    if (!naming) {
      this.toast(
        `"${key}" is registered at ${entry?.xmlRel || 'an unknown path'}, which is not a direct fonts/<folder>/<file>.xml package this exporter can overwrite.`,
        'warn',
        9000
      );
      return false;
    }
    Object.assign(this.naming, naming);
    // Game code selects bitmap fonts by face, so keep the registered face.
    if (entry.face) this.settings.face = entry.face;
    if (entry.pageFormat === 'png' || entry.pageFormat === 'webp') {
      this.formats[entry.pageFormat] = true;
      this.formats.runtimeTexture = entry.pageFormat;
    }
    this.outputParent = this.target.fontsRoot;
    this.formats.registerAfter = true;
    this.coerceFormats();
    this.syncControls();
    this.markDirty({ invalidate: false });
    this.renderAll();
    return true;
  }

  /**
   * Select the registered font this source updates, if any: the entry whose
   * XML was opened, otherwise the entry that already owns the runtime face
   * (Pixi cannot load two fonts with one face, so that font can only be
   * updated or the face renamed).
   */
  autoAdoptRegistration() {
    if (!this.target) return null;
    const normalize = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const sourceXml = normalize(this.source?.selectedMetadata?.path || this.source?.metadata?.path);
    const face = this.settings.face.trim();
    const entries = this.registeredFontEntries();
    const entry =
      (sourceXml && entries.find((item) => normalize(item.absolutePath) === sourceXml)) ||
      entries.find((item) => item.face && item.face === face) ||
      null;
    if (!entry || !this.adoptableNaming(entry)) return null;
    if (this.registrationPlan()?.entry === entry) return entry;
    if (!this.adoptRegisteredFont(String(entry.key))) return null;
    this.toast(
      `This export will update the registered font "${entry.key}" (${entry.xmlRel}).`,
      'info',
      7000
    );
    return entry;
  }

  renderExistingFontPicker(plan) {
    const select = $('fontExistingFont');
    if (!select) return;
    const entries = this.registeredFontEntries();
    const placeholder = !this.target
      ? 'Select a project first'
      : entries.length
        ? 'None: add as a new font'
        : 'No fonts registered in this app';
    select.innerHTML =
      `<option value="">${escapeHtml(placeholder)}</option>` +
      entries
        .map((entry) => {
          const supported = !!this.adoptableNaming(entry);
          return (
            `<option value="${escapeHtml(entry.key)}"${supported ? '' : ' disabled'}>` +
            `${escapeHtml(entry.key)} · ${escapeHtml(entry.face || 'no face')} · ${escapeHtml(entry.xmlRel)}` +
            `${supported ? '' : ' (unsupported path)'}</option>`
          );
        })
        .join('');
    select.disabled = !this.target || !entries.length;
    select.value = plan?.entry ? String(plan.entry.key) : '';
  }

  renderTarget() {
    const root = $('fontTargetInfo');
    if (!this.target) {
      this.renderExistingFontPicker(null);
      root.innerHTML =
        `No project selected. Choose an output parent for a standalone package. ` +
        `<span class="dim">Current Web SDK projects load BMFont XML from assets.ts; index.ts is legacy compatibility output.</span>`;
      return;
    }
    const target = this.target;
    const names = this.outputNames();
    const collisions = this.targetCollisions(names);
    const plan = this.registrationPlan(names);
    this.renderExistingFontPicker(plan);
    root.innerHTML =
      `<div><span class="dim">App</span> ${escapeHtml(target.appName)} <span class="dim">${escapeHtml(target.appDir)}</span></div>` +
      `<div><span class="dim">Runtime</span> Pixi ${escapeHtml(target.pixiVersion || 'unknown')} · pixi-svelte ${escapeHtml(target.pixiSvelteVersion || 'unknown')}</div>` +
      `<div><span class="dim">Loader</span> BMFont XML via <span class="mono">src/game/assets.ts</span> · preferred page ${escapeHtml(target.preferredTextureFormat || 'webp')}</div>` +
      `<div><span class="dim">Fonts folder</span> ${escapeHtml(target.fontsRoot)}</div>` +
      `<div><span class="dim">Registered fonts</span> ${asArray(target.registeredFonts).length}</div>` +
      (collisions.length
        ? `<div class="err">${escapeHtml(collisions.map((issue) => issue.message).join(' '))}</div>`
        : `<div class="ok">${escapeHtml(this.registrationPlanText(plan, names))}</div>`) +
      asArray(target.warnings)
        .map((warning) => `<div class="warn">${escapeHtml(warning?.message || String(warning))}</div>`)
        .join('');
  }

  outputNames(naming = this.naming) {
    const names = this.sanitizedOutputNames(naming);
    // The Asset key field is authoritative whenever it is a valid identifier,
    // so an existing assets.ts key is reproduced exactly instead of re-cased.
    if (VALID_ASSET_KEY.test(String(naming.assetKey || ''))) names.assetKey = naming.assetKey;
    return names;
  }

  sanitizedOutputNames(naming) {
    const fn = FontCore.buildOutputNames || FontCore.createOutputNames;
    const input = {
      fontName: this.settings.face,
      fileBase: naming.fileBase,
      folderName: naming.folderName,
      assetKey: naming.assetKey,
      runtimeTexture: this.formats.runtimeTexture,
      includePng: this.formats.png,
      includeWebp: this.formats.webp,
      includeXml: this.formats.xml,
      includeJson: this.formats.json,
      includeIndex: this.formats.index,
    };
    if (typeof fn === 'function') {
      try {
        return fn(input);
      } catch (error) {
        console.warn('Output naming helper fell back:', error);
      }
    }
    const fileBase = safeFileBase(naming.fileBase);
    return {
      fontName: this.settings.face,
      fileBase,
      folderName: safeFolderName(naming.folderName),
      assetKey: assetKeyFrom(naming.assetKey),
      pngFile: `${fileBase}.png`,
      webpFile: `${fileBase}.webp`,
      textureFile: `${fileBase}.${this.formats.runtimeTexture}`,
      xmlFile: `${fileBase}.xml`,
      jsonFile: `${fileBase}.json`,
      indexFile: 'index.ts',
      files: [
        this.formats.png ? `${fileBase}.png` : null,
        this.formats.webp ? `${fileBase}.webp` : null,
        this.formats.xml ? `${fileBase}.xml` : null,
        this.formats.json ? `${fileBase}.json` : null,
        this.formats.index ? 'index.ts' : null,
      ].filter(Boolean),
    };
  }

  canExport() {
    const audit = this.audit();
    const unresolvedSourceErrors = this.sourceWarnings.filter(
      (warning) => warning?.level === 'error'
    );
    return (
      audit.canExport &&
      unresolvedSourceErrors.length === 0 &&
      !!this.build?.ok &&
      !this.verification?.blocking?.length &&
      !!this.outputParent &&
      !!this.settings.face.trim() &&
      this.formats.xml &&
      (this.formats.png || this.formats.webp) &&
      (!this.formats.registerAfter ||
        (this.target &&
          this.formats.xml &&
          this.outputTargetsProject() &&
          this.targetCollisions().length === 0))
    );
  }

  createMetadata(textureName) {
    const fn = FontCore.createBitmapFontMetadata || FontCore.buildFontMetadata;
    if (typeof fn === 'function') {
      return fn({
        fontName: this.settings.face.trim() || 'bitmapFont',
        fontSize: positiveInt(this.settings.size, 1),
        lineHeight: positiveInt(this.settings.lineHeight, 1),
        baseline: int(this.settings.baseline),
        artworkBaseline: int(this.settings.baseline),
        atlasWidth: this.build.width,
        atlasHeight: this.build.height,
        textureFile: textureName,
        chars: this.build.chars,
        kernings: this.kernings,
      });
    }
    return {
      info: { face: this.settings.face, size: this.settings.size },
      common: {
        lineHeight: this.settings.lineHeight,
        base: this.settings.lineHeight,
        scaleW: this.build.width,
        scaleH: this.build.height,
        pages: 1,
        packed: 0,
      },
      pages: [{ id: 0, file: textureName }],
      chars: this.build.chars,
      kernings: this.kernings,
    };
  }

  prepareExportArtifacts() {
    const names = this.outputNames();
    const metadata = this.createMetadata(names.textureFile);
    const serializeXml = FontCore.serializeBMFontXML || FontCore.serializeFontXML;
    const serializeJson = FontCore.serializeBMFontJSON || FontCore.serializeFontJSON;
    const xml = typeof serializeXml === 'function'
      ? serializeXml(metadata, { textureFile: names.textureFile })
      : localXml(this.build, this.settings, names.textureFile);
    const json = typeof serializeJson === 'function'
      ? serializeJson(metadata, { textureFile: names.textureFile, style: 'legacy', pretty: true })
      : localJson(this.build, this.settings, names.textureFile);
    const createIndex =
      FontCore.generateFontIndexTS ||
      FontCore.generateIndexTs ||
      FontCore.generateStakeFontIndex;
    const indexTs = typeof createIndex === 'function'
      ? createIndex({ textureFile: names.textureFile, jsonFile: names.jsonFile })
      : callSerializer('index', this.build, this.settings, names.textureFile, names.fileBase);
    const createSnippet =
      FontCore.generateAssetsTsSnippet ||
      FontCore.generateAssetRegistrationSnippet;
    const assetsTsSnippet = typeof createSnippet === 'function'
      ? createSnippet({
          assetKey: names.assetKey,
          folderName: names.folderName,
          xmlFile: names.xmlFile,
        })
      : '';
    const texturePixels = this.build.atlasCanvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, this.build.width, this.build.height);
    const verify = FontCore.verifyBitmapFontBuild;
    const verification = typeof verify === 'function'
      ? verify({
          xml,
          json: this.formats.json ? json : null,
          metadata,
          atlasWidth: this.build.width,
          atlasHeight: this.build.height,
          textureFile: names.textureFile,
          jsonFile: names.jsonFile,
          xmlFile: names.xmlFile,
          indexTs: this.formats.index ? indexTs : null,
          assetsTsSnippet,
          assetKey: names.assetKey,
          sampleText: this.sampleText,
          expectedCharacters: this.expectedCharacters,
          texturePixels,
        })
      : { ok: true, errors: [], warnings: [], checks: {} };
    const textFiles = [];
    if (this.formats.xml) textFiles.push({ name: names.xmlFile, text: xml });
    if (this.formats.json) textFiles.push({ name: names.jsonFile, text: json });
    if (this.formats.index) textFiles.push({ name: names.indexFile, text: indexTs });
    return {
      names,
      metadata,
      xml,
      json,
      indexTs,
      assetsTsSnippet,
      verification,
      texturePixels,
      textFiles,
    };
  }

  exportWarnings() {
    const audit = this.audit();
    const warnings = [];
    if (audit.unmapped.length || audit.invalid.length) {
      warnings.push({
        level: 'warn',
        message: `${audit.unmapped.length + audit.invalid.length} unmapped or invalid image${audit.unmapped.length + audit.invalid.length === 1 ? '' : 's'} will not be exported.`,
      });
    }
    if (audit.missing.length) {
      warnings.push({
        level: 'warn',
        message: `${audit.missing.length} expected character${audit.missing.length === 1 ? ' is' : 's are'} missing.`,
      });
    }
    for (const message of asArray(this.verification?.warnings)) {
      const text = message?.message || String(message);
      if (
        message?.code === 'pixi-bitmap-font-white-tint' ||
        /fully transparent packed frame|Pixi 8 compatibility: colored bitmap glyphs/i.test(text)
      ) {
        warnings.push({ level: 'warn', message: text });
      }
    }
    for (const sourceWarning of this.sourceWarnings) {
      const message = sourceWarning?.message || sourceWarning?.error || String(sourceWarning);
      if (!warnings.some((warning) => warning.message === message)) {
        warnings.push({
          level: sourceWarning?.level === 'error' ? 'error' : sourceWarning?.level === 'info' ? 'info' : 'warn',
          message,
        });
      }
    }
    if (!this.formats.xml) {
      warnings.push({
        level: 'warn',
        message: 'BMFont XML is disabled. Current Stake Web SDK apps cannot load this package as a bitmap font.',
      });
    }
    if (this.formats.index) {
      warnings.push({
        level: 'info',
        message: 'index.ts is a legacy createAsset compatibility artifact. The selected project runtime registers the XML in assets.ts.',
      });
    }
    if (this.target && !this.outputTargetsProject()) {
      warnings.push({
        level: 'warn',
        message: 'Output is outside the selected app’s fonts folder, so automatic registration is unavailable.',
      });
    }
    const updatedFace = this.registrationPlan()?.entry?.face;
    const face = this.settings.face.trim();
    if (updatedFace && updatedFace !== face) {
      const usage = asArray(this.target.fontFamilyUsage).find((item) => item.family === updatedFace);
      const files = asArray(usage?.files);
      warnings.push({
        level: 'warn',
        message:
          `The runtime face changes from "${updatedFace}" to "${face}". ` +
          (usage
            ? `Update the ${usage.count} fontFamily reference${usage.count === 1 ? '' : 's'} to "${updatedFace}" in ` +
              `${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}.`
            : 'Game code that selects the old face must be updated.'),
      });
    }
    warnings.push(...this.targetCollisions());
    return warnings;
  }

  renderExportSummary() {
    const names = this.outputNames();
    const audit = this.audit();
    const output = this.outputParent
      ? joinPath(this.outputParent, names.folderName)
      : 'Choose an output parent';
    $('fontExportSummary').innerHTML =
      `<div class="info-grid">` +
      `<div class="k">Runtime face</div><div class="v mono">${escapeHtml(this.settings.face || '—')}</div>` +
      `<div class="k">Mapped glyphs</div><div class="v mono">${audit.mappedCount} (${audit.mappedVisibleCount} visible + space)</div>` +
      `<div class="k">Review issues</div><div class="v">${audit.unmapped.length + audit.invalid.length} unmapped / invalid · ${audit.duplicates.length} duplicates · ${audit.missing.length} expected missing</div>` +
      `<div class="k">Texture</div><div class="v mono">${this.build?.ok ? `${this.build.width} × ${this.build.height}` : 'not packed'} · ${escapeHtml(names.textureFile)} runtime page</div>` +
      `<div class="k">Output</div><div class="v mono">${escapeHtml(output)}</div>` +
      `<div class="k">Files</div><div class="v mono">${names.files.map(escapeHtml).join(', ')}</div>` +
      `<div class="k">Registration</div><div class="v">${
        this.formats.registerAfter
          ? `XML → <span class="mono">src/game/assets.ts</span> as <span class="mono">${escapeHtml(names.assetKey)}</span>` +
            ` <span class="dim">${escapeHtml(this.registrationPlanText(this.registrationPlan(names), names))}</span>`
          : 'not requested'
      }</div>` +
      `</div>`;
    const warnings = this.exportWarnings();
    $('fontExportWarnings').innerHTML = warnings.length
      ? `<ul class="tight">${warnings
          .map((warning) =>
            `<li class="small ${warning.level === 'error' ? 'err' : warning.level === 'warn' ? 'warn' : 'dim'}">${escapeHtml(warning.message)}</li>`
          )
          .join('')}</ul>`
      : '<div class="ok small">Ready for a verified package export.</div>';
  }

  /**
   * Public/smoke-friendly export entry point. `options.outputParent` may be
   * supplied by automation; interactive use chooses it in the Export step.
   */
  async exportNow(options = {}) {
    if (options.outputParent) {
      this.outputParent = options.outputParent;
      this.syncControls();
    }
    const build = await this.buildNow();
    if (!build?.ok) {
      this.toast(`Cannot export: ${build?.error || 'atlas packing failed'}`, 'error', 8000);
      return null;
    }
    const audit = this.audit();
    if (audit.duplicates.length) {
      this.toast('Resolve duplicate character mappings before export.', 'error', 7000);
      return null;
    }
    const unresolvedSourceErrors = this.sourceWarnings.filter(
      (warning) => warning?.level === 'error'
    );
    if (unresolvedSourceErrors.length) {
      this.toast(
        `Cannot export: ${unresolvedSourceErrors[0]?.message || 'the imported package has unresolved errors.'}`,
        'error',
        9000
      );
      this.goto('glyphs');
      return null;
    }
    if (audit.unmapped.length || audit.invalid.length) {
      const count = audit.unmapped.length + audit.invalid.length;
      const proceed = this.choiceDialog
        ? await this.choiceDialog({
            title: 'Exclude unmapped artwork?',
            message: `${count} image${count === 1 ? ' is' : 's are'} unmapped or invalid and will not be packed. Mapped glyphs and the transparent space will still export.`,
            buttons: [
              { label: 'Return to Glyphs', value: false },
              { label: 'Export Mapped Glyphs', value: true, primary: true },
            ],
          })
        : window.confirm(`Exclude ${count} unmapped glyph image(s) and continue?`);
      if (!proceed) {
        this.goto('glyphs');
        return null;
      }
    }
    if (!this.outputParent) {
      const folder = await native.pickDirectory({
        title: 'Choose where to create the bitmap font package folder',
      });
      if (!folder) return null;
      this.outputParent = folder;
      this.syncControls();
    }
    if (this.formats.registerAfter) {
      if (!this.target || !this.formats.xml || !this.outputTargetsProject()) {
        this.toast('Automatic registration requires XML exported inside the selected app’s fonts folder.', 'error', 8000);
        return null;
      }
      const collisions = this.targetCollisions();
      if (collisions.length) {
        this.toast(collisions[0].message, 'error', 9000);
        return null;
      }
    }

    let artifacts;
    try {
      artifacts = this.prepareExportArtifacts();
    } catch (error) {
      console.error(error);
      this.toast(`Could not generate font metadata: ${error?.message || error}`, 'error', 9000);
      return null;
    }
    const coreErrors = asArray(artifacts.verification?.errors);
    if (artifacts.verification?.ok === false || coreErrors.length) {
      const message = coreErrors[0]?.message || coreErrors[0]?.error || 'Generated metadata failed verification.';
      this.toast(`Cannot export: ${message}`, 'error', 9000);
      $('fontExportResult').innerHTML =
        `<div class="err">Pre-write verification failed.</div>` +
        `<ul class="tight">${coreErrors.map((error) => `<li class="err small">${escapeHtml(error?.message || String(error))}</li>`).join('')}</ul>`;
      return null;
    }

    const names = artifacts.names;
    const outDir = joinPath(this.outputParent, names.folderName);
    const writeOptions = {
      outDir,
      width: build.width,
      height: build.height,
      rgba: artifacts.texturePixels.data,
      pngName: this.formats.png ? names.pngFile : undefined,
      webpName: this.formats.webp ? names.webpFile : undefined,
      textFiles: artifacts.textFiles,
      overwrite: !!options.overwrite,
    };
    $('fontNext').disabled = true;
    $('fontNext').textContent = 'Encoding & verifying…';
    $('fontExportResult').innerHTML =
      '<div class="dim">Encoding lossless textures and verifying the staged package…</div>';
    const exportRevision = this._revision;
    let result;
    this.setExporting(true);
    try {
      result = await native.fontWritePackage(writeOptions);
      if (!result?.ok && result?.conflict?.length && !options.overwrite) {
        // Conflicts are reported before anything is encoded, so say what is
        // actually pending while the user decides.
        $('fontNext').textContent = 'Waiting for confirmation…';
        $('fontExportResult').innerHTML =
          '<div class="dim">Waiting for confirmation to replace the existing files…</div>';
        const plan = this.formats.registerAfter ? this.registrationPlan(names) : null;
        const count = result.conflict.length;
        const overwrite = this.choiceDialog
          ? await this.choiceDialog({
              title: plan?.entry ? `Update bitmap font "${plan.entry.key}"?` : 'Overwrite existing files?',
              message:
                (plan?.entry ? `${this.registrationPlanText(plan, names)}\n\n` : '') +
                `${count} file${count === 1 ? ' already exists' : 's already exist'} in ${outDir} and will be replaced:\n` +
                `${result.conflict.slice(0, 8).join(', ')}${count > 8 ? ', …' : ''}\n\n` +
                'Other files in the folder are untouched.',
              buttons: [
                { label: 'Cancel', value: false },
                {
                  label: plan?.entry ? 'Overwrite and Update' : 'Overwrite Files',
                  value: true,
                  primary: true,
                },
              ],
            })
          : window.confirm('Overwrite the existing generated bitmap-font files?');
        if (!overwrite) {
          this.renderExportResult();
          this.renderFooter();
          return null;
        }
        $('fontNext').textContent = 'Encoding & verifying…';
        $('fontExportResult').innerHTML =
          '<div class="dim">Encoding lossless textures and verifying the staged package…</div>';
        result = await native.fontWritePackage({ ...writeOptions, overwrite: true });
      }
    } catch (error) {
      console.error(error);
      this.toast(`Could not write the font package: ${error?.message || error}`, 'error', 10000);
      $('fontExportResult').innerHTML = `<div class="err">${escapeHtml(error?.message || String(error))}</div>`;
      this.renderFooter();
      return null;
    } finally {
      this.setExporting(false);
    }
    if (!result?.ok) {
      const messages = asArray(result?.verification?.structure?.errors)
        .map((error) => error?.message || String(error));
      const message = result?.error || messages[0] || 'The encoded package failed verification.';
      this.toast(`Could not write the font package: ${message}`, 'error', 10000);
      $('fontExportResult').innerHTML =
        `<div class="err">${escapeHtml(message)}</div>` +
        (messages.length ? `<ul class="tight">${messages.map((item) => `<li class="err small">${escapeHtml(item)}</li>`).join('')}</ul>` : '');
      this.renderFooter();
      return null;
    }

    this.exported = {
      ...result,
      outDir: result.outDir || outDir,
      names,
      artifacts,
      stats: {
        glyphCount: build.chars.length,
        width: build.width,
        height: build.height,
      },
      firstFile: joinPath(result.outDir || outDir, this.formats.xml ? names.xmlFile : names.textureFile),
      registered: null,
    };
    const exportedCurrentRevision = this.markClean(exportRevision);
    if (!exportedCurrentRevision) {
      this.toast(
        'The package was exported, but newer font changes remain unexported.',
        'warn',
        7000
      );
    }
    this.renderExportResult();
    this.renderFooter();
    this.toast(`Bitmap font exported: ${build.chars.length} glyphs · ${build.width} × ${build.height}`, 'info', 7000);

    if (this.formats.registerAfter) await this.registerInProject();
    return this.exported;
  }

  renderExportResult() {
    const root = $('fontExportResult');
    const exported = this.exported;
    if (!exported) {
      root.className = 'font-summary-block dim';
      root.textContent = 'Nothing exported in this session.';
      $('fontOpenExportFolder').disabled = true;
      $('fontRegisterNow').disabled = true;
      return;
    }
    root.className = 'font-summary-block';
    const written = asArray(exported.written);
    const textureChecks = asArray(exported.verification?.textures);
    const verificationOk = exported.verification?.ok !== false;
    const stats = exported.stats || {
      glyphCount: this.build?.chars?.length ?? 0,
      width: this.build?.width ?? 0,
      height: this.build?.height ?? 0,
    };
    root.innerHTML =
      `<div class="info-grid">` +
      `<div class="k">Output folder</div><div class="v mono">${escapeHtml(exported.outDir)}</div>` +
      `<div class="k">Glyphs</div><div class="v mono">${stats.glyphCount}</div>` +
      `<div class="k">Atlas</div><div class="v mono">${stats.width} × ${stats.height}</div>` +
      `<div class="k">Package verification</div><div class="v">${
        verificationOk
          ? '<span class="badge badge-added">passed</span> coordinates, page reference, alpha and encoded texture checks'
          : '<span class="badge badge-error">failed</span>'
      }</div>` +
      (textureChecks.length
        ? `<div class="k">Textures</div><div class="v">${textureChecks
            .map((texture) =>
              `<span class="mono">${escapeHtml(texture.name || texture.format || 'texture')}</span> ` +
              `<span class="dim">${texture.lossless === false ? 'unexpectedly lossy' : 'lossless'}${texture.vp8l ? ' · VP8L' : ''}</span>`
            )
            .join('<br>')}</div>`
        : '') +
      `</div>` +
      `<div class="sub">Files written</div>` +
      `<ul class="tight">${written
        .map((file) =>
          `<li class="mono small">${escapeHtml(file.name)} <span class="dim">${formatBytes(Number(file.bytes) || 0)}</span></li>`
        )
        .join('')}</ul>` +
      (exported.registered
        ? `<div class="${exported.registered.ok ? 'ok' : 'err'} small">${escapeHtml(exported.registered.message)}</div>`
        : '');
    $('fontOpenExportFolder').disabled = false;
    $('fontRegisterNow').disabled =
      !this.target ||
      !this.formats.xml ||
      !this.outputTargetsProject() ||
      this.targetCollisions(exported.names || this.outputNames()).length > 0 ||
      exported.verification?.ok === false;
  }

  async registerInProject() {
    if (this._exporting || this._importing) return null;
    const exported = this.exported;
    if (!exported || !this.target) {
      this.toast('Export into a selected project before registering the bitmap font.', 'warn', 6000);
      return null;
    }
    if (!this.formats.xml || !this.outputTargetsProject()) {
      this.toast('Registration requires the exported XML inside this app’s fonts folder.', 'error', 7000);
      return null;
    }
    const names = exported.names || this.outputNames();
    const collisions = this.targetCollisions(names);
    if (collisions.length) {
      this.toast(collisions[0].message, 'error', 9000);
      return null;
    }
    this.setExporting(true);
    try {
      const result = await native.fontRegister({
        appDir: this.target.appDir,
        key: names.assetKey,
        xmlRel: `fonts/${names.folderName}/${names.xmlFile}`,
        // The export step already showed and confirmed the update plan.
        replaceExisting: true,
      });
      if (!result?.ok) {
        throw new Error(result?.error || 'The registration was rejected.');
      }
      const added = asArray(result.added || result.addedEntries);
      const updated = asArray(result.updatedEntries);
      const already = asArray(result.alreadyRegistered);
      const message = added.length
        ? `Registered "${names.assetKey}" in ${result.file}. Reload the game to load the new bitmap font.`
        : updated.length
          ? `Updated "${names.assetKey}" in ${result.file}: ${updated[0].previousXmlRel} → ${updated[0].xmlRel}. Reload the game to load the updated font.`
          : already.length
            ? `"${names.assetKey}" already points at this XML, so assets.ts is unchanged. Reload the game to load the updated font files.`
            : `Registration is already up to date in ${result.file}.`;
      exported.registered = { ok: true, result, message };
      this.toast(message, 'info', 8000);
      try {
        const refreshed = await native.fontInspectApp(this.target.appDir);
        if (refreshed?.ok) this.target = refreshed;
      } catch {
        // The successful registration result remains authoritative.
      }
      this.renderTarget();
      this.renderExportResult();
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      exported.registered = { ok: false, message };
      this.toast(`Could not register the bitmap font: ${message}`, 'error', 10000);
      this.renderExportResult();
      return null;
    } finally {
      this.setExporting(false);
    }
  }
}
