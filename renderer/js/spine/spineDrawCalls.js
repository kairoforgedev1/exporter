// Backend-independent estimate of the batches emitted by spine-pixi-v8/Pixi 8.
// One Pixi batch becomes one WebGL draw or one WebGPU drawIndexed call. This
// deliberately analyses the Spine object in isolation: filters, masks, render
// textures, attached Pixi containers, and surrounding scene objects are not
// represented by spine-core and therefore are reported as limitations.

import * as spine from '../../../node_modules/@esotericsoftware/spine-core/dist/index.js';

const DEFAULT_SAMPLE_RATE = 60;
const DEFAULT_MAX_TEXTURES = 16;
const DEFAULT_MAX_SAMPLES = 12000;
const REGION_INDICES = [0, 1, 2, 0, 2, 3];
const NPM_BLEND_MODES = new Set(['normal', 'add', 'screen']);

const roundTime = (value) => Math.round(value * 1e9) / 1e9;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(finiteNumber(value, fallback));
  return number > 0 ? number : fallback;
}

function pushUnique(target, value) {
  if (value && !target.includes(value)) target.push(value);
}

function attachmentKind(attachment) {
  if (!attachment) return null;
  if (attachment instanceof spine.RegionAttachment) return 'region';
  if (attachment instanceof spine.MeshAttachment) return 'mesh';
  if (attachment instanceof spine.ClippingAttachment) return 'clipping';

  // Duck typing keeps the frame analyser useful for focused tests and makes it
  // tolerant of compatible spine-core copies loaded by a host application.
  const namedType = String(attachment.type ?? attachment.kind ?? '').toLowerCase();
  if (namedType.includes('clip')) return 'clipping';
  if (namedType.includes('mesh')) return 'mesh';
  if (namedType.includes('region')) return 'region';
  if (attachment.endSlot && attachment.worldVerticesLength != null) return 'clipping';
  if (attachment.triangles && attachment.worldVerticesLength != null) return 'mesh';
  if (attachment.region && (attachment.uvs || attachment.offset)) return 'region';
  return null;
}

function blendModeName(value, warnings) {
  if (typeof value === 'number') {
    if (value === spine.BlendMode?.Normal || value === 0) return 'normal';
    if (value === spine.BlendMode?.Additive || value === 1) return 'add';
    if (value === spine.BlendMode?.Multiply || value === 2) return 'multiply';
    if (value === spine.BlendMode?.Screen || value === 3) return 'screen';
  }

  const normalized = String(value ?? 'normal').toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'normal') return 'normal';
  if (normalized === 'add' || normalized === 'additive') return 'add';
  if (normalized === 'multiply') return 'multiply';
  if (normalized === 'screen') return 'screen';

  pushUnique(warnings, `Unknown Spine blend mode "${String(value)}"; treated as normal.`);
  return 'normal';
}

function textureAlphaMode(region) {
  const spineTexture = region?.texture ?? region?.page?.texture;
  const pixiTexture = spineTexture?.texture ?? spineTexture;
  return (
    pixiTexture?.source?.alphaMode ??
    pixiTexture?._source?.alphaMode ??
    region?.page?.alphaMode ??
    null
  );
}

function adjustedBlendMode(baseBlendMode, region) {
  // Pixi only selects its non-premultiplied blend variants when a TextureSource
  // explicitly uses no-premultiply-alpha. Spine atlas pages normally use either
  // premultiplied-alpha or premultiply-alpha-on-upload, so `page.pma === false`
  // alone must not force an extra batch.
  return textureAlphaMode(region) === 'no-premultiply-alpha' && NPM_BLEND_MODES.has(baseBlendMode)
    ? `${baseBlendMode}-npm`
    : baseBlendMode;
}

function resolveRegion(slot, attachment, warnings) {
  if (attachment.sequence) {
    try {
      attachment.sequence.apply(slot, attachment);
    } catch (error) {
      pushUnique(
        warnings,
        `Sequence on "${attachment.name ?? slot?.data?.name ?? 'attachment'}" could not be applied: ${error.message}`
      );
    }
  }
  return attachment.region ?? null;
}

let anonymousTextureId = 0;
const anonymousTextureIds = new WeakMap();

function pageDetails(region) {
  const page = region?.page ?? null;
  const texture = region?.texture ?? page?.texture ?? null;
  const identity = page ?? texture ?? region ?? null;
  let name = page?.name ?? texture?.label ?? texture?.name ?? region?.name ?? null;

  if (!name && identity && (typeof identity === 'object' || typeof identity === 'function')) {
    if (!anonymousTextureIds.has(identity)) anonymousTextureIds.set(identity, ++anonymousTextureId);
    name = `<texture-${anonymousTextureIds.get(identity)}>`;
  }
  if (!name) name = '<unresolved-texture>';

  return { identity: identity ?? name, name: String(name) };
}

