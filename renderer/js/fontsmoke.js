// Bitmap Font Exporter end-to-end smoke scenario.
//
// Exercises both loose-glyph filename mapping and an existing BMFont package,
// then writes and reopens the complete Stake/Pixi-compatible export through
// the real main-process encoder/verifier.

import { openBitmapFontExporter } from './app.js';
import { canvasToPngBytes, joinPath } from './util.js';

const native = window.native;
const decoder = new TextDecoder();

function makeGlyphCanvas(width, height, inset = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#ffd43b';
  context.fillRect(inset, inset, Math.max(1, width - inset * 2), Math.max(1, height - inset * 2));
  context.fillStyle = '#7c3aed';
  context.fillRect(
    Math.max(inset, Math.floor(width * 0.4)),
    Math.max(inset, Math.floor(height * 0.25)),
    Math.max(1, Math.floor(width * 0.2)),
    Math.max(1, Math.floor(height * 0.5))
  );
  return canvas;
}

async function writeLooseGlyphs(root) {
  const fixtures = [
    ['A.png', 24, 38],
    ['U+0041.png', 27, 38], // deliberate duplicate mapping for review
    ['W.png', 46, 38], // deliberately wider than A
    ['comma.png', 12, 18],
    ['U+20AC.png', 31, 37],
    ['lowercase_a.png', 25, 29],
    ['mystery.png', 19, 34], // deliberately unmapped, then manually fixed
    ['10.png', 14, 18], // U+000A is not an XML-renderable BMFont glyph
  ];
  for (const [name, width, height] of fixtures) {
    const bytes = await canvasToPngBytes(makeGlyphCanvas(width, height));
    await native.writeFile(joinPath(root, name), bytes);
  }
  return fixtures;
}

function setCharacter(glyph, character) {
  glyph.char = character;
  glyph.codePoint = character.codePointAt(0);
  glyph.mappingInput = character;
  glyph.mappingError = null;
  glyph.detection = { confidence: 'manual', reason: 'manually assigned' };
}

function fileByName(files, name) {
  return (files || []).find((file) => file.name === name);
}

async function fileExists(path) {
  try {
    return !!(await native.fileExists(path));
  } catch {
    return false;
  }
}

async function captureStep(ui, cfg, step, delay = 300) {
  ui.goto(step);
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, delay)))
  );
  await native.capturePage(joinPath(cfg.outDir, `screenshot-font-${step}.png`));
}

