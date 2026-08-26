// Non-destructive import of an existing BMFont package into editable glyph
// canvases. The original texture/metadata objects are only read.

import { computeTrim } from '../atlasio.js';
import {
  createGlyphRecord,
  createVirtualSpaceGlyph,
  integerMetric,
  parseBitmapFont,
  parseBMFontJSON,
  parseBMFontXML,
  unicodeLabel,
} from './fontCore.js';

function rendererCanvas(width, height) {
  if (typeof document === 'undefined') {
    throw new Error('Bitmap font image extraction requires the Electron renderer DOM.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, integerMetric(width, 1));
  canvas.height = Math.max(1, integerMetric(height, 1));
  return canvas;
}

function pageFromCollection(pageCanvases, page, index) {
  if (!pageCanvases) return null;
  if (pageCanvases instanceof Map) {
    return (
      pageCanvases.get(page.file) ??
      pageCanvases.get(page.id) ??
      pageCanvases.get(String(page.id)) ??
      pageCanvases.get(index) ??
      null
    );
  }
  if (Array.isArray(pageCanvases)) return pageCanvases[page.id] ?? pageCanvases[index] ?? null;
  return (
    pageCanvases[page.file] ??
    pageCanvases[page.id] ??
    pageCanvases[String(page.id)] ??
    pageCanvases[index] ??
    null
  );
}

function isTransparent(canvas) {
  const data = canvas
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 0) return false;
  }
  return true;
}

function extractedGlyphFilename(character) {
  return /^[A-Za-z0-9]$/.test(character)
    ? `${character}.png`
    : `${unicodeLabel(character).replace('U+', 'U+')}.png`;
}

/**
 * Convert an imported runtime metric to editor adjustments while preserving
 * the exact position Pixi drew before repacking.
 */
export function initializeImportedGlyphAdjustments({
  metric,
  trim = { x: 0, y: 0 },
  sourceWidth,
  sourceHeight,
  baseline,
  artworkBaseline = baseline,
  lineHeight,
  commonBase,
  baseLineOffset,
  letterSpacing = 0,
} = {}) {
  const width = Math.max(1, integerMetric(sourceWidth, metric?.width ?? 1));
  const height = Math.max(1, integerMetric(sourceHeight, metric?.height ?? 1));
  const guide = integerMetric(
    artworkBaseline,
    integerMetric(lineHeight, Math.max(height, integerMetric(metric?.height, height)))
  );
  const runtimeBaseOffset =
    baseLineOffset == null
      ? integerMetric(lineHeight, guide) - integerMetric(commonBase, integerMetric(lineHeight, guide))
      : integerMetric(baseLineOffset, 0);
  const runtimeY = runtimeBaseOffset + integerMetric(metric?.yoffset ?? metric?.yOffset, 0);
  return {
    xAdjust: integerMetric(metric?.xoffset ?? metric?.xOffset, 0) - integerMetric(trim?.x, 0),
    yAdjust: runtimeY - (guide - height + integerMetric(trim?.y, 0)),
    advanceAdjust:
      integerMetric(metric?.xadvance ?? metric?.xAdvance, width) -
      width -
      integerMetric(letterSpacing, 0),
    yAdvance: integerMetric(metric?.yadvance ?? metric?.yAdvance, 0),
    importedBaseLineOffset: runtimeBaseOffset,
  };
}

export const adjustmentsFromImportedMetric = initializeImportedGlyphAdjustments;

/**
 * Extract every valid normalized char region from its page image.
 *
 * Invalid metadata entries are returned in invalidEntries instead of being
 * discarded. Missing pages and out-of-bounds regions are returned in failures
 * and therefore cannot silently turn into an incomplete export.
 */
