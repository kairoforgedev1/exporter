// Spine skeleton JSON: inspection and safe remapping.
//
// The converter only ever renames things (animation keys, attachment region
// paths, the skeleton's own images path). Bones, slots, skins, meshes,
// timelines, draw order, colors, blend modes, clipping, paths, constraints and
// events are copied through untouched.

/** Attachment types for which SkeletonJson asks the attachment loader for an atlas region. */
const REGION_ATTACHMENT_TYPES = new Set(['region', 'mesh', 'linkedmesh']);
const spineValue = (object, key, fallback) =>
  object && object[key] !== undefined ? object[key] : fallback;

export const spineMajorMinor = (version) => {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  return m ? `${m[1]}.${m[2]}` : null;
};

/**
 * The atlas region an attachment resolves to, exactly as SkeletonJson does it:
 *
 *     name = getValue(map, "name", attachmentKey);
 *     path = getValue(map, "path", name);
 *
 * So `name` is not decoration — when an attachment carries `name` but no
 * `path`, `name` *is* the region. Treating the map key as the region in that
 * case reports a package as incomplete when every region is present, and would
 * drop artwork the skeleton actually references.
 */
function attachmentRegionName(attachmentKey, attachment) {
  const name = spineValue(attachment, 'name', attachmentKey);
  return spineValue(attachment, 'path', name);
}

/**
 * Every attachment in every skin, with the atlas region name it resolves to.
 */
export function listAttachments(skeleton) {
  const out = [];
  const skins = Array.isArray(skeleton.skins)
    ? skeleton.skins
    : Object.entries(skeleton.skins || {}).map(([name, attachments]) => ({ name, attachments }));

  for (const skin of skins) {
    for (const [slotName, slotAttachments] of Object.entries(skin.attachments || {})) {
      for (const [attachmentName, attachment] of Object.entries(slotAttachments || {})) {
        const type = attachment.type || 'region';
        out.push({
          skin: skin.name,
          slot: slotName,
          attachmentName,
          type,
          regionName: attachmentRegionName(attachmentName, attachment),
          // A linked mesh inherits its geometry, but the runtime still creates
          // it through newMeshAttachment with its own texture path.
          usesTexture: REGION_ATTACHMENT_TYPES.has(type),
          attachment,
        });
      }
    }
  }
  return out;
}

/**
 * The atlas region names a Spine *sequence* attachment resolves to.
 *
 * A sequence attachment (flipbook) does not load a region matching its base
 * name; the runtime expands it into numbered frames, appending the zero-padded
 * frame index to the base path: `sf_` + {count:30,start:0,digits:2} resolves to
 * `sf_00 … sf_29`. Mirror that here so the frames are matched, not the base.
 */
export function sequenceRegionNames(basePath, sequence) {
  const count = spineValue(sequence, 'count', 0);
  // SkeletonJson.readSequence defaults start to 1. Keep an explicit 0: a
  // number of exporters intentionally use zero-based frame names.
  const start = spineValue(sequence, 'start', 1);
  const digits = spineValue(sequence, 'digits', 0);
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(basePath + String(start + i).padStart(digits, '0'));
  }
  return names;
}

/** Stable identity for a sequence's atlas-frame family (setup is not part of its filenames). */
export function sequenceFamilyKey(basePath, sequence) {
  return JSON.stringify([
    basePath,
    spineValue(sequence, 'count', 0),
    spineValue(sequence, 'start', 1),
    spineValue(sequence, 'digits', 0),
  ]);
}

/**
 * Sequence attachments and the complete atlas-frame family each one needs.
 *
 * Multiple attachments can return the same `familyKey`; callers that aggregate
 * packages can deduplicate on that key without losing attachment provenance.
 */
export function listSequenceFamilies(skeleton) {
  return listAttachments(skeleton)
    .filter((a) => a.usesTexture && a.attachment?.sequence)
    .map((a) => {
      const sequence = {
        count: spineValue(a.attachment.sequence, 'count', 0),
        start: spineValue(a.attachment.sequence, 'start', 1),
        digits: spineValue(a.attachment.sequence, 'digits', 0),
        setup: spineValue(a.attachment.sequence, 'setup', 0),
      };
      return {
        familyKey: sequenceFamilyKey(a.regionName, sequence),
        basePath: a.regionName,
        sequence,
        regions: sequenceRegionNames(a.regionName, sequence),
        skin: a.skin,
        slot: a.slot,
        attachmentName: a.attachmentName,
        type: a.type,
        attachment: a.attachment,
      };
    });
}

