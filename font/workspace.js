'use strict';
// Main-process support for the Bitmap Font workflow:
//   - opening loose glyph folders and existing BMFont packages
//   - extracting ZIP imports into validated, disposable workspaces
//   - inspecting Stake Engine web-sdk font conventions
//   - registering XML bitmap-font assets in src/game/assets.ts
//
// Imported source packages are read-only. ZIPs are expanded into a temporary
// workspace, and the module only removes workspaces it created and marked.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const spineWorkspace = require('../spine/workspace');

const toPosix = (value) => value.split(path.sep).join('/');
const FONT_FILE_RE = /(?:\.png|\.webp|\.json|\.xml)$/i;
const FONT_META_RE = /\.(?:xml|json)$/i;
const TEMP_MARKER = '.atlas-editor-font-workspace';
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 5000;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const tempWorkspaces = new Map();

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statIfExists(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function decodeXmlEntities(value) {
  return String(value).replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi,
    (entity, decimal, hex, named) => {
      if (named) {
        return {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        }[named.toLowerCase()];
      }
      const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
  );
}

function firstObject(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === 'object' ? value : {};
}

function normalizeJsonPages(value) {
  const pages = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of pages) {
    if (typeof item === 'string') {
      out.push({ id: String(out.length), file: item });
      continue;
    }
    const page = firstObject(item?.page || item);
    if (page && typeof page === 'object' && page.file != null) {
      out.push({ id: String(page.id ?? out.length), file: String(page.file) });
    }
  }
  return out;
}

function normalizeJsonChars(value) {
  const source = value?.char ?? value;
  if (Array.isArray(source)) return source;
  if (source && typeof source === 'object') return [source];
  return [];
}

function validCodePoint(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return false;
  const number = Number(value);
  return Number.isInteger(number) &&
    number >= 0 &&
    number <= 0x10ffff &&
    !(number >= 0xd800 && number <= 0xdfff);
}

