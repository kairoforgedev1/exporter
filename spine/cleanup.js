'use strict';
// Removing stale files from an exported package folder.
//
// This deletes files inside the user's real project, so every rule here is a
// refusal rather than a permission. The folder is treated as flat: only its
// direct children are ever considered, only regular files, only the extensions
// this exporter itself emits, and never anything the export just wrote. A
// symlink, a subfolder, a README, a .gitkeep or an .psd someone parked in the
// folder is left alone no matter what, because nothing here can know it is safe
// to delete.

const path = require('path');
const fsp = require('fs/promises');

/**
 * Only file types the animation exporter produces. A stale file of some other
 * type is not ours to remove — the user put it there.
 */
const REMOVABLE_EXTENSIONS = new Set(['.png', '.webp', '.atlas', '.json', '.ts']);

/** Windows filenames are case-insensitive: never delete a file we just wrote
 *  because the manifest recorded a different case. */
const foldCase = (name) =>
  process.platform === 'win32' ? String(name).toLowerCase() : String(name);

function keepSetOf(keep) {
  const set = new Set();
  for (const name of keep || []) {
    if (typeof name === 'string' && name) set.add(foldCase(name));
  }
  return set;
}

/**
 * List what a cleanup would remove, without deleting anything.
 *
 * @param {{outDir: string, keep: string[]}} options
 *   `keep` is the manifest of files the export just wrote.
 * @returns {Promise<{ok: boolean, outDir?: string, removable?: Array, kept?: Array, error?: string}>}
 */
async function planPackageCleanup({ outDir, keep } = {}) {
  if (typeof outDir !== 'string' || !outDir || outDir.includes('\0')) {
    return { ok: false, error: 'A package output directory is required.' };
  }

  const resolved = path.resolve(outDir);
  const dirStat = await fsp.lstat(resolved).catch(() => null);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    return { ok: false, error: 'The package output folder does not exist as a real directory.' };
  }

  const keepSet = keepSetOf(keep);
  if (!keepSet.size) {
    // Cleaning against an empty manifest would delete the package we just
    // wrote. Refuse rather than interpret it as "remove everything".
    return { ok: false, error: 'Refusing to clean up without the list of exported files.' };
  }

  let entries;
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: `Could not read the output folder: ${error.message}` };
  }

  const removable = [];
  const kept = [];
  for (const entry of entries) {
    const name = entry.name;
    if (keepSet.has(foldCase(name))) {
      kept.push({ name, reason: 'just exported' });
      continue;
    }
    if (entry.isDirectory()) {
      kept.push({ name, reason: 'folder' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      kept.push({ name, reason: 'symlink' });
      continue;
    }
    if (!REMOVABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      kept.push({ name, reason: 'not a file type this exporter writes' });
      continue;
    }
    // Re-check against the filesystem: a dirent can be stale by the time we
    // act on it, and a symlink must never be followed into a delete.
    const stat = await fsp.lstat(path.join(resolved, name)).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      kept.push({ name, reason: 'not a regular file' });
      continue;
    }
    removable.push({ name, bytes: stat.size });
  }

  removable.sort((a, b) => a.name.localeCompare(b.name));
  kept.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, outDir: resolved, removable, kept };
}

/**
 * Delete stale files. Re-plans first and only ever removes the intersection of
 * `names` with a freshly validated plan, so anything that changed on disk
 * between the preview and the confirmation is skipped rather than deleted.
 */
async function applyPackageCleanup({ outDir, keep, names } = {}) {
  const plan = await planPackageCleanup({ outDir, keep });
  if (!plan.ok) return plan;

  const requested = Array.isArray(names)
    ? new Set(names.map(foldCase))
    : null;

  const removed = [];
  const failed = [];
  for (const file of plan.removable) {
    if (requested && !requested.has(foldCase(file.name))) continue;
    try {
      await fsp.unlink(path.join(plan.outDir, file.name));
      removed.push(file);
    } catch (error) {
      failed.push({ name: file.name, error: error.message });
    }
  }

  return { ok: true, outDir: plan.outDir, removed, failed, kept: plan.kept };
}

module.exports = { planPackageCleanup, applyPackageCleanup, REMOVABLE_EXTENSIONS };
