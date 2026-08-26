// libgdx / Spine `.atlas` text format: parser and serializer.
//
// Supports both dialects the Spine runtime accepts:
//   old:  xy: 1,2 / size: 3,4 / offset: 0,0 / orig: 10,10 / rotate: false
//   new:  bounds:1,2,3,4 / offsets:0,0,10,10 / rotate:90
//
// Region geometry (verified against spine-core RegionAttachment.updateRegion):
//   `bounds` w/h are the region's UNROTATED logical size. When `rotate:90` the
//   footprint occupying the page is (h x w) and the stored pixels are the
//   logical image rotated 90° counter-clockwise, so the logical image is
//   recovered with:  logical(Lx, Ly) = page(x + Ly, y + w - 1 - Lx)

/** @returns {{pages: Array}} pages: {name, size:{w,h}, fields:Map, regions:[]} */
export function parseSpineAtlas(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const pages = [];
  let page = null;
  let region = null;
  let i = 0;

  const isEntry = (line) => line.includes(':');
  const entryOf = (line) => {
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const values = line
      .slice(idx + 1)
      .split(',')
      .map((v) => v.trim());
    return { key, values };
  };

  // Skip leading blank lines (and any pre-page header entries, which the
  // runtime silently ignores).
  while (i < lines.length && lines[i].trim() === '') i++;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    i++;

    if (line === '') {
      page = null;
      region = null;
      continue;
    }

    if (!isEntry(line)) {
      // A non-entry line starts either a page (when no page is open) or a region.
      if (!page) {
        page = {
          name: line,
          size: { w: 0, h: 0 },
          // Spine 4.2 defaults both filters to Nearest when the field is absent.
          filter: 'Nearest,Nearest',
          pma: false,
          extra: [], // unrecognized page fields, preserved verbatim
          regions: [],
        };
        pages.push(page);
        region = null;
      } else {
        region = {
          name: line,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          offsetX: 0,
          offsetY: 0,
          origW: 0,
          origH: 0,
          rotate: 0,
          index: -1,
          extra: [],
        };
        page.regions.push(region);
      }
      continue;
    }

    const { key, values } = entryOf(line);
    const num = (n) => parseInt(values[n], 10) || 0;

    if (page && !region) {
      // Page-level fields.
      switch (key) {
        case 'size':
          page.size = { w: num(0), h: num(1) };
          break;
        case 'filter':
          page.filter = values.join(',');
          break;
        case 'pma':
          page.pma = values[0] === 'true';
          break;
        case 'format':
          page.format = values[0];
          break;
        case 'repeat':
          page.repeat = values[0];
          break;
        case 'scale':
          // Packer metadata: the Spine runtime does NOT read this field
          // (pageFields has no "scale"), so it never affects rendering.
          page.scale = parseFloat(values[0]);
          break;
        default:
          page.extra.push(line);
      }
      continue;
    }

    if (region) {
      switch (key) {
        case 'bounds':
          region.x = num(0);
          region.y = num(1);
          region.w = num(2);
          region.h = num(3);
          break;
        case 'xy':
          region.x = num(0);
          region.y = num(1);
          break;
        case 'size':
          region.w = num(0);
          region.h = num(1);
          break;
        case 'offsets':
          region.offsetX = num(0);
          region.offsetY = num(1);
          region.origW = num(2);
          region.origH = num(3);
          break;
        case 'offset':
          region.offsetX = num(0);
          region.offsetY = num(1);
          break;
        case 'orig':
          region.origW = num(0);
          region.origH = num(1);
          break;
        case 'rotate': {
          const v = values[0];
          if (v === 'true') region.rotate = 90;
          else if (v === 'false') region.rotate = 0;
          else region.rotate = parseInt(v, 10) || 0;
          break;
        }
        case 'index':
          region.index = num(0);
          break;
        default:
          region.extra.push(line);
      }
    }
  }

  // Regions with no explicit orig default to their own size.
  for (const p of pages) {
    for (const r of p.regions) {
      if (!r.origW) r.origW = r.w;
      if (!r.origH) r.origH = r.h;
    }
  }
  return { pages };
}