function isXml10CodePoint(value) {
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0d ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function isXml10Text(value) {
  const text = String(value);
  for (const character of text) {
    if (!isXml10CodePoint(character.codePointAt(0))) return false;
  }
  for (const match of text.matchAll(/&#(?:x([0-9a-f]+)|(\d+));/gi)) {
    const codePoint = Number.parseInt(match[1] || match[2], match[1] ? 16 : 10);
    if (!isXml10CodePoint(codePoint)) return false;
  }
  return true;
}

function summarizeCharacters(chars) {
  const ids = [];
  const invalidCharacterIds = [];
  const duplicateCharacterIds = [];
  const seen = new Set();
  for (const glyph of chars) {
    const rawId = glyph?.id;
    if (!validCodePoint(rawId)) {
      invalidCharacterIds.push(rawId == null ? '' : String(rawId));
      continue;
    }
    const id = Number(rawId);
    if (seen.has(id)) duplicateCharacterIds.push(id);
    else seen.add(id);
    ids.push(id);
  }
  return {
    characterCount: chars.length,
    characterIds: ids,
    invalidCharacterIds,
    duplicateCharacterIds: [...new Set(duplicateCharacterIds)],
  };
}

function parseXmlMetadata(text) {
  if (typeof text !== 'string' || !/<font(?:\s|>)/i.test(text)) return null;
  const infoTag = /<info\b[^>]*>/i.exec(text)?.[0] || '';
  const commonTag = /<common\b[^>]*>/i.exec(text)?.[0] || '';
  const pageTags = [...text.matchAll(/<page\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const chars = [...text.matchAll(/<char\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  if (!infoTag || !commonTag || !/<chars(?:\s|>)/i.test(text)) return null;
  const info = parseAttributes(infoTag);
  const common = parseAttributes(commonTag);
  const pageFiles = pageTags.map((page) => page.file).filter((file) => typeof file === 'string');
  return {
    format: 'xml',
    literalFontRoot: /<font>/.test(text),
    xml10Valid: isXml10Text(text),
    face: info.face || null,
    size: Number(info.size) || null,
    lineHeight: Number(common.lineHeight) || null,
    base: Number(common.base) || null,
    scaleW: Number(common.scaleW) || null,
    scaleH: Number(common.scaleH) || null,
    declaredPages: Number(common.pages),
    pages: pageTags.map((page, index) => ({
      id: String(page.id ?? index),
      file: page.file || '',
    })),
    pageFiles,
    chars,
    ...summarizeCharacters(chars),
  };
}

function parseJsonMetadata(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const info = firstObject(json.info);
  const common = firstObject(json.common);
  const chars = normalizeJsonChars(json.chars);
  const pages = normalizeJsonPages(json.pages);
  if (!Object.keys(info).length || !Object.keys(common).length || !json.chars) return null;
  return {
    format: 'json',
    face: info.face == null ? null : String(info.face),
    size: Number(info.size) || null,
    lineHeight: Number(common.lineHeight) || null,
    base: Number(common.base) || null,
    scaleW: Number(common.scaleW) || null,
    scaleH: Number(common.scaleH) || null,
    declaredPages: Number(common.pages),
    pages,
    pageFiles: pages.map((page) => page.file).filter(Boolean),
    chars,
    ...summarizeCharacters(chars),
  };
}

function parseMetadata(file, text = null) {
  const source = text == null ? readIfExists(file) : text;
  if (source == null) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xml') return parseXmlMetadata(source);
  if (ext === '.json') return parseJsonMetadata(source);
  return null;
}

function readImageInfo(file) {
  let data;
  let handle;
  try {
    const size = fs.statSync(file).size;
    handle = fs.openSync(file, 'r');
    data = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(handle, data, 0, data.length, 0);
  } catch {
    return null;
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
  const ext = path.extname(file).toLowerCase();
  if (
    ext === '.png' &&
    data.length >= 33 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    const colorType = data[25];
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      format: 'png',
      hasAlpha: colorType === 4 || colorType === 6 || data.includes(Buffer.from('tRNS')),
    };
  }
  if (
    ext === '.webp' &&
    data.length >= 30 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
        format: 'webp',
        codec: 'VP8X',
        hasAlpha: !!(data[20] & 0x10),
      };
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
        format: 'webp',
        codec: 'VP8L',
        hasAlpha: null,
      };
    }
    if (
      kind === 'VP8 ' &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    ) {
      return {
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
        format: 'webp',
        codec: 'VP8',
        hasAlpha: false,
      };
    }
  }
  return null;
}

function inspectMetadataAt(file) {
  const fileStat = statIfExists(file);
  if (!fileStat?.isFile() || fileStat.size > MAX_METADATA_BYTES) return null;
  const text = readIfExists(file);
  if (text == null) return null;
  const parsed = parseMetadata(file, text);
  if (!parsed) return null;
  return {
    name: path.basename(file),
    path: toPosix(path.resolve(file)),
    format: parsed.format,
    bytes: fileStat.size,
    text,
    ...parsed,
  };
}

async function walkForMetadata(dir, depth = 0, state = { files: [], count: 0 }) {
  if (depth > MAX_SCAN_DEPTH || state.count >= MAX_SCAN_FILES) return state.files;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return state.files;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const entry of entries) {
    if (state.count >= MAX_SCAN_FILES) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForMetadata(full, depth + 1, state);
    } else if (entry.isFile()) {
      state.count++;
      if (FONT_META_RE.test(entry.name)) state.files.push({ file: full, depth });
    }
  }
  return state.files;
}

function packageFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && (FONT_FILE_RE.test(entry.name) || /^index\.ts$/i.test(entry.name)))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return {
        name: entry.name,
        path: toPosix(file),
        extension: /^index\.ts$/i.test(entry.name)
          ? 'index.ts'
          : path.extname(entry.name).toLowerCase().slice(1),
        bytes: statIfExists(file)?.size ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function inspectMetadataVerification(metadata, packageDir) {
  if (!metadata) {
    return {
      metadataValid: false,
      pageFiles: [],
      missingPages: [],
      dimensionMismatches: [],
      invalidCharacterIds: [],
      duplicateCharacterIds: [],
      outOfBoundsGlyphs: [],
      invalidGlyphMetrics: [],
    };
  }
  const missingPages = [];
  const unsafePages = [];
  const pageDetails = [];
  const dimensionMismatches = [];
  const resolvedPackage = path.resolve(packageDir);
  for (const file of metadata.pageFiles) {
    const dest = path.resolve(resolvedPackage, file);
    if (!isWithin(resolvedPackage, dest)) {
      unsafePages.push(file);
      continue;
    }
    const exists = statIfExists(dest)?.isFile() || false;
    if (!exists) missingPages.push(file);
    const image = exists ? readImageInfo(dest) : null;
    if (
      image &&
      Number.isFinite(metadata.scaleW) &&
      Number.isFinite(metadata.scaleH) &&
      (image.width !== metadata.scaleW || image.height !== metadata.scaleH)
    ) {
      dimensionMismatches.push({
        file,
        metadata: { width: metadata.scaleW, height: metadata.scaleH },
        image: { width: image.width, height: image.height },
      });
    }
    pageDetails.push({
      file,
      path: toPosix(dest),
      exists,
      image,
    });
  }
  const outOfBoundsGlyphs = [];
  const invalidGlyphMetrics = [];
  const invalidGlyphPages = [];
  const pageIds = metadata.pages.map((page) => Number(page.id));
  const validPageIds =
    pageIds.length > 0 &&
    pageIds.every((id) => Number.isInteger(id) && id >= 0) &&
    new Set(pageIds).size === pageIds.length;
  const pageIdSet = new Set(pageIds);
  let hasPositiveFrame = false;
  let validSpaceAdvance = false;
  if (Number.isFinite(metadata.scaleW) && Number.isFinite(metadata.scaleH)) {
    for (const glyph of metadata.chars) {
      const x = Number(glyph.x);
      const y = Number(glyph.y);
      const width = Number(glyph.width);
      const height = Number(glyph.height);
      const xoffset = Number(glyph.xoffset);
      const yoffset = Number(glyph.yoffset);
      const xadvance = Number(glyph.xadvance);
      const glyphPage = glyph.page == null || glyph.page === '' ? 0 : Number(glyph.page);
      if (![x, y, width, height, xoffset, yoffset, xadvance].every(Number.isInteger)) {
        invalidGlyphMetrics.push(String(glyph.id ?? ''));
        continue;
      }
      if (!Number.isInteger(glyphPage) || !pageIdSet.has(glyphPage)) {
        invalidGlyphPages.push(String(glyph.id ?? ''));
      }
      if (
        (x < 0 || y < 0 || width < 0 || height < 0 ||
          x + width > metadata.scaleW || y + height > metadata.scaleH)
      ) {
        outOfBoundsGlyphs.push(String(glyph.id ?? ''));
      } else if (width > 0 && height > 0) {
        hasPositiveFrame = true;
      }
      if (Number(glyph.id) === 32 && xadvance > 0) validSpaceAdvance = true;
    }
  }
  const validCommonMetrics =
    Number.isInteger(metadata.size) &&
    metadata.size > 0 &&
    Number.isInteger(metadata.lineHeight) &&
    metadata.lineHeight > 0 &&
    Number.isInteger(metadata.base) &&
    metadata.base >= 0 &&
    Number.isInteger(metadata.scaleW) &&
    metadata.scaleW > 0 &&
    Number.isInteger(metadata.scaleH) &&
    metadata.scaleH > 0;
  const declaredPagesValid =
    Number.isInteger(metadata.declaredPages) &&
    metadata.declaredPages === metadata.pages.length &&
    metadata.declaredPages > 0;
  const warnings = [];
  if (missingPages.length) warnings.push({ level: 'error', message: `Missing texture pages: ${missingPages.join(', ')}.` });
  if (unsafePages.length) warnings.push({ level: 'error', message: `Unsafe texture page paths: ${unsafePages.join(', ')}.` });
  if (dimensionMismatches.length) warnings.push({ level: 'error', message: 'Texture dimensions do not match BMFont common metrics.' });
  if (metadata.invalidCharacterIds.length) {
    warnings.push({ level: 'error', message: `Invalid character IDs: ${metadata.invalidCharacterIds.join(', ')}.` });
  }
  if (metadata.duplicateCharacterIds.length) {
    warnings.push({ level: 'error', message: `Duplicate character IDs: ${metadata.duplicateCharacterIds.join(', ')}.` });
  }
  if (invalidGlyphMetrics.length) warnings.push({ level: 'error', message: 'One or more glyphs use non-integer or missing runtime metrics.' });
  if (invalidGlyphPages.length) warnings.push({ level: 'error', message: 'One or more glyphs reference an undeclared texture page.' });
  if (outOfBoundsGlyphs.length) warnings.push({ level: 'error', message: 'One or more glyph frames extend outside the texture.' });
  if (!validCommonMetrics) warnings.push({ level: 'error', message: 'Font size, line height, baseline, and texture dimensions must be valid integers.' });
  if (!validPageIds || !declaredPagesValid) warnings.push({ level: 'error', message: 'BMFont page declarations are invalid or inconsistent.' });
  if (!hasPositiveFrame) warnings.push({ level: 'error', message: 'The font contains no positive in-bounds glyph frame.' });
  if (metadata.format === 'xml' && !metadata.literalFontRoot) {
    warnings.push({ level: 'error', message: 'Pixi requires the generated XML to use a literal <font> root tag.' });
  }
  if (metadata.format === 'xml' && !metadata.xml10Valid) {
    warnings.push({ level: 'error', message: 'The metadata contains characters forbidden by XML 1.0.' });
  }
  if (!validSpaceAdvance) warnings.push({ level: 'error', message: 'U+0020 SPACE is missing or has no positive integer advance.' });
  return {
    metadataValid: true,
    format: metadata.format,
    face: metadata.face,
    characterCount: metadata.characterCount,
    pageFiles: metadata.pageFiles,
    pageDetails,
    missingPages,
    unsafePages,
    dimensionMismatches,
    invalidCharacterIds: metadata.invalidCharacterIds,
    duplicateCharacterIds: metadata.duplicateCharacterIds,
    outOfBoundsGlyphs,
    invalidGlyphMetrics,
    invalidGlyphPages,
    validPageIds,
    declaredPagesValid,
    validCommonMetrics,
    literalFontRoot: metadata.format !== 'xml' || metadata.literalFontRoot,
    xml10Valid: metadata.format !== 'xml' || metadata.xml10Valid,
    hasPositiveFrame,
    validSpaceAdvance,
    warnings,
    hasFace: typeof metadata.face === 'string' && metadata.face.length > 0,
    hasTexturePages: metadata.pageFiles.length > 0,
    validTextureDimensions:
      Number.isFinite(metadata.scaleW) &&
      metadata.scaleW > 0 &&
      Number.isFinite(metadata.scaleH) &&
      metadata.scaleH > 0,
    validLineHeight: Number.isFinite(metadata.lineHeight) && metadata.lineHeight > 0,
    hasCharacters: metadata.chars.length > 0,
    ok:
      typeof metadata.face === 'string' &&
      metadata.face.length > 0 &&
      metadata.pageFiles.length > 0 &&
      Number.isFinite(metadata.scaleW) &&
      metadata.scaleW > 0 &&
      Number.isFinite(metadata.scaleH) &&
      metadata.scaleH > 0 &&
      Number.isFinite(metadata.lineHeight) &&
      metadata.lineHeight > 0 &&
      metadata.chars.length > 0 &&
      (metadata.format !== 'xml' || metadata.literalFontRoot) &&
      (metadata.format !== 'xml' || metadata.xml10Valid) &&
      validCommonMetrics &&
      validPageIds &&
      declaredPagesValid &&
      hasPositiveFrame &&
      validSpaceAdvance &&
      missingPages.length === 0 &&
      unsafePages.length === 0 &&
      dimensionMismatches.length === 0 &&
      metadata.invalidCharacterIds.length === 0 &&
      metadata.duplicateCharacterIds.length === 0 &&
      outOfBoundsGlyphs.length === 0 &&
      invalidGlyphMetrics.length === 0 &&
      invalidGlyphPages.length === 0,
  };
}

/** List only direct-child PNG glyph files from a selected loose folder. */
async function listFolder(dir) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) {
    throw new Error('Bitmap font source folder must be a non-empty path.');
  }
  const resolved = path.resolve(dir);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Bitmap font source must be a folder.');
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const glyphs = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png') continue;
    const file = path.join(resolved, entry.name);
    const fileStat = await fsp.stat(file);
    glyphs.push({
      name: entry.name,
      path: toPosix(file),
      size: fileStat.size,
      byteLength: fileStat.size,
      image: readImageInfo(file),
    });
  }
  glyphs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    ok: true,
    root: toPosix(resolved),
    glyphs,
    pngFiles: glyphs,
    count: glyphs.length,
  };
}