function darkTintEnabled(skeleton, override) {
  if (typeof override === 'boolean') return override;
  const slots = skeleton?.slots ?? [];
  return slots.some((slot) => !!(slot?.data?.darkColor ?? slot?.darkColor));
}

function trianglesFor(attachment, kind) {
  if (kind === 'region') return 2;
  const length = finiteNumber(attachment?.triangles?.length, 0);
  return Math.max(0, Math.floor(length / 3));
}

function clippedTriangleCount(clipper, slot, attachment, kind, warnings) {
  if (!clipper?.isClipping?.()) return trianglesFor(attachment, kind);
  if (typeof attachment.computeWorldVertices !== 'function') {
    pushUnique(
      warnings,
      `Clipping could not be modelled for "${attachment.name ?? slot?.data?.name ?? 'attachment'}"; using its unclipped triangles.`
    );
    return trianglesFor(attachment, kind);
  }

  try {
    const indices = kind === 'region' ? REGION_INDICES : attachment.triangles;
    const uvs = attachment.uvs ?? [];
    let vertices;
    if (kind === 'region') {
      vertices = new Float32Array(8);
      attachment.computeWorldVertices(slot, vertices, 0, 2);
    } else {
      const vertexLength = positiveInteger(attachment.worldVerticesLength, uvs.length || 2);
      vertices = new Float32Array(vertexLength);
      attachment.computeWorldVertices(slot, 0, vertexLength, vertices, 0, 2);
    }
    clipper.clipTrianglesUnpacked(vertices, indices, indices.length, uvs);
    return Math.max(0, Math.floor(clipper.clippedTriangles.length / 3));
  } catch (error) {
    pushUnique(
      warnings,
      `Clipping could not be modelled for "${attachment.name ?? slot?.data?.name ?? 'attachment'}": ${error.message}`
    );
    return trianglesFor(attachment, kind);
  }
}

function closeBatch(batch) {
  if (!batch) return null;
  batch.texturePages = [...batch._pageNames];
  delete batch._pageNames;
  delete batch._pageIdentities;
  return batch;
}

function newBatch(drawable, reason, reasons) {
  return {
    index: 0,
    batcher: drawable.batcher,
    blendMode: drawable.blendMode,
    topology: drawable.topology,
    texturePages: [],
    drawableAttachments: 0,
    triangles: 0,
    slotNames: [],
    attachmentNames: [],
    startReason: reason,
    breakReasons: reasons,
    _pageNames: new Set(),
    _pageIdentities: new Set(),
  };
}

function addDrawable(batch, drawable) {
  batch.drawableAttachments++;
  batch.triangles += drawable.triangles;
  batch._pageNames.add(drawable.page.name);
  batch._pageIdentities.add(drawable.page.identity);
  batch.slotNames.push(drawable.slotName);
  batch.attachmentNames.push(drawable.attachmentName);
}

/**
 * Analyse one already-applied spine-core Skeleton pose.
 *
 * @param {object} skeleton A spine-core Skeleton (duck-typed mocks are accepted).
 * @param {object} options `maxTextures` defaults to Pixi's conservative 16.
 */
