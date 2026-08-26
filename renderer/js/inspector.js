// Right-panel sprite inspector: preview, name/rename, dimensions, generated
// (read-only) atlas position, replace/delete actions. Also owns the packing
// settings form below it.

import { state, bus, getSprite, statusOf, renameSprite, updateSettings, canBlur } from './state.js';
import { escapeHtml } from './util.js';

export class Inspector {
  constructor(root, actions) {
    this.root = root;
    this.actions = actions; // {replace(id), delete(ids), toast(msg,type)}
    this.emptyEl = root.querySelector('#inspEmpty');
    this.multiEl = root.querySelector('#inspMulti');
    this.singleEl = root.querySelector('#inspSingle');
    this.previewCanvas = root.querySelector('#inspPreview');
    this.nameInput = root.querySelector('#inspName');
    this.infoGrid = root.querySelector('#inspInfo');
    this.statusBadge = root.querySelector('#inspStatus');

    root.querySelector('#inspRenameBtn').addEventListener('click', () => this.startRename());
    root.querySelector('#inspReplaceBtn').addEventListener('click', () => {
      const id = this.currentId();
      if (id != null) this.actions.replace(id);
    });
    root.querySelector('#inspDeleteBtn').addEventListener('click', () => {
      this.actions.delete([...state.selection]);
    });
    root.querySelector('#inspDeleteMultiBtn').addEventListener('click', () => {
      this.actions.delete([...state.selection]);
    });
    for (const id of ['inspBlurBtn', 'inspBlurMultiBtn']) {
      root.querySelector(`#${id}`).addEventListener('click', () => {
        this.actions.blur([...state.selection]);
      });
    }

    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.render(); // revert
        this.nameInput.blur();
      }
      e.stopPropagation();
    });
    this.nameInput.addEventListener('blur', () => this.commitRename());

    bus.on('selection', () => this.render());
    bus.on('sprites', () => this.render());
    bus.on('pack', () => this.render());

    this.initSettingsForm();
    bus.on('settings', () => this.syncSettingsForm());
  }

  currentId() {
    return state.selection.size === 1 ? [...state.selection][0] : null;
  }

  startRename() {
    this.nameInput.focus();
    const dot = this.nameInput.value.lastIndexOf('.');
    this.nameInput.setSelectionRange(0, dot > 0 ? dot : this.nameInput.value.length);
  }

  commitRename() {
    const id = this.currentId();
    if (id == null) return;
    const sprite = getSprite(id);
    const newName = this.nameInput.value.trim();
    if (!sprite || !newName || newName === sprite.name) {
      if (sprite) this.nameInput.value = sprite.name;
      return;
    }
    if (state.sprites.some((s) => s.id !== id && s.name === newName)) {
      this.actions.toast(`A sprite named "${newName}" already exists.`, 'error');
      this.nameInput.value = sprite.name;
      return;
    }
    renameSprite(id, newName);
  }

  render() {
    const sel = state.selection;
    this.emptyEl.classList.toggle('hidden', sel.size !== 0);
    this.multiEl.classList.toggle('hidden', sel.size <= 1);
    this.singleEl.classList.toggle('hidden', sel.size !== 1);

    // Blur is a static-image tool: disabled the moment anything else is picked.
    const blurable = canBlur(sel);
    for (const id of ['inspBlurBtn', 'inspBlurMultiBtn']) {
      const btn = this.root.querySelector(`#${id}`);
      btn.disabled = !blurable;
      btn.title = blurable
        ? 'Generate a blurred copy for reel spinning'
        : 'Only static images can be blurred';
    }

    if (sel.size > 1) {
      this.multiEl.querySelector('.multi-count').textContent = `${sel.size} sprites selected`;
      return;
    }
    const id = this.currentId();
    if (id == null) return;
    const sprite = getSprite(id);
    if (!sprite) return;

    // Preview thumbnail (contain-fit on checkerboard).
    const c = this.previewCanvas;
    const box = 196;
    c.width = box;
    c.height = box;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, box, box);
    const scale = Math.min(box / sprite.sw, box / sprite.sh, 1);
    const w = Math.max(1, Math.round(sprite.sw * scale));
    const h = Math.max(1, Math.round(sprite.sh * scale));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite.source, (box - w) / 2, (box - h) / 2, w, h);

    if (document.activeElement !== this.nameInput) {
      this.nameInput.value = sprite.name;
    }

    const status = statusOf(sprite);
    this.statusBadge.textContent = status;
    this.statusBadge.className = `badge badge-${status}`;

    const placed = state.pack?.placed.find((p) => p.sprite.id === id);
    const rows = [
      ['Source size', `${sprite.sw} × ${sprite.sh}`],
      ['Trimmed size', placed ? `${placed.trim.w} × ${placed.trim.h}` : '—'],
      ['Atlas X', placed ? String(placed.x) : 'not placed'],
      ['Atlas Y', placed ? String(placed.y) : 'not placed'],
      ['Rotated', placed ? (placed.rotated ? 'yes (90°)' : 'no') : '—'],
    ];
    this.infoGrid.innerHTML = rows
      .map(([k, v]) => `<div class="k">${k}</div><div class="v">${escapeHtml(v)}</div>`)
      .join('');
  }

  // -------------------------------------------------------------------------
  // Packing settings form
  // -------------------------------------------------------------------------
  initSettingsForm() {
    this.fields = {
      padding: document.getElementById('setPadding'),
      border: document.getElementById('setBorder'),
      maxWidth: document.getElementById('setMaxW'),
      maxHeight: document.getElementById('setMaxH'),
      extrude: document.getElementById('setExtrude'),
      powerOfTwo: document.getElementById('setPOT'),
      square: document.getElementById('setSquare'),
      allowRotation: document.getElementById('setRotation'),
      trim: document.getElementById('setTrim'),
    };
    for (const [key, el] of Object.entries(this.fields)) {
      el.addEventListener('change', () => {
        let value;
        if (el.type === 'checkbox') {
          value = el.checked;
        } else {
          value = Math.max(Number(el.min) || 0, Math.round(Number(el.value) || 0));
          if (el.max) value = Math.min(Number(el.max), value);
          el.value = value;
        }
        if (state.settings[key] !== value) updateSettings({ [key]: value });
      });
    }
    this.syncSettingsForm();
  }

  syncSettingsForm() {
    for (const [key, el] of Object.entries(this.fields)) {
      if (el.type === 'checkbox') el.checked = !!state.settings[key];
      else if (document.activeElement !== el) el.value = state.settings[key];
    }
  }
}
