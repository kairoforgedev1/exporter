// Removing stale files from an exported package folder.
//
// This code deletes files inside the user's real project, so the tests are
// mostly about what it must REFUSE to touch. Every case below runs against a
// real temporary directory, not a mock.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { planPackageCleanup, applyPackageCleanup } = require(join(root, 'spine', 'cleanup.js'));

/** A package folder holding the fresh export plus whatever else is listed. */
function folder(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-editor-cleanup-'));
  const keep = ['symbols.atlas', 'symbols.png', 'symbols.json', 'index.ts'];
  for (const name of keep) writeFileSync(join(dir, name), `fresh ${name}`);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
  return { dir, keep };
}

const names = (list) => list.map((f) => f.name).sort();

test('stale package files are removed and the fresh export is kept', async () => {
  const { dir, keep } = folder({
    'old_atlas.png': 'stale',
    'old_atlas.webp': 'stale',
    'old_atlas.atlas': 'stale',
    'previous.json': 'stale',
  });

  const plan = await planPackageCleanup({ outDir: dir, keep });
  assert.equal(plan.ok, true, plan.error);
  assert.deepEqual(names(plan.removable), [
    'old_atlas.atlas',
    'old_atlas.png',
    'old_atlas.webp',
    'previous.json',
  ]);
  // Planning must not delete anything.
  assert.equal(readdirSync(dir).length, 8);

  const result = await applyPackageCleanup({ outDir: dir, keep });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.removed.length, 4);
  assert.equal(result.failed.length, 0);
  for (const name of keep) assert.ok(existsSync(join(dir, name)), `${name} must survive`);
  assert.equal(readdirSync(dir).length, 4);
});

test('file types this exporter never writes are left alone', async () => {
  const untouchable = {
    'README.md': 'docs',
    '.gitkeep': '',
    'source.psd': 'art',
    'notes.txt': 'notes',
    'symbols.atlas.bak': 'backup',
    'archive.zip': 'zip',
  };
  const { dir, keep } = folder(untouchable);

  const result = await applyPackageCleanup({ outDir: dir, keep });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.removed.length, 0, 'nothing of an unknown type may be deleted');
  for (const name of Object.keys(untouchable)) {
    assert.ok(existsSync(join(dir, name)), `${name} must survive`);
  }
});

test('subfolders and their contents are never touched', async () => {
  const { dir, keep } = folder({ 'stale.png': 'stale' });
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'deep.png'), 'nested art');
  mkdirSync(join(dir, 'nested', 'deeper'));
  writeFileSync(join(dir, 'nested', 'deeper', 'deeper.json'), '{}');

  const plan = await planPackageCleanup({ outDir: dir, keep });
  assert.equal(plan.ok, true, plan.error);
  assert.deepEqual(names(plan.removable), ['stale.png'], 'cleanup must not recurse');
  assert.ok(plan.kept.some((k) => k.name === 'nested' && k.reason === 'folder'));

  await applyPackageCleanup({ outDir: dir, keep });
  assert.ok(existsSync(join(dir, 'nested', 'deep.png')));
  assert.ok(existsSync(join(dir, 'nested', 'deeper', 'deeper.json')));
});

test('an empty keep manifest is refused rather than read as "delete everything"', async () => {
  const { dir } = folder({ 'stale.png': 'stale' });
  for (const keep of [[], undefined, null, ['']]) {
    const plan = await planPackageCleanup({ outDir: dir, keep });
    assert.equal(plan.ok, false, `keep=${JSON.stringify(keep)} must be refused`);
    assert.match(plan.error, /without the list of exported files/i);

    const applied = await applyPackageCleanup({ outDir: dir, keep });
    assert.equal(applied.ok, false);
  }
  assert.equal(readdirSync(dir).length, 5, 'nothing may have been deleted');
});

test('a missing or non-directory target is refused', async () => {
  const { dir, keep } = folder();
  const cases = [
    [join(dir, 'does-not-exist'), /does not exist/i],
    [join(dir, 'symbols.png'), /does not exist as a real directory/i],
    ['', /output directory is required/i],
    [undefined, /output directory is required/i],
  ];
  for (const [outDir, expected] of cases) {
    const plan = await planPackageCleanup({ outDir, keep });
    assert.equal(plan.ok, false, `${outDir} should be refused`);
    assert.match(plan.error, expected);
  }
});

test('apply only removes what the caller listed, intersected with a fresh plan', async () => {
  const { dir, keep } = folder({ 'a_stale.png': 'a', 'b_stale.png': 'b', 'c_stale.json': 'c' });

  const result = await applyPackageCleanup({ outDir: dir, keep, names: ['a_stale.png'] });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(names(result.removed), ['a_stale.png']);
  assert.ok(!existsSync(join(dir, 'a_stale.png')));
  assert.ok(existsSync(join(dir, 'b_stale.png')), 'unlisted files must survive');
  assert.ok(existsSync(join(dir, 'c_stale.json')));

  // A name that is not in the plan cannot smuggle a deletion through.
  const sneaky = await applyPackageCleanup({
    outDir: dir,
    keep,
    names: ['symbols.png', 'README.md', '../outside.png'],
  });
  assert.equal(sneaky.ok, true, sneaky.error);
  assert.equal(sneaky.removed.length, 0);
  for (const name of keep) assert.ok(existsSync(join(dir, name)), `${name} must survive`);
});

test('the fresh export survives a case-differing manifest on case-insensitive filesystems', async () => {
  const { dir } = folder();
  const result = await applyPackageCleanup({
    outDir: dir,
    keep: ['SYMBOLS.ATLAS', 'Symbols.PNG', 'symbols.json', 'Index.ts'],
  });
  assert.equal(result.ok, true, result.error);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(result.removed.length, 0, 'a case difference must not delete the fresh export');
    assert.equal(readdirSync(dir).length, 4);
  }
});

test('symlinks are never followed into a delete', { skip: symlinkSupport() }, async () => {
  const { dir, keep } = folder();
  const outside = mkdtempSync(join(tmpdir(), 'atlas-editor-outside-'));
  const precious = join(outside, 'precious.png');
  writeFileSync(precious, 'do not delete me');
  symlinkSync(precious, join(dir, 'link.png'));

  const plan = await planPackageCleanup({ outDir: dir, keep });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.removable.length, 0, 'a symlink must never be removable');
  assert.ok(plan.kept.some((k) => k.name === 'link.png'));

  await applyPackageCleanup({ outDir: dir, keep });
  assert.ok(existsSync(precious), 'the symlink target must be untouched');
});

/** Creating symlinks needs privileges or Developer Mode on Windows. */
function symlinkSupport() {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'atlas-editor-symprobe-'));
    writeFileSync(join(probe, 'target'), 'x');
    symlinkSync(join(probe, 'target'), join(probe, 'link'));
    return false;
  } catch {
    return 'symlinks are not creatable in this environment';
  }
}