async function inspectSourceRoot(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const candidates = [];
  const scanState = { files: [], count: 0 };
  const found = await walkForMetadata(resolvedRoot, 0, scanState);
  for (const item of found) {
    const inspected = inspectMetadataAt(item.file);
    if (inspected) candidates.push({ ...inspected, depth: item.depth });
  }
  candidates.sort((a, b) => {
    if (a.format !== b.format) return a.format === 'xml' ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path, undefined, { numeric: true });
  });

  let selected = null;
  if (options.preferredMetadata) {
    const preferred = path.resolve(options.preferredMetadata);
    const preferredCandidate =
      candidates.find((candidate) => path.resolve(candidate.path) === preferred) || null;
    // XML is the Stake/Pixi runtime source of truth. An explicitly selected
    // JSON file is used only when the package has no compatible XML.
    if (
      preferredCandidate &&
      (preferredCandidate.format === 'xml' || !candidates.some((candidate) => candidate.format === 'xml'))
    ) {
      selected = preferredCandidate;
    }
  }
  if (!selected) selected = candidates[0] || null;
  const packageDir = selected ? path.dirname(selected.path) : resolvedRoot;
  const direct = await listFolder(packageDir);
  const files = packageFiles(packageDir);
  const verification = inspectMetadataVerification(selected, packageDir);

  return {
    ok: true,
    root: toPosix(resolvedRoot),
    packageDir: toPosix(packageDir),
    mode: selected ? 'package' : 'glyphs',
    metadata: selected,
    selectedMetadata: selected,
    metadataCandidates: candidates,
    packageFiles: files,
    glyphs: selected ? [] : direct.glyphs,
    directPngs: direct.glyphs,
    verification,
    scannedToDepth: MAX_SCAN_DEPTH,
    scanTruncated: scanState.count >= MAX_SCAN_FILES,
  };
}

