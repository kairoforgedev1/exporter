// Center-panel atlas preview: checkerboard background, zoom/pan, fit,
// sprite outlines, optional name labels, click-to-select, selection highlight.

import { state, bus, setSelection, toggleSelected } from './state.js';
import { clamp } from './util.js';

export class Preview {
  constructor(canvas, infoEl, zoomEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.infoEl = infoEl;
    this.zoomEl = zoomEl;
    this.view = { scale: 1, x: 40, y: 40 };
    this.showOutlines = true;
    this.showLabels = false;
    this.hoverId = null;
    this._needsDraw = false;
    this._fitPending = true;
    this._checker = makeChecker();

    this._bindEvents();
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas.parentElement);
    this._resize();

    bus.on('pack', () => {
      if (this._fitPending && state.pack) {
        this._fitPending = false;
        this.fit();
      }
      this._updateInfo();
      this.requestDraw();
    });
    bus.on('selection', () => this.requestDraw());
    bus.on('project', () => {
      this._fitPending = true;
    });
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.requestDraw();
  }

  requestDraw() {
    if (this._needsDraw) return;
    this._needsDraw = true;
    requestAnimationFrame(() => {
      this._needsDraw = false;
      this.draw();
    });
  }

  // --- coordinate transforms (world = atlas pixels, screen = CSS px) ---
  toScreen(wx, wy) {
    return [wx * this.view.scale + this.view.x, wy * this.view.scale + this.view.y];
  }
  toWorld(sx, sy) {
    return [(sx - this.view.x) / this.view.scale, (sy - this.view.y) / this.view.scale];
  }

  fit() {
    const pack = state.pack;
    if (!pack || !pack.width) return;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const margin = 32;
    const scale = Math.min((w - margin * 2) / pack.width, (h - margin * 2) / pack.height);
    this.view.scale = clamp(scale, 0.01, 16);
    this.view.x = (w - pack.width * this.view.scale) / 2;
    this.view.y = (h - pack.height * this.view.scale) / 2;
    this._updateInfo();
    this.requestDraw();
  }

  zoomAt(sx, sy, factor) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.view.scale = clamp(this.view.scale * factor, 0.02, 32);
    this.view.x = sx - wx * this.view.scale;
    this.view.y = sy - wy * this.view.scale;
    this._updateInfo();
    this.requestDraw();
  }

  zoomCenter(factor) {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    this.zoomAt(w / 2, h / 2, factor);
  }

  zoomTo(scale) {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const [wx, wy] = this.toWorld(w / 2, h / 2);
    this.view.scale = clamp(scale, 0.02, 32);
    this.view.x = w / 2 - wx * this.view.scale;
    this.view.y = h / 2 - wy * this.view.scale;
    this._updateInfo();
    this.requestDraw();
  }

  hitTest(sx, sy) {
    const pack = state.pack;
    if (!pack) return null;
    const [wx, wy] = this.toWorld(sx, sy);
    let best = null;
    for (const p of pack.placed) {
      if (wx >= p.x && wx < p.x + p.regionW && wy >= p.y && wy < p.y + p.regionH) {
        if (!best || p.regionW * p.regionH < best.regionW * best.regionH) best = p;
      }
    }
    return best ? best.sprite.id : null;
  }

  _bindEvents() {
    const c = this.canvas;
    let dragging = false;
    let moved = false;
    let last = null;

    c.addEventListener('pointerdown', (e) => {
      if (e.button === 0 || e.button === 1) {
        dragging = true;
        moved = false;
        last = [e.offsetX, e.offsetY];
        c.setPointerCapture(e.pointerId);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (dragging) {
        const dx = e.offsetX - last[0];
        const dy = e.offsetY - last[1];
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          if (Math.hypot(dx, dy) > 2) moved = true;
          this.view.x += dx;
          this.view.y += dy;
          last = [e.offsetX, e.offsetY];
          this.requestDraw();
        }
      } else {
        const id = this.hitTest(e.offsetX, e.offsetY);
        if (id !== this.hoverId) {
          this.hoverId = id;
          c.style.cursor = id ? 'pointer' : 'grab';
          this.requestDraw();
        }
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      c.releasePointerCapture(e.pointerId);
      if (!moved && e.button === 0) {
        const id = this.hitTest(e.offsetX, e.offsetY);
        if (id == null) {
          if (!e.ctrlKey) setSelection([]);
        } else if (e.ctrlKey) {
          toggleSelected(id);
        } else {
          setSelection([id]);
        }
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.hoverId !== null) {
        this.hoverId = null;
        this.requestDraw();
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoomAt(e.offsetX, e.offsetY, factor);
    }, { passive: false });
  }

  _updateInfo() {
    const pack = state.pack;
    if (this.zoomEl) this.zoomEl.textContent = `${Math.round(this.view.scale * 100)}%`;
    if (!this.infoEl) return;
    if (!pack) {
      this.infoEl.textContent = 'No atlas';
      return;
    }
    const failed = pack.failedIds.length
      ? ` • ${pack.failedIds.length} DID NOT FIT`
      : '';
    this.infoEl.textContent =
      `${pack.width} × ${pack.height} px • ${pack.placed.length} sprites • ` +
      `${pack.usedPct.toFixed(1)}% used${failed}`;
    this.infoEl.classList.toggle('warn', pack.failedIds.length > 0);
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0e0f12';
    ctx.fillRect(0, 0, cw, ch);

    const pack = state.pack;
    if (!pack || !pack.width) return;

    const [ax, ay] = this.toScreen(0, 0);
    const aw = pack.width * this.view.scale;
    const ah = pack.height * this.view.scale;

    // Checkerboard (screen-space pattern clipped to atlas bounds).
    ctx.save();
    ctx.beginPath();
    ctx.rect(ax, ay, aw, ah);
    ctx.clip();
    ctx.fillStyle = this._checker;
    ctx.fillRect(ax, ay, aw, ah);
    ctx.restore();

    // Atlas image.
    ctx.save();
    ctx.imageSmoothingEnabled = this.view.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pack.atlasCanvas, ax, ay, aw, ah);
    ctx.restore();

    // Atlas border.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ax - 0.5, ay - 0.5, aw + 1, ah + 1);

    // Sprite outlines / labels / highlights.
    const sel = state.selection;
    for (const p of pack.placed) {
      const [x, y] = this.toScreen(p.x, p.y);
      const w = p.regionW * this.view.scale;
      const h = p.regionH * this.view.scale;
      const isSel = sel.has(p.sprite.id);
      const isHover = this.hoverId === p.sprite.id;

      if (this.showOutlines && !isSel) {
        ctx.strokeStyle = isHover ? 'rgba(120,190,255,0.9)' : 'rgba(110,150,220,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      } else if (isHover && !isSel) {
        ctx.strokeStyle = 'rgba(120,190,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
      if (isSel) {
        ctx.fillStyle = 'rgba(90,160,255,0.18)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#5aa0ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
      if (this.showLabels && w > 24 && h > 10) {
        const label = p.sprite.name + (p.rotated ? ' ↻' : '');
        ctx.font = '11px "Segoe UI", sans-serif';
        const tw = Math.min(ctx.measureText(label).width + 8, w);
        ctx.fillStyle = 'rgba(10,12,16,0.75)';
        ctx.fillRect(x, y, tw, 16);
        ctx.fillStyle = isSel ? '#9cc7ff' : '#cfd6e4';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, tw, 16);
        ctx.clip();
        ctx.fillText(label, x + 4, y + 12);
        ctx.restore();
      }
    }
  }
}

function makeChecker() {
  const size = 16;
  const c = document.createElement('canvas');
  c.width = size * 2;
  c.height = size * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2c33';
  ctx.fillRect(0, 0, size * 2, size * 2);
  ctx.fillStyle = '#383b44';
  ctx.fillRect(0, 0, size, size);
  ctx.fillRect(size, size, size, size);
  return ctx.createPattern(c, 'repeat');
}
