// Application wiring: toolbar, menu, keyboard, drag & drop, import/export
// flows, modals and toasts.

import {
  state, bus, undo, redo, canUndo, canRedo, setDirty,
  makeSprite, addSprites, removeSprites, replaceSpriteImage,
  setSelection, loadProject, flushPack, repackNow, getSprite, applyImages,
} from './state.js';
import { Library } from './library.js';
import { Preview } from './preview.js';
import { Inspector } from './inspector.js';
import { parseAtlasJSON, extractSprites, serializeAtlasJSON } from './atlasio.js';
import { basename, dirname, stripExt, joinPath, formatBytes, bytesToCanvas, scaleCanvas } from './util.js';

const native = window.native;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------
export const library = new Library($('leftPanel'));
export const preview = new Preview($('previewCanvas'), $('atlasInfo'), $('zoomLevel'));
export const inspector = new Inspector($('rightPanel'), {
  replace: (id) => replaceFlow(id),
  delete: (ids) => deleteSprites(ids),
  blur: (ids) => openBlurTool(ids),
  toast,
});
library.onRenameRequest = () => inspector.startRename();

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(message, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

// ---------------------------------------------------------------------------
// Choice dialog (promise-based modal with labeled buttons)
// ---------------------------------------------------------------------------
export function choiceDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'choice-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const head = document.createElement('div');
    head.className = 'modal-title';
    head.textContent = title;
    const body = document.createElement('div');
    body.className = 'choice-message';
    body.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = (value) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done(null);
      }
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => done(b.value));
      actions.appendChild(btn);
    }
    window.addEventListener('keydown', onKey, true);
    modal.append(head, body, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    actions.querySelector('.btn.primary')?.focus();
  });
}

const rootVisible = (id) => $(id)?.classList.contains('visible') === true;
const modalIsOpen = () =>
  document.querySelector('.choice-overlay') !== null ||
  rootVisible('modalRoot') ||
  rootVisible('blurRoot') ||
  rootVisible('animRoot') ||
  rootVisible('fontRoot');

// ---------------------------------------------------------------------------
// Import: open atlas
// ---------------------------------------------------------------------------
async function tryRead(path) {
  try {
    return await native.readFile(path);
  } catch {
    return null;
  }
}

export async function loadAtlasFromPaths(pngPath, jsonPath) {
  const [pngBytes, jsonBytes] = await Promise.all([native.readFile(pngPath), native.readFile(jsonPath)]);
  const parsed = parseAtlasJSON(new TextDecoder().decode(jsonBytes));
  const atlasCanvas = await bytesToCanvas(pngBytes);

  for (const f of parsed.frames) {
    const rw = f.rotated ? f.frame.h : f.frame.w;
    const rh = f.rotated ? f.frame.w : f.frame.h;
    if (f.frame.x + rw > atlasCanvas.width || f.frame.y + rh > atlasCanvas.height) {
      toast(`Warning: sprite "${f.name}" extends beyond the atlas image.`, 'warn', 6000);
    }
  }

  const extracted = extractSprites(atlasCanvas, parsed.frames);
  const sprites = extracted.map(({ name, canvas }) => makeSprite(name, canvas));

  // Mirror the imported file's own layout in the preview until the first edit:
  // the JSON coordinates are shown exactly as they are on disk.
  let usedPixels = 0;
  const placed = parsed.frames.map((f, i) => {
    usedPixels += f.frame.w * f.frame.h;
    return {
      sprite: sprites[i],
      trim: { x: f.offsetX, y: f.offsetY, w: f.frame.w, h: f.frame.h, trimmed: f.trimmed },
      x: f.frame.x,
      y: f.frame.y,
      rotated: f.rotated,
      regionW: f.rotated ? f.frame.h : f.frame.w,
      regionH: f.rotated ? f.frame.w : f.frame.h,
    };
  });
  const initialPack = {
    width: atlasCanvas.width,
    height: atlasCanvas.height,
    placed,
    failedIds: [],
    usedPct: (usedPixels / (atlasCanvas.width * atlasCanvas.height)) * 100,
    atlasCanvas,
  };

  loadProject(sprites, {
    pngName: basename(pngPath),
    jsonName: basename(jsonPath),
    dir: dirname(pngPath),
    scale: parsed.meta.scale || '1',
  }, initialPack);
  toast(`Loaded ${sprites.length} sprites from ${basename(pngPath)}`, 'info');
}