/**
 * Serialize to the modern Spine atlas dialect (bounds/offsets), matching the
 * format the reference project's own .atlas files use.
 */
export function serializeSpineAtlas(pages) {
  const out = [];
  for (const page of pages) {
    out.push(page.name);
    out.push(`size:${page.size.w},${page.size.h}`);
    out.push(`filter:${page.filter || 'Nearest,Nearest'}`);
    if (page.repeat) out.push(`repeat:${page.repeat}`);
    if (page.pma) out.push('pma:true');
    for (const line of page.extra || []) out.push(line);
    for (const r of page.regions) {
      out.push(r.name);
      out.push(`bounds:${r.x},${r.y},${r.w},${r.h}`);
      const trimmed = r.offsetX !== 0 || r.offsetY !== 0 || r.origW !== r.w || r.origH !== r.h;
      if (trimmed) out.push(`offsets:${r.offsetX},${r.offsetY},${r.origW},${r.origH}`);
      if (r.rotate) out.push(`rotate:${r.rotate}`);
      if (r.index >= 0) out.push(`index:${r.index}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Footprint (pixels actually occupied on the page) for a region. */
export function regionFootprint(region) {
  return region.rotate === 90 || region.rotate === 270
    ? { w: region.h, h: region.w }
    : { w: region.w, h: region.h };
}

/**
 * Copy a region out of a decoded page into a freshly allocated RGBA buffer of
 * the region's logical size, undoing any packing rotation.
 *
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} page
 * @param {object} region parsed atlas region
 * @returns {{data:Uint8ClampedArray,width:number,height:number}}
 */
export function extractRegionPixels(page, region) {
  const w = region.w;
  const h = region.h;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = page.data;
  const pw = page.width;
  const ph = page.height;

  const readInto = (dstIdx, tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= pw || ty >= ph) return; // stays transparent
    const s = (ty * pw + tx) * 4;
    out[dstIdx] = src[s];
    out[dstIdx + 1] = src[s + 1];
    out[dstIdx + 2] = src[s + 2];
    out[dstIdx + 3] = src[s + 3];
  };

  if (region.rotate === 90) {
    // logical(Lx, Ly) = page(x + Ly, y + w - 1 - Lx)
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        readInto((ly * w + lx) * 4, region.x + ly, region.y + w - 1 - lx);
      }
    }
  } else if (region.rotate === 270) {
    // Inverse of the 90° case.
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        readInto((ly * w + lx) * 4, region.x + h - 1 - ly, region.y + lx);
      }
    }
  } else if (region.rotate === 180) {
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        readInto((ly * w + lx) * 4, region.x + w - 1 - lx, region.y + h - 1 - ly);
      }
    }
  } else {
    for (let ly = 0; ly < h; ly++) {
      const srcRow = (region.y + ly) * pw;
      const dstRow = ly * w;
      for (let lx = 0; lx < w; lx++) {
        const s = (srcRow + region.x + lx) * 4;
        const d = (dstRow + lx) * 4;
        if (region.x + lx >= pw || region.y + ly >= ph) continue;
        out[d] = src[s];
        out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2];
        out[d + 3] = src[s + 3];
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Enforce the premultiplied-alpha invariant on a region's pixels, in place.
 *
 * A correct premultiplied export always satisfies `rgb <= alpha`, and stores
 * rgb = 0 wherever alpha = 0. Lossy codecs break both: they cannot see colour
 * underneath transparency, so they smear RGB into transparent areas. That is
 * invisible under straight-alpha blending, but a premultiplied page is blended
 * as `dst = src.rgb + dst.rgb * (1 - src.a)` — the smeared colour is added
 * straight to the screen, drawing a visible rectangle around the whole region
 * quad. Measured on the sample page, that lifts the background by up to 163/255.
 *
 * Only call this for a page that declares `pma:true`. On a straight-alpha page
 * the same operation would strip the colour bilinear filtering blends towards
 * at region edges, trading the boxes for dark halos.
 *
 * @returns {number} how many colour channels were reduced
 */
export function enforcePremultipliedAlpha(img) {
  const data = img.data;
  let corrected = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    for (let c = 0; c < 3; c++) {
      if (data[i + c] > alpha) {
        data[i + c] = alpha;
        corrected++;
      }
    }
  }
  return corrected;
}

/**
 * Convert premultiplied pixels to straight alpha, in place.
 *
 * Storing premultiplied pixels in WebP is hostile to the codec: colour beneath
 * a transparent pixel is added straight to the screen, so libwebp's habit of
 * rewriting those bytes corrupts the image, and avoiding it costs both the lossy
 * modes and every effort level above 0. Straight alpha removes the whole class
 * of problem, because the runtime multiplies RGB by alpha at upload — anything
 * the codec does under a zero alpha is multiplied away.
 *
 * The conversion is exact in the rendered domain. `round(round(p*255/a)*a/255)`
 * returns `p`, so a lossless straight-alpha texture premultiplies back to the
 * bytes we started with. That only holds once `rgb <= alpha` is true, so this
 * must run after {@link enforcePremultipliedAlpha}; otherwise the division
 * overflows and colour is clipped.
 *
 * Emit the page without a `pma:true` line so the loader premultiplies on upload
 * (spine-pixi-v8 selects `premultiply-alpha-on-upload` when `page.pma` is false).
 *
 * @returns {number} how many pixels carried colour that was rescaled
 */
export function unpremultiplyAlpha(img) {
  const data = img.data;
  let rescaled = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) {
      // Nothing recoverable here, and zero is what compresses best.
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    if (alpha === 255) continue;
    let touched = false;
    for (let c = 0; c < 3; c++) {
      const value = data[i + c];
      if (value === 0) continue;
      data[i + c] = Math.min(255, Math.round((value * 255) / alpha));
      touched = true;
    }
    if (touched) rescaled++;
  }
  return rescaled;
}

/** Blit an unrotated RGBA image into a destination RGBA buffer. */
export function blitRegion(dst, dstW, dstH, img, dx, dy) {
  for (let y = 0; y < img.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dstH) continue;
    let s = y * img.width * 4;
    let d = (ty * dstW + dx) * 4;
    for (let x = 0; x < img.width; x++, s += 4, d += 4) {
      const tx = dx + x;
      if (tx < 0 || tx >= dstW) continue;
      dst[d] = img.data[s];
      dst[d + 1] = img.data[s + 1];
      dst[d + 2] = img.data[s + 2];
      dst[d + 3] = img.data[s + 3];
    }
  }
}

/**
 * Compare two same-size RGBA buffers.
 * `maxOpaque` ignores channels where the pixel is nearly transparent, because
 * RGB under a near-zero alpha is invisible (and is exactly where lossy codecs
 * put their largest errors).
 */
export function compareImages(a, b, alphaFloor = 200) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let max = 0;
  let maxOpaque = 0;
  let sum = 0;
  const n = a.data.length;
  for (let i = 0; i < n; i += 4) {
    const visible = a.data[i + 3] >= alphaFloor && b.data[i + 3] >= alphaFloor;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      if (d > max) max = d;
      if (visible && d > maxOpaque) maxOpaque = d;
    }
  }
  return { max, maxOpaque, mean: sum / n };
}

/** FNV-1a hash of an RGBA buffer — used to detect identical regions. */
export function hashPixels(img) {
  let h = 0x811c9dc5;
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${img.width}x${img.height}:${(h >>> 0).toString(16)}`;
}
