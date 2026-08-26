// Loads and renders converted animations with the SAME Spine core the Stake
// Engine Web SDK uses (@esotericsoftware/spine-core, the core that
// spine-pixi-v8 wraps). Generating files is not proof the runtime can read
// them — this module actually parses them and plays the timelines.
//
// Rendering is Canvas2D: region attachments are drawn as transformed quads,
// mesh attachments as per-triangle affine blits. That is enough to confirm
// attachments resolve, alignment is preserved and timelines run.

import * as spine from '../../../node_modules/@esotericsoftware/spine-core/dist/index.js';

/** Minimal Texture implementation backed by a canvas/ImageBitmap. */
class CanvasTexture extends spine.Texture {
  setFilters() {}
  setWraps() {}
  dispose() {}
}

/**
 * Parse atlas text + skeleton JSON with the real runtime.
 * @returns {{ok:boolean, skeletonData?:object, atlas?:object, error?:string, missing?:string[]}}
 */
export function loadWithRuntime({ atlasText, skeletonJson, image, images, scale = 1 }) {
  let atlas;
  try {
    atlas = new spine.TextureAtlas(atlasText);
  } catch (e) {
    return { ok: false, stage: 'atlas', error: `TextureAtlas parse failed: ${e.message}` };
  }

  // Each atlas page gets its own texture. `images` may be a map keyed by page
  // name or an array in page order; `image` is the single-page shorthand.
  const textureFor = (page, index) => {
    if (images) {
      const found = Array.isArray(images) ? images[index] : images.get?.(page.name) ?? images[page.name];
      if (found) return found;
      return null;
    }
    return image ?? null;
  };

  const missingPages = [];
  atlas.pages.forEach((page, index) => {
    const texture = textureFor(page, index);
    if (!texture) {
      missingPages.push(page.name);
      return;
    }
    page.setTexture(new CanvasTexture(texture));
  });
  if (missingPages.length) {
    return {
      ok: false,
      stage: 'atlas',
      error: `No texture supplied for atlas page(s): ${missingPages.join(', ')}`,
      missingPages,
    };
  }

  // Regions whose page texture is missing would fail later; check up front.
  const missing = [];
  let skeletonData;
  try {
    const loader = new spine.AtlasAttachmentLoader(atlas);
    const json = new spine.SkeletonJson(loader);
    json.scale = scale;
    skeletonData = json.readSkeletonData(
      typeof skeletonJson === 'string' ? JSON.parse(skeletonJson) : skeletonJson
    );
  } catch (e) {
    // The runtime throws a descriptive error when an attachment region is absent.
    const m = /Region not found[^:]*:\s*(.+)/i.exec(e.message || '');
    if (m) missing.push(m[1].trim());
    return { ok: false, stage: 'skeleton', error: e.message, missing };
  }

  return {
    ok: true,
    atlas,
    skeletonData,
    animations: skeletonData.animations.map((a) => a.name),
    pageCount: atlas.pages.length,
  };
}