export function analyzeSpineFrame(skeleton, options = {}) {
  const warnings = [];
  const maxTextures = positiveInteger(options.maxTextures, DEFAULT_MAX_TEXTURES);
  const globalDarkTint = darkTintEnabled(skeleton, options.darkTint);
  const batches = [];
  const texturePages = new Map();
  const breakReasons = { blendMode: 0, batcher: 0, topology: 0, textureCapacity: 0 };
  const breakSequence = [];
  let currentBatch = null;
  let drawableAttachments = 0;
  let triangles = 0;
  let clipper = null;

  try {
    clipper = typeof spine.SkeletonClipping === 'function' ? new spine.SkeletonClipping() : null;
  } catch {
    clipper = null;
  }

  for (const slot of skeleton?.drawOrder ?? []) {
    const attachment = slot?.getAttachment?.() ?? slot?.attachment ?? null;
    const kind = attachmentKind(attachment);

    if (kind === 'clipping') {
      if (clipper && slot?.bone && typeof attachment.computeWorldVertices === 'function') {
        try {
          clipper.clipStart(slot, attachment);
        } catch (error) {
          pushUnique(warnings, `Clipping attachment "${attachment.name ?? slot?.data?.name ?? ''}" failed: ${error.message}`);
        }
      }
      continue;
    }

    if (kind === 'region' || kind === 'mesh') {
      const region = resolveRegion(slot, attachment, warnings);
      if (!region) {
        pushUnique(
          warnings,
          `Drawable "${attachment.name ?? slot?.data?.name ?? 'attachment'}" has no resolved atlas region and was skipped.`
        );
      } else {
        const triangleCount = clippedTriangleCount(clipper, slot, attachment, kind, warnings);
        // spine-pixi-v8 only skips an attachment when clipping removes all of
        // its geometry. Alpha-zero attachments still enter Pixi's batcher.
        if (triangleCount > 0) {
          const baseBlend = blendModeName(slot?.data?.blendMode, warnings);
          const page = pageDetails(region);
          const drawable = {
            batcher:
              options.batcherResolver?.({ skeleton, slot, attachment, darkTint: globalDarkTint }) ??
              (globalDarkTint ? 'darkTint' : 'default'),
            blendMode: adjustedBlendMode(baseBlend, region),
            topology: attachment.topology ?? 'triangle-list',
            page,
            triangles: triangleCount,
            slotName: String(slot?.data?.name ?? slot?.name ?? '<slot>'),
            attachmentName: String(attachment.name ?? '<attachment>'),
          };

          texturePages.set(page.identity, page.name);
          drawableAttachments++;
          triangles += triangleCount;

          const reasons = [];
          if (currentBatch) {
            if (currentBatch.batcher !== drawable.batcher) reasons.push('batcher');
            if (currentBatch.blendMode !== drawable.blendMode) reasons.push('blendMode');
            if (currentBatch.topology !== drawable.topology) reasons.push('topology');
            if (
              !currentBatch._pageIdentities.has(page.identity) &&
              currentBatch._pageIdentities.size >= maxTextures
            ) {
              reasons.push('textureCapacity');
            }
          }

          if (!currentBatch || reasons.length) {
            if (currentBatch) batches.push(closeBatch(currentBatch));
            for (const reason of reasons) breakReasons[reason]++;
            const startReason = currentBatch ? reasons.join('+') : 'start';
            currentBatch = newBatch(drawable, startReason, [...reasons]);
            breakSequence.push({
              batch: batches.length,
              reason: startReason,
              reasons: [...reasons],
              slot: drawable.slotName,
              attachment: drawable.attachmentName,
            });
          }
          addDrawable(currentBatch, drawable);
        }
      }
    }

    try {
      clipper?.clipEndWithSlot?.(slot);
    } catch (error) {
      pushUnique(warnings, `Clipping end failed for slot "${slot?.data?.name ?? ''}": ${error.message}`);
    }
  }

  if (currentBatch) batches.push(closeBatch(currentBatch));
  try {
    clipper?.clipEnd?.();
  } catch {
    // Nothing useful to do after a complete frame scan.
  }
  batches.forEach((batch, index) => {
    batch.index = index;
  });

  return {
    drawCalls: batches.length,
    drawableAttachments,
    triangles,
    texturePages: texturePages.size,
    texturePageNames: [...texturePages.values()],
    batches,
    batchSequence: batches.map(
      (batch) => `${batch.batcher}:${batch.blendMode}:${batch.topology}`
    ),
    breakReasons,
    breakSequence,
    warnings,
  };
}

function timelineFrameTimes(animation) {
  const times = [];
  for (const timeline of animation?.timelines ?? []) {
    const frames = timeline?.frames;
    if (!frames?.length) continue;
    let entries = 1;
    try {
      entries = positiveInteger(timeline.getFrameEntries?.(), 1);
    } catch {
      entries = 1;
    }
    let frameCount;
    try {
      frameCount = positiveInteger(timeline.getFrameCount?.(), Math.floor(frames.length / entries));
    } catch {
      frameCount = Math.floor(frames.length / entries);
    }
    frameCount = Math.min(frameCount, Math.floor(frames.length / entries));
    for (let frame = 0; frame < frameCount; frame++) {
      const time = Number(frames[frame * entries]);
      if (Number.isFinite(time) && time >= 0) times.push(time);
    }
  }
  return times;
}

