// "Create Blurred Version" — generates blurred twins of selected STATIC
// symbol images for use while the reels spin. Sharp originals are untouched;
// the blurred copies enter the project as ordinary static sprites.

import { state, getSprite, addSprites, isStaticImage } from './state.js';
import { blurImage, blurredName, alphaCentroidOffset, BLUR_STYLES, DEFAULT_BLUR } from './blur.js';
import { escapeHtml } from './util.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_BOX = 240;

export class BlurTool {
  constructor({ toast }) {
    this.toast = toast;
    this.options = { ...DEFAULT_BLUR };
    this.targets = [];
    this.names = new Map(); // sprite id -> output name
    this.results = new Map(); // sprite id -> blur result (full resolution)
    this.activeId = null;
    this._timer = null;
    this._bind();
  }

  // -------------------------------------------------------------------------
  open(ids) {
    const targets = [...ids].map(getSprite).filter(Boolean);
    const rejected = targets.filter((s) => !isStaticImage(s));
    if (rejected.length) {
      this.toast(
        `Blur only supports static images — ${rejected.map((s) => s.name).join(', ')} cannot be blurred.`,
        'warn',
        6000
      );
      return false;
    }
    if (!targets.length) {
      this.toast('Select one or more static symbols first.', 'warn');
      return false;
    }

    this.targets = targets;
    this.activeId = targets[0].id;
    this.names = new Map(targets.map((s) => [s.id, blurredName(s.name)]));
    this.results = new Map();
    $('blurRoot').classList.add('visible');
    this.syncControls();
    this.renderTargets();
    this.renderNames();
    this.schedulePreview(true);
    return true;
  }

  close() {
    $('blurRoot').classList.remove('visible');
    this.results = new Map();
  }

