// Pure bitmap-font model, filename mapping, BMFont parsing/serialization,
// Stake Engine registration helpers, compatible text layout and verification.
//
// This module deliberately has no DOM dependency so the exporter rules can be
// regression-tested with plain Node. Canvas-specific work lives in fontAtlas,
// fontImport and fontPreview.

const MAX_UNICODE = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const INTEGER_METRICS = [
  'x',
  'y',
  'width',
  'height',
  'xoffset',
  'yoffset',
  'xadvance',
  'yadvance',
  'page',
  'chnl',
];

const CHARACTER_ALIASES = new Map(
  Object.entries({
    space: ' ',
    whitespace: ' ',
    blank: ' ',
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
    quotationmark: '"',
    hyphen: '-',
    minus: '-',
    dash: '-',
    endash: '–',
    emdash: '—',
    plus: '+',
    equals: '=',
    equal: '=',
    slash: '/',
    forwardslash: '/',
    backslash: '\\',
    underscore: '_',
    ampersand: '&',
    and: '&',
    at: '@',
    atsign: '@',
    hash: '#',
    hashtag: '#',
    numbersign: '#',
    dollar: '$',
    dollarsign: '$',
    euro: '€',
    eurosign: '€',
    sterling: '£',
    poundsterling: '£',
    poundsign: '£',
    yen: '¥',
    yensign: '¥',
    yuan: '¥',
    cent: '¢',
    centsign: '¢',
    rupee: '₹',
    rupeesign: '₹',
    baht: '฿',
    bahtsign: '฿',
    won: '₩',
    wonsign: '₩',
    ruble: '₽',
    rouble: '₽',
    rublesign: '₽',
    percent: '%',
    percentsign: '%',
    permille: '‰',
    multiply: '×',
    multiplication: '×',
    times: '×',
    divide: '÷',
    division: '÷',
    leftparen: '(',
    lparen: '(',
    leftparenthesis: '(',
    openparen: '(',
    rightparen: ')',
    rparen: ')',
    rightparenthesis: ')',
    closeparen: ')',
    leftbracket: '[',
    openbracket: '[',
    rightbracket: ']',
    closebracket: ']',
    leftbrace: '{',
    openbrace: '{',
    rightbrace: '}',
    closebrace: '}',
    lessthan: '<',
    greaterthan: '>',
    tilde: '~',
    pipe: '|',
    verticalbar: '|',
    caret: '^',
    asterisk: '*',
    star: '*',
    grave: '`',
    backtick: '`',
    copyright: '©',
    registered: '®',
    trademark: '™',
    degree: '°',
    degreesign: '°',
    bullet: '•',
    ellipsis: '…',
  })
);