/** Open a folder, XML/JSON metadata file, PNG file, or ZIP font delivery. */
async function openSource(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) {
    throw new Error('Bitmap font source must be a non-empty path.');
  }
  const original = path.resolve(sourcePath);
  const stat = await fsp.stat(original);
  let root;
  let preferredMetadata = null;
  let fromArchive = false;
  let tempWorkspace = false;
  let workspaceToken = null;

  if (stat.isDirectory()) {
    root = original;
  } else if (stat.isFile() && /\.zip$/i.test(original)) {
    // Reuse Exporter's hardened ZIP parser/extractor, then add a
    // font-specific marker so cleanup cannot target an arbitrary temp folder.
    root = await spineWorkspace.extractZip(original);
    workspaceToken = crypto.randomBytes(24).toString('hex');
    const marker = {
      kind: 'atlas-editor-bitmap-font',
      token: workspaceToken,
      createdAt: new Date().toISOString(),
      source: toPosix(original),
    };
    await fsp.writeFile(path.join(root, TEMP_MARKER), JSON.stringify(marker), 'utf8');
    tempWorkspaces.set(path.resolve(root), workspaceToken);
    fromArchive = true;
    tempWorkspace = true;
  } else if (stat.isFile() && /\.(?:xml|json|png)$/i.test(original)) {
    root = path.dirname(original);
    if (FONT_META_RE.test(original)) preferredMetadata = original;
  } else {
    throw new Error('Select a glyph folder, BMFont XML/JSON file, PNG, or .zip archive.');
  }

  try {
    const scan = await inspectSourceRoot(root, { preferredMetadata });
    return {
      ...scan,
      fromArchive,
      tempWorkspace,
      originalPath: toPosix(original),
    };
  } catch (error) {
    if (tempWorkspace) await cleanup(root).catch(() => {});
    throw error;
  }
}

/** Remove only a marked temp workspace created by openSource(.zip). */
async function cleanup(rootOrOptions) {
  const requested = typeof rootOrOptions === 'string'
    ? rootOrOptions
    : rootOrOptions?.root || rootOrOptions?.workspace;
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    return { ok: false, removed: false, error: 'A font temp workspace path is required.' };
  }
  const resolved = path.resolve(requested);
  const token = tempWorkspaces.get(resolved);
  if (!token) {
    return { ok: false, removed: false, error: 'This path is not a font workspace created by this session.' };
  }
  const tempRoot = path.resolve(os.tmpdir());
  const base = path.basename(resolved);
  if (!isWithin(tempRoot, resolved) || !base.startsWith('atlas-editor-anim-')) {
    return { ok: false, removed: false, error: 'The recorded font workspace path failed validation.' };
  }
  const dirStat = await fsp.lstat(resolved).catch(() => null);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    tempWorkspaces.delete(resolved);
    return { ok: false, removed: false, error: 'The recorded font workspace no longer exists safely.' };
  }
  let marker;
  try {
    marker = JSON.parse(await fsp.readFile(path.join(resolved, TEMP_MARKER), 'utf8'));
  } catch {
    return { ok: false, removed: false, error: 'The font workspace marker is missing or invalid.' };
  }
  if (marker?.kind !== 'atlas-editor-bitmap-font' || marker?.token !== token) {
    return { ok: false, removed: false, error: 'The font workspace marker does not match this session.' };
  }
  await fsp.rm(resolved, { recursive: true, force: true });
  tempWorkspaces.delete(resolved);
  return { ok: true, removed: true, root: toPosix(resolved) };
}

