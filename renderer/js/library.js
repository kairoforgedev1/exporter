// Left-panel sprite library: search, sort, thumbnails, status badges,
// single/multi selection, sprite count.

import { state, bus, setSelection, toggleSelected, statusOf } from './state.js';
import { escapeHtml } from './util.js';

const THUMB = 44;

export class Library {
  constructor(root) {
    this.listEl = root.querySelector('#spriteList');
    this.searchEl = root.querySelector('#spriteSearch');
    this.sortEl = root.querySelector('#spriteSort');
    this.countEl = root.querySelector('#spriteCount');
    this.thumbCache = new Map(); // id -> {rev, canvas}
    this.lastClickedId = null;
    this.onRenameRequest = null; // set by app.js

    this.searchEl.addEventListener('input', () => this.render());
    this.sortEl.addEventListener('change', () => this.render());

    this.listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.sprite-item');
      if (!item) return;
      const id = Number(item.dataset.id);
      if (e.shiftKey && this.lastClickedId != null) {
        const order = this.visibleIds;
        const a = order.indexOf(this.lastClickedId);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
          const merged = e.ctrlKey ? new Set([...state.selection, ...range]) : new Set(range);
          setSelection(merged);
          return;
        }
      }
      this.lastClickedId = id;
      if (e.ctrlKey) toggleSelected(id);
      else setSelection([id]);
    });

    this.listEl.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.sprite-item');
      if (item && this.onRenameRequest) {
        setSelection([Number(item.dataset.id)]);
        this.onRenameRequest(Number(item.dataset.id));
      }
    });

    bus.on('sprites', () => this.render());
    bus.on('selection', () => this.updateSelectionUI());
    bus.on('project', () => {
      this.thumbCache.clear();
      this.render();
    });
  }

  get visibleIds() {
    return [...this.listEl.querySelectorAll('.sprite-item')].map((el) => Number(el.dataset.id));
  }

  filteredSorted() {
    const q = this.searchEl.value.trim().toLowerCase();
    let list = state.sprites;
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    const mode = this.sortEl.value;
    const cmp = {
      'name-asc': (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      'name-desc': (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()),
      'size-desc': (a, b) => b.sw * b.sh - a.sw * a.sh || a.name.localeCompare(b.name),
      'size-asc': (a, b) => a.sw * a.sh - b.sw * b.sh || a.name.localeCompare(b.name),
    }[mode];
    return [...list].sort(cmp);
  }

  thumbFor(sprite) {
    const cached = this.thumbCache.get(sprite.id);
    if (cached && cached.rev === sprite.imageRev) return cached.canvas;
    const c = document.createElement('canvas');
    c.width = THUMB;
    c.height = THUMB;
    const ctx = c.getContext('2d');
    const scale = Math.min(THUMB / sprite.sw, THUMB / sprite.sh, 1);
    const w = Math.max(1, Math.round(sprite.sw * scale));
    const h = Math.max(1, Math.round(sprite.sh * scale));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite.source, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
    this.thumbCache.set(sprite.id, { rev: sprite.imageRev, canvas: c });
    return c;
  }

  render() {
    const sprites = this.filteredSorted();
    this.listEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const s of sprites) {
      const item = document.createElement('div');
      item.className = 'sprite-item';
      item.dataset.id = s.id;
      const status = statusOf(s);

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb';
      thumbWrap.appendChild(this.thumbFor(s));
      item.appendChild(thumbWrap);

      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML =
        `<div class="name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>` +
        `<div class="dims">${s.sw} × ${s.sh}</div>`;
      item.appendChild(info);

      if (status !== 'unchanged') {
        const badge = document.createElement('span');
        badge.className = `badge badge-${status}`;
        badge.textContent = status;
        item.appendChild(badge);
      }
      frag.appendChild(item);
    }
    this.listEl.appendChild(frag);
    this.updateSelectionUI();
    this.updateCount(sprites.length);

    // Purge cache entries for deleted sprites.
    const alive = new Set(state.sprites.map((s) => s.id));
    for (const id of [...this.thumbCache.keys()]) {
      if (!alive.has(id)) this.thumbCache.delete(id);
    }
  }

  updateSelectionUI() {
    for (const el of this.listEl.querySelectorAll('.sprite-item')) {
      el.classList.toggle('selected', state.selection.has(Number(el.dataset.id)));
    }
    this.updateCount();
  }

  updateCount(visible) {
    const total = state.sprites.length;
    const sel = state.selection.size;
    if (visible == null) {
      visible = this.listEl.querySelectorAll('.sprite-item').length;
    }
    let text = `${total} sprite${total === 1 ? '' : 's'}`;
    if (visible !== total) text = `${visible} of ${text}`;
    if (sel > 0) text += ` • ${sel} selected`;
    this.countEl.textContent = text;
  }
}