const DIGIT_NAMES = new Map([
  ['zero', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
]);

const JS_RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function issue(code, message, extra = {}) {
  return { severity: 'warning', code, message, ...extra };
}

function errorIssue(code, message, extra = {}) {
  return { severity: 'error', code, message, ...extra };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Match Pixi 8's BMFont loader, which parses every metric with parseInt. */
export function integerMetric(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isUnicodeScalar(value) {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_UNICODE &&
    (value < SURROGATE_MIN || value > SURROGATE_MAX)
  );
}

/** Characters safe/useful as XML 1.0 BMFont glyph keys. */
export function isBMFontCharacterCodePoint(value) {
  return isUnicodeScalar(value) && value >= 0x20 && value !== 0xfffe && value !== 0xffff;
}

export const isXmlSafeUnicodeScalar = isBMFontCharacterCodePoint;

export function isSingleUnicodeCharacter(value) {
  if (typeof value !== 'string') return false;
  const points = [...value];
  return points.length === 1 && isUnicodeScalar(points[0].codePointAt(0));
}

export function unicodeLabel(value, minDigits = 4) {
  const codePoint =
    typeof value === 'string' && isSingleUnicodeCharacter(value)
      ? value.codePointAt(0)
      : Number(value);
  if (!isUnicodeScalar(codePoint)) return 'Invalid Unicode';
  return `U+${codePoint.toString(16).toUpperCase().padStart(minDigits, '0')}`;
}

function mappingResult(character, source, confidence = 'high', extra = {}) {
  const codePoint = character.codePointAt(0);
  if (!isBMFontCharacterCodePoint(codePoint)) {
    return invalidMapping(
      character,
      source,
      `${unicodeLabel(codePoint)} cannot be represented as a renderable XML BMFont glyph.`
    );
  }
  return {
    status: 'mapped',
    character,
    codePoint,
    unicode: unicodeLabel(codePoint),
    source,
    confidence,
    ...extra,
  };
}

function invalidMapping(input, source, reason) {
  return {
    status: 'invalid',
    character: null,
    codePoint: null,
    unicode: null,
    source,
    confidence: 'none',
    input,
    reason,
  };
}

function unmapped(input, reason = 'No supported character convention matched.') {
  return {
    status: 'unmapped',
    character: null,
    codePoint: null,
    unicode: null,
    source: 'none',
    confidence: 'none',
    input,
    reason,
  };
}

function mappingFromCodePoint(raw, radix, source, input) {
  const codePoint = Number.parseInt(raw, radix);
  if (!isUnicodeScalar(codePoint)) {
    return invalidMapping(input, source, `Code point ${raw} is not a Unicode scalar value.`);
  }
  if (!isBMFontCharacterCodePoint(codePoint)) {
    return invalidMapping(
      input,
      source,
      `${unicodeLabel(codePoint)} cannot be represented as a renderable XML BMFont glyph.`
    );
  }
  return mappingResult(String.fromCodePoint(codePoint), source);
}

function leafName(path) {
  return String(path ?? '').split(/[\\/]/).pop() || '';
}

function fileStem(path) {
  // Glyph names are filesystem paths, not URLs. Both # and ? are meaningful
  // literal character stems in metadata (the supplied font uses "?.png").
  const leaf = leafName(path);
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

function compactAlias(value) {
  return value.toLowerCase().replace(/[\s_.-]+/g, '');
}

function detectNamedLetter(value) {
  let match = /^(?:uppercase|upper|capital)[\s_.-]*(?:letter[\s_.-]*)?([a-z])$/i.exec(value);
  if (match) return match[1].toUpperCase();
  match = /^(?:lowercase|lower|small)[\s_.-]*(?:letter[\s_.-]*)?([a-z])$/i.exec(value);
  if (match) return match[1].toLowerCase();
  match = /^letter[\s_.-]*([a-z])$/i.exec(value);
  if (match) return match[1] === match[1].toUpperCase() ? match[1].toUpperCase() : match[1];
  return null;
}

/**
 * Detect a glyph's character from a source filename.
 *
 * Supported conventions include literal scalars, common names/aliases,
 * U+1F600, U_1F600, uni1F600, unicode_1F600, 0x1F600, decimal_128512,
 * codepoint_128512 and multi-digit bare decimal IDs.
 */
export function detectCharacterFromFilename(filename) {
  const stem = fileStem(filename).trim();
  if (!stem) return unmapped(filename, 'The filename has no character stem.');

  // A one-character filename means that literal character. This makes 0.png
  // through 9.png behave as users expect, while 65.png is the decimal ID 65.
  if (isSingleUnicodeCharacter(stem)) return mappingResult(stem, 'literal');

  const namedLetter = detectNamedLetter(stem);
  if (namedLetter) return mappingResult(namedLetter, 'character-name');

  const compact = compactAlias(stem);
  const aliasCandidates = [
    compact,
    compact.replace(/^(?:glyph|character|symbol)/, ''),
  ];
  for (const candidate of aliasCandidates) {
    if (CHARACTER_ALIASES.has(candidate)) {
      return mappingResult(CHARACTER_ALIASES.get(candidate), 'alias');
    }
    if (DIGIT_NAMES.has(candidate)) {
      return mappingResult(DIGIT_NAMES.get(candidate), 'character-name');
    }
    const namedDigit = /^(?:digit|number)(zero|one|two|three|four|five|six|seven|eight|nine)$/.exec(
      candidate
    );
    if (namedDigit) return mappingResult(DIGIT_NAMES.get(namedDigit[1]), 'character-name');
  }

  let match = /^(?:u\+|u[_-])([0-9a-f]{2,6})$/i.exec(stem);
  if (match) return mappingFromCodePoint(match[1], 16, 'unicode-hex', filename);
  match = /^u([0-9a-f]{4,6})$/i.exec(stem);
  if (match) return mappingFromCodePoint(match[1], 16, 'unicode-hex', filename);
  match = /^uni(?:code)?[_+-]?([0-9a-f]{2,6})$/i.exec(stem);
  if (match) return mappingFromCodePoint(match[1], 16, 'unicode-hex', filename);
  match = /^0x([0-9a-f]{1,6})$/i.exec(stem);
  if (match) return mappingFromCodePoint(match[1], 16, 'unicode-hex', filename);
  match = /^(?:decimal|dec|codepoint|code|cp|charcode)[_-]?(\d+)$/i.exec(stem);
  if (match) return mappingFromCodePoint(match[1], 10, 'unicode-decimal', filename);
  if (/^\d{2,7}$/.test(stem)) {
    return mappingFromCodePoint(stem, 10, 'unicode-decimal', filename);
  }

  const looksLikeCodePoint =
    /^(?:u\+|u[_-]?|uni|unicode|0x|decimal|dec|codepoint|cp)/i.test(stem);
  if (looksLikeCodePoint) {
    return invalidMapping(filename, 'unicode', `"${stem}" is not a valid Unicode identifier.`);
  }
  return unmapped(filename);
}

export const detectGlyphCharacter = detectCharacterFromFilename;
export const detectFilenameCharacter = detectCharacterFromFilename;
export const detectCharacter = detectCharacterFromFilename;

/** Parse a manual character/Unicode field without assuming it is a filename. */
export function parseCharacterMapping(value) {
  if (typeof value === 'number') {
    return mappingFromCodePoint(String(value), 10, 'manual-code-point', value);
  }
  const rawInput = String(value ?? '');
  if (isSingleUnicodeCharacter(rawInput)) return mappingResult(rawInput, 'manual-character');
  const input = rawInput.trim();
  if (!input) return unmapped(value, 'No character was assigned.');
  if (isSingleUnicodeCharacter(input)) return mappingResult(input, 'manual-character');

  const detected = detectCharacterFromFilename(`${input}.png`);
  if (detected.status === 'mapped') {
    return { ...detected, source: `manual-${detected.source}` };
  }
  return detected.status === 'invalid'
    ? detected
    : invalidMapping(value, 'manual', 'Enter one character, an alias, or a Unicode ID.');
}

function dimensionsOf(input) {
  const source = input?.source;
  const sourceWidth = Math.max(
    1,
    integerMetric(input?.sourceWidth ?? input?.sw ?? input?.width ?? source?.width, 1)
  );
  const sourceHeight = Math.max(
    1,
    integerMetric(input?.sourceHeight ?? input?.sh ?? input?.height ?? source?.height, 1)
  );
  return { sourceWidth, sourceHeight };
}

/**
 * Create the controller-facing glyph model from an imported image descriptor.
 * The source may be a canvas, ImageBitmap or other CanvasImageSource.
 */
export function createGlyphRecord(input = {}, defaults = {}) {
  const sourceFilename =
    input.sourceFilename ?? input.filename ?? input.fileName ?? input.name ?? 'unmapped.png';
  let mapping;
  if (input.mapping && typeof input.mapping === 'object') {
    mapping = input.mapping;
  } else if (input.character !== undefined && input.character !== null) {
    mapping = parseCharacterMapping(input.character);
  } else if (input.codePoint !== undefined && input.codePoint !== null) {
    mapping = parseCharacterMapping(Number(input.codePoint));
  } else {
    mapping = detectCharacterFromFilename(sourceFilename);
  }
  const { sourceWidth, sourceHeight } = dimensionsOf(input);
  return {
    id: input.id ?? sourceFilename,
    kind: 'bitmap-glyph',
    sourceFilename,
    filename: sourceFilename,
    source: input.source ?? input.canvas ?? null,
    sourceWidth,
    sourceHeight,
    sw: sourceWidth,
    sh: sourceHeight,
    character: mapping.status === 'mapped' ? mapping.character : null,
    codePoint: mapping.status === 'mapped' ? mapping.codePoint : null,
    mappingStatus: mapping.status,
    mappingSource: mapping.source,
    mappingReason: mapping.reason ?? null,
    virtual: !!input.virtual,
    xAdjust: finiteNumber(input.xAdjust ?? defaults.xAdjust, 0),
    yAdjust: finiteNumber(input.yAdjust ?? defaults.yAdjust, 0),
    advanceAdjust: finiteNumber(input.advanceAdjust ?? defaults.advanceAdjust, 0),
    yAdvance: finiteNumber(input.yAdvance ?? defaults.yAdvance, 0),
    originalMetric: input.originalMetric ?? null,
    ...input.extra,
  };
}

export const makeGlyph = createGlyphRecord;

/** Create an image-less space; fontAtlas supplies its transparent packed 1x1. */
export function createVirtualSpaceGlyph({
  id = 'virtual-space',
  sourceFilename = 'space.virtual',
  spaceWidth = 32,
  letterSpacing = 0,
  ...extra
} = {}) {
  const width = Math.max(0, integerMetric(spaceWidth, 32));
  return createGlyphRecord({
    id,
    sourceFilename,
    character: ' ',
    source: null,
    sourceWidth: 1,
    sourceHeight: 1,
    virtual: true,
    // xadvance = source.width + letterSpacing + advanceAdjust.
    advanceAdjust: width - 1 - finiteNumber(letterSpacing, 0),
    ...extra,
  });
}

export const createSpaceGlyph = createVirtualSpaceGlyph;

function glyphMapping(glyph) {
  const character = glyph?.character;
  const codePoint = glyph?.codePoint;
  if (character == null && codePoint == null) {
    return { status: glyph?.mappingStatus === 'invalid' ? 'invalid' : 'unmapped' };
  }
  if (!isSingleUnicodeCharacter(character)) {
    return { status: 'invalid', reason: 'The assigned value is not exactly one Unicode scalar.' };
  }
  const actual = character.codePointAt(0);
  if (!isBMFontCharacterCodePoint(actual)) {
    return {
      status: 'invalid',
      reason: `${unicodeLabel(actual)} cannot be exported as an XML BMFont glyph.`,
    };
  }
  if (codePoint != null && (!isUnicodeScalar(codePoint) || codePoint !== actual)) {
    return {
      status: 'invalid',
      reason: `Character ${unicodeLabel(actual)} does not match ID ${String(codePoint)}.`,
    };
  }
  return { status: 'mapped', character, codePoint: actual };
}

function expectedSet(expectedCharacters) {
  if (!expectedCharacters) return new Set();
  const values =
    typeof expectedCharacters === 'string'
      ? [...expectedCharacters]
      : Array.from(expectedCharacters, (value) =>
          typeof value === 'number' && isUnicodeScalar(value) ? String.fromCodePoint(value) : String(value)
        );
  return new Set(values.filter((value) => isSingleUnicodeCharacter(value) && value !== '\r' && value !== '\n'));
}

/** Summarize mapped, duplicate, invalid, unmapped and expected-but-missing glyphs. */
export function analyzeGlyphMappings(glyphs, { expectedCharacters = '' } = {}) {
  const mapped = [];
  const unmappedGlyphs = [];
  const invalid = [];
  const byCharacter = new Map();
  const statuses = new Map();

  for (const glyph of glyphs || []) {
    const mapping = glyphMapping(glyph);
    statuses.set(glyph?.id, mapping);
    if (mapping.status === 'unmapped') {
      unmappedGlyphs.push(glyph);
      continue;
    }
    if (mapping.status === 'invalid') {
      invalid.push({ glyph, reason: mapping.reason ?? glyph?.mappingReason ?? 'Invalid mapping.' });
      continue;
    }
    mapped.push(glyph);
    if (!byCharacter.has(mapping.character)) byCharacter.set(mapping.character, []);
    byCharacter.get(mapping.character).push(glyph);
  }

  const duplicates = [...byCharacter.entries()]
    .filter(([, assigned]) => assigned.length > 1)
    .map(([character, assigned]) => ({
      character,
      codePoint: character.codePointAt(0),
      unicode: unicodeLabel(character),
      glyphs: assigned,
    }));
  const missing = [...expectedSet(expectedCharacters)]
    .filter((character) => !byCharacter.has(character))
    .map((character) => ({
      character,
      codePoint: character.codePointAt(0),
      unicode: unicodeLabel(character),
    }));
  const duplicateGlyphs = new Set(duplicates.flatMap((entry) => entry.glyphs));
  const uniqueMapped = mapped.filter((glyph) => !duplicateGlyphs.has(glyph));

  return {
    ok: unmappedGlyphs.length === 0 && invalid.length === 0 && duplicates.length === 0,
    canExport:
      mapped.some((glyph) => glyph?.character !== ' ') &&
      unmappedGlyphs.length === 0 &&
      invalid.length === 0 &&
      duplicates.length === 0,
    mapped,
    mappedCount: mapped.length,
    uniqueMapped,
    unmapped: unmappedGlyphs,
    invalid,
    duplicates,
    missing,
    statuses,
  };
}

export const validateGlyphMappings = analyzeGlyphMappings;
export const inspectGlyphMappings = analyzeGlyphMappings;

function decodeXml(value) {
  return String(value ?? '').replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal, hex) => {
      if (decimal) {
        const cp = Number.parseInt(decimal, 10);
        return isUnicodeScalar(cp) ? String.fromCodePoint(cp) : '\ufffd';
      }
      if (hex) {
        const cp = Number.parseInt(hex, 16);
        return isUnicodeScalar(cp) ? String.fromCodePoint(cp) : '\ufffd';
      }
      return {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      }[entity.toLowerCase()];
    }
  );
}

function xmlAttributes(fragment) {
  const attrs = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(fragment))) {
    attrs[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function firstXmlTag(text, tag) {
  const match = new RegExp(`<${tag}\\b([^>]*)\\/?>`, 'i').exec(text);
  return match ? xmlAttributes(match[1]) : null;
}

function allXmlTags(text, tag) {
  const found = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)\\/?>`, 'gi');
  let match;
  while ((match = pattern.exec(text))) found.push(xmlAttributes(match[1]));
  return found;
}

function unwrapFirst(value) {
  return Array.isArray(value) ? value[0] ?? {} : value ?? {};
}

function runtimeInt(raw, field, warnings, path, fallback = 0) {
  if (raw === undefined || raw === null || raw === '') {
    warnings.push(issue('missing-integer', `Missing ${field}; Pixi would parse it as NaN.`, { path }));
    return fallback;
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) {
    warnings.push(issue('invalid-integer', `"${String(raw)}" is not a valid ${field}.`, { path, raw }));
    return fallback;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && !Number.isInteger(numeric)) {
    warnings.push(
      issue(
        'fractional-metric',
        `${field}=${String(raw)} is fractional; Pixi 8 parses it as ${value}.`,
        { path, field, raw, runtimeValue: value }
      )
    );
  } else if (!Number.isFinite(numeric) || String(raw).trim() !== String(value)) {
    warnings.push(
      issue(
        'noncanonical-integer',
        `${field}="${String(raw)}" is parsed by Pixi as ${value}; export will normalize it.`,
        { path, field, raw, runtimeValue: value }
      )
    );
  }
  return value;
}

function optionalRuntimeInt(raw, field, warnings, path, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return runtimeInt(raw, field, warnings, path, fallback ?? 0);
}

function rawCharacterId(raw, index, warnings, format) {
  const glyphWarnings = [];
  const path = `chars[${index}]`;
  const rawId = raw?.id;
  let numericId = Number.parseInt(String(rawId), 10);
  if (!Number.isFinite(numericId) || !isUnicodeScalar(numericId)) {
    numericId = null;
  } else if (String(rawId).trim() !== String(numericId)) {
    const entry = issue(
      'noncanonical-character-id',
      `Character ID "${String(rawId)}" is parsed by Pixi as ${numericId}; export will normalize it.`,
      { path, rawId, runtimeValue: numericId }
    );
    glyphWarnings.push(entry);
  }

  let explicit = raw?.letter ?? raw?.char ?? null;
  if (explicit === 'space') explicit = ' ';
  let explicitCharacter = null;
  if (explicit != null) {
    if (isSingleUnicodeCharacter(String(explicit))) {
      explicitCharacter = String(explicit);
    } else {
      glyphWarnings.push(
        issue('invalid-letter', `Explicit letter "${String(explicit)}" is not one Unicode scalar.`, {
          path,
          raw: explicit,
        })
      );
    }
  }

  let character = explicitCharacter;
  let id = explicitCharacter ? explicitCharacter.codePointAt(0) : numericId;
  let repaired = false;
  if (explicitCharacter && numericId != null && numericId !== id) {
    glyphWarnings.push(
      issue(
        'id-letter-mismatch',
        `ID ${numericId} disagrees with letter ${unicodeLabel(id)}; the letter is retained as the character.`,
        { path, rawId, character: explicitCharacter }
      )
    );
  }
  if (!character && numericId != null) {
    character = String.fromCodePoint(numericId);
    id = numericId;
    if (numericId > 0xffff) {
      glyphWarnings.push(
        issue(
          'astral-letter-required',
          `${unicodeLabel(numericId)} needs an explicit letter attribute for Pixi 8; export will add it.`,
          { path, rawId }
        )
      );
    }
  }

  // Repair the supplied reference's "?.png" entry, and equivalently obvious
  // one-literal filename IDs, without pretending arbitrary malformed IDs work.
  if (!character && typeof rawId === 'string' && /\.[A-Za-z0-9]+$/.test(rawId)) {
    const detected = detectCharacterFromFilename(rawId);
    if (detected.status === 'mapped' && detected.source === 'literal') {
      character = detected.character;
      id = detected.codePoint;
      repaired = true;
      glyphWarnings.push(
        issue(
          'repaired-filename-id',
          `Invalid BMFont ID "${rawId}" was repaired to ${unicodeLabel(id)} (${JSON.stringify(character)}).`,
          { path, rawId, repairedId: id }
        )
      );
    }
  }

  const valid = isBMFontCharacterCodePoint(id) && isSingleUnicodeCharacter(character);
  if (!valid) {
    glyphWarnings.push(
      issue('invalid-character-id', `Character entry "${String(rawId)}" cannot be loaded by Pixi.`, {
        path,
        rawId,
      })
    );
  }
  for (const entry of glyphWarnings) warnings.push(entry);
  return { id: valid ? id : null, character: valid ? character : null, valid, rawId, repaired, glyphWarnings };
}

function normalizeChar(raw, index, warnings, format) {
  const identity = rawCharacterId(raw, index, warnings, format);
  const metric = {};
  for (const field of INTEGER_METRICS) {
    const fallback = field === 'page' ? 0 : field === 'chnl' ? 15 : 0;
    const rawValue =
      raw?.[field] ?? raw?.[field.replace('offset', 'Offset').replace('advance', 'Advance')];
    metric[field] =
      (field === 'page' || field === 'chnl' || field === 'yadvance') &&
      (rawValue === undefined || rawValue === null || rawValue === '')
        ? fallback
        : runtimeInt(rawValue, field, warnings, `chars[${index}].${field}`, fallback);
  }
  return {
    ...identity,
    ...metric,
    raw: { ...(raw || {}) },
    sourceIndex: index,
    warnings: identity.glyphWarnings,
  };
}

function normalizePage(raw, index, warnings) {
  if (typeof raw === 'string') return { id: index, file: raw, raw };
  const value = raw?.page ?? raw ?? {};
  const id = runtimeInt(value.id ?? index, 'page id', warnings, `pages[${index}].id`, index);
  const file = String(value.file ?? '');
  if (!file) {
    warnings.push(
      issue('missing-page-file', `Texture page ${id} has no file reference.`, {
        path: `pages[${index}].file`,
      })
    );
  }
  return { id, file, raw: value };
}

function normalizeKerning(raw, index, warnings) {
  const first = optionalRuntimeInt(raw?.first, 'kerning first', warnings, `kernings[${index}].first`);
  const second = optionalRuntimeInt(raw?.second, 'kerning second', warnings, `kernings[${index}].second`);
  const amount = runtimeInt(raw?.amount, 'kerning amount', warnings, `kernings[${index}].amount`, 0);
  const valid = isUnicodeScalar(first) && isUnicodeScalar(second);
  if (!valid) {
    warnings.push(
      issue('invalid-kerning', `Kerning entry ${index} has an invalid character ID.`, {
        path: `kernings[${index}]`,
      })
    );
  }
  return { first, second, amount, valid, raw: { ...(raw || {}) }, sourceIndex: index };
}

function normalizeParsedFont({
  format,
  infoRaw,
  commonRaw,
  pagesRaw,
  charsRaw,
  declaredCharCountRaw,
  kerningsRaw,
  declaredKerningCountRaw,
}) {
  const warnings = [];
  const info = {
    face: String(infoRaw?.face ?? 'Bitmap Font'),
    size: runtimeInt(infoRaw?.size ?? 16, 'font size', warnings, 'info.size', 16),
    bold: optionalRuntimeInt(infoRaw?.bold, 'bold', warnings, 'info.bold', 0) ?? 0,
    italic: optionalRuntimeInt(infoRaw?.italic, 'italic', warnings, 'info.italic', 0) ?? 0,
    charset: String(infoRaw?.charset ?? ''),
    unicode: String(infoRaw?.unicode ?? '1'),
    stretchH: optionalRuntimeInt(infoRaw?.stretchH, 'stretchH', warnings, 'info.stretchH', 100) ?? 100,
    smooth: optionalRuntimeInt(infoRaw?.smooth, 'smooth', warnings, 'info.smooth', 1) ?? 1,
    aa: optionalRuntimeInt(infoRaw?.aa, 'aa', warnings, 'info.aa', 1) ?? 1,
    padding: String(infoRaw?.padding ?? '0,0,0,0'),
    spacing: String(infoRaw?.spacing ?? '0,0'),
    outline: optionalRuntimeInt(infoRaw?.outline, 'outline', warnings, 'info.outline', 0) ?? 0,
    raw: { ...(infoRaw || {}) },
  };
  const lineHeight = runtimeInt(
    commonRaw?.lineHeight ?? info.size,
    'lineHeight',
    warnings,
    'common.lineHeight',
    Math.max(1, info.size)
  );
  const base = runtimeInt(commonRaw?.base ?? lineHeight, 'base', warnings, 'common.base', lineHeight);
  const common = {
    lineHeight,
    base,
    baseLineOffset: lineHeight - base,
    scaleW: runtimeInt(commonRaw?.scaleW ?? 0, 'scaleW', warnings, 'common.scaleW', 0),
    scaleH: runtimeInt(commonRaw?.scaleH ?? 0, 'scaleH', warnings, 'common.scaleH', 0),
    pages: runtimeInt(commonRaw?.pages ?? 1, 'page count', warnings, 'common.pages', 1),
    packed: optionalRuntimeInt(commonRaw?.packed, 'packed', warnings, 'common.packed', 0) ?? 0,
    raw: { ...(commonRaw || {}) },
  };
  const pages = (pagesRaw || []).map((page, index) => normalizePage(page, index, warnings));
  const chars = (charsRaw || []).map((char, index) => normalizeChar(char, index, warnings, format));
  const kernings = (kerningsRaw || []).map((entry, index) =>
    normalizeKerning(entry, index, warnings)
  );
  const declaredCharCount = optionalRuntimeInt(
    declaredCharCountRaw,
    'char count',
    warnings,
    'chars.count',
    null
  );
  const declaredKerningCount = optionalRuntimeInt(
    declaredKerningCountRaw,
    'kerning count',
    warnings,
    'kernings.count',
    null
  );

  if (declaredCharCount == null) {
    warnings.push(
      issue('missing-char-count', 'The chars section has no count; export will write the exact count.', {
        path: 'chars.count',
      })
    );
  } else if (declaredCharCount !== chars.length) {
    warnings.push(
      issue(
        'char-count-mismatch',
        `chars.count is ${declaredCharCount}, but ${chars.length} entries were parsed.`,
        { path: 'chars.count', declared: declaredCharCount, actual: chars.length }
      )
    );
  }
  if (declaredKerningCount != null && declaredKerningCount !== kernings.length) {
    warnings.push(
      issue(
        'kerning-count-mismatch',
        `kernings.count is ${declaredKerningCount}, but ${kernings.length} entries were parsed.`,
        { path: 'kernings.count', declared: declaredKerningCount, actual: kernings.length }
      )
    );
  }
  if (common.pages !== pages.length) {
    warnings.push(
      issue(
        'page-count-mismatch',
        `common.pages is ${common.pages}, but ${pages.length} page entries were parsed.`,
        { path: 'common.pages', declared: common.pages, actual: pages.length }
      )
    );
  }
  if (pages.length !== 1) {
    warnings.push(
      issue(
        'unsupported-page-count',
        `Stake Engine's current bitmap-font workflow expects one page; this font has ${pages.length}.`,
        { path: 'pages', actual: pages.length }
      )
    );
  }
  const pageIds = new Set();
  for (const [index, page] of pages.entries()) {
    if (pageIds.has(page.id)) {
      warnings.push(
        issue('duplicate-page-id', `Page ID ${page.id} is duplicated.`, { path: `pages[${index}].id` })
      );
    }
    pageIds.add(page.id);
  }
  for (const char of chars) {
    if (char.valid && !pageIds.has(char.page)) {
      warnings.push(
        issue(
          'unknown-character-page',
          `${unicodeLabel(char.id)} refers to missing page ${char.page}.`,
          { path: `chars[${char.sourceIndex}].page`, character: char.character }
        )
      );
    }
  }
  const assigned = new Map();
  for (const char of chars.filter((entry) => entry.valid)) {
    if (!assigned.has(char.character)) assigned.set(char.character, []);
    assigned.get(char.character).push(char);
  }
  for (const [character, duplicates] of assigned) {
    if (duplicates.length > 1) {
      warnings.push(
        issue(
          'duplicate-character',
          `${unicodeLabel(character)} is assigned ${duplicates.length} times; Pixi keeps the last entry.`,
          { path: 'chars', character, count: duplicates.length }
        )
      );
    }
  }

  return {
    format,
    info,
    common,
    pages,
    chars,
    kernings,
    declaredCharCount,
    declaredKerningCount,
    invalidChars: chars.filter((entry) => !entry.valid),
    invalidKernings: kernings.filter((entry) => !entry.valid),
    warnings,
  };
}

