// Central project state: sprite list, packing settings, selection, undo/redo
// history, dirty tracking and the automatic repack pipeline.

import { Emitter, uid } from './util.js';
import { pack } from './packer.js';
import { computeTrim, buildAtlas } from './atlasio.js';

export const bus = new Emitter();

export const DEFAULT_SETTINGS = {
  padding: 2,
  border: 1,
  maxWidth: 4096,
  maxHeight: 4096,
  powerOfTwo: false,
  square: false,
  allowRotation: true,
  trim: true,
  extrude: 0,
};

export const state = {
  /** @type {Array<object>} sprite: {id, name, source, sw, sh, imageRev, trim,
   *  trimRev, status:{added,replaced,renamed}, originalName} */
  sprites: [],
  settings: { ...DEFAULT_SETTINGS },
  meta: { pngName: null, jsonName: null, dir: null, scale: '1' },
  /** last pack result: {width, height, placed, usedPct, failedIds, atlasCanvas, rev} */
  pack: null,
  selection: new Set(),
  dirty: false,
};

let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 100;
let packTimer = null;
let packRev = 0;

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

export function makeSprite(name, canvas, statusFlags = {}, extra = {}) {
  return {
    id: uid(),
    name,
    source: canvas,
    sw: canvas.width,
    sh: canvas.height,
    imageRev: 0,
    trim: null,
    trimRev: -1,
    status: { added: false, replaced: false, renamed: false, ...statusFlags },
    originalName: name,
    // Everything the atlas editor holds is a static image; the field exists so
    // image-only tools can refuse anything that is not one.
    kind: 'static',
    ...extra,
  };
}

/** Static raster images are the only thing the blur tool may touch. */
export const isStaticImage = (sprite) => !!sprite && sprite.kind === 'static';

/** True when every listed sprite can have a blurred variant generated. */
export function canBlur(ids) {
  const list = [...ids];
  if (!list.length) return false;
  return list.every((id) => isStaticImage(getSprite(id)));
}

export function getSprite(id) {
  return state.sprites.find((s) => s.id === id);
}

export function statusOf(sprite) {
  if (sprite.status.added) return 'added';
  if (sprite.status.replaced) return 'replaced';
  if (sprite.status.renamed) return 'renamed';
  return 'unchanged';
}

export function uniqueName(desired) {
  const names = new Set(state.sprites.map((s) => s.name));
  if (!names.has(desired)) return desired;
  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!names.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    sprites: state.sprites.map((s) => ({ ...s, status: { ...s.status } })),
    settings: { ...state.settings },
  };
}

function restore(snap) {
  state.sprites = snap.sprites.map((s) => ({ ...s, status: { ...s.status } }));
  state.settings = { ...snap.settings };
  const ids = new Set(state.sprites.map((s) => s.id));
  state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
  bus.emit('sprites');
  bus.emit('settings');
  bus.emit('selection');
  setDirty(true);
  schedulePack();
}

/** Apply an undoable mutation to sprites and/or settings. */
export function commit(mutator) {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  mutator();
  const ids = new Set(state.sprites.map((s) => s.id));
  state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
  bus.emit('sprites');
  bus.emit('settings');
  bus.emit('selection');
  bus.emit('history');
  setDirty(true);
  schedulePack();
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  bus.emit('history');
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  bus.emit('history');
}

