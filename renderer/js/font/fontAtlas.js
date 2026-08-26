// Canvas-backed bitmap-font atlas packing. This intentionally reuses the
// editor's MaxRects packer, alpha trim detection and atlas compositor.

import { computeTrim, buildAtlas } from '../atlasio.js';
import { pack } from '../packer.js';
import {
  analyzeGlyphMappings,
  buildGlyphMetric,
  createBitmapFontMetadata,
} from './fontCore.js';

export const DEFAULT_FONT_ATLAS_SETTINGS = Object.freeze({
  padding: 2,
  border: 1,
  maxWidth: 4096,
  maxHeight: 4096,
  powerOfTwo: false,
  square: false,
  trim: true,
  extrude: 1,
  // Bitmap fonts are a one-page, unrotated runtime format in the target SDK.
  allowRotation: false,
});

function int(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback);
}

function normalizedSettings(input = {}) {
  return {
    padding: int(input.padding ?? input.glyphPadding, DEFAULT_FONT_ATLAS_SETTINGS.padding),
    border: int(input.border, DEFAULT_FONT_ATLAS_SETTINGS.border),
    maxWidth: int(input.maxWidth, DEFAULT_FONT_ATLAS_SETTINGS.maxWidth, 16),
    maxHeight: int(input.maxHeight, DEFAULT_FONT_ATLAS_SETTINGS.maxHeight, 16),
    powerOfTwo: !!input.powerOfTwo,
    square: !!input.square,
    trim: input.trim !== false,
    extrude: int(input.extrude, DEFAULT_FONT_ATLAS_SETTINGS.extrude),
    allowRotation: false,
  };
}

function canvasFactory(width = 1, height = 1) {
  if (typeof document === 'undefined') {
    throw new Error('Bitmap font atlas composition requires the Electron renderer DOM.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, int(width, 1, 1));
  canvas.height = Math.max(1, int(height, 1, 1));
  return canvas;
}

/** The only image synthesized by this workflow: a fully transparent 1x1 page region for space. */
export function createTransparentGlyphCanvas() {
  return canvasFactory(1, 1);
}

function failure(stage, error, extra = {}) {
  return {
    ok: false,
    stage,
    error: error instanceof Error ? error.message : String(error),
    width: 0,
    height: 0,
    placed: [],
    chars: [],
    metadata: null,
    atlasCanvas: null,
    failedIds: [],
    ...extra,
  };
}

function preparedSource(glyph) {
  if (glyph?.virtual) {
    return { source: createTransparentGlyphCanvas(), virtual: true };
  }
  const source = glyph?.source ?? glyph?.canvas;
  if (!source || typeof source.getContext !== 'function') {
    throw new Error(
      `${glyph?.sourceFilename ?? glyph?.filename ?? glyph?.id ?? 'Glyph'} has no decoded canvas image.`
    );
  }
  if (!source.width || !source.height) {
    throw new Error(
      `${glyph?.sourceFilename ?? glyph?.filename ?? glyph?.id ?? 'Glyph'} has invalid image dimensions.`
    );
  }
  return { source, virtual: false };
}

function alphaStats(canvas) {
  const { width, height } = canvas;
  const data = canvas
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 255) transparentPixels += 1;
    if (data[offset] > 0) visiblePixels += 1;
  }
  return {
    hasTransparency: transparentPixels > 0,
    hasVisiblePixels: visiblePixels > 0,
    transparentPixels,
    visiblePixels,
    pixelCount: width * height,
  };
}

function regionIsTransparent(canvas, region) {
  const data = canvas
    .getContext('2d', { willReadFrequently: true })
    .getImageData(region.x, region.y, region.w, region.h).data;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 0) return false;
  }
  return true;
}

/**
 * Pack and compose a complete one-page bitmap font.
 *
 * @param {object} options
 * @param {Array<object>} options.glyphs createGlyphRecord-compatible glyphs
 * @param {object} options.font {fontName,fontSize,lineHeight,baseline,
 *   letterSpacing,textureFile}
 * @param {object} options.settings atlas settings
 */