/** Parse XML BMFont without relying on DOMParser (safe in renderer and Node). */
export function parseBMFontXML(text) {
  const source = String(text ?? '');
  if (!/<font(?:\s|>)/i.test(source)) throw new Error('Invalid BMFont XML: missing <font>.');
  const infoRaw = firstXmlTag(source, 'info');
  const commonRaw = firstXmlTag(source, 'common');
  if (!infoRaw || !commonRaw) {
    throw new Error('Invalid BMFont XML: missing info or common section.');
  }
  const charsSection = firstXmlTag(source, 'chars') ?? {};
  const kerningsSection = firstXmlTag(source, 'kernings') ?? {};
  return normalizeParsedFont({
    format: 'xml',
    infoRaw,
    commonRaw,
    pagesRaw: allXmlTags(source, 'page'),
    charsRaw: allXmlTags(source, 'char'),
    declaredCharCountRaw: charsSection.count,
    kerningsRaw: allXmlTags(source, 'kerning'),
    declaredKerningCountRaw: kerningsSection.count,
  });
}

function jsonPages(data) {
  const raw = data?.pages;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.page)) return raw.page;
  if (raw?.page) return [raw.page];
  return [];
}

function jsonChars(data) {
  const raw = data?.chars;
  if (Array.isArray(raw)) return { list: raw, count: data?.charCount ?? null };
  if (Array.isArray(raw?.char)) return { list: raw.char, count: raw.count ?? null };
  if (raw?.char) return { list: [raw.char], count: raw.count ?? null };
  if (raw && typeof raw === 'object') {
    const list = Object.entries(raw)
      .filter(([key]) => key !== 'count')
      .map(([key, value]) => ({ id: value?.id ?? key, ...(value || {}) }));
    return { list, count: raw.count ?? null };
  }
  return { list: [], count: null };
}

