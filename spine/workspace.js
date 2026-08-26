'use strict';
// Main-process support for the Spine Animation workflow:
//   - reading an animator-delivered folder or .zip into a temp workspace
//   - inspecting a Stake Engine web-sdk app for its asset conventions
//   - appending spine entries to the app's src/game/assets.ts
//
// Source files are only ever READ. Everything the tool produces goes to a
// temporary workspace or to an explicitly chosen output directory.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const toPosix = (p) => p.split(path.sep).join('/');
const SPINE_TEXTURE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// ZIP reading (stored + deflate, which is everything a normal archiver emits)
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('Not a ZIP archive (file is too small).');
  }
  // Locate the End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let totalUncompressedSize = 0;

  for (let n = 0; n < count; n++) {
    if (offset < 0 || offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP central directory at entry ${n + 1}.`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLen + extraLen + commentLen;
    if (nextOffset > buf.length) {
      throw new Error(`Corrupt ZIP metadata at entry ${n + 1}.`);
    }
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (!name || name.includes('\0')) {
      throw new Error(`ZIP entry ${n + 1} has an invalid filename.`);
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`ZIP entry is too large to import safely: ${name}`);
    }
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('ZIP expands beyond the 1 GB animation import limit.');
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset = nextOffset;
  }

  return entries.map((entry) => {
    if (/[\\/]$/.test(entry.name)) return { ...entry, data: null };
    const lo = entry.localOffset;
    if (lo < 0 || lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP entry: ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    if (start > buf.length || start + entry.compressedSize > buf.length) {
      throw new Error(`Truncated ZIP entry: ${entry.name}`);
    }
    const raw = buf.subarray(start, start + entry.compressedSize);
    let data;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) {
      data = zlib.inflateRawSync(raw, {
        maxOutputLength: Math.min(
          entry.uncompressedSize + 1,
          MAX_ZIP_ENTRY_BYTES + 1
        ),
      });
    }
    else throw new Error(`Unsupported ZIP compression method ${entry.method} in ${entry.name}`);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP entry size mismatch: ${entry.name}`);
    }
    return { ...entry, data };
  });
}

/** Extract a zip into a fresh temp workspace directory. */
async function extractZip(zipPath) {
  const buf = await fsp.readFile(zipPath);
  const entries = readZipEntries(buf);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-editor-anim-'));
  const resolvedDir = path.resolve(dir);
  for (const entry of entries) {
    if (!entry.data) continue;
    // Guard against zip-slip.
    const dest = path.resolve(resolvedDir, entry.name);
    const relative = path.relative(resolvedDir, dest);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, entry.data);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Animation source scanning
// ---------------------------------------------------------------------------
async function walk(dir, depth = 0, out = []) {
  if (depth > 5) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else out.push(full);
  }
  return out;
}

/** Page image names declared by an atlas, in declaration order. */
function atlasPageNames(atlasText) {
  const names = [];
  let expectPage = true;
  for (const raw of atlasText.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      expectPage = true;
      continue;
    }
    if (expectPage && !line.includes(':')) {
      names.push(line);
      expectPage = false;
    }
  }
  return names;
}

/**
 * A Photoshop→Spine import descriptor — the JSON the animator's Photoshop
 * script emits so the layered art can be *imported* into Spine to start
 * rigging. It is authoring input, not a runtime export, and it lives beside
 * the raw layer PNGs in the source `images/` folder. It structurally looks
 * like a skeleton (bones/skins/animations) so it must be excluded explicitly.
 * Tells: a `PhotoshopToSpine` block, or a `skeleton` that only points at an
 * images path and carries no `spine` version (a real export always does).
 */
function isSpineSourceJson(json) {
  if (!json) return false;
  if (json.PhotoshopToSpine) return true;
  return !!(json.skeleton && json.skeleton.images && !json.skeleton.spine);
}

/** Quick structural test — is this JSON a Spine *runtime* skeleton, not data? */
function isSkeletonJson(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json || (!json.bones && !json.skeleton)) return false;
    if (isSpineSourceJson(json)) return false;
    return !!(json.skins || json.animations);
  } catch {
    return false;
  }
}

