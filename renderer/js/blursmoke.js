// End-to-end test for blurred static symbol generation, driven through the
// real UI controller.

import { state, getSprite, canBlur, undo, redo, flushPack, setSelection } from './state.js';
import { openBlurTool, exportToPaths } from './app.js';
import { blurImage, alphaCentroidOffset, blurredName, BLUR_STYLES } from './blur.js';
import { parseAtlasJSON, extractSprites } from './atlasio.js';
import { joinPath, bytesToCanvas } from './util.js';

const native = window.native;

/** A pure-red opaque disc on transparency — the classic halo detector. */
function makeDisc(size = 96, color = [255, 0, 0]) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function pixels(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
}

function hashCanvas(canvas) {
  const d = pixels(canvas);
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${canvas.width}x${canvas.height}:${(h >>> 0).toString(16)}`;
}

export async function runBlurSmokeTest(cfg, check) {
  // ---- 1. Halo correctness (premultiplied blur) --------------------------
  const disc = makeDisc(96, [255, 0, 0]);
  const blurredDisc = blurImage(disc, { style: BLUR_STYLES.GAUSSIAN, strength: 24, expand: true });
  const bd = pixels(blurredDisc.canvas);
  let fringeSamples = 0;
  let worstHue = 0;
  let darkest = 255;
  for (let i = 0; i < bd.length; i += 4) {
    const a = bd[i + 3];
    if (a < 40 || a > 210) continue; // the semi-transparent fringe
    fringeSamples++;
    worstHue = Math.max(worstHue, bd[i + 1], bd[i + 2]); // green/blue contamination
    darkest = Math.min(darkest, bd[i]); // red must stay strong
  }
  check('blur: fringe pixels exist to test', fringeSamples > 100, `${fringeSamples} samples`);
  check(
    'blur: no dark halo — red stays red through the alpha falloff',
    darkest >= 250 && worstHue <= 4,
    `min R=${darkest}, max G/B=${worstHue}`
  );

  // A white symbol must not pick up a bright halo either.
  const whiteDisc = makeDisc(96, [255, 255, 255]);
  const blurredWhite = blurImage(whiteDisc, { style: BLUR_STYLES.GAUSSIAN, strength: 20, expand: true });
  const wd = pixels(blurredWhite.canvas);
  let whiteMin = 255;
  for (let i = 0; i < wd.length; i += 4) {
    const a = wd[i + 3];
    if (a < 40 || a > 210) continue;
    whiteMin = Math.min(whiteMin, wd[i], wd[i + 1], wd[i + 2]);
  }
  check('blur: white symbol keeps its colour in the fringe', whiteMin >= 250, `min channel=${whiteMin}`);

  // ---- 2. Alpha + alignment ----------------------------------------------
  check(
    'blur: transparency preserved (not flattened to opaque)',
    (() => {
      let transparent = 0;
      let partial = 0;
      for (let i = 3; i < bd.length; i += 4) {
        if (bd[i] === 0) transparent++;
        else if (bd[i] < 250) partial++;
      }
      return transparent > 0 && partial > 0;
    })()
  );

  const beforeC = alphaCentroidOffset(disc);
  const afterC = alphaCentroidOffset(blurredDisc.canvas);
  check(
    'blur: visual centre preserved after expansion',
    Math.hypot(afterC.x - beforeC.x, afterC.y - beforeC.y) < 0.5,
    `drift=${Math.hypot(afterC.x - beforeC.x, afterC.y - beforeC.y).toFixed(3)} px`
  );

  // Motion blur is symmetric about the pixel, so it must not translate art.
  const motion = blurImage(disc, { style: BLUR_STYLES.MOTION, strength: 32, angle: 90, expand: true });
  const motionC = alphaCentroidOffset(motion.canvas);
  check(
    'blur: vertical motion blur does not shift the symbol',
    Math.hypot(motionC.x - beforeC.x, motionC.y - beforeC.y) < 0.5,
    `drift=${Math.hypot(motionC.x - beforeC.x, motionC.y - beforeC.y).toFixed(3)} px`
  );
  const diagonal = blurImage(disc, { style: BLUR_STYLES.MOTION, strength: 24, angle: 45, expand: true });
  const diagC = alphaCentroidOffset(diagonal.canvas);
  check(
    'blur: angled motion blur does not shift the symbol',
    Math.hypot(diagC.x - beforeC.x, diagC.y - beforeC.y) < 0.75,
    `drift=${Math.hypot(diagC.x - beforeC.x, diagC.y - beforeC.y).toFixed(3)} px`
  );

  // Vertical motion must actually spread vertically and not horizontally.
  const boundsOf = (canvas) => {
    const d = pixels(canvas);
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (d[(y * canvas.width + x) * 4 + 3] > 2) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1 };
  };
  const discB = boundsOf(disc);
  // Softness deliberately adds an isotropic gaussian on top of the streak, so
  // pure directionality is measured with it switched off.
  const pureMotion = blurImage(disc, {
    style: BLUR_STYLES.MOTION,
    strength: 32,
    angle: 90,
    softness: 0,
    expand: true,
  });
  const pureB = boundsOf(pureMotion.canvas);
  check(
    'blur: vertical motion spreads along Y, not X',
    pureB.h > discB.h + 24 && pureB.w <= discB.w + 2,
    `disc ${discB.w}x${discB.h} -> motion ${pureB.w}x${pureB.h}`
  );
  const pureHorizontal = blurImage(disc, {
    style: BLUR_STYLES.MOTION,
    strength: 32,
    angle: 0,
    softness: 0,
    expand: true,
  });
  const horizB = boundsOf(pureHorizontal.canvas);
  check(
    'blur: horizontal motion spreads along X, not Y',
    horizB.w > discB.w + 24 && horizB.h <= discB.h + 2,
    `disc ${discB.w}x${discB.h} -> motion ${horizB.w}x${horizB.h}`
  );
  const softened = boundsOf(motion.canvas);
  check(
    'blur: softness widens the streak isotropically',
    softened.w > pureB.w && softened.h > pureB.h,
    `pure ${pureB.w}x${pureB.h} -> softened ${softened.w}x${softened.h}`
  );

  // ---- 3. Clipping / expansion -------------------------------------------
  const tight = document.createElement('canvas');
  tight.width = 40;
  tight.height = 40;
  const tctx = tight.getContext('2d');
  tctx.fillStyle = '#00d0ff';
  tctx.fillRect(0, 0, 40, 40); // fills the canvas edge to edge
  const clipped = blurImage(tight, { style: BLUR_STYLES.GAUSSIAN, strength: 16, expand: false });
  const expanded = blurImage(tight, { style: BLUR_STYLES.GAUSSIAN, strength: 16, expand: true });
  check('blur: clipping detected when the canvas is locked', clipped.clipped === true, `edge=${clipped.edgeAlpha}`);
  check(
    'blur: expanded canvas keeps original size when not expanding',
    clipped.width === 40 && clipped.height === 40
  );
  check(
    'blur: expansion grows the canvas symmetrically',
    expanded.width === 40 + expanded.padding.x * 2 && expanded.height === 40 + expanded.padding.y * 2,
    `${expanded.width}x${expanded.height} pad=${expanded.padding.x}/${expanded.padding.y}`
  );

  // ---- 4. Eligibility guard ----------------------------------------------
  const staticIds = state.sprites.slice(0, 2).map((s) => s.id);
  check('blur: static sprites are eligible', canBlur(staticIds) === true);
  const victim = getSprite(staticIds[0]);
  const originalKind = victim.kind;
  victim.kind = 'spine';
  check('blur: a non-static asset is refused', canBlur(staticIds) === false);
  check('blur: mixed selection is refused', canBlur([staticIds[0]]) === false);
  const guarded = await openBlurTool([staticIds[0]]);
  check(
    'blur: the tool will not open for a non-static asset',
    document.getElementById('blurRoot').classList.contains('visible') === false
  );
  victim.kind = originalKind;
  check('blur: empty selection is refused', canBlur([]) === false);

  // The inspector buttons must reflect eligibility, not just the API. Driven
  // through the real selection so the gating path is what is actually tested.
  setSelection([victim.id]);
  check(
    'blur: inspector button enabled for a static selection',
    document.getElementById('inspBlurBtn').disabled === false
  );
  victim.kind = 'spine';
  setSelection([]);
  setSelection([victim.id]);
  check(
    'blur: inspector button disabled for non-static selection',
    document.getElementById('inspBlurBtn').disabled === true
  );
  victim.kind = originalKind;
  setSelection([]);

  // ---- 5. Batch generation through the real UI ---------------------------
  const sourceSprites = state.sprites.slice(0, 3);
  const sourceIds = sourceSprites.map((s) => s.id);
  const sourceHashes = sourceSprites.map((s) => hashCanvas(s.source));
  const sourceDims = sourceSprites.map((s) => ({ w: s.sw, h: s.sh }));
  const beforeCount = state.sprites.length;

  const tool = await openBlurTool(sourceIds);
  check('blur: tool opened for a batch', document.getElementById('blurRoot').classList.contains('visible'));
  check('blur: all selected symbols are targeted', tool.targets.length === 3);
  check(
    'blur: names generated consistently from the originals',
    sourceSprites.every((s) => tool.names.get(s.id) === blurredName(s.name)),
    [...tool.names.values()].join(', ')
  );

  tool.options.style = BLUR_STYLES.MOTION;
  tool.options.strength = 28;
  tool.options.angle = 90;
  tool.options.expand = true;
  tool.syncControls();
  tool.schedulePreview(true);
  check('blur: preview rendered', document.getElementById('blurAfter').width > 0);

  // Name collisions must block generation rather than overwrite.
  const firstId = sourceIds[0];
  tool.names.set(firstId, state.sprites[1].name);
  tool.renderNames();
  check(
    'blur: colliding name blocks generation',
    document.getElementById('blurApply').disabled === true
  );
  document.getElementById('blurAutoFix').click();
  check(
    'blur: auto-fix resolves the collision',
    document.getElementById('blurApply').disabled === false &&
      !state.sprites.some((s) => s.name === tool.names.get(firstId))
  );
  tool.names.set(firstId, blurredName(sourceSprites[0].name));
  tool.renderNames();

  const addedIds = tool.generate();
  check('blur: three blurred sprites added', state.sprites.length === beforeCount + 3);
  check('blur: modal closed after generating', !document.getElementById('blurRoot').classList.contains('visible'));

  const added = addedIds.map(getSprite);
  check(
    'blur: blurred sprites are named as expected',
    added.every((s, i) => s.name === blurredName(sourceSprites[i].name)),
    added.map((s) => s.name).join(', ')
  );
  check('blur: blurred sprites are static and blurrable', added.every((s) => s.kind === 'static'));
  check('blur: provenance recorded', added.every((s, i) => s.derivedFrom?.name === sourceSprites[i].name));
  check(
    'blur: each blurred sprite keeps its own source dimensions plus padding',
    added.every((s, i) => s.sw > sourceDims[i].w && s.sh > sourceDims[i].h),
    added.map((s, i) => `${sourceDims[i].w}x${sourceDims[i].h}->${s.sw}x${s.sh}`).join(' ')
  );
  check(
    'blur: originals are untouched',
    sourceSprites.every((s, i) => hashCanvas(s.source) === sourceHashes[i]) &&
      sourceSprites.every((s, i) => s.sw === sourceDims[i].w && s.sh === sourceDims[i].h)
  );
  check(
    'blur: each blurred symbol stays centred on its original',
    added.every((s, i) => {
      const a = alphaCentroidOffset(sourceSprites[i].source);
      const b = alphaCentroidOffset(s.source);
      return Math.hypot(a.x - b.x, a.y - b.y) < 1.0;
    }),
    added
      .map((s, i) => {
        const a = alphaCentroidOffset(sourceSprites[i].source);
        const b = alphaCentroidOffset(s.source);
        return Math.hypot(a.x - b.x, a.y - b.y).toFixed(2);
      })
      .join(', ')
  );
  check(
    'blur: blurred output differs from the original',
    added.every((s, i) => hashCanvas(s.source) !== sourceHashes[i])
  );

  // ---- 6. Undo / redo -----------------------------------------------------
  undo();
  check('blur: undo removes the whole batch', state.sprites.length === beforeCount);
  redo();
  check('blur: redo restores the batch', state.sprites.length === beforeCount + 3);
  check(
    'blur: redone sprites keep their names',
    added.every((s) => state.sprites.some((x) => x.name === s.name))
  );

  // ---- 7. Repack + export -------------------------------------------------
  const pack = flushPack();
  check(
    'blur: blurred sprites take part in repacking',
    added.every((s) => pack.placed.some((p) => p.sprite.id === s.id)),
    `${pack.placed.length} placed`
  );

  const outPng = joinPath(cfg.outDir, 'blur/atlas_with_blur.png');
  const summary = await exportToPaths(outPng);
  const jsonText = new TextDecoder().decode(await native.readFile(summary.jsonPath));
  const parsed = parseAtlasJSON(jsonText);
  const frameNames = parsed.frames.map((f) => f.name);
  check(
    'blur: exported JSON registers the blurred frames',
    added.every((s) => frameNames.includes(s.name)),
    added.map((s) => s.name).join(', ')
  );
  check(
    'blur: exported JSON still registers the sharp originals',
    sourceSprites.every((s) => frameNames.includes(s.name))
  );
  check(
    'blur: blurred frames are ordinary static frames',
    parsed.frames
      .filter((f) => added.some((s) => s.name === f.name))
      .every((f) => f.frame.w > 0 && f.frame.h > 0 && Number.isInteger(f.frame.x))
  );

  // The exported pixels must survive the round trip with their alpha intact.
  const exportedCanvas = await bytesToCanvas(await native.readFile(summary.pngPath));
  const reExtracted = extractSprites(exportedCanvas, parsed.frames);
  const reBlur = reExtracted.find((s) => s.name === added[0].name);
  check('blur: blurred frame recoverable from the exported atlas', !!reBlur);
  if (reBlur) {
    const d = pixels(reBlur.canvas);
    let partial = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 250) partial++;
    check('blur: soft alpha survives the export round trip', partial > 50, `${partial} soft pixels`);
  }

  return { added, sourceSprites, summary };
}