/** Drives one skeleton: applies an animation at a time and draws to a canvas. */
export class SpinePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.skeleton = null;
    this.state = null;
    this.image = null;
    this.time = 0;
    this.playing = false;
    this._raf = null;
    this._last = 0;
    this.fit = { scale: 1, x: 0, y: 0 };
    this.onFrame = null;
  }

  setSkeleton({ skeletonData, image }) {
    this.skeleton = new spine.Skeleton(skeletonData);
    this.state = new spine.AnimationState(new spine.AnimationStateData(skeletonData));
    // Textures come from each region's own atlas page; this is only a fallback.
    this.image = image ?? null;
    this.skeleton.setToSetupPose();
    this.skeleton.updateWorldTransform(spine.Physics.update);
    this.autoFit();
  }

  /** The backing canvas/bitmap of the page a region lives on. */
  _imageFor(region) {
    const texture = region?.page?.texture ?? region?.texture;
    return texture?.getImage?.() ?? this.image;
  }

  play(animationName, loop = true) {
    if (!this.state) return;
    this.state.setAnimation(0, animationName, loop);
    this.time = 0;
    this.start();
  }

  setToSetupPose() {
    if (!this.skeleton) return;
    this.state?.clearTracks();
    this.skeleton.setToSetupPose();
    this.skeleton.updateWorldTransform(spine.Physics.update);
    this.draw();
  }

  start() {
    if (this._raf) return;
    this.playing = true;
    this._last = performance.now();
    const tick = (now) => {
      const delta = Math.min((now - this._last) / 1000, 0.05);
      this._last = now;
      this.time += delta;
      if (this.state) {
        this.state.update(delta);
        this.state.apply(this.skeleton);
        this.skeleton.update(delta);
        this.skeleton.updateWorldTransform(spine.Physics.update);
      }
      this.draw();
      this.onFrame?.(this.time);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.playing = false;
  }

  _applyVisibleSequences() {
    if (!this.skeleton) return;
    for (const slot of this.skeleton.drawOrder) {
      const attachment = slot.getAttachment();
      if (attachment?.sequence) attachment.sequence.apply(slot, attachment);
    }
  }

  /** Fit the skeleton's setup-pose bounds into the canvas. */
  autoFit() {
    if (!this.skeleton) return;
    this._applyVisibleSequences();
    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    this.skeleton.getBounds(offset, size, []);
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (size.x <= 0 || size.y <= 0) {
      this.fit = { scale: 1, x: w / 2, y: h / 2 };
      return;
    }
    const scale = Math.min((w * 0.8) / size.x, (h * 0.8) / size.y);
    this.fit = {
      scale,
      x: w / 2 - (offset.x + size.x / 2) * scale,
      y: h / 2 + (offset.y + size.y / 2) * scale,
    };
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.skeleton) return;

    // Spine is y-up; canvas is y-down.
    const { scale, x: ox, y: oy } = this.fit;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, -scale);

    const drawOrder = this.skeleton.drawOrder;
    for (const slot of drawOrder) {
      const attachment = slot.getAttachment();
      if (!attachment) continue;
      const alpha = this.skeleton.color.a * slot.color.a * (attachment.color?.a ?? 1);
      if (alpha <= 0.001) continue;
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation =
        slot.data.blendMode === spine.BlendMode.Additive ? 'lighter' : 'source-over';

      if (attachment instanceof spine.RegionAttachment) {
        this._drawRegion(ctx, slot, attachment);
      } else if (attachment instanceof spine.MeshAttachment) {
        this._drawMesh(ctx, slot, attachment);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _regionRect(region) {
    // Pixel rect of the region on the page, accounting for pack rotation.
    const rotated = region.degrees === 90;
    return {
      sx: region.x,
      sy: region.y,
      sw: rotated ? region.height : region.width,
      sh: rotated ? region.width : region.height,
      rotated,
    };
  }

  _drawRegion(ctx, slot, attachment) {
    // Sequence attachments choose their atlas region lazily.
    if (attachment.sequence) attachment.sequence.apply(slot, attachment);
    const region = attachment.region;
    if (!region) return;
    const verts = new Float32Array(8);
    attachment.computeWorldVertices(slot, verts, 0, 2);
    // verts: BL, TL, TR, BR (see RegionAttachment.updateRegion)
    this._drawQuad(ctx, verts, region);
  }

  /** Draw the region image mapped onto the (possibly skewed) quad. */
  _drawQuad(ctx, v, region) {
    const image = this._imageFor(region);
    if (!image) return;
    const { sx, sy, sw, sh, rotated } = this._regionRect(region);
    // Use BL, TL, TR to derive the affine transform (ignores perspective skew
    // of the 4th point, which Spine quads do not produce anyway).
    const [blx, bly, tlx, tly, trx, try_] = v;
    // u axis: TL -> TR ; v axis: TL -> BL
    const ux = (trx - tlx) / sw;
    const uy = (try_ - tly) / sw;
    const vx = (blx - tlx) / sh;
    const vy = (bly - tly) / sh;

    ctx.save();
    ctx.transform(ux, uy, vx, vy, tlx, tly);
    if (rotated) {
      // The stored pixels are the logical image rotated 90° CCW.
      ctx.translate(0, sh);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    ctx.restore();
  }

  _drawMesh(ctx, slot, attachment) {
    // Applying the sequence also refreshes the mesh UVs for this frame.
    if (attachment.sequence) attachment.sequence.apply(slot, attachment);
    const region = attachment.region;
    if (!region) return;
    const image = this._imageFor(region);
    if (!image) return;
    const count = attachment.worldVerticesLength;
    const verts = new Float32Array(count);
    attachment.computeWorldVertices(slot, 0, count, verts, 0, 2);
    const uvs = attachment.uvs;
    const triangles = attachment.triangles;
    // UVs are normalized against the page this region lives on.
    const pageW = image.width;
    const pageH = image.height;

    for (let i = 0; i < triangles.length; i += 3) {
      const i0 = triangles[i] * 2;
      const i1 = triangles[i + 1] * 2;
      const i2 = triangles[i + 2] * 2;
      const x0 = verts[i0];
      const y0 = verts[i0 + 1];
      const x1 = verts[i1];
      const y1 = verts[i1 + 1];
      const x2 = verts[i2];
      const y2 = verts[i2 + 1];
      const u0 = uvs[i0] * pageW;
      const w0 = uvs[i0 + 1] * pageH;
      const u1 = uvs[i1] * pageW;
      const w1 = uvs[i1 + 1] * pageH;
      const u2 = uvs[i2] * pageW;
      const w2 = uvs[i2 + 1] * pageH;

      const det = (u1 - u0) * (w2 - w0) - (u2 - u0) * (w1 - w0);
      if (Math.abs(det) < 1e-6) continue;
      const a = ((x1 - x0) * (w2 - w0) - (x2 - x0) * (w1 - w0)) / det;
      const b = ((y1 - y0) * (w2 - w0) - (y2 - y0) * (w1 - w0)) / det;
      const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
      const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      ctx.clip();
      ctx.transform(a, b, c, d, x0 - a * u0 - c * w0, y0 - b * u0 - d * w0);
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    }
  }
}

/**
 * Headless verification: load with the runtime, then step every animation to
 * make sure timelines apply without throwing and attachments stay resolvable.
 */
export function verifyConverted({ atlasText, skeletonJson, image, images, scale = 1, steps = 12 }) {
  const load = loadWithRuntime({ atlasText, skeletonJson, image, images, scale });
  if (!load.ok) return { ok: false, ...load };

  const skeleton = new spine.Skeleton(load.skeletonData);
  const state = new spine.AnimationState(new spine.AnimationStateData(load.skeletonData));
  const results = [];

  // Attachments that resolve to no texture would load "successfully" and then
  // render nothing, so they are counted rather than assumed fine.
  const unresolved = new Set();
  const pagesTouched = new Set();
  const inspectAttachments = () => {
    let drawable = 0;
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.getAttachment();
      if (!attachment) continue;
      const isTextured =
        attachment instanceof spine.RegionAttachment || attachment instanceof spine.MeshAttachment;
      if (!isTextured) continue;

      // A sequence's current region starts null. Check every frame, then apply
      // the setup/timeline-selected frame before deciding if it is drawable.
      const sequence = attachment.sequence;
      if (sequence) {
        let framesResolved = sequence.regions.length > 0;
        for (const frameRegion of sequence.regions) {
          if (frameRegion?.page?.name) pagesTouched.add(frameRegion.page.name);
          if (!frameRegion || !(frameRegion.page?.texture ?? frameRegion.texture)) {
            framesResolved = false;
          }
        }
        if (!framesResolved) {
          unresolved.add(attachment.name || slot.data.name);
          continue;
        }
        sequence.apply(slot, attachment);
      }

      const region = attachment.region;
      if (!region || !(region.page?.texture ?? region.texture)) {
        unresolved.add(attachment.name || slot.data.name);
        continue;
      }
      if (region.page?.name) pagesTouched.add(region.page.name);
      drawable++;
    }
    return drawable;
  };

  for (const animation of load.skeletonData.animations) {
    try {
      skeleton.setToSetupPose();
      state.clearTracks();
      state.setAnimation(0, animation.name, false);
      const duration = animation.duration || 0;
      const step = steps > 1 ? Math.max(duration / (steps - 1), 1 / 60) : 1 / 60;
      let visibleAttachments = 0;
      for (let i = 0; i < steps; i++) {
        state.update(i === 0 ? 0 : step);
        state.apply(skeleton);
        skeleton.update(i === 0 ? 0 : step);
        skeleton.updateWorldTransform(spine.Physics.update);
        visibleAttachments = Math.max(visibleAttachments, inspectAttachments());
      }
      results.push({
        animation: animation.name,
        duration,
        ok: true,
        visibleAttachments,
        empty: visibleAttachments === 0,
      });
    } catch (e) {
      results.push({ animation: animation.name, ok: false, error: e.message });
    }
  }

  // Setup-pose bounds prove attachments actually resolved to real geometry.
  const offset = new spine.Vector2();
  const size = new spine.Vector2();
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform(spine.Physics.update);
  // Sequence attachments choose their setup frame lazily. Resolve that frame
  // before asking the runtime for bounds, otherwise a valid sequence-only
  // skeleton can incorrectly report an empty setup pose.
  const setupDrawable = inspectAttachments();
  skeleton.getBounds(offset, size, []);

  const problems = [];
  if (unresolved.size) {
    problems.push(`${unresolved.size} attachment(s) resolve to no texture: ${[...unresolved].slice(0, 5).join(', ')}`);
  }
  const emptyAnimations = results.filter((r) => r.ok && r.empty).map((r) => r.animation);
  if (emptyAnimations.length === results.length && results.length) {
    problems.push('no animation shows any drawable attachment');
  }
  const anyAnimationDrawable = results.some(
    (result) => result.ok && result.visibleAttachments > 0
  );
  if (
    !(size.x > 0 && size.y > 0) &&
    (setupDrawable > 0 || !anyAnimationDrawable)
  ) {
    problems.push('setup pose has zero bounds');
  }

  return {
    ok: results.every((r) => r.ok) && problems.length === 0,
    animations: results,
    bounds: { x: offset.x, y: offset.y, width: size.x, height: size.y },
    pagesUsed: [...pagesTouched],
    pageCount: load.pageCount,
    unresolvedAttachments: [...unresolved],
    emptyAnimations,
    setupDrawable,
    problems,
    error: problems.length ? problems.join('; ') : undefined,
    runtimeVersion: '4.2.74',
  };
}

export { spine };