/** Distinct atlas region names this skeleton needs. */
export function requiredRegions(skeleton) {
  const names = new Set();
  for (const a of listAttachments(skeleton)) {
    if (!a.usesTexture) continue;
    // Sequence attachments resolve to numbered frames, not the base name.
    if (a.attachment?.sequence) {
      for (const frame of sequenceRegionNames(a.regionName, a.attachment.sequence)) {
        names.add(frame);
      }
    } else {
      names.add(a.regionName);
    }
  }
  return [...names];
}

/** Spine features present, for the compatibility report. */
export function detectFeatures(skeleton) {
  const features = new Set();
  for (const a of listAttachments(skeleton)) {
    if (a.type === 'mesh' || a.type === 'linkedmesh') features.add('meshes');
    if (a.type === 'clipping') features.add('clipping');
    if (a.type === 'path') features.add('paths');
    if (a.type === 'boundingbox') features.add('bounding boxes');
    if (a.type === 'point') features.add('points');
    if (a.attachment?.sequence) features.add('sequences');
  }
  for (const slot of skeleton.slots || []) {
    if (slot.blend && slot.blend !== 'normal') features.add(`blend:${slot.blend}`);
    if (slot.dark) features.add('two-color tint');
  }
  if (skeleton.ik?.length) features.add('ik constraints');
  if (skeleton.transform?.length) features.add('transform constraints');
  if (skeleton.path?.length) features.add('path constraints');
  if (skeleton.physics?.length) features.add('physics constraints');
  if (skeleton.events && Object.keys(skeleton.events).length) features.add('events');
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  if (skins.length > 1) features.add('multiple skins');
  for (const anim of Object.values(skeleton.animations || {})) {
    if (anim.drawOrder) features.add('draw order timelines');
    if (anim.events) features.add('event timelines');
    if (anim.physics) features.add('physics timelines');
  }
  return [...features];
}

/** Longest animation duration in seconds (last keyframe time found anywhere). */
export function animationDuration(anim) {
  let max = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') {
          if (typeof item.time === 'number' && item.time > max) max = item.time;
          walk(item);
        }
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') walk(value);
      }
    }
  };
  walk(anim);
  return max;
}

export function summarizeSkeleton(skeleton) {
  const animations = Object.keys(skeleton.animations || {});
  return {
    spine: skeleton.skeleton?.spine || null,
    hash: skeleton.skeleton?.hash || null,
    images: skeleton.skeleton?.images || null,
    bones: (skeleton.bones || []).length,
    slots: (skeleton.slots || []).length,
    skins: (Array.isArray(skeleton.skins) ? skeleton.skins : Object.keys(skeleton.skins || {})).length,
    animations,
    animationDurations: Object.fromEntries(
      animations.map((name) => [name, animationDuration(skeleton.animations[name])])
    ),
    features: detectFeatures(skeleton),
    regions: requiredRegions(skeleton),
  };
}

/**
 * Find animation rename targets that would receive more than one source.
 *
 * @returns {Array<{target:string,sources:string[]}>}
 */
export function validateAnimationMap(skeleton, animationMap = new Map()) {
  const sourcesByTarget = new Map();
  for (const name of Object.keys(skeleton.animations || {})) {
    const mapped = animationMap.get(name);
    const target = mapped === null || mapped === undefined ? name : mapped;
    if (!sourcesByTarget.has(target)) sourcesByTarget.set(target, []);
    sourcesByTarget.get(target).push(name);
  }
  return [...sourcesByTarget]
    .filter(([, sources]) => sources.length > 1)
    .map(([target, sources]) => ({ target, sources }));
}

/**
 * Produce a converted copy of the skeleton.
 *
 * @param {object} skeleton               parsed source skeleton JSON
 * @param {object} opts
 * @param {Map<string,string>} opts.regionMap   source region name -> shared atlas region name
 * @param {Map<string,string>} opts.sequenceBaseMap source sequence base path -> shared sequence base path
 * @param {Map<string,string>} opts.animationMap source animation name -> output name
 * @returns {{skeleton: object, changes: Array<{kind:string,from:string,to:string}>}}
 */