async function openAtlasFlow() {
  if (state.dirty && !confirm('Discard unsaved changes and open another atlas?')) return;
  const picked = await native.pickFiles({
    title: 'Select atlas PNG (its JSON will be auto-detected)',
    filters: [
      { name: 'Atlas files', extensions: ['png', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!picked.length) return;
  let pngPath = null;
  let jsonPath = null;
  const p = picked[0];
  if (p.toLowerCase().endsWith('.json')) jsonPath = p;
  else pngPath = p;

  // Auto-detect the counterpart file next to the picked one.
  if (pngPath && !jsonPath) {
    const guess = stripExt(pngPath) + '.json';
    if (await native.fileExists(guess)) jsonPath = guess;
  } else if (jsonPath && !pngPath) {
    const bytes = await tryRead(jsonPath);
    if (bytes) {
      try {
        const meta = parseAtlasJSON(new TextDecoder().decode(bytes)).meta;
        if (meta.image) {
          const guess = joinPath(dirname(jsonPath), meta.image);
          if (await native.fileExists(guess)) pngPath = guess;
        }
      } catch { /* fall through to manual pick */ }
    }
    if (!pngPath) {
      const guess = stripExt(jsonPath) + '.png';
      if (await native.fileExists(guess)) pngPath = guess;
    }
  }

  if (!jsonPath) {
    const r = await native.pickFiles({
      title: 'Select the matching atlas JSON',
      defaultPath: dirname(pngPath),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!r.length) return;
    jsonPath = r[0];
  }
  if (!pngPath) {
    const r = await native.pickFiles({
      title: 'Select the matching atlas PNG',
      defaultPath: dirname(jsonPath),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!r.length) return;
    pngPath = r[0];
  }

  try {
    await loadAtlasFromPaths(pngPath, jsonPath);
  } catch (err) {
    console.error(err);
    toast(`Could not load atlas: ${err.message}`, 'error', 7000);
  }
}

// ---------------------------------------------------------------------------
// Add / replace images
// ---------------------------------------------------------------------------
/**
 * Shared import path for Add Images and drag & drop. Images whose filename
 * matches an existing sprite can replace that sprite's image instead of
 * silently being added as a "name (2).png" copy.
 */
async function importImages(items) {
  if (!items.length) return;
  const lower = (n) => n.toLowerCase();
  const matched = [];
  const fresh = [];
  for (const it of items) {
    const existing = state.sprites.find((s) => lower(s.name) === lower(it.name));
    if (existing) matched.push({ ...it, existing });
    else fresh.push(it);
  }

  if (!matched.length) {
    addSprites(items);
    toast(`Added ${items.length} image${items.length === 1 ? '' : 's'}`);
    return;
  }

  const shown = matched.slice(0, 4).map((m) => m.existing.name).join(', ');
  const more = matched.length > 4 ? ` and ${matched.length - 4} more` : '';
  const choice = await choiceDialog({
    title: 'Images Match Existing Sprites',
    message:
      `${matched.length === 1 ? 'One imported image matches an existing sprite' : `${matched.length} imported images match existing sprites`}: ${shown}${more}.\n\n` +
      `Replace the existing sprite image${matched.length === 1 ? '' : 's'} (keeping the sprite name, using each new image's own size), or add the file${matched.length === 1 ? '' : 's'} as new copies?`,
    buttons: [
      { label: 'Replace Existing', value: 'replace', primary: true },
      { label: 'Add as Copies', value: 'copy' },
      { label: 'Cancel', value: null },
    ],
  });
  if (!choice) return;

  if (choice === 'copy') {
    addSprites(items);
    toast(`Added ${items.length} image${items.length === 1 ? '' : 's'} as copies`);
  } else {
    applyImages(
      matched.map((m) => ({ id: m.existing.id, canvas: m.canvas })),
      fresh
    );
    const parts = [`Replaced ${matched.length}`];
    if (fresh.length) parts.push(`added ${fresh.length}`);
    toast(`${parts.join(', ')} image${matched.length + fresh.length === 1 ? '' : 's'}`);
  }
}

async function addImagesFlow() {
  const paths = await native.pickFiles({
    title: 'Add images to the atlas',
    multi: true,
    filters: [
      { name: 'PNG images', extensions: ['png'] },
      { name: 'All images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
  });
  if (!paths.length) return;
  const items = [];
  for (const p of paths) {
    try {
      items.push({ name: basename(p), canvas: await bytesToCanvas(await native.readFile(p)) });
    } catch {
      toast(`Could not decode ${basename(p)}`, 'error');
    }
  }
  await importImages(items);
}

async function replaceFlow(id) {
  const sprite = getSprite(id);
  if (!sprite) return;
  const paths = await native.pickFiles({
    title: `Replace image of "${sprite.name}"`,
    filters: [
      { name: 'PNG images', extensions: ['png'] },
      { name: 'All images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
  });
  if (!paths.length) return;
  let canvas;
  try {
    canvas = await bytesToCanvas(await native.readFile(paths[0]));
  } catch (err) {
    toast(`Could not decode image: ${err.message}`, 'error');
    return;
  }

  // When the new image's size differs, let the user choose which size to use.
  if (canvas.width !== sprite.sw || canvas.height !== sprite.sh) {
    const choice = await choiceDialog({
      title: 'Replace Image — Different Size',
      message:
        `The new image is ${canvas.width} × ${canvas.height} px, but "${sprite.name}" is currently ${sprite.sw} × ${sprite.sh} px.\n\n` +
        `Use the new image's own size (recommended — the atlas relayouts automatically), or scale the new image to keep the old sprite size?`,
      buttons: [
        { label: `Use new size ${canvas.width} × ${canvas.height}`, value: 'new', primary: true },
        { label: `Keep old size ${sprite.sw} × ${sprite.sh} (scale)`, value: 'old' },
        { label: 'Cancel', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'old') canvas = scaleCanvas(canvas, sprite.sw, sprite.sh);
  }

  replaceSpriteImage(id, canvas);
  toast(`Replaced image of "${sprite.name}" (${canvas.width} × ${canvas.height})`);
}

// ---------------------------------------------------------------------------
// Blurred static symbols (reel-spin variants)
// ---------------------------------------------------------------------------
let blurTool = null;
export async function openBlurTool(ids) {
  if (!blurTool) {
    const { BlurTool } = await import('./blurui.js');
    blurTool = new BlurTool({ toast });
  }
  blurTool.open(ids);
  return blurTool;
}

export function deleteSprites(ids) {
  if (!ids.length) return;
  const names = ids.map((id) => getSprite(id)?.name).filter(Boolean);
  removeSprites(ids);
  toast(
    names.length === 1 ? `Deleted "${names[0]}" (Ctrl+Z to undo)` : `Deleted ${names.length} sprites (Ctrl+Z to undo)`
  );
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------
function setupDragDrop() {
  const overlay = $('dropOverlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes('Files')) {
      depth++;
      if (bitmapFontExporter?.isOpen) $('fontRoot').classList.add('dragging');
      else overlay.classList.add('visible');
    }
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--depth <= 0) {
      depth = 0;
      overlay.classList.remove('visible');
      $('fontRoot').classList.remove('dragging');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('visible');
    $('fontRoot').classList.remove('dragging');
    const dropped = [...(e.dataTransfer?.files || [])];
    if (bitmapFontExporter?.isOpen) {
      await bitmapFontExporter.importDroppedFiles(dropped);
      return;
    }
    // Spine deliveries belong in the Spine Animation workflow, not the sprite atlas.
    const spineLike = dropped.filter((f) => /\.(atlas|skel|spine)$/i.test(f.name));
    if (spineLike.length) {
      toast(
        'Spine animation files are not static images — use the Spine Animation workflow for those.',
        'warn',
        6000
      );
    }
    const files = dropped.filter(
      (f) => /image\/(png|jpeg|webp|gif|bmp)/.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)
    );
    if (!files.length) {
      if (!spineLike.length) toast('Drop PNG image files to add them to the atlas.', 'warn');
      return;
    }
    const items = [];
    for (const f of files) {
      try {
        items.push({ name: f.name, canvas: await bytesToCanvas(new Uint8Array(await f.arrayBuffer())) });
      } catch {
        toast(`Could not decode ${f.name}`, 'error');
      }
    }
    await importImages(items);
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export async function exportToPaths(pngPath) {
  const pack = flushPack();
  if (!pack || !pack.placed.length) throw new Error('Nothing to export.');
  const jsonPath = stripExt(pngPath) + '.json';
  const jsonText = serializeAtlasJSON({
    placed: pack.placed,
    width: pack.width,
    height: pack.height,
    pngName: basename(pngPath),
    scale: state.meta.scale,
  });
  // pixi-svelte asset module alongside the atlas (same shape as the sample).
  const tsPath = joinPath(dirname(pngPath), 'index.ts');
  const tsText =
    `import { createAsset } from 'pixi-svelte';\n\n` +
    `import img from './${basename(pngPath)}';\n` +
    `import atlas from './${basename(jsonPath)}';\n\n` +
    `export default createAsset({ img, atlas });\n`;
  const ctx = pack.atlasCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, pack.width, pack.height);
  const rgba = new Uint8Array(imageData.data.buffer, 0, imageData.data.byteLength);
  const res = await native.writeExport({
    pngPath,
    jsonPath,
    width: pack.width,
    height: pack.height,
    rgba,
    jsonText,
    tsPath,
    tsText,
  });
  setDirty(false);
  return {
    pngPath,
    jsonPath,
    tsPath,
    width: pack.width,
    height: pack.height,
    spriteCount: pack.placed.length,
    pngBytes: res.pngBytes,
    usedPct: pack.usedPct,
  };
}

async function exportFlow() {
  const pack = flushPack();
  if (!pack || !state.sprites.length) {
    toast('Nothing to export — open an atlas or add images first.', 'warn');
    return;
  }
  if (pack.failedIds.length) {
    const ok = confirm(
      `${pack.failedIds.length} sprite(s) did not fit within the maximum atlas size and will be MISSING from the export.\n\nExport anyway?`
    );
    if (!ok) return;
  }
  const defaultName = state.meta.pngName || 'atlas.png';
  const pngPath = await native.pickSave({
    title: 'Export atlas PNG (JSON is saved alongside)',
    defaultPath: state.meta.dir ? joinPath(state.meta.dir, defaultName) : defaultName,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!pngPath) return;
  try {
    const summary = await exportToPaths(pngPath);
    showExportSummary(summary);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, 'error', 7000);
  }
}

function showExportSummary(s) {
  $('expPng').textContent = s.pngPath;
  $('expJson').textContent = s.jsonPath;
  $('expTs').textContent = s.tsPath;
  $('expDims').textContent = `${s.width} × ${s.height} px`;
  $('expCount').textContent = String(s.spriteCount);
  $('expSize').textContent = formatBytes(s.pngBytes);
  $('expUsed').textContent = `${s.usedPct.toFixed(1)}%`;
  $('btnOpenFolder').onclick = () => native.showInFolder(s.pngPath);
  $('modalRoot').classList.add('visible');
}

$('btnCloseModal').addEventListener('click', () => $('modalRoot').classList.remove('visible'));
$('modalRoot').addEventListener('click', (e) => {
  if (e.target === $('modalRoot')) $('modalRoot').classList.remove('visible');
});

// ---------------------------------------------------------------------------
// Toolbar / title / empty state
// ---------------------------------------------------------------------------
// Spine Animation lives in its own workflow; loaded on first use so the
// Spine runtime is not paid for by the normal atlas editing path.
let animReExport = null;
export async function openAnimationReExport() {
  if (!animReExport) {
    const { AnimationReExport } = await import('./animre.js');
    animReExport = new AnimationReExport({ toast });
  }
  animReExport.open();
  return animReExport;
}

// Bitmap-font editing is an independent, lazy workflow. Its glyphs, packing
// settings and dirty state never enter the normal texture-atlas project.
let bitmapFontExporter = null;
export async function openBitmapFontExporter() {
  if (!bitmapFontExporter) {
    const { BitmapFontExporter } = await import('./bitmapfont.js');
    bitmapFontExporter = new BitmapFontExporter({ toast, choiceDialog });
  }
  bitmapFontExporter.open();
  return bitmapFontExporter;
}

// Keep application-level workflows behind one compact launcher. The workflow
// implementations remain lazy and isolated; this only centralizes switching,
// native-menu routing and the visible current-workflow state.
function activeWorkflow() {
  if (rootVisible('fontRoot')) return 'font';
  if (rootVisible('animRoot')) return 'spine';
  return 'atlas';
}

function setWorkflowMenuOpen(open) {
  const menu = $('workflowMenu');
  const trigger = $('btnWorkflows');
  menu.classList.toggle('visible', open);
  menu.setAttribute('aria-hidden', String(!open));
  trigger.setAttribute('aria-expanded', String(open));
}

function syncWorkflowLauncher() {
  const current = activeWorkflow();
  const items = {
    atlas: $('workflowAtlas'),
    spine: $('workflowSpine'),
    font: $('workflowFont'),
  };
  for (const [workflow, item] of Object.entries(items)) {
    const isCurrent = workflow === current;
    item.classList.toggle('active', isCurrent);
    if (isCurrent) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const label = current === 'spine' ? 'Spine Animation' : current === 'font' ? 'Bitmap Font' : 'Texture Atlas';
  $('btnWorkflows').title = `Choose a workflow (current: ${label})`;
}

async function activateWorkflow(workflow) {
  setWorkflowMenuOpen(false);

  // Bitmap Font owns independent dirty state and may refuse to close until the
  // user decides what to do with unexported changes.
  if (workflow !== 'font' && rootVisible('fontRoot')) {
    const closed = await bitmapFontExporter?.close();
    if (!closed) {
      syncWorkflowLauncher();
      return false;
    }
  }
  if (workflow !== 'spine' && rootVisible('animRoot')) animReExport?.close();

  if (workflow === 'spine') await openAnimationReExport();
  else if (workflow === 'font') await openBitmapFontExporter();

  syncWorkflowLauncher();
  refreshTitle();
  return true;
}

$('btnWorkflows').addEventListener('click', () => {
  setWorkflowMenuOpen(!$('workflowMenu').classList.contains('visible'));
});
$('workflowAtlas').addEventListener('click', () => activateWorkflow('atlas'));
$('workflowSpine').addEventListener('click', () => activateWorkflow('spine'));
$('workflowFont').addEventListener('click', () => activateWorkflow('font'));
document.addEventListener('pointerdown', (e) => {
  if (!$('workflowLauncher').contains(e.target)) setWorkflowMenuOpen(false);
});
$('workflowLauncher').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setWorkflowMenuOpen(false);
    $('btnWorkflows').focus();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  setWorkflowMenuOpen(true);
  const items = [$('workflowAtlas'), $('workflowSpine'), $('workflowFont')];
  const index = items.indexOf(document.activeElement);
  const next = index < 0
    ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
    : e.key === 'ArrowDown'
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
  items[next].focus();
});
window.addEventListener('blur', () => setWorkflowMenuOpen(false));
syncWorkflowLauncher();

$('btnOpen').addEventListener('click', openAtlasFlow);
$('btnAdd').addEventListener('click', addImagesFlow);
$('btnRepack').addEventListener('click', () => {
  repackNow();
  toast('Atlas repacked.');
});
$('btnSettings').addEventListener('click', () => {
  const details = $('settingsSection');
  details.open = true;
  details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  details.classList.remove('flash');
  requestAnimationFrame(() => details.classList.add('flash'));
});
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnExport').addEventListener('click', exportFlow);
$('btnAddLeft').addEventListener('click', addImagesFlow);
$('btnDeleteLeft').addEventListener('click', () => deleteSprites([...state.selection]));
$('btnEmptyOpen').addEventListener('click', openAtlasFlow);
$('btnEmptyAdd').addEventListener('click', addImagesFlow);

$('btnZoomIn').addEventListener('click', () => preview.zoomCenter(1.25));
$('btnZoomOut').addEventListener('click', () => preview.zoomCenter(1 / 1.25));
$('btnZoomFit').addEventListener('click', () => preview.fit());
$('btnZoom100').addEventListener('click', () => preview.zoomTo(1));
$('chkOutlines').addEventListener('change', (e) => {
  preview.showOutlines = e.target.checked;
  preview.requestDraw();
});
$('chkLabels').addEventListener('change', (e) => {
  preview.showLabels = e.target.checked;
  preview.requestDraw();
});

function refreshHistoryButtons() {
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();
}
bus.on('history', refreshHistoryButtons);
refreshHistoryButtons();

function refreshTitle() {
  const workflow = activeWorkflow();
  $('dirtyDot').classList.toggle('visible', workflow === 'atlas' && state.dirty);
  if (workflow === 'spine') {
    document.title = 'Exporter — Spine Animation';
    return;
  }
  if (workflow === 'font') {
    document.title = 'Exporter — Bitmap Font';
    return;
  }
  const name = state.meta.pngName ? stripExt(state.meta.pngName) : 'untitled';
  document.title = `Exporter — Texture Atlas — ${name}${state.dirty ? ' •' : ''}`;
}
bus.on('dirty', refreshTitle);
bus.on('project', refreshTitle);
refreshTitle();

// Workflow dialogs control their own close buttons. Watching their root class
// keeps the launcher and window title correct even when they close themselves.
const workflowObserver = new MutationObserver(() => {
  syncWorkflowLauncher();
  refreshTitle();
});
workflowObserver.observe($('animRoot'), { attributes: true, attributeFilter: ['class'] });
workflowObserver.observe($('fontRoot'), { attributes: true, attributeFilter: ['class'] });

function refreshEmptyState() {
  $('emptyState').classList.toggle('hidden', state.sprites.length > 0);
}
bus.on('sprites', refreshEmptyState);
bus.on('project', refreshEmptyState);
refreshEmptyState();

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (inField) return; // let text fields keep native behaviour
  if (modalIsOpen()) return; // dialogs own the keyboard while visible

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if ((ctrl && e.key.toLowerCase() === 'y') || (ctrl && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault();
    redo();
  } else if (ctrl && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(state.sprites.map((s) => s.id));
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSprites([...state.selection]);
  } else if (e.key === 'F2') {
    e.preventDefault();
    if (state.selection.size === 1) inspector.startRename();
  } else if (e.key === 'Escape') {
    setSelection([]);
  } else if (ctrl && e.key === '0') {
    e.preventDefault();
    preview.fit();
  } else if (ctrl && e.key === '1') {
    e.preventDefault();
    preview.zoomTo(1);
  } else if (e.key === '+' || e.key === '=') {
    preview.zoomCenter(1.25);
  } else if (e.key === '-') {
    preview.zoomCenter(1 / 1.25);
  }
});

// ---------------------------------------------------------------------------
// Menu events
// ---------------------------------------------------------------------------
native.onMenu((id) => {
  // A full-window workflow owns the workspace while visible. Native menu
  // accelerators arrive independently of DOM focus, so only workflow switching
  // remains available instead of mutating the hidden texture-atlas project.
  const workflowCommands = new Set([
    'workflow-atlas', 'workflow-spine', 'workflow-font',
    // Backward-compatible aliases for any older smoke helpers or callers.
    'anim-reexport', 'font-exporter',
  ]);
  if ((rootVisible('fontRoot') || rootVisible('animRoot')) && !workflowCommands.has(id)) return;

  const handlers = {
    'open-atlas': openAtlasFlow,
    'add-images': addImagesFlow,
    'workflow-atlas': () => activateWorkflow('atlas'),
    'workflow-spine': () => activateWorkflow('spine'),
    'workflow-font': () => activateWorkflow('font'),
    'anim-reexport': () => activateWorkflow('spine'),
    'font-exporter': () => activateWorkflow('font'),
    export: exportFlow,
    undo,
    redo,
    'select-all': () => setSelection(state.sprites.map((s) => s.id)),
    'delete-selected': () => deleteSprites([...state.selection]),
    'zoom-in': () => preview.zoomCenter(1.25),
    'zoom-out': () => preview.zoomCenter(1 / 1.25),
    'zoom-fit': () => preview.fit(),
    'zoom-100': () => preview.zoomTo(1),
  };
  handlers[id]?.();
});

setupDragDrop();

// ---------------------------------------------------------------------------
// Smoke test bootstrap (only when launched with --smoke-test)
// ---------------------------------------------------------------------------
(async () => {
  const cfg = await native.getLaunchConfig();
  if (cfg?.smoke) {
    const { runSmokeTest } = await import('./smoketest.js');
    runSmokeTest(cfg.smoke);
  }
})();
