// Atlas import/export: TexturePacker JSON (hash) parsing, sprite extraction
// (with un-rotation of 90°-rotated frames), trim detection, atlas image
// composition (with rotation + edge extrusion) and JSON serialization that
// mirrors the reference file's structure.

/** Parse a TexturePacker JSON atlas (hash or array flavour). */
export function parseAtlasJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !data.frames) {
    throw new Error('Unsupported atlas JSON: missing "frames" section.');
  }

  const frames = [];
  const push = (name, f) => {
    if (!f || !f.frame) throw new Error(`Sprite "${name}" has no "frame" rect.`);
    const frame = {
      x: f.frame.x | 0,
      y: f.frame.y | 0,
      w: f.frame.w | 0,
      h: f.frame.h | 0,
    };
    const sss = f.spriteSourceSize || { x: 0, y: 0, w: frame.w, h: frame.h };
    const src = f.sourceSize || { w: sss.x + frame.w, h: sss.y + frame.h };
    frames.push({
      name,
      frame,
      rotated: !!f.rotated,
      trimmed: !!f.trimmed,
      offsetX: sss.x | 0,
      offsetY: sss.y | 0,
      sourceW: src.w | 0,
      sourceH: src.h | 0,
    });
  };

  if (Array.isArray(data.frames)) {
    for (const f of data.frames) push(f.filename ?? f.name ?? `sprite_${frames.length}`, f);
  } else {
    for (const [name, f] of Object.entries(data.frames)) push(name, f);
  }
  if (!frames.length) throw new Error('Atlas JSON contains no sprites.');

  return { frames, meta: data.meta || {} };
}

/**
 * Extract each sprite from the atlas image into its own working canvas,
 * reconstructing the full (untrimmed) source image. Rotated frames are stored
 * 90° clockwise in the atlas, so we rotate them back counter-clockwise.
 */
export function extractSprites(atlasImage, frames) {
  const out = [];
  for (const f of frames) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, f.sourceW || f.frame.w + f.offsetX);
    canvas.height = Math.max(1, f.sourceH || f.frame.h + f.offsetY);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    if (f.rotated) {
      // Region in the atlas occupies frame.h wide × frame.w tall.
      ctx.save();
      ctx.translate(f.offsetX, f.offsetY + f.frame.h);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(atlasImage, f.frame.x, f.frame.y, f.frame.h, f.frame.w, 0, 0, f.frame.h, f.frame.w);
      ctx.restore();
    } else {
      ctx.drawImage(
        atlasImage,
        f.frame.x, f.frame.y, f.frame.w, f.frame.h,
        f.offsetX, f.offsetY, f.frame.w, f.frame.h
      );
    }
    out.push({ name: f.name, canvas });
  }
  return out;
}

/** Find the bounding box of non-transparent pixels. */
export function computeTrim(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w * 4 + 3;
    for (let x = 0; x < w; x++) {
      if (data[rowOff + x * 4] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // Fully transparent image: keep a 1×1 stub so the sprite survives packing.
    return { x: 0, y: 0, w: 1, h: 1, trimmed: w > 1 || h > 1 };
  }
  const t = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  t.trimmed = t.x !== 0 || t.y !== 0 || t.w !== w || t.h !== h;
  return t;
}

/**
 * Compose the atlas image from placed sprites.
 * @param {Array} placed - entries of {sprite, x, y, rotated} where x/y is the
 *   top-left of the sprite's pixel region (excluding extrusion) in the atlas.
 */
export function buildAtlas(placed, width, height, settings) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const e = settings.extrude | 0;

  for (const p of placed) {
    const { sprite, trim } = p;
    const src = sprite.source;
    const tw = trim.w;
    const th = trim.h;
    ctx.save();
    if (p.rotated) {
      // Rotate 90° clockwise: the region occupies th wide × tw tall at (x, y).
      ctx.translate(p.x + th, p.y);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(p.x, p.y);
    }
    // Main sprite pixels (local space: 0,0 → tw,th).
    ctx.drawImage(src, trim.x, trim.y, tw, th, 0, 0, tw, th);
    if (e > 0) {
      // Edge extrusion: repeat the border pixels outward to prevent bleeding.
      ctx.drawImage(src, trim.x, trim.y, tw, 1, 0, -e, tw, e); // top
      ctx.drawImage(src, trim.x, trim.y + th - 1, tw, 1, 0, th, tw, e); // bottom
      ctx.drawImage(src, trim.x, trim.y, 1, th, -e, 0, e, th); // left
      ctx.drawImage(src, trim.x + tw - 1, trim.y, 1, th, tw, 0, e, th); // right
      ctx.drawImage(src, trim.x, trim.y, 1, 1, -e, -e, e, e); // corners
      ctx.drawImage(src, trim.x + tw - 1, trim.y, 1, 1, tw, -e, e, e);
      ctx.drawImage(src, trim.x, trim.y + th - 1, 1, 1, -e, th, e, e);
      ctx.drawImage(src, trim.x + tw - 1, trim.y + th - 1, 1, 1, tw, th, e, e);
    }
    ctx.restore();
  }
  return canvas;
}

const frameNum = (n) => String(n);

/**
 * Serialize the packed atlas to JSON matching the reference format
 * (TexturePacker JSON hash, same field order and layout).
 */
export function serializeAtlasJSON({ placed, width, height, pngName, scale }) {
  const entries = [...placed].sort((a, b) =>
    a.sprite.name.toLowerCase().localeCompare(b.sprite.name.toLowerCase())
  );
  const parts = [];
  for (const p of entries) {
    const s = p.sprite;
    const t = p.trim;
    const trimmed = t.trimmed;
    parts.push(
      `"${s.name}":\n` +
        `{\n` +
        `\t"frame": {"x":${frameNum(p.x)},"y":${frameNum(p.y)},"w":${frameNum(t.w)},"h":${frameNum(t.h)}},\n` +
        `\t"rotated": ${p.rotated},\n` +
        `\t"trimmed": ${trimmed},\n` +
        `\t"spriteSourceSize": {"x":${frameNum(t.x)},"y":${frameNum(t.y)},"w":${frameNum(t.w)},"h":${frameNum(t.h)}},\n` +
        `\t"sourceSize": {"w":${frameNum(s.sw)},"h":${frameNum(s.sh)}}\n` +
        `}`
    );
  }
  return (
    `{"frames": {\n\n` +
    parts.join(',\n') +
    `},\n` +
    `"meta": {\n` +
    `\t"app": "Exporter",\n` +
    `\t"version": "1.0",\n` +
    `\t"image": "${pngName}",\n` +
    `\t"format": "RGBA8888",\n` +
    `\t"size": {"w":${width},"h":${height}},\n` +
    `\t"scale": "${scale || '1'}"\n` +
    `}\n` +
    `}\n`
  );
}
