// Automated end-to-end test, run when the app is launched with --smoke-test.
// Exercises the full workflow (import → edit → repack → export → re-import)
// and writes a machine-readable result file plus a window screenshot.

import {
  state, flushPack, setSelection, renameSprite, replaceSpriteImage,
  addSprites, removeSprites, updateSettings, undo, redo, applyImages,
} from './state.js';
import { loadAtlasFromPaths, exportToPaths, preview } from './app.js';
import { parseAtlasJSON, extractSprites } from './atlasio.js';
import { bytesToCanvas, canvasToPngBytes, joinPath, scaleCanvas } from './util.js';

const native = window.native;

function makeTestCanvas(w, h, transparentRight = 0) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const ow = w - transparentRight;
  ctx.fillStyle = '#e03131';
  ctx.fillRect(0, 0, ow / 2, h / 2);
  ctx.fillStyle = '#2f9e44';
  ctx.fillRect(ow / 2, 0, ow / 2, h / 2);
  ctx.fillStyle = '#1971c2';
  ctx.fillRect(0, h / 2, ow / 2, h / 2);
  ctx.fillStyle = '#f08c00';
  ctx.fillRect(ow / 2, h / 2, ow / 2, h / 2);
  return c;
}

function samplePoints(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  return [
    [Math.floor(w * 0.2), Math.floor(h * 0.2)],
    [Math.floor(w * 0.7), Math.floor(h * 0.2)],
    [Math.floor(w * 0.2), Math.floor(h * 0.7)],
    [Math.floor(w * 0.7), Math.floor(h * 0.7)],
    [Math.floor(w * 0.45), Math.floor(h * 0.55)],
  ];
}

function pixelsMatch(a, b, tolerance = 3) {
  const ctxA = a.getContext('2d');
  const ctxB = b.getContext('2d');
  if (a.width !== b.width || a.height !== b.height) {
    return `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`;
  }
  for (const [x, y] of samplePoints(a)) {
    const pa = ctxA.getImageData(x, y, 1, 1).data;
    const pb = ctxB.getImageData(x, y, 1, 1).data;
    if (Math.abs(pa[3] - pb[3]) > tolerance) return `alpha diff at ${x},${y}: ${pa[3]} vs ${pb[3]}`;
    if (pa[3] > 16) {
      for (let i = 0; i < 3; i++) {
        if (Math.abs(pa[i] - pb[i]) > tolerance) {
          return `rgb diff at ${x},${y} ch${i}: ${pa[i]} vs ${pb[i]}`;
        }
      }
    }
  }
  return null;
}

function overlapCheck(pack, extrude) {
  const rects = pack.placed.map((p) => ({
    n: p.sprite.name,
    x: p.x - extrude,
    y: p.y - extrude,
    w: p.regionW + extrude * 2,
    h: p.regionH + extrude * 2,
  }));
  for (const r of rects) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > pack.width || r.y + r.h > pack.height) {
      return `"${r.n}" out of bounds`;
    }
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        return `"${a.n}" overlaps "${b.n}"`;
      }
    }
  }
  return null;
}

const byName = (name) => state.sprites.find((s) => s.name === name);