export function extractFontGlyphs({
  metadata,
  pageCanvases,
  pages = pageCanvases,
  baseline,
  artworkBaseline = baseline,
  letterSpacing = 0,
} = {}) {
  if (!metadata?.chars || !metadata?.pages) {
    throw new Error('Normalized BMFont metadata is required for glyph extraction.');
  }
  const pageImages = pages;
  const warnings = [...(metadata.warnings || [])];
  const invalidEntries = metadata.chars.filter((char) => char.valid === false);
  const failures = [];
  const glyphs = [];
  const lineHeight = integerMetric(metadata.common?.lineHeight, metadata.info?.size ?? 1);
  const commonBase = integerMetric(metadata.common?.base, lineHeight);
  const guide = integerMetric(artworkBaseline, lineHeight);
  const pagesById = new Map(metadata.pages.map((page, index) => [page.id, { page, index }]));

  for (const char of metadata.chars) {
    if (char.valid === false) continue;
    const pageRecord = pagesById.get(integerMetric(char.page, 0));
    const pageImage = pageRecord
      ? pageFromCollection(pageImages, pageRecord.page, pageRecord.index)
      : null;
    if (!pageImage) {
      failures.push({
        character: char.character,
        codePoint: char.id,
        metric: char,
        reason: `Texture page ${char.page} (${pageRecord?.page?.file || 'unknown'}) is unavailable.`,
      });
      continue;
    }
    const x = integerMetric(char.x, 0);
    const y = integerMetric(char.y, 0);
    const width = integerMetric(char.width, 0);
    const height = integerMetric(char.height, 0);
    if (
      width <= 0 ||
      height <= 0 ||
      x < 0 ||
      y < 0 ||
      x + width > pageImage.width ||
      y + height > pageImage.height
    ) {
      failures.push({
        character: char.character,
        codePoint: char.id,
        metric: char,
        reason: `${unicodeLabel(char.character)} lies outside texture page ${char.page}.`,
      });
      continue;
    }

    const extracted = rendererCanvas(width, height);
    const context = extracted.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(pageImage, x, y, width, height, 0, 0, width, height);
    const extractedIsTransparent = isTransparent(extracted);
    // Pixi draws a space texture when one is present. Some legacy packages
    // point SPACE at a visible extrusion row, so every imported U+0020 is
    // normalized to the exporter's transparent 1x1 invariant.
    const virtual = char.character === ' ';
    if (virtual && !extractedIsTransparent) {
      warnings.push({
        severity: 'warning',
        code: 'repaired-visible-space',
        message:
          'U+0020 SPACE referenced visible texture pixels; it was normalized to a transparent 1x1 region while preserving its advance.',
        character: ' ',
        sourceIndex: char.sourceIndex,
      });
    }
    const source = virtual ? null : extracted;
    const sourceWidth = virtual ? 1 : extracted.width;
    const sourceHeight = virtual ? 1 : extracted.height;
    const trim = virtual ? { x: 0, y: 0, w: 1, h: 1, trimmed: false } : computeTrim(extracted);
    const adjustments = initializeImportedGlyphAdjustments({
      metric: char,
      trim,
      sourceWidth,
      sourceHeight,
      artworkBaseline: guide,
      lineHeight,
      commonBase,
      letterSpacing,
    });
    const common = {
      id: `imported-${char.sourceIndex ?? glyphs.length}-${char.id}`,
      sourceFilename: extractedGlyphFilename(char.character),
      character: char.character,
      source,
      sourceWidth,
      sourceHeight,
      virtual,
      ...adjustments,
      originalMetric: {
        id: char.id,
        character: char.character,
        x: char.x,
        y: char.y,
        width: char.width,
        height: char.height,
        xoffset: char.xoffset,
        yoffset: char.yoffset,
        xadvance: char.xadvance,
        yadvance: char.yadvance,
        page: char.page,
        chnl: char.chnl,
      },
      extra: {
        imported: true,
        importedPage: char.page,
        importedTrim: trim,
        sourceMetricIndex: char.sourceIndex,
      },
    };
    const glyph = virtual
      ? createVirtualSpaceGlyph({
          ...common,
          // createVirtualSpaceGlyph's default advance is replaced by the
          // preservation adjustment calculated just above.
          spaceWidth: 1,
          letterSpacing,
          advanceAdjust: adjustments.advanceAdjust,
        })
      : createGlyphRecord(common);
    glyphs.push(glyph);
  }

  return {
    ok: failures.length === 0 && invalidEntries.length === 0,
    glyphs,
    invalidEntries,
    failures,
    warnings,
    metadata,
    font: {
      fontName: metadata.info.face,
      name: metadata.info.face,
      fontSize: metadata.info.size,
      size: metadata.info.size,
      lineHeight,
      baseline: guide,
      artworkBaseline: guide,
      letterSpacing: integerMetric(letterSpacing, 0),
      originalBase: commonBase,
      originalBaseLineOffset: lineHeight - commonBase,
      textureFile: metadata.pages[0]?.file ?? '',
    },
  };
}

export const extractBitmapFontGlyphs = extractFontGlyphs;

/**
 * Open a package using XML as source of truth when supplied. JSON is parsed as
 * a companion so its warnings/inconsistencies remain visible to the UI.
 */
export function importBitmapFontPackage({
  xml,
  xmlText = xml,
  json,
  jsonText = json,
  metadata,
  fontText,
  format = 'auto',
  pageCanvases,
  pages = pageCanvases,
  baseline,
  artworkBaseline = baseline,
  letterSpacing = 0,
} = {}) {
  let authoritative = metadata ?? null;
  let companion = null;
  if (!authoritative) {
    if (xmlText != null) authoritative = parseBMFontXML(xmlText);
    else if (fontText != null) authoritative = parseBitmapFont(fontText, format);
    else if (jsonText != null) authoritative = parseBMFontJSON(jsonText);
  }
  if (!authoritative) throw new Error('Choose an XML or JSON bitmap-font metadata file.');
  if (jsonText != null && authoritative.format !== 'json') companion = parseBMFontJSON(jsonText);

  const extracted = extractFontGlyphs({
    metadata: authoritative,
    pages,
    artworkBaseline,
    letterSpacing,
  });
  const companionWarnings = companion?.warnings || [];
  return {
    ...extracted,
    companion,
    warnings: [...extracted.warnings, ...companionWarnings],
    sourceFormat: authoritative.format,
  };
}

export const openBitmapFontPackage = importBitmapFontPackage;
export const importExistingBitmapFont = importBitmapFontPackage;