export async function runFontSmokeTest(cfg, check) {
  const ui = await openBitmapFontExporter();
  const looseDir = joinPath(cfg.outDir, 'font-loose-glyphs');

  // ---- 1. Loose images: detection, review issues and manual correction ----
  await writeLooseGlyphs(looseDir);
  const looseScan = await ui.loadSourcePath(looseDir);
  check('font loose: glyph folder scanned', looseScan?.mode === 'glyphs', looseScan?.mode || 'no scan');
  check('font loose: all PNG artwork imported', ui.glyphs.filter((g) => !g.virtual).length === 8);

  const findSource = (name) => ui.glyphs.find((glyph) => glyph.sourceName === name);
  check('font mapping: literal character detected', findSource('A.png')?.char === 'A');
  check('font mapping: U+ identifier detected', findSource('U+20AC.png')?.char === '\u20ac');
  check('font mapping: named punctuation detected', findSource('comma.png')?.char === ',');
  check('font mapping: character-name alias detected', findSource('lowercase_a.png')?.char === 'a');
  check('font mapping: unknown filename is reviewable', findSource('mystery.png')?.char == null);
  check(
    'font mapping: XML-forbidden control ID is invalid',
    findSource('10.png')?.char == null && !!findSource('10.png')?.mappingError
  );

  let audit = ui.audit();
  check(
    'font mapping: duplicate assignment detected',
    audit.duplicates.some((entry) => entry.character === 'A' && entry.glyphs.length === 2)
  );
  check('font mapping: unmapped artwork detected', audit.unmapped.some((glyph) => glyph.sourceName === 'mystery.png'));
  check('font mapping: invalid artwork detected', audit.invalid.some((entry) => entry.glyph.sourceName === '10.png'));

  const space = ui.glyphs.find((glyph) => glyph.char === ' ');
  const spaceAlpha = space?.source
    ?.getContext('2d', { willReadFrequently: true })
    ?.getImageData(0, 0, 1, 1).data[3];
  check(
    'font metrics: virtual transparent space exists',
    !!space?.virtual && space.source.width === 1 && space.source.height === 1 && spaceAlpha === 0,
    `virtual=${space?.virtual} alpha=${spaceAlpha}`
  );
  check(
    'font metrics: differing glyph widths preserved',
    findSource('W.png')?.source.width > findSource('A.png')?.source.width,
    `A=${findSource('A.png')?.source.width} W=${findSource('W.png')?.source.width}`
  );

  setCharacter(findSource('mystery.png'), '?'); // manual mapping
  setCharacter(findSource('U+0041.png'), 'B'); // resolve the deliberate duplicate
  setCharacter(findSource('10.png'), 'C'); // repair the XML-forbidden mapping
  ui.expectedPreset = 'custom';
  ui.expectedCharacters = 'ABCWa,\u20ac?\u2603';
  ui.samplePreset = 'custom';
  ui.sampleText = 'ABW a, \u20ac?';
  ui.markDirty();
  audit = ui.audit();
  check('font mapping: manual correction applied', findSource('mystery.png')?.char === '?');
  check('font mapping: duplicate correction applied', audit.duplicates.length === 0);
  check('font mapping: invalid correction applied', audit.invalid.length === 0);
  check('font mapping: missing expected character reported', audit.missing.includes('\u2603'));
  const looseBuild = await ui.buildNow();
  check('font loose: corrected glyphs pack successfully', looseBuild?.ok === true, looseBuild?.error || '');
  check(
    'font atlas: bitmap glyph rotation is disabled',
    (looseBuild?.chars || []).every((char) => !char.rotated)
  );
  await captureStep(ui, cfg, 'glyphs');

  // ---- 2. Open the supplied reference and preserve its useful metrics -----
  const referenceScan = await ui.loadSourcePath(cfg.fontSource, {
    expectPackage: true,
    replaceCurrent: true,
  });
  check('font reference: existing package opened', referenceScan?.mode === 'package', referenceScan?.mode || 'no scan');
  const referenceVisible = ui.glyphs.filter((glyph) => !glyph.virtual);
  const referenceSpace = ui.glyphs.find((glyph) => glyph.char === ' ');
  check('font reference: glyph artwork extracted', referenceVisible.length >= 50, `got ${referenceVisible.length}`);
  check('font reference: questionable question-mark ID repaired', ui.glyphs.some((glyph) => glyph.char === '?'));
  check(
    'font reference: visible source space normalized',
    !!referenceSpace?.virtual && referenceSpace.source.width === 1 && referenceSpace.source.height === 1
  );
  check(
    'font reference: variable advances retained',
    new Set(referenceVisible.map((glyph) => glyph.source.width + glyph.advanceAdjust)).size > 4
  );

  ui.settings.face = 'SmokeBitmapFont';
  ui.naming.fileBase = 'smoke_bitmap_font';
  ui.naming.folderName = 'smokeBitmapFont';
  ui.naming.assetKey = 'smokeBitmapFont';
  ui.formats = {
    ...ui.formats,
    png: true,
    webp: true,
    xml: true,
    json: true,
    index: true,
    runtimeTexture: 'webp',
    registerAfter: false,
  };
  ui.expectedPreset = 'custom';
  ui.expectedCharacters = `${referenceVisible.slice(0, 5).map((glyph) => glyph.char).join('')}\u2603`;
  ui.samplePreset = 'custom';
  ui.sampleText = `${referenceVisible.slice(0, 12).map((glyph) => glyph.char).join('')} 0123`;
  ui.markDirty();
  const build = await ui.buildNow();
  check('font reference: atlas rebuilt', build?.ok === true, build?.error || '');
  check('font reference: one texture page generated', build?.metadata?.pages?.length === 1);
  check('font reference: packed coordinates verify', ui.verification?.ok === true, (ui.verification?.blocking || []).join('; '));
  const previewCanvas = document.getElementById('fontTextCanvas');
  const previewPixels = previewCanvas
    ?.getContext('2d', { willReadFrequently: true })
    ?.getImageData(0, 0, previewCanvas.width, previewCanvas.height).data;
  check(
    'font preview: sample text renders',
    previewCanvas?.width > 1 &&
      previewCanvas?.height > 1 &&
      !!previewPixels &&
      Array.from(previewPixels).some((value, index) => index % 4 === 3 && value > 0),
    `${previewCanvas?.width || 0}x${previewCanvas?.height || 0}`
  );
  await captureStep(ui, cfg, 'layout');
  await captureStep(ui, cfg, 'preview', 650);

  // ---- 3. Export all package formats through Sharp/native verification ----
  ui.goto('export');
  const exported = await ui.exportNow({ outputParent: cfg.outDir, overwrite: true });
  check('font export: package written', !!exported?.ok, exported?.error || '');
  if (!exported) return { ui };

  const names = exported.names;
  const expectedFiles = [names.pngFile, names.webpFile, names.xmlFile, names.jsonFile, names.indexFile];
  for (const name of expectedFiles) {
    check(`font export: ${name} generated`, await fileExists(joinPath(exported.outDir, name)));
  }
  const written = exported.written || [];
  check('font export: generated files are non-empty', expectedFiles.every((name) => Number(fileByName(written, name)?.bytes) > 0));

  const png = new Uint8Array(await native.readFile(joinPath(exported.outDir, names.pngFile)));
  const webp = new Uint8Array(await native.readFile(joinPath(exported.outDir, names.webpFile)));
  check(
    'font export: PNG signature valid',
    png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  );
  check(
    'font export: WebP is lossless VP8L',
    decoder.decode(webp.subarray(0, 4)) === 'RIFF' &&
      decoder.decode(webp.subarray(8, 12)) === 'WEBP' &&
      decoder.decode(webp.subarray(12, 16)) === 'VP8L'
  );
  const textureChecks = exported.verification?.textures || [];
  check(
    'font export: alpha and pixels survive both encoders',
    textureChecks.length === 2 &&
      textureChecks.every((item) => item.ok && item.lossless && item.alphaPreserved && item.renderedPixelEquivalent),
    textureChecks.map((item) => `${item.name}:${item.ok}`).join(', ')
  );

  const xml = decoder.decode(await native.readFile(joinPath(exported.outDir, names.xmlFile)));
  const json = JSON.parse(decoder.decode(await native.readFile(joinPath(exported.outDir, names.jsonFile))));
  const indexTs = decoder.decode(await native.readFile(joinPath(exported.outDir, names.indexFile)));
  check('font export: XML uses Pixi BMFont root', xml.trimStart().startsWith('<?xml') && xml.includes('<font>'));
  check('font export: XML page references runtime WebP', xml.includes(`file="${names.webpFile}"`));
  check('font export: JSON page agrees with XML', JSON.stringify(json).includes(names.webpFile));
  check(
    'font export: legacy index registration is complete',
    indexTs.includes(`from './${names.webpFile}'`) &&
      indexTs.includes(`from './${names.jsonFile}?raw'`) &&
      indexTs.includes('createAsset({ img, font })')
  );
  // Capture the populated post-export summary before the reopen exercise
  // intentionally replaces the editor session.
  await captureStep(ui, cfg, 'export', 350);

  // ---- 4. Reopen the generated package non-destructively ------------------
  const exportedGlyphCount = build.chars.length;
  const exportedAtlasSize = `${build.width}x${build.height}`;
  const referenceWasTemporary = !!referenceScan?.tempWorkspace;
  await ui.cleanupSource(referenceScan);
  check(
    'font source: archive workspace cleaned before session reset',
    !referenceWasTemporary || !referenceScan.tempWorkspace
  );
  ui.reset();
  ui.open();
  const reopen = await ui.loadSourcePath(exported.outDir, { expectPackage: true });
  const reopenedBuild = await ui.buildNow();
  check('font reopen: exported package recognized', reopen?.mode === 'package');
  check(
    'font reopen: glyph count retained',
    ui.glyphs.filter((glyph) => glyph.char).length === exportedGlyphCount,
    `expected ${exportedGlyphCount}, got ${ui.glyphs.filter((glyph) => glyph.char).length}`
  );
  check('font reopen: package repacks and verifies', reopenedBuild?.ok === true && ui.verification?.ok === true);
  check(
    'font reopen: source atlas dimensions were recorded',
    reopen?.selectedMetadata?.scaleW === build.width && reopen?.selectedMetadata?.scaleH === build.height,
    `expected ${exportedAtlasSize}`
  );

  return { ui, exported, screenshotsCaptured: true };
}