/** Return sorted 60 Hz sample points plus exact/before/after timeline keys. */
export function collectAnimationSampleTimes(animation, options = {}) {
  const duration = Math.max(0, finiteNumber(animation?.duration, 0));
  const sampleRate = finiteNumber(options.sampleRate, DEFAULT_SAMPLE_RATE) > 0
    ? finiteNumber(options.sampleRate, DEFAULT_SAMPLE_RATE)
    : DEFAULT_SAMPLE_RATE;
  const includeKeyframes = options.includeKeyframes !== false;
  const epsilon = Math.max(1e-8, finiteNumber(options.keyframeEpsilon, 1e-6));
  const times = new Set([0, roundTime(duration)]);

  const regularFrames = Math.floor(duration * sampleRate + 1e-9);
  for (let frame = 1; frame <= regularFrames; frame++) {
    times.add(roundTime(Math.min(duration, frame / sampleRate)));
  }

  if (includeKeyframes) {
    for (const keyTime of timelineFrameTimes(animation)) {
      if (keyTime > duration + epsilon) continue;
      const time = Math.max(0, Math.min(duration, keyTime));
      times.add(roundTime(time));
      if (time > 0) times.add(roundTime(Math.max(0, time - epsilon)));
      if (time < duration) times.add(roundTime(Math.min(duration, time + epsilon)));
    }
  }

  return [...times].sort((a, b) => a - b);
}