  _bind() {
    $('blurClose').addEventListener('click', () => this.close());
    $('blurCancel').addEventListener('click', () => this.close());
    $('blurApply').addEventListener('click', () => this.generate());
    $('blurRoot').addEventListener('click', (e) => {
      if (e.target === $('blurRoot')) this.close();
    });

    const controls = $('blurControls');
    controls.addEventListener('input', (e) => {
      const el = e.target;
      if (el.id === 'blurStrength') this.options.strength = Number(el.value);
      else if (el.id === 'blurAngle') this.options.angle = Number(el.value);
      else if (el.id === 'blurSoftness') this.options.softness = Number(el.value);
      else return;
      this.syncControls();
      this.schedulePreview();
    });
    controls.addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'blurStyle') this.options.style = el.value;
      else if (el.id === 'blurExpand') this.options.expand = el.checked;
      else if (el.name === 'blurDirection') {
        this.options.angle = Number(el.value);
        $('blurAngle').value = this.options.angle;
      } else return;
      this.syncControls();
      this.schedulePreview(true);
    });

    $('blurNames').addEventListener('input', (e) => {
      const el = e.target;
      if (!el.classList.contains('blur-name')) return;
      this.names.set(Number(el.dataset.id), el.value.trim());
      this.validateNames();
    });

    $('blurTargets').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      this.activeId = Number(chip.dataset.id);
      this.renderTargets();
      this.renderPreview();
    });

    $('blurAutoFix').addEventListener('click', () => {
      const taken = new Set(state.sprites.map((s) => s.name));
      for (const sprite of this.targets) {
        let candidate = this.names.get(sprite.id) || blurredName(sprite.name);
        if (!taken.has(candidate)) {
          taken.add(candidate);
          continue;
        }
        const dot = candidate.lastIndexOf('.');
        const base = dot > 0 ? candidate.slice(0, dot) : candidate;
        const ext = dot > 0 ? candidate.slice(dot) : '';
        let n = 2;
        while (taken.has(`${base}_${n}${ext}`)) n++;
        candidate = `${base}_${n}${ext}`;
        taken.add(candidate);
        this.names.set(sprite.id, candidate);
      }
      this.renderNames();
    });
  }

  syncControls() {
    const o = this.options;
    $('blurStyle').value = o.style;
    $('blurStrength').value = o.strength;
    $('blurStrengthOut').textContent = `${o.strength} px`;
    $('blurAngle').value = o.angle;
    $('blurAngleOut').textContent = `${o.angle}°`;
    $('blurSoftness').value = o.softness;
    $('blurSoftnessOut').textContent = `${o.softness}%`;
    $('blurExpand').checked = o.expand;
    const motion = o.style === BLUR_STYLES.MOTION;
    $('blurMotionRow').classList.toggle('hidden', !motion);
    $('blurSoftnessRow').classList.toggle('hidden', !motion);
    for (const radio of document.querySelectorAll('input[name="blurDirection"]')) {
      radio.checked = Number(radio.value) === o.angle;
    }
  }

  renderTargets() {
    $('blurTargets').innerHTML = this.targets
      .map(
        (s) =>
          `<button class="chip ${s.id === this.activeId ? 'active' : ''}" data-id="${s.id}">` +
          `${escapeHtml(s.name)}</button>`
      )
      .join('');
    $('blurCount').textContent =
      this.targets.length === 1
        ? '1 symbol'
        : `${this.targets.length} symbols · the same blur is applied to all`;
  }

  schedulePreview(immediate = false) {
    clearTimeout(this._timer);
    this.results = new Map();
    if (immediate) this.renderPreview();
    else this._timer = setTimeout(() => this.renderPreview(), 110);
  }

  resultFor(sprite) {
    if (!this.results.has(sprite.id)) {
      this.results.set(sprite.id, blurImage(sprite.source, this.options));
    }
    return this.results.get(sprite.id);
  }

  renderPreview() {
    const sprite = getSprite(this.activeId) || this.targets[0];
    if (!sprite) return;
    const result = this.resultFor(sprite);

    // Both panes share one scale so the comparison is honest.
    const scale = Math.min(
      PREVIEW_BOX / Math.max(sprite.sw, result.width),
      PREVIEW_BOX / Math.max(sprite.sh, result.height),
      1
    );
    const draw = (canvasId, image, w, h) => {
      const canvas = $(canvasId);
      canvas.width = PREVIEW_BOX;
      canvas.height = PREVIEW_BOX;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, PREVIEW_BOX, PREVIEW_BOX);
      const dw = Math.max(1, Math.round(w * scale));
      const dh = Math.max(1, Math.round(h * scale));
      ctx.imageSmoothingQuality = 'high';
      // Centre both: identical centres is exactly the alignment guarantee.
      ctx.drawImage(image, (PREVIEW_BOX - dw) / 2, (PREVIEW_BOX - dh) / 2, dw, dh);
    };
    draw('blurBefore', sprite.source, sprite.sw, sprite.sh);
    draw('blurAfter', result.canvas, result.width, result.height);

    const before = alphaCentroidOffset(sprite.source);
    const after = alphaCentroidOffset(result.canvas);
    const drift = Math.hypot(after.x - before.x, after.y - before.y);

    const notes = [];
    notes.push(
      `<div class="k">Source</div><div class="v mono">${sprite.sw} × ${sprite.sh}</div>` +
        `<div class="k">Blurred</div><div class="v mono">${result.width} × ${result.height}` +
        (result.padding.x || result.padding.y
          ? ` <span class="dim">(+${result.padding.x}/${result.padding.y} px each side)</span>`
          : '') +
        `</div>` +
        `<div class="k">Centre drift</div><div class="v mono">${drift.toFixed(2)} px ` +
        (drift < 0.75
          ? '<span class="badge badge-added">aligned</span>'
          : '<span class="badge badge-replaced">check alignment</span>') +
        `</div>`
    );
    $('blurStats').innerHTML = `<div class="info-grid">${notes.join('')}</div>`;

    const warnings = [];
    if (result.clipped) {
      warnings.push(
        this.options.expand
          ? 'The blur still reaches the canvas edge. Reduce the strength if you see a hard cut.'
          : 'The blur is clipped at the image edge. Turn on “Expand canvas to fit blur” to keep the falloff intact.'
      );
    }
    if (!this.options.expand && (this.options.strength || 0) > 0) {
      warnings.push('Canvas size is locked to the original, so the outer falloff may be cut off.');
    }
    $('blurWarnings').innerHTML = warnings.length
      ? warnings.map((w) => `<div class="warn small">⚠ ${escapeHtml(w)}</div>`).join('')
      : '';
  }

  renderNames() {
    $('blurNames').innerHTML = this.targets
      .map(
        (s) =>
          `<div class="blur-name-row">` +
          `<span class="mono src" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>` +
          `<span class="arrow">→</span>` +
          `<input class="anim-input blur-name" data-id="${s.id}" value="${escapeHtml(this.names.get(s.id) || '')}" />` +
          `</div>`
      )
      .join('');
    this.validateNames();
  }

  /** Nothing is generated while a name would collide — no silent overwrites. */
  validateNames() {
    const existing = new Set(state.sprites.map((s) => s.name));
    const seen = new Map();
    const problems = [];
    for (const sprite of this.targets) {
      const name = this.names.get(sprite.id) || '';
      const input = $('blurNames').querySelector(`.blur-name[data-id="${sprite.id}"]`);
      let issue = null;
      if (!name) issue = 'name required';
      else if (existing.has(name)) issue = `“${name}” already exists in the atlas`;
      else if (seen.has(name)) issue = `“${name}” is used twice in this batch`;
      seen.set(name, sprite.id);
      if (input) input.classList.toggle('bad', !!issue);
      if (issue) problems.push(issue);
    }
    const ok = problems.length === 0;
    $('blurApply').disabled = !ok;
    $('blurAutoFix').classList.toggle('hidden', ok);
    $('blurNameError').innerHTML = ok
      ? ''
      : `<div class="err small">${escapeHtml(problems[0])}${
          problems.length > 1 ? ` (+${problems.length - 1} more)` : ''
        }</div>`;
    return ok;
  }

  generate() {
    if (!this.validateNames()) return;
    const items = this.targets.map((sprite) => {
      const result = this.resultFor(sprite);
      return {
        name: this.names.get(sprite.id),
        canvas: result.canvas,
        extra: {
          kind: 'static',
          derivedFrom: { id: sprite.id, name: sprite.name },
          blur: { ...this.options },
        },
      };
    });

    const added = addSprites(items);
    this.close();
    this.toast(
      added.length === 1
        ? `Created “${items[0].name}” (Ctrl+Z to undo)`
        : `Created ${added.length} blurred symbols (Ctrl+Z to undo)`
    );
    return added;
  }
}