function inspectIndexTs(file) {
  const source = readIfExists(file);
  if (source == null) return null;
  const imports = [];
  for (const match of source.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])(\.\/[^'"]+)\2\s*;/g
  )) {
    imports.push({ binding: match[1], path: match[3] });
  }
  return {
    text: source,
    imports,
    usesCreateAsset: /\bcreateAsset\s*\(/.test(source),
  };
}

function inspectFontFolder(dir) {
  const stat = statIfExists(dir);
  if (!stat?.isDirectory()) return null;
  const files = packageFiles(dir);
  const xmlFiles = files.filter((file) => file.extension === 'xml');
  const jsonFiles = files.filter((file) => file.extension === 'json');
  const textures = files.filter((file) => file.extension === 'png' || file.extension === 'webp');
  const metadata = [
    ...xmlFiles.map((file) => inspectMetadataAt(file.path)).filter(Boolean),
    ...jsonFiles.map((file) => inspectMetadataAt(file.path)).filter(Boolean),
  ];
  const primary = metadata.find((item) => item.format === 'xml') || metadata[0] || null;
  const indexFile = files.find((file) => file.extension === 'index.ts');
  const index = indexFile ? inspectIndexTs(indexFile.path) : null;
  const verification = inspectMetadataVerification(primary, dir);
  return {
    name: path.basename(dir),
    dir: toPosix(path.resolve(dir)),
    files,
    xmlFiles: xmlFiles.map((file) => file.name),
    jsonFiles: jsonFiles.map((file) => file.name),
    textures: textures.map((file) => file.name),
    textureFormats: [...new Set(textures.map((file) => file.extension))],
    hasXml: xmlFiles.length > 0,
    hasJson: jsonFiles.length > 0,
    hasIndexTs: !!indexFile,
    indexTs: index,
    metadata,
    primaryMetadata: primary,
    faces: [...new Set(metadata.map((item) => item.face).filter(Boolean))],
    pageFiles: primary?.pageFiles || [],
    pageFormats: [...new Set((primary?.pageFiles || []).map((file) => path.extname(file).toLowerCase().slice(1)).filter(Boolean))],
    pageFormat:
      (primary?.pageFiles || []).map((file) => path.extname(file).toLowerCase().slice(1)).find(Boolean) || null,
    verification,
  };
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipTrivia(source, start) {
  let i = start;
  while (i < source.length) {
    if (/\s|,/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i + 2);
      if (i < 0) return source.length;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return source.length;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readProperty(source, start) {
  let i = start;
  if (source[i] === "'" || source[i] === '"') {
    const quote = source[i++];
    let key = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        // Asset keys should not need escape sequences; retain a conservative
        // representation for duplicate detection without evaluating JS.
        key += source[i + 1] || '';
        i += 2;
      } else {
        key += source[i++];
      }
    }
    if (source[i] !== quote) return null;
    return { key, end: i + 1 };
  }
  const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
  return match ? { key: match[0], end: i + match[0].length } : null;
}

/** Extract direct properties of the `export default { ... }` asset manifest. */
function topLevelAssetEntries(source) {
  const exportMatch = /\bexport\s+default\s*\{/.exec(source);
  if (!exportMatch) return { anchor: -1, entries: [] };
  const open = source.indexOf('{', exportMatch.index);
  const close = matchingBrace(source, open);
  if (close < 0) return { anchor: open, entries: [] };
  const entries = [];
  let i = open + 1;
  while (i < close) {
    i = skipTrivia(source, i);
    const property = readProperty(source, i);
    if (!property) {
      i++;
      continue;
    }
    let cursor = skipTrivia(source, property.end);
    if (source[cursor] !== ':') {
      i = property.end;
      continue;
    }
    cursor = skipTrivia(source, cursor + 1);
    if (source[cursor] !== '{') {
      i = cursor + 1;
      continue;
    }
    const end = matchingBrace(source, cursor);
    if (end < 0 || end > close) break;
    entries.push({
      key: property.key,
      start: i,
      open: cursor,
      end,
      body: source.slice(cursor, end + 1),
    });
    i = end + 1;
  }
  return { anchor: open, close, entries };
}

function assetRelativePath(raw) {
  const posix = String(raw || '').replace(/\\/g, '/');
  const match = /(?:^|\/)assets\/(.+)$/.exec(posix);
  return (match ? match[1] : posix).replace(/^\/+/, '');
}

function parseAssetsTs(source) {
  const parsed = topLevelAssetEntries(source);
  const fontEntries = [];
  for (const entry of parsed.entries) {
    if (!/\btype\s*:\s*(['"])font\1/.test(entry.body)) continue;
    const url = /\bsrc\s*:\s*new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)\.href/.exec(entry.body);
    if (!url) continue;
    fontEntries.push({
      key: entry.key,
      url: url[2],
      xmlRel: assetRelativePath(url[2]),
    });
  }
  return {
    anchor: parsed.anchor,
    keys: new Set(parsed.entries.map((entry) => entry.key)),
    fontEntries,
  };
}

function findPackageAbove(appDir) {
  const roots = [];
  let current = path.resolve(appDir);
  for (let i = 0; i < 7; i++) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of roots) {
    for (const relative of [
      path.join('packages', 'pixi-svelte', 'package.json'),
      path.join('node_modules', 'pixi-svelte', 'package.json'),
    ]) {
      const pkgPath = path.join(root, relative);
      const text = readIfExists(pkgPath);
      if (text == null) continue;
      try {
        const pkg = JSON.parse(text);
        const packageDir = path.dirname(pkgPath);
        let createAssetAvailable = false;
        for (const probe of [
          path.join(packageDir, 'src', 'index.ts'),
          path.join(packageDir, 'dist', 'index.js'),
          path.join(packageDir, 'dist', 'index.d.ts'),
        ]) {
          const probeText = readIfExists(probe);
          if (probeText && /\bcreateAsset\b/.test(probeText)) {
            createAssetAvailable = true;
            break;
          }
        }
        return {
          path: toPosix(pkgPath),
          version: pkg.version == null ? null : String(pkg.version),
          pixiVersion:
            pkg.dependencies?.['pixi.js'] ||
            pkg.peerDependencies?.['pixi.js'] ||
            pkg.devDependencies?.['pixi.js'] ||
            null,
          createAssetAvailable,
        };
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function walkSourceFiles(dir, depth = 0, out = []) {
  if (depth > 5 || out.length >= MAX_SCAN_FILES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(file, depth + 1, out);
    else if (/\.(?:ts|tsx|js|jsx|svelte|css|scss)$/i.test(entry.name)) out.push(file);
  }
  return out;
}

function scanFontFamilyUsage(appDir) {
  const usage = new Map();
  for (const file of walkSourceFiles(path.join(appDir, 'src'))) {
    const source = readIfExists(file);
    if (source == null || (!source.includes('fontFamily') && !source.includes('font-family'))) continue;
    const found = [];
    for (const match of source.matchAll(/\bfontFamily\s*:\s*(['"])([^'"]+)\1/g)) found.push(match[2]);
    for (const match of source.matchAll(/\bfont-family\s*:\s*(['"]?)([^;'"}\n]+)\1/g)) {
      found.push(match[2].trim());
    }
    for (const family of found) {
      if (!family) continue;
      if (!usage.has(family)) usage.set(family, { family, count: 0, files: [] });
      const item = usage.get(family);
      item.count++;
      const relative = toPosix(path.relative(appDir, file));
      if (!item.files.includes(relative)) item.files.push(relative);
    }
  }
  return [...usage.values()].sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

function validateRegisteredFile(assetsRoot, entry) {
  const absolute = path.resolve(assetsRoot, entry.xmlRel);
  const safe = isWithin(assetsRoot, absolute);
  const exists = safe && statIfExists(absolute)?.isFile();
  const metadata = exists ? inspectMetadataAt(absolute) : null;
  const folder = safe && exists ? inspectFontFolder(path.dirname(absolute)) : null;
  const pageFormats = [
    ...new Set((metadata?.pageFiles || []).map((file) => path.extname(file).toLowerCase().slice(1)).filter(Boolean)),
  ];
  return {
    ...entry,
    absolutePath: toPosix(absolute),
    safe,
    exists: !!exists,
    folder: entry.xmlRel.split('/').slice(1, -1).join('/'),
    face: metadata?.face || null,
    pageFiles: metadata?.pageFiles || [],
    pageFormats,
    pageFormat: pageFormats[0] || null,
    metadata,
    verification: folder?.verification || {
      ok: false,
      metadataValid: false,
      missingPages: [],
    },
  };
}

/** Find web-sdk applications using the existing, tested app discovery logic. */
function findApps(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) return [];
  return spineWorkspace.findApps(root);
}

/** Inspect the selected app's actual font loader and asset conventions. */
function inspectApp(appDir) {
  if (typeof appDir !== 'string' || !appDir || appDir.includes('\0')) {
    return { ok: false, error: 'A Stake Engine app folder is required.' };
  }
  const resolvedApp = path.resolve(appDir);
  const assetsTsPath = path.join(resolvedApp, 'src', 'game', 'assets.ts');
  const source = readIfExists(assetsTsPath);
  if (source == null) return { ok: false, error: 'src/game/assets.ts not found in this app.' };

  const parsed = parseAssetsTs(source);
  const assetsRoot = path.join(resolvedApp, 'static', 'assets');
  const fontsRoot = path.join(assetsRoot, 'fonts');
  const registeredFonts = parsed.fontEntries.map((entry) => validateRegisteredFile(assetsRoot, entry));
  let folders = [];
  try {
    folders = fs
      .readdirSync(fontsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => inspectFontFolder(path.join(fontsRoot, entry.name)))
      .filter(Boolean);
  } catch {
    folders = [];
  }

  const pixi = findPackageAbove(resolvedApp);
  const fontFamilyUsage = scanFontFamilyUsage(resolvedApp);
  const existingFaces = [...new Set(registeredFonts.map((entry) => entry.face).filter(Boolean))];
  const formatCounts = new Map();
  for (const entry of registeredFonts) {
    for (const format of entry.pageFormats) {
      formatCounts.set(format, (formatCounts.get(format) || 0) + 1);
    }
  }
  const preferredTextureFormat =
    [...formatCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'webp';
  const registeredPaths = new Set(registeredFonts.map((entry) => entry.xmlRel));
  const unregisteredFolders = folders
    .filter((folder) => !folder.xmlFiles.some((file) => registeredPaths.has(`fonts/${folder.name}/${file}`)))
    .map((folder) => folder.name);
  const faceCounts = new Map();
  for (const entry of registeredFonts) {
    if (entry.face) faceCounts.set(entry.face, (faceCounts.get(entry.face) || 0) + 1);
  }
  const duplicateFaces = [...faceCounts.entries()].filter(([, count]) => count > 1).map(([face]) => face);
  const warnings = [];
  if (!registeredFonts.length) warnings.push('No type: font entries were found in src/game/assets.ts.');
  if (!pixi) warnings.push('packages/pixi-svelte/package.json was not found; loader compatibility could not be confirmed.');
  if (pixi && !pixi.createAssetAvailable) {
    warnings.push('This pixi-svelte package does not export createAsset; index.ts is a compatibility artifact, not the runtime registration.');
  }
  if (registeredFonts.some((entry) => !entry.exists)) warnings.push('One or more registered font XML files are missing.');
  if (registeredFonts.some((entry) => entry.exists && !entry.verification.ok)) {
    warnings.push('One or more registered font packages failed metadata or texture-page verification.');
  }
  if (duplicateFaces.length) warnings.push(`Duplicate XML font faces are registered: ${duplicateFaces.join(', ')}.`);

  return {
    ok: true,
    appDir: toPosix(resolvedApp),
    appName: path.basename(resolvedApp),
    assetsTsPath: toPosix(assetsTsPath),
    manifestPath: toPosix(assetsTsPath),
    assetsRoot: toPosix(assetsRoot),
    fontsRoot: toPosix(fontsRoot),
    existingKeys: [...parsed.keys],
    existingFaces,
    registeredFonts,
    fontEntries: registeredFonts,
    fontFolders: folders,
    folders,
    fontFamilyUsage,
    preferredTextureFormat,
    pixiSvelteVersion: pixi?.version || null,
    pixiVersion: pixi?.pixiVersion || null,
    pixiSvelte: pixi,
    registrationStyle: 'assets.ts',
    createAssetAvailable: pixi?.createAssetAvailable ?? null,
    supportsXml: true,
    supportsFnt: true,
    supportsJson: false,
    runtimeMetadataFormat: 'xml',
    unregisteredFolders,
    warnings,
    verification: {
      ok:
        registeredFonts.every((entry) => entry.exists && entry.verification.ok) &&
        duplicateFaces.length === 0,
      registeredCount: registeredFonts.length,
      missingMetadata: registeredFonts.filter((entry) => !entry.exists).map((entry) => entry.xmlRel),
      invalidPackages: registeredFonts
        .filter((entry) => entry.exists && !entry.verification.ok)
        .map((entry) => entry.xmlRel),
      duplicateFaces,
      unregisteredFolders,
    },
  };
}

function validJsIdentifier(key) {
  return typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function normalizeRegistrationPath(entry, fontsRoot, assetsRoot) {
  let raw =
    entry.xmlRel ||
    entry.xml ||
    entry.path ||
    entry.src ||
    entry.metadataPath ||
    null;
  if (!raw && entry.folder && (entry.file || entry.xmlFile || entry.name)) {
    raw = `${entry.folder}/${entry.file || entry.xmlFile || entry.name}`;
  }
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) {
    throw new Error('Each font registration needs an XML path.');
  }

  let relative;
  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    if (!isWithin(fontsRoot, absolute)) throw new Error('Font XML must be inside the selected app fonts folder.');
    relative = toPosix(path.relative(assetsRoot, absolute));
  } else {
    relative = raw.replace(/\\/g, '/');
    relative = relative.replace(/^(\.\.\/)+assets\//, '');
    relative = relative.replace(/^static\/assets\//, '');
    relative = relative.replace(/^assets\//, '');
    if (!relative.startsWith('fonts/')) relative = `fonts/${relative}`;
  }
  const normalized = path.posix.normalize(relative);
  const segments = normalized.split('/');
  if (
    !normalized.startsWith('fonts/') ||
    !/\.xml$/i.test(normalized) ||
    segments.some((segment) =>
      !segment ||
      segment === '.' ||
      segment === '..' ||
      /[\0-\x1f<>'"#%:|?*]/.test(segment) ||
      /[ .]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
  ) {
    throw new Error(`Unsafe font XML path: ${JSON.stringify(raw)}.`);
  }
  const absolute = path.resolve(assetsRoot, ...normalized.split('/'));
  if (!isWithin(fontsRoot, absolute)) throw new Error('Font XML path escapes the selected app fonts folder.');
  return { relative: normalized, absolute };
}

/**
 * Append one or more type:'font' XML registrations to src/game/assets.ts.
 * Existing source is preserved byte-for-byte around the inserted block.
 */
function registerFontAsset(options) {
  const appDir = options?.appDir;
  if (typeof appDir !== 'string' || !appDir || appDir.includes('\0')) {
    return { ok: false, error: 'A Stake Engine app folder is required.' };
  }
  const resolvedApp = path.resolve(appDir);
  const assetsTsPath = path.join(resolvedApp, 'src', 'game', 'assets.ts');
  let source = readIfExists(assetsTsPath);
  if (source == null) return { ok: false, error: 'src/game/assets.ts not found.' };
  const manifestStat = (() => {
    try {
      return fs.lstatSync(assetsTsPath);
    } catch {
      return null;
    }
  })();
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    return { ok: false, error: 'src/game/assets.ts must be a regular, non-symbolic-link file.' };
  }
  const parsed = parseAssetsTs(source);
  if (parsed.anchor < 0) {
    return { ok: false, error: 'assets.ts has no `export default {` object; register the font by hand.' };
  }
  const assetsRoot = path.join(resolvedApp, 'static', 'assets');
  const fontsRoot = path.join(assetsRoot, 'fonts');
  const requested = Array.isArray(options.entries) ? options.entries : [options];
  if (!requested.length) return { ok: false, error: 'No font registrations were supplied.' };

  const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const existingPaths = new Map(parsed.fontEntries.map((entry) => [pathKey(entry.xmlRel), entry]));
  const existingByKey = new Map(parsed.fontEntries.map((entry) => [entry.key, entry]));
  const existingFaces = new Map();
  for (const item of parsed.fontEntries.map((entry) => validateRegisteredFile(assetsRoot, entry))) {
    if (item.face && !existingFaces.has(item.face)) existingFaces.set(item.face, item);
  }
  const stagedKeys = new Set();
  const stagedPaths = new Set();
  const stagedFaces = new Map();
  const prepared = [];
  const skipped = [];
  const alreadyRegistered = [];

  try {
    for (const entry of requested) {
      const key = entry?.key || entry?.assetKey;
      if (!validJsIdentifier(key)) {
        throw new Error(`Font asset key must be a safe JavaScript identifier: ${JSON.stringify(key)}.`);
      }
      const target = normalizeRegistrationPath(entry, fontsRoot, assetsRoot);
      const fileStat = statIfExists(target.absolute);
      if (!fileStat?.isFile()) throw new Error(`Font XML does not exist: ${target.relative}.`);
      const realFontsRoot = fs.realpathSync(fontsRoot);
      const realXml = fs.realpathSync(target.absolute);
      if (!isWithin(realFontsRoot, realXml)) throw new Error(`Font XML resolves outside the fonts folder: ${target.relative}.`);
      const metadata = inspectMetadataAt(realXml);
      if (!metadata || metadata.format !== 'xml') {
        throw new Error(`Font registration requires valid BMFont XML: ${target.relative}.`);
      }
      const verification = inspectMetadataVerification(metadata, path.dirname(realXml));
      if (!verification.ok) {
        const error = new Error(
          `Font XML failed bitmap-font verification and was not registered: ${target.relative}.`
        );
        error.fontVerification = verification;
        throw error;
      }
      if (!metadata.face) throw new Error(`Font XML has no <info face> name: ${target.relative}.`);

      const keyOwner = existingByKey.get(key);
      if (parsed.keys.has(key)) {
        if (
          keyOwner &&
          pathKey(keyOwner.xmlRel) === pathKey(target.relative) &&
          existingFaces.get(metadata.face)?.key === key
        ) {
          alreadyRegistered.push({
            key,
            xmlRel: target.relative,
            face: metadata.face,
            verification,
          });
          continue;
        }
        throw new Error(`Asset key ${JSON.stringify(key)} already exists with a different registration.`);
      }
      const pathOwner = existingPaths.get(pathKey(target.relative));
      if (pathOwner) {
        throw new Error(
          `Font XML path ${JSON.stringify(target.relative)} is already registered as ${pathOwner.key}.`
        );
      }
      if (stagedKeys.has(key)) throw new Error(`Duplicate requested font asset key: ${key}.`);
      if (stagedPaths.has(pathKey(target.relative))) {
        throw new Error(`Duplicate requested font XML path: ${target.relative}.`);
      }
      const faceOwner = existingFaces.get(metadata.face);
      if (faceOwner && pathKey(faceOwner.xmlRel) !== pathKey(target.relative)) {
        throw new Error(
          `Bitmap font face ${JSON.stringify(metadata.face)} is already registered by ${faceOwner.key}; ` +
          'Pixi caches bitmap fonts by face name.'
        );
      }
      if (stagedFaces.has(metadata.face)) {
        throw new Error(`Duplicate requested bitmap font face: ${metadata.face}.`);
      }
      stagedKeys.add(key);
      stagedPaths.add(pathKey(target.relative));
      stagedFaces.set(metadata.face, key);
      prepared.push({
        key,
        xmlRel: target.relative,
        absolutePath: toPosix(target.absolute),
        face: metadata.face,
        verification,
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      added: [],
      skipped,
      alreadyRegistered,
      verification: error.fontVerification || null,
    };
  }

  let backup = null;
  if (prepared.length) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    let block =
      `\t// Registered by Exporter - Bitmap Font (${new Date().toISOString().slice(0, 10)})${eol}`;
    for (const entry of prepared) {
      block +=
        `\t${entry.key}: {${eol}` +
        `\t\ttype: 'font',${eol}` +
        `\t\tsrc: new URL('../../assets/${entry.xmlRel}', import.meta.url).href,${eol}` +
        `\t},${eol}`;
    }
    let insertAt = parsed.anchor + 1;
    if (source[insertAt] === '\r') insertAt++;
    if (source[insertAt] === '\n') insertAt++;
    backup = `${assetsTsPath}.ae-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(assetsTsPath, backup);
    source = source.slice(0, insertAt) + block + source.slice(insertAt);
    fs.writeFileSync(assetsTsPath, source, 'utf8');
  }

  const after = parseAssetsTs(readIfExists(assetsTsPath) || '');
  const verification = [...alreadyRegistered, ...prepared].map((entry) => ({
      key: entry.key,
      xmlRel: entry.xmlRel,
      face: entry.face,
      alreadyRegistered: alreadyRegistered.includes(entry),
      manifestEntryPresent: after.fontEntries.some(
        (candidate) => candidate.key === entry.key && candidate.xmlRel === entry.xmlRel
      ),
      metadataAndPagesValid: entry.verification.ok,
      details: entry.verification,
    }));
  return {
    ok: verification.every((item) => item.manifestEntryPresent && item.metadataAndPagesValid),
    added: prepared.map((entry) => entry.key),
    addedEntries: prepared,
    skipped,
    alreadyRegistered,
    file: toPosix(assetsTsPath),
    backup: backup ? toPosix(backup) : null,
    reloadRequired: prepared.length > 0,
    verification,
  };
}

module.exports = {
  cleanup,
  findApps,
  inspectApp,
  inspectFontFolder,
  inspectSourceRoot,
  isXml10Text,
  listFolder,
  openSource,
  parseAssetsTs,
  parseJsonMetadata,
  parseMetadata,
  parseXmlMetadata,
  registerFontAsset,
};
