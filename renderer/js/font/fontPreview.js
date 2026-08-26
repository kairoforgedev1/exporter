// Canvas preview using the same metric/layout function as export verification.

import { integerMetric, layoutBitmapText } from './fontCore.js';

function previewCanvas() {
  if (typeof document === 'undefined') {
    throw new Error('Bitmap font preview requires the Electron renderer DOM.');
  }
  return document.createElement('canvas');
}

function pageImage(pageImages, page) {
  if (!pageImages) return null;
  if (pageImages instanceof Map) {
    return (
      pageImages.get(page?.file) ??
      pageImages.get(page?.id) ??
      pageImages.get(String(page?.id)) ??
      null
    );
  }
  if (Array.isArray(pageImages)) return pageImages[page?.id ?? 0] ?? null;
  return (
    pageImages[page?.file] ??
    pageImages[page?.id] ??
    pageImages[String(page?.id)] ??
    null
  );
}

function fillBackground(context, width, height, background) {
  if (!background || background === 'transparent') {
    context.clearRect(0, 0, width, height);
    return;
  }
  context.save();
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.restore();
}

/**
 * Render generated/imported bitmap-font text to a canvas.
 *
 * The returned layout contains occurrence-level and unique missing-character
 * data for the workflow's warning panel.
 */
export function renderBitmapFontPreview({
  canvas = null,
  atlasCanvas,
  atlasImage,
  image,
  pageImages,
  metadata,
  font,
  text = '',
  scale = 1,
  padding = 16,
  background = 'transparent',
  autoSize = true,
  width,
  height,
  showGuides = true,
  showBounds = false,
  baseline,
  guideColor = 'rgba(89, 160, 255, 0.75)',
  baselineColor = 'rgba(255, 116, 88, 0.9)',
  boundsColor = 'rgba(114, 225, 151, 0.8)',
} = {}) {
  const output = canvas ?? previewCanvas();
  const source = atlasCanvas ?? atlasImage ?? image ?? pageImage(pageImages, metadata?.pages?.[0]);
  if (!source) throw new Error('A packed font texture is required for preview.');
  if (!metadata?.chars) throw new Error('Bitmap-font metadata is required for preview.');

  const outputScale = Math.max(0.05, Number(scale) || 1);
  const outputPadding = Math.max(0, Number(padding) || 0);
  const layout = layoutBitmapText(metadata, text);
  const minX = Math.min(0, layout.inkBounds.x);
  const minY = Math.min(0, layout.inkBounds.y);
  const maxX = Math.max(layout.width, layout.inkBounds.x + layout.inkBounds.width);
  const maxY = Math.max(layout.height, layout.inkBounds.y + layout.inkBounds.height);
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  if (autoSize) {
    output.width = Math.max(1, Math.ceil((contentWidth + outputPadding * 2) * outputScale));
    output.height = Math.max(1, Math.ceil((contentHeight + outputPadding * 2) * outputScale));
  } else {
    if (width != null) output.width = Math.max(1, integerMetric(width, output.width || 1));
    if (height != null) output.height = Math.max(1, integerMetric(height, output.height || 1));
  }

  const context = output.getContext('2d');
  context.imageSmoothingEnabled = false;
  fillBackground(context, output.width, output.height, background);
  context.save();
  context.setTransform(
    outputScale,
    0,
    0,
    outputScale,
    (outputPadding - minX) * outputScale,
    (outputPadding - minY) * outputScale
  );

  if (showGuides) {
    const artworkBaseline = integerMetric(
      baseline ?? font?.artworkBaseline ?? font?.baseline ?? metadata.artworkBaseline,
      integerMetric(metadata.common?.lineHeight, metadata.info?.size ?? 1)
    );
    context.save();
    context.lineWidth = 1 / outputScale;
    for (const line of layout.lines) {
      context.strokeStyle = guideColor;
      context.beginPath();
      context.moveTo(minX, line.y + 0.5 / outputScale);
      context.lineTo(maxX, line.y + 0.5 / outputScale);
      context.stroke();
      context.strokeStyle = baselineColor;
      context.beginPath();
      context.moveTo(minX, line.y + artworkBaseline + 0.5 / outputScale);
      context.lineTo(maxX, line.y + artworkBaseline + 0.5 / outputScale);
      context.stroke();
    }
    context.restore();
  }

  for (const run of layout.glyphs) {
    const page = metadata.pages?.find(
      (entry) => integerMetric(entry.id, 0) === integerMetric(run.page, 0)
    );
    const pageSource =
      integerMetric(run.page, 0) === 0 && (atlasCanvas || atlasImage || image)
        ? source
        : pageImage(pageImages, page);
    if (!pageSource || run.width <= 0 || run.height <= 0) continue;
    context.drawImage(
      pageSource,
      run.atlasX,
      run.atlasY,
      run.width,
      run.height,
      run.x,
      run.y,
      run.width,
      run.height
    );
    if (showBounds) {
      context.save();
      context.strokeStyle = boundsColor;
      context.lineWidth = 1 / outputScale;
      context.strokeRect(run.x, run.y, run.width, run.height);
      context.restore();
    }
  }
  context.restore();

  return {
    canvas: output,
    layout,
    missing: layout.missing,
    missingCharacters: layout.missingCharacters,
    scale: outputScale,
    contentBounds: {
      x: minX,
      y: minY,
      width: contentWidth,
      height: contentHeight,
    },
  };
}

export const drawBitmapFontPreview = renderBitmapFontPreview;
export const renderFontPreview = renderBitmapFontPreview;
export { layoutBitmapText };