/** Does this JSON file read as a Photoshop→Spine import descriptor? */
function isSpineSourceFile(file) {
  try {
    return isSpineSourceJson(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Group the files of an animator delivery into spine packages.
 *
 * A package is one `.atlas` plus every skeleton JSON that belongs to it and
 * every texture page it declares. An atlas may legitimately serve SEVERAL
 * skeletons (e.g. mobile/desktop variants of one feature sharing one atlas)
 * and may declare SEVERAL texture pages.
 *
 * Skeletons are attributed to an atlas by name, most specific first:
 *   1. exact base-name match      lp1.json      <- lp1.atlas
 *   2. prefix match               fs_meter_*.json <- fs_meter.atlas
 *   3. sole atlas in the folder   anything.json <- the only .atlas there
 * so a folder of independent one-to-one packages and a folder holding one
 * shared multi-skeleton package both resolve correctly.
 */
async function scanAnimationSource(rootDir) {
  const files = await walk(rootDir);
  const atlasFiles = files.filter((f) => f.toLowerCase().endsWith('.atlas'));
  const jsonFiles = files.filter((f) => f.toLowerCase().endsWith('.json'));

  const skeletonFiles = jsonFiles.filter(isSkeletonJson);
  const otherJson = jsonFiles.filter((f) => !skeletonFiles.includes(f));
  // Photoshop→Spine import descriptors: not deliverables, but worth naming so
  // it is never a mystery why they didn't surface as skeletons.
  const spineSourceJson = otherJson.filter(isSpineSourceFile);
  const nonSkeletonJson = otherJson.filter((f) => !spineSourceJson.includes(f));

  const claimed = new Set();
  const packages = [];

  for (const atlasFile of atlasFiles) {
    const dir = path.dirname(atlasFile);
    const base = path.basename(atlasFile, path.extname(atlasFile));

    let atlasText = '';
    try {
      atlasText = await fsp.readFile(atlasFile, 'utf8');
    } catch (e) {
      packages.push({
        name: base,
        dir: toPosix(dir),
        atlasPath: toPosix(atlasFile),
        error: `Could not read atlas: ${e.message}`,
        skeletonPaths: [],
        textures: [],
      });
      continue;
    }

    const resolvedDir = path.resolve(dir);
    const textures = atlasPageNames(atlasText).map((name) => {
      const abs = path.resolve(resolvedDir, name);
      const relative = path.relative(resolvedDir, abs);
      const unsafe =
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative);
      return {
        name,
        path: toPosix(abs),
        exists: !unsafe && fs.existsSync(abs),
        unsafe,
      };
    });

    const siblings = skeletonFiles.filter((f) => path.dirname(f) === dir);
    const atlasesHere = atlasFiles.filter((f) => path.dirname(f) === dir);

    const exact = siblings.filter((f) => path.basename(f, '.json') === base);
    const prefixed = siblings.filter((f) => {
      const name = path.basename(f, '.json');
      return name !== base && (name.startsWith(`${base}_`) || name.startsWith(`${base}-`));
    });

    let attributed;
    if (exact.length || prefixed.length) {
      attributed = [...exact, ...prefixed];
    } else if (atlasesHere.length === 1) {
      // A single atlas in the folder owns every skeleton beside it.
      attributed = siblings;
    } else {
      attributed = [];
    }
    attributed = attributed.filter((f) => !claimed.has(f));
    for (const f of attributed) claimed.add(f);

    packages.push({
      name: base,
      dir: toPosix(dir),
      atlasPath: toPosix(atlasFile),
      atlasText,
      skeletonPaths: attributed.map(toPosix),
      textures,
    });
  }

  // Skeletons that no atlas claimed: an incomplete delivery, surfaced not hidden.
  const orphanSkeletons = skeletonFiles.filter((f) => !claimed.has(f)).map(toPosix);

  packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    root: toPosix(rootDir),
    packages,
    looseJson: orphanSkeletons,
    spineSourceJson: spineSourceJson.map(toPosix),
    ignoredJson: nonSkeletonJson.map(toPosix),
  };
}

// ---------------------------------------------------------------------------
// Stake Engine project inspection
// ---------------------------------------------------------------------------
const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

/** Find candidate web-sdk apps under a chosen root. */
function findApps(root) {
  const apps = [];
  const candidates = [root, path.join(root, 'web-sdk'), path.join(root, 'apps')];
  for (const base of candidates) {
    const appsDir = path.basename(base) === 'apps' ? base : path.join(base, 'apps');
    if (!fs.existsSync(appsDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(appsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const appDir = path.join(appsDir, entry.name);
      if (fs.existsSync(path.join(appDir, 'src', 'game', 'assets.ts'))) {
        apps.push({ name: entry.name, dir: toPosix(appDir) });
      }
    }
    if (apps.length) break;
  }
  // The chosen folder may itself be an app.
  if (!apps.length && fs.existsSync(path.join(root, 'src', 'game', 'assets.ts'))) {
    apps.push({ name: path.basename(root), dir: toPosix(root) });
  }
  return apps;
}

/** Read the spine runtime version the app's SDK actually ships. */
function detectRuntimeVersion(appDir) {
  const roots = [];
  let cur = path.resolve(appDir);
  for (let i = 0; i < 5; i++) {
    roots.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const seen = [];
  for (const root of roots) {
    for (const rel of [
      path.join('packages', 'pixi-svelte', 'package.json'),
      path.join('node_modules', 'pixi-svelte', 'package.json'),
      'package.json',
    ]) {
      const pkgPath = path.join(root, rel);
      const text = readIfExists(pkgPath);
      if (!text) continue;
      try {
        const pkg = JSON.parse(text);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        for (const [name, version] of Object.entries(deps || {})) {
          if (name.includes('spine')) {
            seen.push({ package: name, version: String(version).replace(/^[\^~]/, ''), from: toPosix(pkgPath) });
          }
        }
      } catch {
        /* ignore malformed package.json */
      }
    }
    if (seen.length) break;
  }
  const pixi = seen.find((s) => s.package.includes('spine-pixi')) || seen[0] || null;
  return { runtime: pixi, all: seen };
}

/** Parse assets.ts for existing keys, registered paths and spine conventions. */
function parseAssetsTs(source) {
  const registeredPaths = new Set();
  for (const match of source.matchAll(/new URL\(\s*'([^']+)'/g)) {
    registeredPaths.add(match[1].replace(/^(\.\.\/)+assets\//, ''));
  }
  const keys = new Set();
  for (const match of source.matchAll(/^\t([A-Za-z_$][\w$]*)\s*:\s*\{/gm)) keys.add(match[1]);

  // Spine entries: capture atlas/skeleton/scale so we can mirror the convention.
  const spineEntries = [];
  const entryRe =
    /^\t([A-Za-z_$][\w$]*)\s*:\s*\{\s*\n\t{2}type:\s*'spine',\s*\n\t{2}src:\s*\{([\s\S]*?)\n\t{2}\},/gm;
  for (const match of source.matchAll(entryRe)) {
    const body = match[2];
    const atlas = /atlas:\s*new URL\(\s*'([^']+)'/.exec(body);
    const skeleton = /skeleton:\s*new URL\(\s*'([^']+)'/.exec(body);
    const scale = /scale:\s*([\d.]+)/.exec(body);
    spineEntries.push({
      key: match[1],
      atlas: atlas ? atlas[1].replace(/^(\.\.\/)+assets\//, '') : null,
      skeleton: skeleton ? skeleton[1].replace(/^(\.\.\/)+assets\//, '') : null,
      scale: scale ? parseFloat(scale[1]) : null,
    });
  }
  return { registeredPaths, keys, spineEntries };
}

/**
 * Which animation names the game asks for, per spine asset key.
 * Reads `animationName: '...'` alongside `assetKey: '...'` in the game source.
 */
function scanAnimationUsage(appDir) {
  const srcDir = path.join(appDir, 'src');
  const usage = new Map(); // assetKey -> Set(animationName)
  const files = [];
  const walkSync = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkSync(full, depth + 1);
      else if (/\.(ts|svelte|js)$/.test(entry.name)) files.push(full);
    }
  };
  walkSync(srcDir);

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('animationName')) continue;
    // Pair assetKey + animationName inside the same object literal.
    for (const match of text.matchAll(
      /assetKey:\s*'([^']+)'\s*,\s*\n?\s*animationName:\s*'([^']+)'|animationName:\s*'([^']+)'\s*,\s*\n?\s*assetKey:\s*'([^']+)'/g
    )) {
      const key = match[1] || match[4];
      const anim = match[2] || match[3];
      if (!key || !anim) continue;
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key).add(anim);
    }
  }
  return Object.fromEntries([...usage].map(([k, v]) => [k, [...v]]));
}

/** Inspect a reference spine asset folder to learn the output conventions. */
function inspectSpineFolder(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const atlasFiles = files.filter((f) => f.endsWith('.atlas'));
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const textures = files.filter((f) => SPINE_TEXTURE_EXT.has(path.extname(f).toLowerCase()));
  const sample = atlasFiles.length ? readIfExists(path.join(dir, atlasFiles[0])) : null;

  const skeletons = [];
  for (const f of jsonFiles) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.skeleton && !j.bones) continue;
      skeletons.push({
        file: f,
        spine: j.skeleton?.spine || null,
        animations: Object.keys(j.animations || {}),
      });
    } catch {
      /* not a skeleton */
    }
  }
  return {
    dir: toPosix(dir),
    name: path.basename(dir),
    atlasFiles,
    textures,
    hasIndexTs: files.includes('index.ts'),
    indexTs: readIfExists(path.join(dir, 'index.ts')),
    sharedAtlas: atlasFiles.length === 1 && skeletons.length > 1,
    textureFormats: [...new Set(textures.map((t) => path.extname(t).toLowerCase().slice(1)))],
    atlasSample: sample ? sample.split('\n').slice(0, 6).join('\n') : null,
    skeletons,
  };
}