export function remapSkeleton(
  skeleton,
  { regionMap = new Map(), sequenceBaseMap = new Map(), animationMap = new Map() } = {}
) {
  const out = structuredClone(skeleton);
  const changes = [];

  // --- attachment region paths -------------------------------------------
  const skinList = Array.isArray(out.skins)
    ? out.skins
    : Object.entries(out.skins || {}).map(([name, attachments]) => ({ name, attachments }));

  for (const skin of skinList) {
    for (const slotAttachments of Object.values(skin.attachments || {})) {
      for (const [attachmentName, attachment] of Object.entries(slotAttachments || {})) {
        const type = attachment.type || 'region';
        if (!REGION_ATTACHMENT_TYPES.has(type)) continue;
        const current = attachmentRegionName(attachmentName, attachment);
        const isSequence = !!attachment.sequence;
        // A sequence needs a coherent base rename. Its per-frame regionMap
        // entries cannot be represented by independently changing attachment.path.
        const mapped = (isSequence ? sequenceBaseMap : regionMap).get(current);
        if (mapped !== null && mapped !== undefined && mapped !== current) {
          attachment.path = mapped;
          changes.push({ kind: isSequence ? 'sequence-region' : 'region', from: current, to: mapped });
        }
      }
    }
  }

  // --- animation names ----------------------------------------------------
  if (animationMap.size && out.animations) {
    const collisions = validateAnimationMap(out, animationMap);
    if (collisions.length) {
      const detail = collisions
        .map(({ target, sources }) => `"${target}" from ${sources.map((s) => `"${s}"`).join(', ')}`)
        .join('; ');
      const error = new Error(`Animation mappings have duplicate output names: ${detail}.`);
      error.code = 'DUPLICATE_ANIMATION_TARGET';
      error.collisions = collisions;
      throw error;
    }

    const renamed = Object.create(null);
    for (const [name, anim] of Object.entries(out.animations)) {
      const target = animationMap.get(name);
      if (target === null || target === undefined) {
        renamed[name] = anim; // not mapped: keep as-is
        continue;
      }
      if (target !== name) changes.push({ kind: 'animation', from: name, to: target });
      renamed[target] = anim;
    }
    out.animations = renamed;
  }

  // The images path is an editor hint; drop it so nothing points at the
  // animator's local folders.
  if (out.skeleton && out.skeleton.images) {
    delete out.skeleton.images;
  }

  return { skeleton: out, changes };
}

/**
 * Compatibility assessment against the target runtime.
 *
 * The Spine JSON loader (SkeletonJson) does not gate on version — unlike the
 * binary loader — but data written by a NEWER major.minor than the runtime can
 * still contain structures the runtime cannot represent. Both directions are
 * reported honestly.
 */
export function assessCompatibility({ sourceVersion, runtimeVersion, features }) {
  const src = spineMajorMinor(sourceVersion);
  const rt = spineMajorMinor(runtimeVersion);
  const result = { status: 'unknown', title: 'Manual review required', detail: '', blocking: false };

  if (!src) {
    result.status = 'unknown';
    result.title = 'Manual review required';
    result.detail = 'The skeleton JSON has no "spine" version field.';
    return result;
  }
  if (!rt) {
    result.detail = 'The target runtime version could not be determined.';
    return result;
  }

  const [srcMajor, srcMinor] = src.split('.').map(Number);
  const [rtMajor, rtMinor] = rt.split('.').map(Number);

  if (srcMajor === rtMajor && srcMinor === rtMinor) {
    result.status = 'compatible';
    result.title = 'Compatible';
    result.detail = `Source Spine ${src} matches the target runtime ${rt}.`;
  } else if (srcMajor === rtMajor && srcMinor < rtMinor) {
    result.status = 'compatible-older';
    result.title = 'Target runtime supports this version';
    result.detail =
      `Source Spine ${src} is older than the runtime ${rt}. Spine ${rtMajor}.x runtimes ` +
      `read ${src} JSON, which is why the project already ships ${src} assets.`;
  } else if (srcMajor === rtMajor && srcMinor > rtMinor) {
    result.status = 'reexport-required';
    result.title = 'Re-export from Spine ' + rt + ' required';
    result.detail =
      `Source Spine ${src} is NEWER than the runtime ${rt}. Data written by a newer editor ` +
      `can contain timelines and attachment fields this runtime cannot read. This tool will not ` +
      `fake compatibility by rewriting the version string — ask the animator to export from Spine ${rt}.`;
    result.blocking = true;
  } else {
    result.status = 'reexport-required';
    result.title = `Re-export from Spine ${rt} required`;
    result.detail = `Source Spine ${src} and runtime ${rt} are different major versions; the formats are not interchangeable.`;
    result.blocking = true;
  }

  const risky = (features || []).filter((f) => f === 'physics constraints' || f === 'physics timelines');
  if (risky.length && result.status !== 'reexport-required') {
    // Physics was introduced in Spine 4.2; a 4.1 runtime cannot represent it.
    if (rtMajor === 4 && rtMinor < 2) {
      result.status = 'unsupported-feature';
      result.title = 'Unsupported feature detected';
      result.detail = `Uses ${risky.join(', ')}, which requires a Spine 4.2+ runtime (target is ${rt}).`;
      result.blocking = true;
    }
  }
  return result;
}