function jsonKernings(data) {
  const raw = data?.kernings;
  if (Array.isArray(raw)) return { list: raw, count: data?.kerningCount ?? null };
  if (Array.isArray(raw?.kerning)) return { list: raw.kerning, count: raw.count ?? null };
  if (raw?.kerning) return { list: [raw.kerning], count: raw.count ?? null };
  return { list: [], count: raw?.count ?? null };
}

/** Parse standard BMFont JSON and the legacy xml2js-shaped Stake companion. */
export function parseBMFontJSON(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      throw new Error(`Invalid BMFont JSON: ${error.message}`);
    }
  }
  if (!data || typeof data !== 'object') throw new Error('Invalid BMFont JSON root.');
  const chars = jsonChars(data);
  const kernings = jsonKernings(data);
  return normalizeParsedFont({
    format: 'json',
    infoRaw: unwrapFirst(data.info),
    commonRaw: unwrapFirst(data.common),
    pagesRaw: jsonPages(data),
    charsRaw: chars.list,
    declaredCharCountRaw: chars.count,
    kerningsRaw: kernings.list,
    declaredKerningCountRaw: kernings.count,
  });
}

export function parseBitmapFont(input, format = 'auto') {
  if (format === 'xml') return parseBMFontXML(input);
  if (format === 'json') return parseBMFontJSON(input);
  if (typeof input === 'object') return parseBMFontJSON(input);
  const text = String(input ?? '').trim();
  return text.startsWith('{') || text.startsWith('[')
    ? parseBMFontJSON(text)
    : parseBMFontXML(text);
}

export const parseFontMetadata = parseBitmapFont;
export const parseBMFontXml = parseBMFontXML;
export const parseBMFontJson = parseBMFontJSON;

function normalizedOutputCharacter(char, index) {
  const character =
    char?.character ??
    char?.letter ??
    (isUnicodeScalar(Number(char?.codePoint ?? char?.id))
      ? String.fromCodePoint(Number(char.codePoint ?? char.id))
      : null);
  if (!isSingleUnicodeCharacter(character)) {
    throw new Error(`Cannot serialize chars[${index}]: no valid Unicode character.`);
  }
  const id = character.codePointAt(0);
  if (!isBMFontCharacterCodePoint(id)) {
    throw new Error(
      `Cannot serialize chars[${index}]: ${unicodeLabel(id)} is not XML BMFont-safe.`
    );
  }
  if (char?.id != null && Number(char.id) !== id && char?.codePoint == null) {
    throw new Error(`Cannot serialize chars[${index}]: character and ID disagree.`);
  }
  return {
    id,
    character,
    x: integerMetric(char?.x, 0),
    y: integerMetric(char?.y, 0),
    width: integerMetric(char?.width, 0),
    height: integerMetric(char?.height, 0),
    xoffset: integerMetric(char?.xoffset ?? char?.xOffset, 0),
    yoffset: integerMetric(char?.yoffset ?? char?.yOffset, 0),
    xadvance: integerMetric(char?.xadvance ?? char?.xAdvance, 0),
    yadvance: integerMetric(char?.yadvance ?? char?.yAdvance, 0),
    page: 0,
    chnl: integerMetric(char?.chnl, 15),
  };
}