export function buildFontAtlas({
  glyphs = [],
  font = {},
  fontSettings,
  settings = {},
  expectedCharacters = '',
  strictMappings = true,
} = {}) {
  const mapping = analyzeGlyphMappings(glyphs, { expectedCharacters });
  if (!glyphs.length) {
    return failure('mapping', 'Import at least one glyph before packing.', { mapping });
  }
  if (strictMappings && !mapping.canExport) {
    return failure(
      'mapping',
      'Resolve unmapped, invalid and duplicate character assignments before packing.',
      {
        mapping,
        failedIds: [
          ...mapping.unmapped.map((glyph) => glyph?.id),
          ...mapping.invalid.map((entry) => entry.glyph?.id),
          ...mapping.duplicates.flatMap((entry) => entry.glyphs.map((glyph) => glyph?.id)),
        ],
      }
    );
  }

  const outputSettings = normalizedSettings(settings);
  const outputFont = { ...(fontSettings || {}), ...(font || {}) };
  const sourceGlyphs = strictMappings ? mapping.mapped : mapping.uniqueMapped;
  const prepared = [];
  const sourceFailures = [];
  for (const [index, glyph] of sourceGlyphs.entries()) {
    try {
      const { source, virtual } = preparedSource(glyph);
      const trim = outputSettings.trim
        ? computeTrim(source)
        : { x: 0, y: 0, w: source.width, h: source.height, trimmed: false };
      prepared.push({
        packId: index + 1,
        glyph,
        source,
        virtual,
        trim,
        sprite: {
          id: index + 1,
          name: glyph.sourceFilename ?? glyph.filename ?? `glyph_${index}`,
          source,
          sw: source.width,
          sh: source.height,
        },
      });
    } catch (error) {
      sourceFailures.push({
        id: glyph?.id,
        glyph,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (sourceFailures.length) {
    return failure('images', 'One or more glyph images could not be prepared.', {
      mapping,
      sourceFailures,
      failedIds: sourceFailures.map((entry) => entry.id),
    });
  }

  const extrude = outputSettings.extrude;
  const items = prepared.map((entry) => ({
    id: entry.packId,
    w: entry.trim.w + extrude * 2,
    h: entry.trim.h + extrude * 2,
  }));
  const packed = pack(items, outputSettings);
  if (!packed.ok || packed.failedIds.length) {
    const failedIds = packed.failedIds.map(
      (packId) => prepared.find((entry) => entry.packId === packId)?.glyph?.id ?? packId
    );
    return failure(
      'packing',
      `Unable to fit ${failedIds.length} glyph${failedIds.length === 1 ? '' : 's'} within ${outputSettings.maxWidth}x${outputSettings.maxHeight}.`,
      {
        mapping,
        width: packed.width,
        height: packed.height,
        failedIds,
        settings: outputSettings,
      }
    );
  }

  const byPackId = new Map(prepared.map((entry) => [entry.packId, entry]));
  const placed = packed.placed.map((placement) => {
    const entry = byPackId.get(placement.id);
    return {
      glyph: entry.glyph,
      sprite: entry.sprite,
      source: entry.source,
      trim: entry.trim,
      x: placement.x + extrude,
      y: placement.y + extrude,
      rotated: false,
      regionW: entry.trim.w,
      regionH: entry.trim.h,
      virtual: entry.virtual,
    };
  });

  let atlasCanvas;
  try {
    atlasCanvas = buildAtlas(placed, packed.width, packed.height, outputSettings);
  } catch (error) {
    return failure('composition', error, {
      mapping,
      width: packed.width,
      height: packed.height,
      failedIds: sourceGlyphs.map((glyph) => glyph?.id),
      settings: outputSettings,
    });
  }

  const artworkBaseline =
    outputFont.artworkBaseline ??
    outputFont.baseline ??
    outputFont.lineHeight ??
    outputFont.fontSize ??
    outputFont.size ??
    Math.max(...prepared.map((entry) => entry.source.height), 1);
  const letterSpacing = Number(outputFont.letterSpacing) || 0;
  const chars = placed.map((placement) =>
    buildGlyphMetric({
      glyph: {
        ...placement.glyph,
        source: placement.source,
        sourceWidth: placement.source.width,
        sourceHeight: placement.source.height,
      },
      trim: placement.trim,
      placement,
      artworkBaseline,
      letterSpacing,
    })
  );

  let metadata;
  try {
    metadata = createBitmapFontMetadata({
      fontName: outputFont.fontName ?? outputFont.name ?? 'Bitmap Font',
      fontSize: outputFont.fontSize ?? outputFont.size ?? artworkBaseline,
      lineHeight: outputFont.lineHeight ?? outputFont.fontSize ?? outputFont.size ?? artworkBaseline,
      baseline: artworkBaseline,
      artworkBaseline,
      atlasWidth: packed.width,
      atlasHeight: packed.height,
      textureFile: outputFont.textureFile ?? outputFont.pageFile,
      chars,
      kernings: outputFont.kernings ?? [],
    });
  } catch (error) {
    return failure('metadata', error, {
      mapping,
      width: packed.width,
      height: packed.height,
      placed,
      chars,
      atlasCanvas,
      failedIds: sourceGlyphs.map((glyph) => glyph?.id),
      settings: outputSettings,
    });
  }

  const virtualFailures = placed
    .filter(
      (entry) =>
        entry.virtual &&
        !regionIsTransparent(atlasCanvas, {
          x: entry.x,
          y: entry.y,
          w: entry.trim.w,
          h: entry.trim.h,
        })
    )
    .map((entry) => entry.glyph?.id);
  if (virtualFailures.length) {
    return failure('verification', 'A virtual space atlas region unexpectedly contains visible pixels.', {
      mapping,
      width: packed.width,
      height: packed.height,
      placed,
      chars,
      metadata,
      atlasCanvas,
      failedIds: virtualFailures,
      settings: outputSettings,
    });
  }

  let usedPixels = 0;
  for (const placement of placed) usedPixels += placement.trim.w * placement.trim.h;
  const totalPixels = packed.width * packed.height;
  return {
    ok: true,
    stage: 'complete',
    error: null,
    width: packed.width,
    height: packed.height,
    placed,
    chars,
    metadata,
    atlasCanvas,
    failedIds: [],
    mapping,
    settings: outputSettings,
    font: {
      ...outputFont,
      artworkBaseline: Number.parseInt(String(artworkBaseline), 10),
      baseline: Number.parseInt(String(artworkBaseline), 10),
      letterSpacing,
    },
    usedPct: totalPixels > 0 ? (usedPixels / totalPixels) * 100 : 0,
    alpha: alphaStats(atlasCanvas),
  };
}

export const packBitmapFont = buildFontAtlas;
export const buildBitmapFontAtlas = buildFontAtlas;

/** Read RGBA/alpha statistics for export verification. */
export function analyzeFontAtlasPixels(canvas) {
  return alphaStats(canvas);
}