/** Full inspection of a Stake Engine app. */
function inspectApp(appDir) {
  const assetsTsPath = path.join(appDir, 'src', 'game', 'assets.ts');
  const source = readIfExists(assetsTsPath);
  if (!source) return { ok: false, error: 'src/game/assets.ts not found in this app.' };

  const parsed = parseAssetsTs(source);
  const spinesRoot = path.join(appDir, 'static', 'assets', 'spines');
  const spineFolders = fs.existsSync(spinesRoot)
    ? fs
        .readdirSync(spinesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => inspectSpineFolder(path.join(spinesRoot, e.name)))
        .filter(Boolean)
    : [];

  // Dominant registration scale (the project uses one value throughout).
  const scales = parsed.spineEntries.map((e) => e.scale).filter((s) => Number.isFinite(s));
  const scaleCounts = new Map();
  for (const s of scales) scaleCounts.set(s, (scaleCounts.get(s) || 0) + 1);
  const dominantScale = [...scaleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;

  const runtime = detectRuntimeVersion(appDir);
  const shipped = spineFolders.flatMap((f) => f.skeletons.map((s) => s.spine)).filter(Boolean);
  const shippedVersions = [...new Set(shipped)].sort();

  return {
    ok: true,
    appDir: toPosix(appDir),
    appName: path.basename(appDir),
    assetsTsPath: toPosix(assetsTsPath),
    assetsRoot: toPosix(path.join(appDir, 'static', 'assets')),
    spinesRoot: toPosix(spinesRoot),
    existingKeys: [...parsed.keys],
    spineEntries: parsed.spineEntries,
    dominantScale,
    spineFolders,
    runtime: runtime.runtime,
    runtimePackages: runtime.all,
    shippedVersions,
    animationUsage: scanAnimationUsage(appDir),
    registrationStyle: 'assets.ts',
  };
}

// ---------------------------------------------------------------------------
// Registration: append spine entries to assets.ts
// ---------------------------------------------------------------------------
function registerSpineAssets({ appDir, entries, scale }) {
  const assetsTsPath = path.join(appDir, 'src', 'game', 'assets.ts');
  let source = readIfExists(assetsTsPath);
  if (!source) return { ok: false, error: 'src/game/assets.ts not found' };
  const anchor = 'export default {';
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) {
    return { ok: false, error: 'assets.ts has no `export default {` anchor — register the assets by hand.' };
  }
  const { keys } = parseAssetsTs(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const added = [];
  const skipped = [];
  let block = '';

  for (const entry of entries) {
    if (keys.has(entry.key)) {
      skipped.push(entry.key);
      continue;
    }
    block +=
      `\t${entry.key}: {${eol}` +
      `\t\ttype: 'spine',${eol}` +
      `\t\tsrc: {${eol}` +
      `\t\t\tatlas: new URL('../../assets/${entry.atlas}', import.meta.url).href,${eol}` +
      `\t\t\tskeleton: new URL('../../assets/${entry.skeleton}', import.meta.url).href,${eol}` +
      `\t\t\tscale: ${entry.scale ?? scale ?? 1},${eol}` +
      `\t\t},${eol}` +
      `\t},${eol}`;
    added.push(entry.key);
  }

  if (block) {
    const header = `\t// Registered by Exporter — Spine Animation (${new Date()
      .toISOString()
      .slice(0, 10)})${eol}`;
    let afterAnchor = anchorIndex + anchor.length;
    if (source[afterAnchor] === '\r') afterAnchor++;
    if (source[afterAnchor] === '\n') afterAnchor++;
    const backup = `${assetsTsPath}.ae-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(assetsTsPath, backup);
    source = source.slice(0, afterAnchor) + header + block + source.slice(afterAnchor);
    fs.writeFileSync(assetsTsPath, source, 'utf8');
  }
  return { ok: true, added, skipped, file: toPosix(assetsTsPath) };
}

module.exports = {
  extractZip,
  scanAnimationSource,
  findApps,
  inspectApp,
  inspectSpineFolder,
  registerSpineAssets,
};