function serializableChars(chars, { strict = true } = {}) {
  const output = [];
  const seen = new Set();
  const failures = [];
  for (const [index, char] of (chars || []).entries()) {
    if (char?.valid === false) {
      failures.push(`chars[${index}] has invalid ID ${String(char.rawId)}`);
      continue;
    }
    try {
      const normalized = normalizedOutputCharacter(char, index);
      if (seen.has(normalized.character)) {
        failures.push(`duplicate ${unicodeLabel(normalized.character)}`);
        continue;
      }
      seen.add(normalized.character);
      output.push(normalized);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (strict && failures.length) {
    throw new Error(`Bitmap font contains non-exportable entries: ${failures.join('; ')}.`);
  }
  return output.sort((a, b) => a.id - b.id || a.character.localeCompare(b.character));
}

function serializableKernings(kernings, characters) {
  const ids = new Set(characters.map((char) => char.id));
  return (kernings || [])
    .filter(
      (entry) =>
        entry?.valid !== false &&
        isUnicodeScalar(Number(entry?.first)) &&
        isUnicodeScalar(Number(entry?.second)) &&
        ids.has(Number(entry.first)) &&
        ids.has(Number(entry.second))
    )
    .map((entry) => ({
      first: Number(entry.first),
      second: Number(entry.second),
      amount: integerMetric(entry.amount, 0),
    }))
    .sort((a, b) => a.first - b.first || a.second - b.second);
}

/**
 * Apply the specified metric model to one packed glyph.
 *
 * xoffset  = trim.x + xAdjust
 * yoffset  = artworkBaseline - source.height + trim.y + yAdjust
 * xadvance = source.width + letterSpacing + advanceAdjust
 */
export function buildGlyphMetric({
  glyph,
  trim,
  placement,
  artworkBaseline,
  baseline,
  letterSpacing = 0,
}) {
  const { sourceWidth, sourceHeight } = dimensionsOf(glyph);
  const guide = finiteNumber(artworkBaseline ?? baseline, sourceHeight);
  return normalizedOutputCharacter(
    {
      id: glyph?.codePoint,
      codePoint: glyph?.codePoint,
      character: glyph?.character,
      x: placement?.x ?? 0,
      y: placement?.y ?? 0,
      width: trim?.w ?? sourceWidth,
      height: trim?.h ?? sourceHeight,
      xoffset: finiteNumber(trim?.x, 0) + finiteNumber(glyph?.xAdjust, 0),
      yoffset:
        guide -
        sourceHeight +
        finiteNumber(trim?.y, 0) +
        finiteNumber(glyph?.yAdjust, 0),
      xadvance:
        sourceWidth +
        finiteNumber(letterSpacing, 0) +
        finiteNumber(glyph?.advanceAdjust, 0),
      yadvance: finiteNumber(glyph?.yAdvance, 0),
      page: 0,
      chnl: 15,
    },
    0
  );
}

export const calculateGlyphMetric = buildGlyphMetric;

/** Build canonical one-page metadata from packed integer glyph metrics. */
export function createBitmapFontMetadata({
  fontName = 'Bitmap Font',
  fontSize = 64,
  lineHeight = fontSize,
  baseline = lineHeight,
  artworkBaseline = baseline,
  atlasWidth,
  atlasHeight,
  textureFile,
  glyphs,
  chars = glyphs,
  kernings = [],
  strict = true,
} = {}) {
  const outputChars = serializableChars(chars || [], { strict });
  if (!outputChars.length && strict) throw new Error('Cannot build a bitmap font with no mapped glyphs.');
  const width = Math.max(1, integerMetric(atlasWidth, 1));
  const height = Math.max(1, integerMetric(atlasHeight, 1));
  const outputLineHeight = Math.max(1, integerMetric(lineHeight, integerMetric(fontSize, 64)));
  const outputFontSize = Math.max(1, integerMetric(fontSize, outputLineHeight));
  const pageFile = leafName(textureFile || `${safeFileBase(fontName)}.webp`);
  return {
    format: 'generated',
    info: {
      face: String(fontName || 'Bitmap Font'),
      size: outputFontSize,
      bold: 0,
      italic: 0,
      charset: '',
      unicode: '1',
      stretchH: 100,
      smooth: 1,
      aa: 1,
      padding: '0,0,0,0',
      spacing: '0,0',
      outline: 0,
    },
    common: {
      lineHeight: outputLineHeight,
      // Pixi uses lineHeight - base as an extra offset. The user's baseline
      // is an artwork guide, so generated fonts intentionally use offset 0.
      base: outputLineHeight,
      baseLineOffset: 0,
      scaleW: width,
      scaleH: height,
      pages: 1,
      packed: 0,
    },
    artworkBaseline: integerMetric(artworkBaseline, outputLineHeight),
    pages: [{ id: 0, file: pageFile }],
    chars: outputChars,
    kernings: serializableKernings(kernings, outputChars),
    declaredCharCount: outputChars.length,
    declaredKerningCount: kernings.length,
    invalidChars: [],
    invalidKernings: [],
    warnings: [],
  };
}

export const buildFontMetadata = createBitmapFontMetadata;
export const createFontMetadata = createBitmapFontMetadata;

function canonicalMetadata(metadata, options = {}) {
  const chars = serializableChars(metadata?.chars || [], { strict: options.strict !== false });
  const lineHeight = Math.max(
    1,
    integerMetric(options.lineHeight ?? metadata?.common?.lineHeight ?? metadata?.info?.size, 1)
  );
  const pageFile = leafName(
    options.textureFile ?? metadata?.pages?.[0]?.file ?? `${safeFileBase(metadata?.info?.face)}.webp`
  );
  return {
    info: {
      face: String(options.fontName ?? metadata?.info?.face ?? 'Bitmap Font'),
      size: Math.max(1, integerMetric(options.fontSize ?? metadata?.info?.size, lineHeight)),
      bold: integerMetric(metadata?.info?.bold, 0),
      italic: integerMetric(metadata?.info?.italic, 0),
      charset: String(metadata?.info?.charset ?? ''),
      unicode: String(metadata?.info?.unicode ?? '1'),
      stretchH: integerMetric(metadata?.info?.stretchH, 100),
      smooth: integerMetric(metadata?.info?.smooth, 1),
      aa: integerMetric(metadata?.info?.aa, 1),
      padding: String(metadata?.info?.padding ?? '0,0,0,0'),
      spacing: String(metadata?.info?.spacing ?? '0,0'),
      outline: integerMetric(metadata?.info?.outline, 0),
    },
    common: {
      lineHeight,
      base: lineHeight,
      scaleW: Math.max(1, integerMetric(options.atlasWidth ?? metadata?.common?.scaleW, 1)),
      scaleH: Math.max(1, integerMetric(options.atlasHeight ?? metadata?.common?.scaleH, 1)),
      pages: 1,
      packed: 0,
    },
    pages: [{ id: 0, file: pageFile }],
    chars,
    kernings: serializableKernings(metadata?.kernings, chars),
  };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlLetter(character) {
  return character === ' ' ? 'space' : character;
}

/** Serialize authoritative Pixi 8-compatible BMFont XML. */
export function serializeBMFontXML(metadata, options = {}) {
  const font = canonicalMetadata(metadata, options);
  const { info, common } = font;
  const chars = font.chars
    .map(
      (char) =>
        `    <char id="${char.id}" letter="${xmlEscape(xmlLetter(char.character))}" x="${char.x}" y="${char.y}" width="${char.width}" height="${char.height}" xoffset="${char.xoffset}" yoffset="${char.yoffset}" xadvance="${char.xadvance}" yadvance="${char.yadvance}" page="0" chnl="${char.chnl}"/>`
    )
    .join('\n');
  const kernings = font.kernings
    .map(
      (entry) =>
        `    <kerning first="${entry.first}" second="${entry.second}" amount="${entry.amount}"/>`
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<font>\n` +
    `  <info face="${xmlEscape(info.face)}" size="${info.size}" bold="${info.bold}" italic="${info.italic}" charset="${xmlEscape(info.charset)}" unicode="${xmlEscape(info.unicode)}" stretchH="${info.stretchH}" smooth="${info.smooth}" aa="${info.aa}" padding="${xmlEscape(info.padding)}" spacing="${xmlEscape(info.spacing)}" outline="${info.outline}"/>\n` +
    `  <common lineHeight="${common.lineHeight}" base="${common.base}" scaleW="${common.scaleW}" scaleH="${common.scaleH}" pages="1" packed="0"/>\n` +
    `  <pages>\n` +
    `    <page id="0" file="${xmlEscape(font.pages[0].file)}"/>\n` +
    `  </pages>\n` +
    `  <chars count="${font.chars.length}">\n` +
    (chars ? `${chars}\n` : '') +
    `  </chars>\n` +
    (font.kernings.length
      ? `  <kernings count="${font.kernings.length}">\n${kernings}\n  </kernings>\n`
      : `  <kernings count="0"/>\n`) +
    `</font>\n`
  );
}

export const serializeFontXML = serializeBMFontXML;
export const serializeBMFontXml = serializeBMFontXML;

function legacyJson(font) {
  const numericChar = (char) => ({
    id: char.id,
    letter: xmlLetter(char.character),
    x: char.x,
    y: char.y,
    width: char.width,
    height: char.height,
    xoffset: char.xoffset,
    yoffset: char.yoffset,
    xadvance: char.xadvance,
    yadvance: char.yadvance,
    page: 0,
    chnl: char.chnl,
  });
  const data = {
    info: [{ ...font.info }],
    common: [{ ...font.common }],
    pages: [{ page: { id: 0, file: font.pages[0].file } }],
    chars: { count: font.chars.length, char: font.chars.map(numericChar) },
    kernings: {
      count: font.kernings.length,
      kerning: font.kernings.map((entry) => ({ ...entry })),
    },
  };
  return data;
}

function standardJson(font) {
  return {
    info: { ...font.info },
    common: { ...font.common },
    pages: [font.pages[0].file],
    chars: font.chars.map((char) => ({
      id: char.id,
      letter: xmlLetter(char.character),
      x: char.x,
      y: char.y,
      width: char.width,
      height: char.height,
      xoffset: char.xoffset,
      yoffset: char.yoffset,
      xadvance: char.xadvance,
      yadvance: char.yadvance,
      page: 0,
      chnl: char.chnl,
    })),
    kernings: font.kernings.map((entry) => ({ ...entry })),
  };
}

/** Serialize the legacy Stake companion by default; XML remains authoritative. */
export function serializeBMFontJSON(metadata, { style = 'legacy', pretty = false, ...options } = {}) {
  const font = canonicalMetadata(metadata, options);
  const data = style === 'standard' ? standardJson(font) : legacyJson(font);
  return `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`;
}

export const serializeFontJSON = serializeBMFontJSON;
export const serializeBMFontJson = serializeBMFontJSON;

function metadataCharacterMap(metadata) {
  const map = new Map();
  for (const char of metadata?.chars || []) {
    if (char?.valid === false) continue;
    const character =
      char.character ??
      char.letter ??
      (isUnicodeScalar(Number(char.codePoint ?? char.id))
        ? String.fromCodePoint(Number(char.codePoint ?? char.id))
        : null);
    if (isSingleUnicodeCharacter(character)) map.set(character, char);
  }
  return map;
}

function kerningMap(metadata) {
  const map = new Map();
  for (const entry of metadata?.kernings || []) {
    if (entry?.valid === false) continue;
    map.set(`${Number(entry.first)},${Number(entry.second)}`, integerMetric(entry.amount, 0));
  }
  return map;
}

/**
 * Lay out text the way Pixi 8's imported BitmapFont data does: the current
 * glyph receives kerning from the previous character, missing glyphs do not
 * draw but use SPACE as Pixi's advance fallback, and y uses
 * (lineHeight - common.base) + yoffset.
 */
export function layoutBitmapText(metadata, text, { x = 0, y = 0 } = {}) {
  const source = String(text ?? '');
  const chars = metadataCharacterMap(metadata);
  const kernings = kerningMap(metadata);
  const lineHeight = Math.max(
    1,
    integerMetric(metadata?.common?.lineHeight ?? metadata?.info?.size, 1)
  );
  const commonBase = integerMetric(metadata?.common?.base, lineHeight);
  const baseLineOffset = lineHeight - commonBase;
  const glyphs = [];
  const missing = [];
  const lines = [];
  let cursorX = 0;
  let lineIndex = 0;
  let previous = null;
  let codeUnitIndex = 0;
  let column = 0;

  const finishLine = () => {
    lines.push({ index: lineIndex, y: y + lineIndex * lineHeight, width: cursorX });
  };

  for (const character of source) {
    const sourceIndex = codeUnitIndex;
    codeUnitIndex += character.length;
    if (character === '\r' || character === '\n') {
      // Pixi 8.8.1 only advances to a new line when the current line has
      // measurable width. This makes CR a line break, coalesces CRLF, and
      // collapses otherwise empty consecutive line breaks.
      if (cursorX !== 0) {
        finishLine();
        cursorX = 0;
        lineIndex += 1;
        column = 0;
      }
      previous = character;
      continue;
    }
    const char = chars.get(character);
    if (!char) {
      missing.push({
        character,
        codePoint: character.codePointAt(0),
        unicode: unicodeLabel(character),
        sourceIndex,
        line: lineIndex,
        column,
      });
      const fallback = chars.get(' ');
      if (fallback) {
        const fallbackId = ' '.codePointAt(0);
        const previousId = previous == null ? null : previous.codePointAt(0);
        const fallbackKerning =
          previousId == null ? 0 : kernings.get(`${previousId},${fallbackId}`) ?? 0;
        cursorX +=
          fallbackKerning + integerMetric(fallback.xadvance ?? fallback.xAdvance, 0);
      }
      column += 1;
      previous = character;
      continue;
    }
    const id = character.codePointAt(0);
    const previousId = previous == null ? null : previous.codePointAt(0);
    const kerning = previousId == null ? 0 : kernings.get(`${previousId},${id}`) ?? 0;
    cursorX += kerning;
    const xoffset = integerMetric(char.xoffset ?? char.xOffset, 0);
    const yoffset = integerMetric(char.yoffset ?? char.yOffset, 0);
    const placement = {
      character,
      codePoint: id,
      unicode: unicodeLabel(id),
      sourceIndex,
      line: lineIndex,
      column,
      x: x + cursorX + xoffset,
      y: y + lineIndex * lineHeight + baseLineOffset + yoffset,
      cursorX: x + cursorX,
      kerning,
      width: integerMetric(char.width, 0),
      height: integerMetric(char.height, 0),
      atlasX: integerMetric(char.x, 0),
      atlasY: integerMetric(char.y, 0),
      page: integerMetric(char.page, 0),
      metric: char,
    };
    glyphs.push(placement);
    cursorX += integerMetric(char.xadvance ?? char.xAdvance, 0);
    previous = character;
    column += 1;
  }
  finishLine();

  const width = lines.reduce((max, line) => Math.max(max, line.width), 0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const glyph of glyphs) {
    minX = Math.min(minX, glyph.x);
    minY = Math.min(minY, glyph.y);
    maxX = Math.max(maxX, glyph.x + glyph.width);
    maxY = Math.max(maxY, glyph.y + glyph.height);
  }
  const missingCharacters = [...new Set(missing.map((entry) => entry.character))];
  return {
    text: source,
    glyphs,
    runs: glyphs,
    missing,
    missingCharacters,
    lines,
    width,
    height: lines.length * lineHeight,
    lineHeight,
    commonBase,
    baseLineOffset,
    inkBounds:
      glyphs.length > 0
        ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        : { x, y, width: 0, height: 0 },
  };
}

export const layoutText = layoutBitmapText;
export const layoutFontText = layoutBitmapText;

function verificationResult(errors, warnings, checks, extra = {}) {
  return { ok: errors.length === 0, errors, warnings, checks, ...extra };
}

function normalizeExpectedCharacters(expectedCharacters) {
  return [...expectedSet(expectedCharacters)];
}

/** Verify one normalized metadata document against its intended atlas. */
export function verifyFontMetadata(
  input,
  {
    atlasWidth,
    atlasHeight,
    textureFile,
    expectedCharacters = '',
    sampleText = '',
    requireZeroBaseLineOffset = false,
  } = {}
) {
  const metadata =
    typeof input === 'string' ? parseBitmapFont(input) : input && input.info ? input : null;
  const errors = [];
  const warnings = [...(metadata?.warnings || [])];
  const checks = {
    glyphCount: metadata?.chars?.filter((char) => char.valid !== false).length ?? 0,
    pageCount: metadata?.pages?.length ?? 0,
    baseLineOffset: 0,
    atlasBounds: true,
    integerMetrics: true,
    uniqueCharacters: true,
    sampleMissing: [],
    spaceGlyph: false,
  };
  if (!metadata) {
    errors.push(errorIssue('missing-metadata', 'No bitmap-font metadata was supplied.'));
    return verificationResult(errors, warnings, checks);
  }

  const lineHeight = integerMetric(metadata.common?.lineHeight, 0);
  const base = integerMetric(metadata.common?.base, lineHeight);
  checks.baseLineOffset = lineHeight - base;
  if (checks.baseLineOffset !== 0) {
    const entry = issue(
      'nonzero-baseline-offset',
      `Pixi will add ${checks.baseLineOffset}px to every yoffset because common.base differs from lineHeight.`,
      { baseLineOffset: checks.baseLineOffset }
    );
    if (requireZeroBaseLineOffset) errors.push({ ...entry, severity: 'error' });
    else warnings.push(entry);
  }

  if (metadata.pages?.length !== 1 || integerMetric(metadata.common?.pages, 0) !== 1) {
    errors.push(errorIssue('page-count', 'The Stake Engine font package must contain exactly one page.'));
  }
  const page = metadata.pages?.[0];
  if (!page || integerMetric(page.id, -1) !== 0) {
    errors.push(errorIssue('page-id', 'The sole texture page must have ID 0.'));
  }
  if (!page?.file) errors.push(errorIssue('page-file', 'The texture page filename is empty.'));
  if (textureFile && leafName(page?.file) !== leafName(textureFile)) {
    errors.push(
      errorIssue(
        'texture-reference',
        `Metadata references "${String(page?.file)}", expected "${leafName(textureFile)}".`
      )
    );
  }

  const expectedW = atlasWidth == null ? integerMetric(metadata.common?.scaleW, 0) : integerMetric(atlasWidth, 0);
  const expectedH = atlasHeight == null ? integerMetric(metadata.common?.scaleH, 0) : integerMetric(atlasHeight, 0);
  if (
    atlasWidth != null &&
    integerMetric(metadata.common?.scaleW, -1) !== integerMetric(atlasWidth, -2)
  ) {
    errors.push(errorIssue('atlas-width', 'common.scaleW does not match the texture width.'));
  }
  if (
    atlasHeight != null &&
    integerMetric(metadata.common?.scaleH, -1) !== integerMetric(atlasHeight, -2)
  ) {
    errors.push(errorIssue('atlas-height', 'common.scaleH does not match the texture height.'));
  }

  const seen = new Set();
  for (const [index, char] of (metadata.chars || []).entries()) {
    if (
      char.valid === false ||
      !isBMFontCharacterCodePoint(Number(char.id)) ||
      !isSingleUnicodeCharacter(char.character)
    ) {
      errors.push(
        errorIssue('invalid-character', `chars[${index}] has no valid Unicode scalar mapping.`, {
          index,
          rawId: char.rawId,
        })
      );
      continue;
    }
    if (seen.has(char.character)) {
      checks.uniqueCharacters = false;
      errors.push(
        errorIssue('duplicate-character', `${unicodeLabel(char.character)} is assigned more than once.`, {
          character: char.character,
        })
      );
    }
    seen.add(char.character);
    for (const field of INTEGER_METRICS) {
      const value = char[field] ?? char[field.replace('offset', 'Offset').replace('advance', 'Advance')];
      if (!Number.isInteger(Number(value))) {
        checks.integerMetrics = false;
        errors.push(
          errorIssue('fractional-output-metric', `chars[${index}].${field} must be an integer.`, {
            index,
            field,
            value,
          })
        );
      }
    }
    const x = Number(char.x);
    const y = Number(char.y);
    const width = Number(char.width);
    const height = Number(char.height);
    if (
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > expectedW ||
      y + height > expectedH
    ) {
      checks.atlasBounds = false;
      errors.push(
        errorIssue(
          'glyph-out-of-bounds',
          `${unicodeLabel(char.character)} lies outside the declared texture.`,
          { index, x, y, width, height, scaleW: expectedW, scaleH: expectedH }
        )
      );
    }
    if (integerMetric(char.page, -1) !== 0) {
      errors.push(
        errorIssue('character-page', `${unicodeLabel(char.character)} does not reference page 0.`, {
          index,
          page: char.page,
        })
      );
    }
  }

  const space = (metadata.chars || []).find(
    (char) => char.valid !== false && char.character === ' '
  );
  checks.spaceGlyph = !!space;
  if (!space) {
    errors.push(
      errorIssue(
        'missing-space-glyph',
        'U+0020 SPACE is required for Stake/Pixi text fallback and must be included.'
      )
    );
  } else if (
    integerMetric(space.xadvance ?? space.xAdvance, 0) <= 0 ||
    integerMetric(space.page, -1) !== 0 ||
    integerMetric(space.width, 0) <= 0 ||
    integerMetric(space.height, 0) <= 0
  ) {
    errors.push(
      errorIssue(
        'invalid-space-glyph',
        'U+0020 SPACE must have positive advance and a nonzero frame on page 0.'
      )
    );
  }

  for (const character of normalizeExpectedCharacters(expectedCharacters)) {
    if (!seen.has(character)) {
      warnings.push(
        issue('missing-expected-character', `Expected ${unicodeLabel(character)} is missing.`, {
          character,
        })
      );
    }
  }
  const layout = sampleText ? layoutBitmapText(metadata, sampleText) : null;
  if (layout?.missing.length) {
    checks.sampleMissing = layout.missingCharacters;
    warnings.push(
      issue(
        'sample-missing-characters',
        `Sample text has missing glyphs: ${layout.missingCharacters
          .map((character) => unicodeLabel(character))
          .join(', ')}.`,
        { characters: layout.missingCharacters }
      )
    );
  }
  return verificationResult(errors, warnings, checks, { metadata, layout });
}

function charsComparable(metadata) {
  return (metadata?.chars || [])
    .filter((char) => char.valid !== false)
    .map((char) => ({
      id: char.id,
      character: char.character,
      x: char.x,
      y: char.y,
      width: char.width,
      height: char.height,
      xoffset: char.xoffset,
      yoffset: char.yoffset,
      xadvance: char.xadvance,
      page: char.page,
    }))
    .sort((a, b) => a.id - b.id);
}

function alphaCheck(texturePixels, errors, warnings, checks) {
  if (!texturePixels?.data) {
    checks.transparency = 'not-checked';
    return;
  }
  const data = texturePixels.data;
  let transparent = false;
  let visible = false;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) transparent = true;
    if (data[index] > 0) visible = true;
    if (transparent && visible) break;
  }
  checks.transparency = transparent;
  checks.visiblePixels = visible;
  if (!transparent) {
    errors.push(errorIssue('no-transparency', 'The generated texture has no transparent pixels.'));
  }
  if (!visible) errors.push(errorIssue('empty-texture', 'The generated texture contains no visible glyph pixels.'));
}

export const PIXI_BITMAP_FONT_STYLE_GUIDANCE =
  'Pixi 8 compatibility: colored bitmap glyphs are tinted by BitmapText style.fill. ' +
  'Keep the style object stable; if code assigns or replaces the style, include fill: 0xffffff ' +
  'to preserve the artwork colors.';

/**
 * Imported Pixi 8 BitmapFonts apply TextStyle.fill as a multiplicative tint.
 * Pixi's BitmapText constructor supplies white for an omitted fill, but a later
 * `bitmapText.style = { ... }` assignment uses TextStyle's black default. That
 * makes otherwise-valid colored glyph textures render as black silhouettes.
 * Flag colored artwork so the exported package carries an actionable runtime
 * diagnostic without pretending the texture or BMFont metadata is defective.
 */
function coloredArtworkCheck(texturePixels, warnings, checks) {
  if (!texturePixels?.data) {
    checks.coloredArtwork = 'not-checked';
    return;
  }
  const data = texturePixels.data;
  let colored = false;
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    // Ignore nearly invisible edge noise. A visible pixel whose channels differ
    // is authored color rather than a neutral mask intended for tinting.
    if (data[offset + 3] < 8) continue;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 3) {
      colored = true;
      break;
    }
  }
  checks.coloredArtwork = colored;
  if (colored) {
    warnings.push(issue('pixi-bitmap-font-white-tint', PIXI_BITMAP_FONT_STYLE_GUIDANCE));
  }
}

function spaceAlphaCheck(metadata, texturePixels, errors, checks) {
  if (!texturePixels?.data || !texturePixels.width || !texturePixels.height) {
    checks.spaceTransparency = 'not-checked';
    return;
  }
  const space = metadata?.chars?.find(
    (char) => char.valid !== false && char.character === ' '
  );
  if (!space) {
    checks.spaceTransparency = false;
    return;
  }
  const textureWidth = integerMetric(texturePixels.width, 0);
  const textureHeight = integerMetric(texturePixels.height, 0);
  const x = integerMetric(space.x, -1);
  const y = integerMetric(space.y, -1);
  const width = integerMetric(space.width, 0);
  const height = integerMetric(space.height, 0);
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > textureWidth ||
    y + height > textureHeight
  ) {
    checks.spaceTransparency = false;
    return;
  }
  let transparent = true;
  for (let py = y; py < y + height && transparent; py++) {
    for (let px = x; px < x + width; px++) {
      if (texturePixels.data[(py * textureWidth + px) * 4 + 3] !== 0) {
        transparent = false;
        break;
      }
    }
  }
  checks.spaceTransparency = transparent;
  if (!transparent) {
    errors.push(
      errorIssue(
        'visible-space-texture',
        'U+0020 SPACE references visible texture pixels; its packed frame must be transparent.'
      )
    );
  }
}

/**
 * Verify the complete generated build. XML is authoritative; JSON must agree
 * with it, index.ts must use the reference createAsset shape, and assets.ts
 * must point the runtime at XML.
 */
export function verifyBitmapFontBuild(input = {}, legacyAtlasCanvas = null) {
  // Backwards-friendly renderer call: verifyBitmapFontBuild(metadata, canvas).
  if (
    input?.info &&
    input?.common &&
    input?.chars &&
    !('xml' in input) &&
    !('metadata' in input)
  ) {
    const pixels = legacyAtlasCanvas?.getContext
      ? legacyAtlasCanvas
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, legacyAtlasCanvas.width, legacyAtlasCanvas.height)
      : null;
    const result = verifyFontMetadata(input, {
      atlasWidth: legacyAtlasCanvas?.width,
      atlasHeight: legacyAtlasCanvas?.height,
      textureFile: input.pages?.[0]?.file,
      requireZeroBaseLineOffset: true,
    });
    alphaCheck(pixels, result.errors, result.warnings, result.checks);
    coloredArtworkCheck(pixels, result.warnings, result.checks);
    spaceAlphaCheck(input, pixels, result.errors, result.checks);
    result.ok = result.errors.length === 0;
    return result;
  }
  const {
    xml,
    json,
    metadata,
    atlasWidth,
    atlasHeight,
    textureFile,
    jsonFile,
    xmlFile,
    indexTs,
    assetsTsSnippet,
    assetKey,
    sampleText = '',
    expectedCharacters = '',
    texturePixels,
  } = input || {};
  const errors = [];
  const warnings = [];
  const checks = {};
  let xmlMetadata = metadata ?? null;
  let jsonMetadata = null;
  try {
    if (xml != null) xmlMetadata = parseBMFontXML(xml);
  } catch (error) {
    errors.push(errorIssue('invalid-xml', error.message));
  }
  try {
    if (json != null) jsonMetadata = parseBMFontJSON(json);
  } catch (error) {
    errors.push(errorIssue('invalid-json', error.message));
  }
  if (!xmlMetadata) errors.push(errorIssue('missing-xml', 'Authoritative BMFont XML is missing.'));

  let metadataVerification = null;
  if (xmlMetadata) {
    metadataVerification = verifyFontMetadata(xmlMetadata, {
      atlasWidth,
      atlasHeight,
      textureFile,
      sampleText,
      expectedCharacters,
      requireZeroBaseLineOffset: true,
    });
    errors.push(...metadataVerification.errors);
    warnings.push(...metadataVerification.warnings);
    Object.assign(checks, metadataVerification.checks);
  }
  if (jsonMetadata && xmlMetadata) {
    const same =
      JSON.stringify(charsComparable(jsonMetadata)) === JSON.stringify(charsComparable(xmlMetadata)) &&
      jsonMetadata.common.scaleW === xmlMetadata.common.scaleW &&
      jsonMetadata.common.scaleH === xmlMetadata.common.scaleH &&
      jsonMetadata.common.lineHeight === xmlMetadata.common.lineHeight &&
      jsonMetadata.pages[0]?.file === xmlMetadata.pages[0]?.file;
    checks.jsonMatchesXml = same;
    if (!same) errors.push(errorIssue('json-xml-mismatch', 'JSON metadata does not match XML metadata.'));
  } else {
    checks.jsonMatchesXml = json == null ? 'not-generated' : false;
  }

  if (indexTs != null) {
    const expectedTexture = `./${leafName(textureFile)}`;
    const expectedJson = `./${leafName(jsonFile || '')}?raw`;
    const valid =
      /createAsset\s*\(\s*\{\s*img\s*,\s*font\s*\}\s*\)/s.test(indexTs) &&
      indexTs.includes(`from '${expectedTexture}'`) &&
      (!jsonFile || indexTs.includes(`from '${expectedJson}'`));
    checks.registration = valid;
    if (!valid) {
      errors.push(
        errorIssue('invalid-index-registration', 'index.ts does not register the expected texture and font.')
      );
    }
  }
  if (assetsTsSnippet != null) {
    const valid =
      assetsTsSnippet.includes(`type: 'font'`) &&
      (!xmlFile || assetsTsSnippet.includes(leafName(xmlFile))) &&
      (!assetKey || assetsTsSnippet.includes(safeAssetKey(assetKey)));
    checks.assetsTsRegistration = valid;
    if (!valid) {
      errors.push(
        errorIssue('invalid-assets-registration', 'The assets.ts snippet does not reference the exported XML.')
      );
    }
  }
  alphaCheck(texturePixels, errors, warnings, checks);
  coloredArtworkCheck(texturePixels, warnings, checks);
  if (xmlMetadata) spaceAlphaCheck(xmlMetadata, texturePixels, errors, checks);
  return verificationResult(errors, warnings, checks, {
    metadata: xmlMetadata,
    jsonMetadata,
    layout: metadataVerification?.layout ?? null,
  });
}

export const verifyFontBuild = verifyBitmapFontBuild;
export const verifyBitmapFont = verifyBitmapFontBuild;

function safeWords(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function safeFileBase(value, fallback = 'bitmap_font') {
  const raw = fileStem(leafName(value)).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let safe = raw
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_.\s]+|[-_.\s]+$/g, '')
    .slice(0, 96);
  if (!safe || safe === '.' || safe === '..' || WINDOWS_RESERVED_NAMES.test(safe)) {
    safe = String(fallback || 'bitmap_font').replace(/[^A-Za-z0-9_-]+/g, '_') || 'bitmap_font';
  }
  return safe;
}

export const sanitizeFileBase = safeFileBase;

export function safeFolderName(value, fallback = 'bitmapFont') {
  return safeFileBase(value, fallback);
}

export const sanitizeFolderName = safeFolderName;

export function safeAssetKey(value, fallback = 'bitmapFont') {
  const words = safeWords(value);
  let key = words
    .map((word, index) => {
      const normalized = /^[A-Z0-9]+$/.test(word) ? word.toLowerCase() : word;
      return index === 0
        ? `${normalized[0].toLowerCase()}${normalized.slice(1)}`
        : `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
    })
    .join('');
  if (!key) key = safeWords(fallback).join('') || 'bitmapFont';
  if (/^\d/.test(key)) key = `font${key}`;
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) key = 'bitmapFont';
  if (JS_RESERVED_WORDS.has(key)) key = `${key}Font`;
  return key;
}

export const sanitizeAssetKey = safeAssetKey;

export function buildOutputNames({
  fontName = 'Bitmap Font',
  fileBase,
  folderName,
  assetKey,
  runtimeTexture = 'webp',
  includePng = true,
  includeWebp = true,
  includeJson = true,
  includeXml = true,
  includeIndex = true,
} = {}) {
  const base = safeFileBase(fileBase ?? fontName);
  const folder = safeFolderName(folderName ?? safeAssetKey(fontName));
  const key = safeAssetKey(assetKey ?? folder);
  const runtimeExtension = runtimeTexture === 'png' ? 'png' : 'webp';
  const names = {
    fontName: String(fontName),
    fileBase: base,
    folderName: folder,
    assetKey: key,
    pngFile: `${base}.png`,
    webpFile: `${base}.webp`,
    textureFile: `${base}.${runtimeExtension}`,
    jsonFile: `${base}.json`,
    xmlFile: `${base}.xml`,
    indexFile: 'index.ts',
  };
  names.files = [
    includePng ? names.pngFile : null,
    includeWebp ? names.webpFile : null,
    includeJson ? names.jsonFile : null,
    includeXml ? names.xmlFile : null,
    includeIndex ? names.indexFile : null,
  ].filter(Boolean);
  return names;
}

export const createOutputNames = buildOutputNames;

function safeImportLeaf(value, fallback) {
  const leaf = leafName(value);
  const dot = leaf.lastIndexOf('.');
  const extension = dot > 0 ? leaf.slice(dot).replace(/[^.A-Za-z0-9]/g, '') : '';
  return `${safeFileBase(dot > 0 ? leaf.slice(0, dot) : leaf, fallback)}${extension}`;
}

export function generateFontIndexTS({
  textureFile,
  jsonFile,
  metadataFile = jsonFile,
} = {}) {
  const texture = safeImportLeaf(textureFile || 'bitmap_font.webp', 'bitmap_font');
  const font = safeImportLeaf(metadataFile || 'bitmap_font.json', 'bitmap_font');
  return (
    `import { createAsset } from 'pixi-svelte';\n\n` +
    `import img from './${texture}';\n` +
    `import font from './${font}?raw';\n\n` +
    `export default createAsset({ img, font });\n`
  );
}

export const generateIndexTs = generateFontIndexTS;
export const generateStakeFontIndex = generateFontIndexTS;

export function generateAssetsTsSnippet({
  assetKey,
  folderName,
  xmlFile,
  assetsRoot = '../../assets/fonts',
  indent = '\t',
} = {}) {
  const key = safeAssetKey(assetKey ?? folderName ?? 'bitmapFont');
  const folder = safeFolderName(folderName ?? key);
  const xml = safeImportLeaf(xmlFile || `${safeFileBase(key)}.xml`, safeFileBase(key));
  const root = String(assetsRoot || '../../assets/fonts').replace(/\\/g, '/').replace(/\/+$/, '');
  return (
    `${indent}${key}: {\n` +
    `${indent}${indent}type: 'font',\n` +
    `${indent}${indent}src: new URL('${root}/${folder}/${xml}', import.meta.url).href,\n` +
    `${indent}},\n`
  );
}

export const generateAssetRegistrationSnippet = generateAssetsTsSnippet;