function range(values) {
  if (!values.length) return { min: 0, average: 0, max: 0 };
  return {
    min: Math.min(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  };
}

function aggregateReasonCounts(frames) {
  const total = { blendMode: 0, batcher: 0, topology: 0, textureCapacity: 0 };
  for (const frame of frames) {
    for (const key of Object.keys(total)) total[key] += frame.breakReasons?.[key] ?? 0;
  }
  return total;
}

function analyseAnimation(skeletonData, animation, options) {
  const skeleton = new spine.Skeleton(skeletonData);
  const state = new spine.AnimationState(new spine.AnimationStateData(skeletonData));
  let sampleTimes = collectAnimationSampleTimes(animation, options);
  const warnings = [];
  const maxSamples = Math.max(2, positiveInteger(options.maxSamples, DEFAULT_MAX_SAMPLES));

  if (sampleTimes.length > maxSamples) {
    // Preserve the first and last frame while evenly retaining the configured
    // ceiling. This is only expected for unusually long/key-heavy animations.
    const reduced = [];
    for (let i = 0; i < maxSamples; i++) {
      reduced.push(sampleTimes[Math.round((i * (sampleTimes.length - 1)) / (maxSamples - 1))]);
    }
    sampleTimes = [...new Set(reduced)];
    warnings.push(`Sampling was capped at ${sampleTimes.length} frames.`);
  }

  skeleton.setToSetupPose();
  state.clearTracks();
  state.setAnimation(0, animation.name, false);
  let previousTime = 0;
  const frames = [];

  for (const timestamp of sampleTimes) {
    const delta = Math.max(0, timestamp - previousTime);
    state.update(delta);
    state.apply(skeleton);
    skeleton.update(delta);
    skeleton.updateWorldTransform(spine.Physics?.update ?? 0);
    const frame = analyzeSpineFrame(skeleton, options);
    frame.timestamp = timestamp;
    frames.push(frame);
    for (const warning of frame.warnings) pushUnique(warnings, warning);
    previousTime = timestamp;
  }

  let worstFrame = frames[0] ?? {
    timestamp: 0,
    drawCalls: 0,
    drawableAttachments: 0,
    triangles: 0,
    texturePages: 0,
    texturePageNames: [],
    batches: [],
    batchSequence: [],
    breakReasons: {},
    breakSequence: [],
    warnings: [],
  };
  for (const frame of frames) {
    if (
      frame.drawCalls > worstFrame.drawCalls ||
      (frame.drawCalls === worstFrame.drawCalls && frame.triangles > worstFrame.triangles)
    ) {
      worstFrame = frame;
    }
  }

  const drawCalls = range(frames.map((frame) => frame.drawCalls));
  const attachments = range(frames.map((frame) => frame.drawableAttachments));
  const triangles = range(frames.map((frame) => frame.triangles));
  const texturePages = range(frames.map((frame) => frame.texturePages));
  texturePages.names = [...new Set(frames.flatMap((frame) => frame.texturePageNames))];

  return {
    ok: true,
    animation: animation.name,
    duration: finiteNumber(animation.duration, 0),
    sampleCount: frames.length,
    minDrawCalls: drawCalls.min,
    averageDrawCalls: drawCalls.average,
    maxDrawCalls: drawCalls.max,
    worstTimestamp: worstFrame.timestamp,
    attachments,
    triangles,
    texturePages,
    worstFrame,
    breakReasons: aggregateReasonCounts(frames),
    warnings,
  };
}

/**
 * Sample every selected animation and estimate the batches spine-pixi-v8 will
 * submit for the Spine object alone.
 */
export function analyzeSpineDrawCalls({
  skeletonData,
  sampleRate = DEFAULT_SAMPLE_RATE,
  maxTextures = DEFAULT_MAX_TEXTURES,
  animationNames,
  includeKeyframes = true,
  keyframeEpsilon = 1e-6,
  maxSamples = DEFAULT_MAX_SAMPLES,
  darkTint,
  batcherResolver,
} = {}) {
  if (!skeletonData || !Array.isArray(skeletonData.animations)) {
    return {
      ok: false,
      animations: [],
      summary: null,
      warnings: ['A parsed spine-core SkeletonData with animations is required.'],
      options: { sampleRate, maxTextures, includeKeyframes, keyframeEpsilon, maxSamples },
      error: 'Invalid skeletonData.',
    };
  }

  const requested = animationNames ? new Set(animationNames) : null;
  const selected = skeletonData.animations.filter((animation) => !requested || requested.has(animation.name));
  const warnings = [
    'Expected calls cover this Spine object only; scene objects, filters, masks, render textures, and attached Pixi slot containers can add calls.',
  ];
  if (requested) {
    for (const name of requested) {
      if (!selected.some((animation) => animation.name === name)) {
        warnings.push(`Animation "${name}" was not found.`);
      }
    }
  }

  const options = {
    sampleRate: finiteNumber(sampleRate, DEFAULT_SAMPLE_RATE),
    maxTextures: positiveInteger(maxTextures, DEFAULT_MAX_TEXTURES),
    includeKeyframes: includeKeyframes !== false,
    keyframeEpsilon: Math.max(1e-8, finiteNumber(keyframeEpsilon, 1e-6)),
    maxSamples: Math.max(2, positiveInteger(maxSamples, DEFAULT_MAX_SAMPLES)),
    darkTint,
    batcherResolver,
  };
  const animations = [];

  for (const animation of selected) {
    try {
      const result = analyseAnimation(skeletonData, animation, options);
      animations.push(result);
      for (const warning of result.warnings) pushUnique(warnings, warning);
    } catch (error) {
      animations.push({
        ok: false,
        animation: animation.name,
        duration: finiteNumber(animation.duration, 0),
        error: error.message,
        warnings: [error.message],
      });
      pushUnique(warnings, `${animation.name}: ${error.message}`);
    }
  }

  const successful = animations.filter((animation) => animation.ok);
  const allFrameCounts = successful.reduce((sum, animation) => sum + animation.sampleCount, 0);
  const weightedDrawCalls = successful.reduce(
    (sum, animation) => sum + animation.averageDrawCalls * animation.sampleCount,
    0
  );
  let worst = null;
  for (const animation of successful) {
    if (
      !worst ||
      animation.maxDrawCalls > worst.maxDrawCalls ||
      (animation.maxDrawCalls === worst.maxDrawCalls &&
        animation.worstFrame.triangles > worst.worstFrame.triangles)
    ) {
      worst = animation;
    }
  }

  const summary = {
    animationCount: selected.length,
    analyzedAnimationCount: successful.length,
    failedAnimationCount: animations.length - successful.length,
    sampleCount: allFrameCounts,
    minDrawCalls: successful.length ? Math.min(...successful.map((value) => value.minDrawCalls)) : 0,
    averageDrawCalls: allFrameCounts ? weightedDrawCalls / allFrameCounts : 0,
    maxDrawCalls: successful.length ? Math.max(...successful.map((value) => value.maxDrawCalls)) : 0,
    worstAnimation: worst?.animation ?? null,
    worstTimestamp: worst?.worstTimestamp ?? 0,
    attachments: {
      min: successful.length ? Math.min(...successful.map((value) => value.attachments.min)) : 0,
      max: successful.length ? Math.max(...successful.map((value) => value.attachments.max)) : 0,
    },
    triangles: {
      min: successful.length ? Math.min(...successful.map((value) => value.triangles.min)) : 0,
      max: successful.length ? Math.max(...successful.map((value) => value.triangles.max)) : 0,
    },
    texturePages: {
      min: successful.length ? Math.min(...successful.map((value) => value.texturePages.min)) : 0,
      max: successful.length ? Math.max(...successful.map((value) => value.texturePages.max)) : 0,
      names: [...new Set(successful.flatMap((value) => value.texturePages.names))],
    },
    warningCount: warnings.length,
  };

  return {
    ok: animations.every((animation) => animation.ok),
    animations,
    summary,
    warnings,
    options: {
      sampleRate: options.sampleRate,
      maxTextures: options.maxTextures,
      includeKeyframes: options.includeKeyframes,
      keyframeEpsilon: options.keyframeEpsilon,
      maxSamples: options.maxSamples,
      darkTint: typeof darkTint === 'boolean' ? darkTint : null,
    },
  };
}