export async function runSmokeTest(cfg) {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, pass: !!ok, extra: String(extra) });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  };

  // Current-package smoke: re-open a Stake-format Spine package, run the
  // converter without touching its source, and exercise the draw-call UI.
  // This is deliberately separate from the legacy five-symbol fixture smoke.
  if (cfg.drawCallsSource) {
    try {
      const { openAnimationReExport } = await import('./app.js');
      const ui = await openAnimationReExport();
      await ui.loadSource(cfg.drawCallsSource);
      check(
        'draw calls: current package detected',
        ui.packages.length === 1 && ui.packages[0].complete,
        `${ui.packages.length} package(s)`
      );

      ui.target = {
        ok: true,
        appName: 'smoke',
        appDir: cfg.drawCallsSource,
        runtime: { package: '@esotericsoftware/spine-pixi-v8', version: '4.2.74' },
        dominantScale: 1,
        animationUsage: {},
        spineFolders: [],
      };
      ui.targetKind = 'project';
      ui.buildMappings();
      const currentSkeleton = ui.packages[0]?.skeletons[0];
      const currentMapping = currentSkeleton ? ui.mappings.get(currentSkeleton.id) : null;
      const savedTargetNames = JSON.stringify(currentMapping?.animations || {});
      ui.renderMapping();
      const nameMode = document.getElementById('animNameMode');
      nameMode.value = 'source';
      nameMode.dispatchEvent(new Event('change', { bubbles: true }));
      ui.goto('mapping');
      check(
        'animation names: imported-name mode is selected',
        document.getElementById('animNameMode')?.value === 'source'
      );
      const visibleAnimationInputs = [
        ...document.querySelectorAll('#animMappingTable .anim-anim'),
      ];
      check(
        'animation names: exact imported names are shown read-only',
        visibleAnimationInputs.length === (currentMapping?.sourceAnimations?.length || 0) &&
          visibleAnimationInputs.every(
            (input) => input.readOnly && input.value === input.dataset.anim
          ),
        `${visibleAnimationInputs.length} name(s)`
      );
      nameMode.value = 'target';
      nameMode.dispatchEvent(new Event('change', { bubbles: true }));
      const restoredAnimationInputs = [
        ...document.querySelectorAll('#animMappingTable .anim-anim'),
      ];
      check(
        'animation names: switching back restores editable custom mappings',
        restoredAnimationInputs.every(
          (input) =>
            !input.readOnly && input.value === (currentMapping?.animations?.[input.dataset.anim] || '')
        )
      );
      nameMode.value = 'source';
      nameMode.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('animNameMode')?.scrollIntoView({ block: 'center' });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)))
      );
      await native.capturePage(joinPath(cfg.outDir, 'screenshot-spine-animation-names.png'));
      let exportAttempts = 0;
      const realDoExport = ui.doExport;
      ui.doExport = async () => {
        exportAttempts++;
        return false;
      };
      await ui.next();
      ui.doExport = realDoExport;
      const converted = ui.conversion?.ok === true;
      check('draw calls: current package converts', converted);
      const convertedAnimations = ui.conversion?.skeletons?.[0]?.outAnimations || [];
      check(
        'animation names: output keeps exact current Spine names',
        JSON.stringify(convertedAnimations) ===
          JSON.stringify(currentMapping?.sourceAnimations || []),
        convertedAnimations.join(', ')
      );
      check(
        'animation names: target/custom mapping survives source-name export',
        JSON.stringify(currentMapping?.animations || {}) === savedTargetNames
      );
      check(
        'navigation: Mapping Next stops on Preview & Verify',
        ui.step === 'preview',
        `landed on ${ui.step}`
      );
      check(
        'navigation: arriving on Preview does not export',
        exportAttempts === 0,
        `${exportAttempts} export attempt(s)`
      );

      const report = ui.drawCallReports?.[0]?.report;
      check(
        'draw calls: every animation analysed',
        report?.ok === true && report.summary?.analyzedAnimationCount === 10,
        `${report?.summary?.analyzedAnimationCount || 0} animation(s)`
      );
      check(
        'draw calls: sample remains seven isolated Pixi batches',
        report?.summary?.minDrawCalls === 7 && report?.summary?.maxDrawCalls === 7,
        `${report?.summary?.minDrawCalls ?? '?'}-${report?.summary?.maxDrawCalls ?? '?'}`
      );
      check(
        'draw calls: preview table renders every animation',
        document.querySelectorAll('#animDrawCallTable .draw-call-row').length === 10,
        `${document.querySelectorAll('#animDrawCallTable .draw-call-row').length} row(s)`
      );

      const workflowButton = document.getElementById('btnWorkflows');
      const workflowRect = workflowButton.getBoundingClientRect();
      const topAtLauncher = document.elementFromPoint(
        workflowRect.left + workflowRect.width / 2,
        workflowRect.top + workflowRect.height / 2
      );
      check(
        'workflows: launcher remains accessible from a focused tool',
        topAtLauncher === workflowButton || topAtLauncher?.closest?.('#btnWorkflows') === workflowButton
      );

      const details = document.getElementById('animDrawCallDetails');
      details.open = true;
      check(
        'draw calls: batch-break explanation is rendered',
        /multiply/.test(document.getElementById('animDrawCallReasons')?.textContent || '')
      );

      details.scrollIntoView({ block: 'center' });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 350)))
      );
      await native.capturePage(joinPath(cfg.outDir, 'screenshot-spine-draw-calls.png'));
      ui.close();
    } catch (err) {
      console.error(err);
      results.push({
        name: 'draw calls: unhandled exception',
        pass: false,
        extra: String(err && err.stack ? err.stack : err),
      });
    }
  }

  // Animation Re-Export runs as its own scenario.
  if (cfg.animSource) {
    try {
      const { runAnimationSmokeTest } = await import('./animsmoke.js');
      const outcome = await runAnimationSmokeTest(cfg, check);
      if (outcome?.ui) {
        outcome.ui.goto('preview');
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500)))
        );
        await native.capturePage(joinPath(cfg.outDir, 'screenshot-anim-preview.png'));
        outcome.ui.goto('export');
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
        await native.capturePage(joinPath(cfg.outDir, 'screenshot-anim-export.png'));
        outcome.ui.goto('source');
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200)));
        await native.capturePage(joinPath(cfg.outDir, 'screenshot-anim-source.png'));
        outcome.ui.close();
      }

      if (cfg.meterSource) {
        const { runMeterSmokeTest } = await import('./animsmoke.js');
        const meter = await runMeterSmokeTest(cfg, check);
        if (meter?.ui) {
          meter.ui.goto('source');
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
          await native.capturePage(joinPath(cfg.outDir, 'screenshot-meter-source.png'));
          meter.ui.goto('preview');
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 600)))
          );
          await native.capturePage(joinPath(cfg.outDir, 'screenshot-meter-preview.png'));
          meter.ui.close();
        }
      }
    } catch (err) {
      console.error(err);
      results.push({
        name: 'anim: unhandled exception',
        pass: false,
        extra: String(err && err.stack ? err.stack : err),
      });
    }
  }

  // Bitmap Font Exporter runs as an independent scenario and can be launched
  // without the normal atlas fixtures.
  if (cfg.fontSource) {
    try {
      const { runFontSmokeTest } = await import('./fontsmoke.js');
      const outcome = await runFontSmokeTest(cfg, check);
      if (outcome?.ui && !outcome.screenshotsCaptured) {
        for (const [step, delay] of [
          ['glyphs', 300],
          ['layout', 300],
          ['preview', 650],
          ['export', 350],
        ]) {
          outcome.ui.goto(step);
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, delay)))
          );
          await native.capturePage(joinPath(cfg.outDir, `screenshot-font-${step}.png`));
        }
      }
      if (outcome?.ui) await outcome.ui.close({ force: true });
    } catch (err) {
      console.error(err);
      results.push({
        name: 'font: unhandled exception',
        pass: false,
        extra: String(err && err.stack ? err.stack : err),
      });
    }
  }

  if (cfg.atlasPng && cfg.atlasJson) {
  try {
    // ---- 1. Import the reference atlas -----------------------------------
    await loadAtlasFromPaths(cfg.atlasPng, cfg.atlasJson);
    check('import: 8 sprites loaded', state.sprites.length === 8, `got ${state.sprites.length}`);

    let pack = flushPack();
    check('initial pack places all sprites', pack && pack.placed.length === 8);
    check('initial pack has no overlaps', pack && !overlapCheck(pack, state.settings.extrude), overlapCheck(pack, state.settings.extrude) || '');

    // Dump extracted working images for visual inspection.
    for (const s of state.sprites) {
      const bytes = await canvasToPngBytes(s.source);
      await native.writeFile(joinPath(cfg.outDir, `extracted/${s.name}`), bytes);
    }

    // Remember original pixel content of an untouched sprite for round-trip check.
    const untouched = byName('frame_edge.png');
    const untouchedCopy = document.createElement('canvas');
    untouchedCopy.width = untouched.sw;
    untouchedCopy.height = untouched.sh;
    untouchedCopy.getContext('2d').drawImage(untouched.source, 0, 0);

    // ---- 1b. Unmodified re-export (fidelity + optimizer check) ------------
    const unmod = await exportToPaths(joinPath(cfg.outDir, 'exported_unmodified.png'));
    check('unmodified export written', unmod.pngBytes > 0, `${unmod.pngBytes} bytes`);
    const unmodParsed = parseAtlasJSON(
      new TextDecoder().decode(await native.readFile(unmod.jsonPath))
    );
    const unmodCanvas = await bytesToCanvas(await native.readFile(unmod.pngPath));
    const unmodExtract = extractSprites(unmodCanvas, unmodParsed.frames);
    const uEdge = unmodExtract.find((s) => s.name === 'frame_edge.png');
    const uDiff = pixelsMatch(uEdge.canvas, untouchedCopy);
    check('unmodified round-trip pixels', !uDiff, uDiff || '');

    // ---- 2. Edit operations ----------------------------------------------
    renameSprite(byName('Frame_FSCounter.png').id, 'fs_counter_renamed.png');
    check('rename applied', !!byName('fs_counter_renamed.png'));
    check('rename status', byName('fs_counter_renamed.png').status.renamed);

    removeSprites([byName('Frame_TumbleWin.png').id]);
    check('delete applied', !byName('Frame_TumbleWin.png') && state.sprites.length === 7);

    const genAdd = makeTestCanvas(220, 140, 20);
    addSprites([{ name: 'generated_new.png', canvas: genAdd }]);
    check('add applied', !!byName('generated_new.png') && state.sprites.length === 8);
    check('added status', byName('generated_new.png').status.added);

    const genReplace = makeTestCanvas(300, 200, 0);
    replaceSpriteImage(byName('frame_fade.png').id, genReplace);
    const replaced = byName('frame_fade.png');
    check('replace applied (new dims)', replaced.sw === 300 && replaced.sh === 200);
    check('replace status', replaced.status.replaced);

    updateSettings({ padding: 4, extrude: 2 });
    check('settings applied', state.settings.padding === 4 && state.settings.extrude === 2);

    // ---- 3. Undo / redo ----------------------------------------------------
    undo(); // settings
    check('undo settings', state.settings.padding === 2 && state.settings.extrude === 0);
    undo(); // replace
    check('undo replace', byName('frame_fade.png').sw === 876);
    redo();
    redo();
    check('redo restores', byName('frame_fade.png').sw === 300 && state.settings.extrude === 2);

    pack = flushPack();
    check('repack after edits places all 8', pack.placed.length === 8, `placed ${pack.placed.length}`);
    const overlap = overlapCheck(pack, state.settings.extrude);
    check('no overlaps with padding+extrude', !overlap, overlap || '');
    check('trim: generated_new trimmed to 200 wide', (() => {
      const p = pack.placed.find((q) => q.sprite.name === 'generated_new.png');
      return p && p.trim.w === 200 && p.trim.h === 140;
    })());

    // ---- 4. Export ---------------------------------------------------------
    const summary = await exportToPaths(joinPath(cfg.outDir, 'exported.png'));
    check('export wrote PNG', summary.pngBytes > 0, `${summary.pngBytes} bytes`);
    check('dirty cleared after export', !state.dirty);

    // ---- 5. Re-import the exported atlas and verify ------------------------
    const jsonText = new TextDecoder().decode(await native.readFile(summary.jsonPath));
    const parsed = parseAtlasJSON(jsonText);
    check('exported JSON has 8 frames', parsed.frames.length === 8);
    check('exported JSON references PNG', parsed.meta.image === 'exported.png', parsed.meta.image);
    check(
      'exported JSON meta size matches',
      parsed.meta.size && parsed.meta.size.w === summary.width && parsed.meta.size.h === summary.height
    );
    const names = parsed.frames.map((f) => f.name);
    check('renamed name in JSON', names.includes('fs_counter_renamed.png'));
    check('added name in JSON', names.includes('generated_new.png'));
    check('deleted name absent from JSON', !names.includes('Frame_TumbleWin.png'));
    const structural = parsed.frames.every(
      (f) => Number.isInteger(f.frame.x) && Number.isInteger(f.frame.y) && f.frame.w > 0 && f.frame.h > 0
    );
    check('frames structurally valid', structural);

    const tsOut = new TextDecoder().decode(await native.readFile(summary.tsPath));
    check(
      'index.ts references exported files',
      tsOut.includes(`from './exported.png'`) &&
        tsOut.includes(`from './exported.json'`) &&
        tsOut.includes(`import { createAsset } from 'pixi-svelte'`) &&
        tsOut.includes('export default createAsset({ img, atlas });')
    );

    const exportedCanvas = await bytesToCanvas(await native.readFile(summary.pngPath));
    check(
      'exported PNG dimensions match JSON',
      exportedCanvas.width === summary.width && exportedCanvas.height === summary.height,
      `${exportedCanvas.width}x${exportedCanvas.height}`
    );
    const reExtracted = extractSprites(exportedCanvas, parsed.frames);
    const reGen = reExtracted.find((s) => s.name === 'generated_new.png');
    const genDiff = pixelsMatch(reGen.canvas, genAdd);
    check('round-trip pixels: generated_new.png', !genDiff, genDiff || '');
    const reEdge = reExtracted.find((s) => s.name === 'frame_edge.png');
    const edgeDiff = pixelsMatch(reEdge.canvas, untouchedCopy);
    check('round-trip pixels: frame_edge.png (untouched)', !edgeDiff, edgeDiff || '');

    // ---- 6. Same-name import replacement + size-keep scaling ---------------
    const beforeCount = state.sprites.length;
    applyImages([{ id: byName('pressanywhere_fade.png').id, canvas: makeTestCanvas(100, 50, 0) }], []);
    check('same-name replace keeps sprite count', state.sprites.length === beforeCount);
    const pf = byName('pressanywhere_fade.png');
    check('same-name replace adopts new size', pf.sw === 100 && pf.sh === 50);
    check('same-name replace sets status', pf.status.replaced);
    undo();
    check('undo same-name replace restores size', byName('pressanywhere_fade.png').sw === 1024);
    const scaled = scaleCanvas(makeTestCanvas(100, 60, 0), 250, 130);
    check('scaleCanvas produces requested dims', scaled.width === 250 && scaled.height === 130);

    // ---- 6c. Blurred static symbol generation -------------------------------
    if (cfg.blurTest) {
      const { runBlurSmokeTest } = await import('./blursmoke.js');
      const blurOutcome = await runBlurSmokeTest(cfg, check);
      if (blurOutcome) {
        // Re-open the tool purely for a screenshot of the comparison view.
        const { openBlurTool } = await import('./app.js');
        const tool = await openBlurTool([blurOutcome.sourceSprites[0].id]);
        tool.options.strength = 28;
        tool.syncControls();
        tool.schedulePreview(true);
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))
        );
        await native.capturePage(joinPath(cfg.outDir, 'screenshot-blur.png'));
        tool.close();
      }
    }

    // ---- 7. Library scrolling with many sprites -----------------------------
    const bulk = [];
    for (let i = 0; i < 60; i++) {
      bulk.push({
        name: `bulk_${String(i).padStart(2, '0')}.png`,
        canvas: makeTestCanvas(24 + (i % 5) * 8, 20 + (i % 7) * 6, 0),
      });
    }
    addSprites(bulk);
    flushPack();
    const listEl = document.getElementById('spriteList');
    check(
      'library scrolls when overflowing',
      listEl.scrollHeight > listEl.clientHeight + 10,
      `scrollHeight=${listEl.scrollHeight} clientHeight=${listEl.clientHeight}`
    );
    const footRect = document.getElementById('btnAddLeft').getBoundingClientRect();
    check(
      'library footer stays visible',
      footRect.bottom <= window.innerHeight + 1,
      `footer bottom=${Math.round(footRect.bottom)} window=${window.innerHeight}`
    );
    listEl.scrollTop = listEl.scrollHeight; // show mid-list scroll position
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))));
    await native.capturePage(joinPath(cfg.outDir, 'screenshot-library-scroll.png'));
    undo(); // remove the bulk sprites again for the main screenshot

    // ---- 8. Screenshot ------------------------------------------------------
    preview.showLabels = true;
    document.getElementById('chkLabels').checked = true;
    setSelection([byName('generated_new.png').id]);
    preview.fit();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))));
    await native.capturePage(joinPath(cfg.outDir, 'screenshot.png'));
  } catch (err) {
    console.error(err);
    results.push({ name: 'unhandled exception', pass: false, extra: String(err && err.stack ? err.stack : err) });
  }
  }

  const passed = results.filter((r) => r.pass).length;
  const report = {
    passed,
    failed: results.length - passed,
    total: results.length,
    results,
  };
  await native.writeFile(
    joinPath(cfg.outDir, 'smoke-result.json'),
    new TextEncoder().encode(JSON.stringify(report, null, 2))
  );
  await native.quit(report.failed === 0 ? 0 : 1);
}
