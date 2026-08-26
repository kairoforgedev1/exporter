// MaxRects bin packing (Best Short Side Fit) with optional 90° rotation,
// automatic atlas sizing, power-of-two / square constraints and tight shrink.

import { nextPowerOfTwo } from './util.js';

class MaxRectsBin {
  constructor(w, h) {
    this.free = [{ x: 0, y: 0, w, h }];
  }

  insert(w, h, allowRotation) {
    let best = null;
    for (const r of this.free) {
      if (r.w >= w && r.h >= h) {
        const dw = r.w - w;
        const dh = r.h - h;
        const short = Math.min(dw, dh);
        const long = Math.max(dw, dh);
        if (!best || short < best.short || (short === best.short && long < best.long)) {
          best = { x: r.x, y: r.y, pw: w, ph: h, rotated: false, short, long };
        }
      }
      if (allowRotation && w !== h && r.w >= h && r.h >= w) {
        const dw = r.w - h;
        const dh = r.h - w;
        const short = Math.min(dw, dh);
        const long = Math.max(dw, dh);
        if (!best || short < best.short || (short === best.short && long < best.long)) {
          best = { x: r.x, y: r.y, pw: h, ph: w, rotated: true, short, long };
        }
      }
    }
    if (!best) return null;

    const node = { x: best.x, y: best.y, w: best.pw, h: best.ph };
    const next = [];
    for (const r of this.free) {
      if (node.x >= r.x + r.w || node.x + node.w <= r.x || node.y >= r.y + r.h || node.y + node.h <= r.y) {
        next.push(r);
        continue;
      }
      // Split the intersecting free rect into up to four maximal rects.
      if (node.x > r.x) next.push({ x: r.x, y: r.y, w: node.x - r.x, h: r.h });
      if (node.x + node.w < r.x + r.w) {
        next.push({ x: node.x + node.w, y: r.y, w: r.x + r.w - (node.x + node.w), h: r.h });
      }
      if (node.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: node.y - r.y });
      if (node.y + node.h < r.y + r.h) {
        next.push({ x: r.x, y: node.y + node.h, w: r.w, h: r.y + r.h - (node.y + node.h) });
      }
    }
    this.free = pruneFreeList(next);
    return { x: best.x, y: best.y, rotated: best.rotated };
  }
}

function pruneFreeList(rects) {
  const out = [];
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const b = rects[j];
      if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
        // Identical rects: keep only the first occurrence.
        if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && i < j) continue;
        contained = true;
        break;
      }
    }
    if (!contained) out.push(a);
  }
  return out;
}