export function setDirty(d) {
  if (state.dirty === d) return;
  state.dirty = d;
  window.native.setDirty(d);
  bus.emit('dirty');
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function setSelection(ids) {
  state.selection = new Set(ids);
  bus.emit('selection');
}

export function toggleSelected(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  bus.emit('selection');
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

/**
 * Replace the whole project (atlas import). Resets history and dirty flag.
 * When `initialPack` is given (the layout read from the imported JSON), it is
 * shown as-is; automatic repacking takes over on the first edit.
 */
export function loadProject(sprites, meta, initialPack = null) {
  state.sprites = sprites;
  state.meta = { ...state.meta, ...meta };
  state.selection = new Set();
  undoStack = [];
  redoStack = [];
  bus.emit('sprites');
  bus.emit('selection');
  bus.emit('history');
  bus.emit('project');
  state.dirty = false;
  window.native.setDirty(false);
  bus.emit('dirty');
  if (initialPack) {
    clearTimeout(packTimer);
    packTimer = null;
    state.pack = { ...initialPack, rev: ++packRev };
    bus.emit('pack');
  } else {
    schedulePack();
  }
}

export function addSprites(list) {
  const added = [];
  commit(() => {
    for (const { name, canvas, extra } of list) {
      const sprite = makeSprite(uniqueName(name), canvas, { added: true }, extra);
      state.sprites.push(sprite);
      added.push(sprite.id);
    }
  });
  setSelection(added);
  return added;
}

export function removeSprites(ids) {
  const kill = new Set(ids);
  commit(() => {
    state.sprites = state.sprites.filter((s) => !kill.has(s.id));
  });
}

export function renameSprite(id, newName) {
  commit(() => {
    const s = getSprite(id);
    if (!s) return;
    s.name = newName;
    if (!s.status.added) s.status.renamed = s.name !== s.originalName;
  });
}

export function replaceSpriteImage(id, canvas) {
  applyImages([{ id, canvas }], []);
}

/**
 * Replace images of existing sprites and add new ones in a single undo step.
 * @param {Array<{id:number,canvas:HTMLCanvasElement}>} replaceList
 * @param {Array<{name:string,canvas:HTMLCanvasElement}>} addList
 */
export function applyImages(replaceList, addList) {
  const addedIds = [];
  commit(() => {
    for (const { id, canvas } of replaceList) {
      const s = getSprite(id);
      if (!s) continue;
      s.source = canvas;
      s.sw = canvas.width;
      s.sh = canvas.height;
      s.imageRev++;
      if (!s.status.added) s.status.replaced = true;
    }
    for (const { name, canvas } of addList) {
      const sprite = makeSprite(uniqueName(name), canvas, { added: true });
      state.sprites.push(sprite);
      addedIds.push(sprite.id);
    }
  });
  setSelection(addedIds.length ? addedIds : replaceList.map((r) => r.id));
  return addedIds;
}

export function updateSettings(partial) {
  commit(() => {
    Object.assign(state.settings, partial);
  });
}

// ---------------------------------------------------------------------------
// Packing pipeline
// ---------------------------------------------------------------------------

function trimOf(sprite) {
  if (!state.settings.trim) {
    return { x: 0, y: 0, w: sprite.sw, h: sprite.sh, trimmed: false };
  }
  if (sprite.trimRev !== sprite.imageRev) {
    sprite.trim = computeTrim(sprite.source);
    sprite.trimRev = sprite.imageRev;
  }
  return sprite.trim;
}

export function schedulePack() {
  clearTimeout(packTimer);
  packTimer = setTimeout(repackNow, 50);
}

/** Run the packer synchronously and rebuild the atlas canvas. */
export function repackNow() {
  clearTimeout(packTimer);
  packTimer = null;

  if (!state.sprites.length) {
    state.pack = null;
    bus.emit('pack');
    return null;
  }

  const e = state.settings.extrude | 0;
  const items = state.sprites.map((s) => {
    const t = trimOf(s);
    return { id: s.id, w: t.w + e * 2, h: t.h + e * 2 };
  });

  const result = pack(items, state.settings);

  const placed = [];
  for (const p of result.placed) {
    const sprite = getSprite(p.id);
    const t = trimOf(sprite);
    placed.push({
      sprite,
      trim: t,
      // Position of the sprite's pixel region (the packer rect includes the
      // extrusion margin on every side).
      x: p.x + e,
      y: p.y + e,
      rotated: p.rotated,
      regionW: p.rotated ? t.h : t.w,
      regionH: p.rotated ? t.w : t.h,
    });
  }

  const atlasCanvas = buildAtlas(placed, result.width, result.height, state.settings);
  let usedPixels = 0;
  for (const p of placed) usedPixels += p.trim.w * p.trim.h;
  const total = result.width * result.height;

  state.pack = {
    width: result.width,
    height: result.height,
    placed,
    failedIds: result.failedIds,
    usedPct: total > 0 ? (usedPixels / total) * 100 : 0,
    atlasCanvas,
    rev: ++packRev,
  };
  bus.emit('pack');
  return state.pack;
}

/** Ensure any pending debounced repack has run; returns the current pack. */
export function flushPack() {
  if (packTimer) repackNow();
  return state.pack;
}