const SORTS = [
  (a, b) => b.w * b.h - a.w * a.h || b.id - a.id,
  (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.id - a.id,
  (a, b) => b.h - a.h || b.w - a.w || b.id - a.id,
  (a, b) => b.w - a.w || b.h - a.h || b.id - a.id,
];

function attempt(items, binW, binH, padding, border, allowRotation) {
  // The bin is reduced by the border once; each item is inflated by `padding`
  // on the right/bottom, and the inner area gets that padding back so the last
  // row/column doesn't pay for trailing padding.
  const innerW = binW - border * 2 + padding;
  const innerH = binH - border * 2 + padding;
  if (innerW <= 0 || innerH <= 0) return { placed: [], failed: items.slice() };

  const bin = new MaxRectsBin(innerW, innerH);
  const placed = [];
  const failed = [];
  for (const it of items) {
    const pos = bin.insert(it.w + padding, it.h + padding, allowRotation);
    if (pos) {
      placed.push({ id: it.id, x: pos.x + border, y: pos.y + border, rotated: pos.rotated, w: it.w, h: it.h });
    } else {
      failed.push(it);
    }
  }
  return { placed, failed };
}

function shrink(placed, border, settings) {
  let maxX = 0;
  let maxY = 0;
  for (const p of placed) {
    maxX = Math.max(maxX, p.x + (p.rotated ? p.h : p.w));
    maxY = Math.max(maxY, p.y + (p.rotated ? p.w : p.h));
  }
  let w = Math.max(1, maxX + border);
  let h = Math.max(1, maxY + border);
  if (settings.powerOfTwo) {
    w = nextPowerOfTwo(w);
    h = nextPowerOfTwo(h);
  }
  if (settings.square) {
    w = h = Math.max(w, h);
  }
  // Candidate sizes are already normalized to the POT/square constraints, so
  // rounding the tight bounds back up can never exceed the bin we packed into.
  return { w, h };
}

/**
 * Pack items into an automatically sized atlas.
 * @param {Array<{id:number,w:number,h:number}>} items - full occupied size per
 *   sprite (trimmed size + 2 * extrude), excluding padding.
 * @param {object} settings - {padding, border, maxWidth, maxHeight,
 *   powerOfTwo, square, allowRotation}
 * @returns {{width:number,height:number,placed:Array,failedIds:Array,ok:boolean}}
 */
export function pack(items, settings) {
  const { padding, border, allowRotation } = settings;
  const floorPowerOfTwo = (value) => 2 ** Math.floor(Math.log2(Math.max(1, value)));
  let maxW = Math.max(16, settings.maxWidth | 0);
  let maxH = Math.max(16, settings.maxHeight | 0);
  // A POT or square output must satisfy the configured maxima as well as the
  // shape constraint. Use the largest valid constrained bin at or below each
  // maximum instead of packing into a non-POT max and rounding beyond it.
  if (settings.powerOfTwo) {
    maxW = floorPowerOfTwo(maxW);
    maxH = floorPowerOfTwo(maxH);
  }
  if (settings.square) {
    maxW = maxH = Math.min(maxW, maxH);
  }

  if (!items.length) {
    return { width: 0, height: 0, placed: [], failedIds: [], ok: true };
  }

  // Lower bounds for the atlas size.
  let minW = 0;
  let minH = 0;
  let area = 0;
  for (const it of items) {
    const wNeed = allowRotation ? Math.min(it.w, it.h) : it.w;
    const hNeed = allowRotation ? Math.min(it.w, it.h) : it.h;
    minW = Math.max(minW, wNeed + padding);
    minH = Math.max(minH, hNeed + padding);
    area += (it.w + padding) * (it.h + padding);
  }

  const normalize = (w, h) => {
    if (settings.powerOfTwo) {
      w = nextPowerOfTwo(w);
      h = nextPowerOfTwo(h);
    }
    if (settings.square) w = h = Math.max(w, h);
    return [Math.min(w, maxW), Math.min(h, maxH)];
  };

  const candidateSizes = () => {
    const sizes = [];
    const seen = new Set();
    const push = (w, h) => {
      [w, h] = normalize(Math.ceil(w), Math.ceil(h));
      const key = `${w}x${h}`;
      if (!seen.has(key)) {
        seen.add(key);
        sizes.push([w, h]);
      }
    };
    const base = Math.sqrt(area) * 1.02;
    let w = Math.max(base, minW + border * 2);
    let h = Math.max(base, minH + border * 2);
    push(w, h);
    for (let i = 0; i < 40 && (w < maxW || h < maxH); i++) {
      if (settings.powerOfTwo || settings.square) {
        if (w <= h && w < maxW) w = Math.min(maxW, w * 2);
        else h = Math.min(maxH, h * 2);
        if (settings.powerOfTwo && !settings.square) {
          // also try growing the other axis at the same step
        }
      } else if (w <= h && w < maxW) {
        w = Math.min(maxW, Math.ceil(w * 1.25));
      } else {
        h = Math.min(maxH, Math.ceil(h * 1.25));
      }
      push(w, h);
    }
    push(maxW, maxH);
    return sizes;
  };

  let best = null; // fully packed, minimal area
  let bestPartial = null; // fallback: most sprites placed at max size

  for (const sortFn of SORTS) {
    const sorted = [...items].sort(sortFn);
    for (const [w, h] of candidateSizes()) {
      const res = attempt(sorted, w, h, padding, border, allowRotation);
      if (res.failed.length === 0) {
        const size = shrink(res.placed, border, settings);
        const a = size.w * size.h;
        if (!best || a < best.area) {
          best = { area: a, width: size.w, height: size.h, placed: res.placed };
        }
        break; // larger candidates for this sort can't beat this area meaningfully
      }
      if (w >= maxW && h >= maxH) {
        if (!bestPartial || res.placed.length > bestPartial.placed.length) {
          bestPartial = { width: maxW, height: maxH, placed: res.placed, failed: res.failed };
        }
      }
    }
  }

  if (best) {
    return { width: best.width, height: best.height, placed: best.placed, failedIds: [], ok: true };
  }
  if (bestPartial) {
    return {
      width: bestPartial.width,
      height: bestPartial.height,
      placed: bestPartial.placed,
      failedIds: bestPartial.failed.map((f) => f.id),
      ok: false,
    };
  }
  return { width: maxW, height: maxH, placed: [], failedIds: items.map((i) => i.id), ok: false };
}
