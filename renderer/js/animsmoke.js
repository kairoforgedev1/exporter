// End-to-end test for the Animation Re-Export feature, driven through the real
// UI controller so the workflow itself is exercised (not just the libraries).

import { openAnimationReExport } from './app.js';
import { parseSpineAtlas, extractRegionPixels, hashPixels, compareImages } from './spine/spineAtlas.js';
import { verifyConverted, loadWithRuntime } from './spine/spinePreview.js';
import { decodeTexture } from './spine/spineConvert.js';
import { joinPath, basename } from './util.js';

const native = window.native;

/** Compare the pixels of one region before and after conversion. */
function comparePixels(a, b, tolerance = 0) {
  if (a.width !== b.width || a.height !== b.height) {
    return `size ${a.width}x${a.height} vs ${b.width}x${b.height}`;
  }
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > worst) worst = d;
  }
  return worst > tolerance ? `max channel delta ${worst}` : null;
}

export async function runAnimationSmokeTest(cfg, check) {
  const outDir = joinPath(cfg.outDir, 'anim');
  const ui = await openAnimationReExport();

  // ---- 1. Source detection ------------------------------------------------
  await ui.loadSource(cfg.animSource);
  check('anim: 5 packages detected', ui.packages.length === 5, `got ${ui.packages.length}`);
  check('anim: all packages complete', ui.packages.every((p) => p.complete));
  check(
    'anim: each package has one skeleton + atlas + texture',
    ui.packages.every((p) => p.skeletons.length === 1 && p.atlas && p.pages.size === 1)
  );
  check(
    'anim: one-to-one packages are not grouped together',
    ui.packages.every((p) => p.skeletons[0].name === p.name),
    ui.packages.map((p) => `${p.name}<-${p.skeletons.map((s) => s.name).join('+')}`).join(' ')
  );
  check(
    'anim: source animations read (land, win)',
    ui.packages.every((p) => {
      const a = p.skeletons[0].summary.animations;
      return a.includes('land') && a.includes('win');
    })
  );
  check(
    'anim: source Spine version detected as 4.2',
    ui.packages.every((p) => /^4\.2\./.test(p.skeletons[0].summary.spine)),
    ui.packages[0]?.skeletons[0]?.summary?.spine
  );
  check(
    'anim: texture dimensions read',
    ui.packages.every((p) => p.textures[0]?.width > 0 && p.textures[0]?.height === 330)
  );

  const compatSource = ui.packages[0].skeletons[0].summary;
  // Incomplete deliveries must be reported, never silently skipped.
  const lp1 = ui.packages.find((p) => p.name === 'lp1');
  const savedPage = lp1.pages.get(lp1.textures[0].name);
  lp1.pages.delete(lp1.textures[0].name);
  const missingReport = (() => {
    const available = new Set(lp1.atlas.pages.flatMap((p) => p.regions.map((r) => r.name)));
    return available.size > 0 && !lp1.pages.size;
  })();
  check('anim: missing texture page is detectable', missingReport);
  lp1.pages.set(lp1.textures[0].name, savedPage);

  // Archive import must produce the same detection as the folder import.
  if (cfg.animZip) {
    const zipScan = await native.animOpenSource(cfg.animZip);
    check(
      'anim: .zip archive import detects the same packages',
      zipScan.fromArchive === true && zipScan.packages.length === ui.packages.length,
      `${zipScan.packages.length} packages from archive`
    );
    check(
      'anim: archive extracted to a temp workspace (not beside the source)',
      zipScan.root !== zipScan.originalPath && /temp|tmp/i.test(zipScan.root),
      zipScan.root
    );
  }

  // ---- 2. Target ----------------------------------------------------------
  let targetLabel = 'reference';
  if (cfg.animProject) {
    const apps = await native.animFindApps(cfg.animProject);
    check('anim: web-sdk apps discovered', apps.length > 0, `${apps.length} apps`);
    const app = apps.find((a) => a.name === 'ways') || apps[0];
    const info = await native.animInspectApp(app.dir);
    check('anim: app inspected', info.ok, info.error || app.name);
    ui.target = info;
    ui.targetKind = 'project';
    targetLabel = `project:${app.name}`;
    check(
      'anim: spine runtime detected from project',
      /spine-pixi/.test(info.runtime?.package || '') && /^4\.2/.test(info.runtime?.version || ''),
      `${info.runtime?.package} ${info.runtime?.version}`
    );
    check('anim: registration style is assets.ts', info.registrationStyle === 'assets.ts');
    check(
      'anim: project ships 4.1 spine assets (older than runtime)',
      (info.shippedVersions || []).some((v) => /^4\.1/.test(v)),
      (info.shippedVersions || []).join(',')
    );
    check(
      'anim: game animation usage scanned',
      Object.keys(info.animationUsage || {}).length > 0,
      `${Object.keys(info.animationUsage || {}).length} keys`
    );
    const refFolder = ui.pickReferenceFolder();
    check('anim: shared-atlas reference folder found', !!refFolder?.sharedAtlas, refFolder?.name);
    check(
      'anim: reference folder HAS symbols.atlas (sample archive was incomplete)',
      (refFolder?.atlasFiles || []).length === 1,
      (refFolder?.atlasFiles || []).join(',')
    );
  } else {
    const info = await native.animInspectFolder(cfg.animReference);
    check('anim: reference folder inspected', !!info);
    ui.target = { ok: true, reference: info, appName: null, dominantScale: 1, animationUsage: {} };
    ui.targetKind = 'reference';
    check(
      'anim: sample_output reference is incomplete (no .atlas)',
      info.atlasFiles.length === 0 && /symbols\.atlas/.test(info.indexTs || '')
    );
  }
  ui.renderTarget();

  // ---- 3. Compatibility ---------------------------------------------------
  const compat = ui.packages[0].compatibility;
  if (cfg.animProject) {
    check(
      'anim: 4.2 source vs 4.2 runtime reported compatible',
      compat.status === 'compatible' && !compat.blocking,
      `${compat.status}: ${compat.title}`
    );
  }
  // A genuinely newer source must be refused rather than version-stamped.
  const { assessCompatibility } = await import('./spine/spineSkeleton.js');
  const newer = assessCompatibility({ sourceVersion: '4.3.10', runtimeVersion: '4.2.74', features: [] });
  check('anim: newer-than-runtime source demands re-export', newer.status === 'reexport-required' && newer.blocking);
  const older = assessCompatibility({ sourceVersion: '4.1.23', runtimeVersion: '4.2.74', features: [] });
  check('anim: older source accepted by 4.2 runtime', older.status === 'compatible-older' && !older.blocking);
  const physics = assessCompatibility({
    sourceVersion: '4.1.0',
    runtimeVersion: '4.1.23',
    features: ['physics constraints'],
  });
  check('anim: unsupported feature flagged', physics.status === 'unsupported-feature' && physics.blocking);

  // ---- 4. Mapping ---------------------------------------------------------
  ui.buildMappings();
  ui.atlasName = 'symbols';
  ui.outputFolder = 'lowSymbols';
  const m1 = ui.mappings.get('lp1::lp1');
  check('anim: asset key suggested', m1.assetKey === 'LP1', m1.assetKey);
  check('anim: json name suggested', m1.jsonName === 'lp1.json', m1.jsonName);
  check(
    'anim: win maps to bare symbol name (project convention)',
    m1.animations.win === 'lp1',
    JSON.stringify(m1.animations)
  );
  check('anim: land keeps a suffixed name', m1.animations.land === 'lp1_land', m1.animations.land);
  // User adjustment must be honoured.
  ui.mappings.get('lp2::lp2').animations.land = 'lp2_static';
  ui.renderMapping();

  // Duplicate output names must be refused.
  const dupBackup = ui.mappings.get('lp3::lp3').jsonName;
  ui.mappings.get('lp3::lp3').jsonName = 'lp1.json';
  const dupResult = await ui.runConversion();
  check('anim: duplicate output name refused', dupResult === false);
  ui.mappings.get('lp3::lp3').jsonName = dupBackup;

  // ---- 5. Conversion ------------------------------------------------------
  const ok = await ui.runConversion();
  check('anim: conversion succeeded', ok === true);
  if (!ok) return { targetLabel };

  const conv = ui.conversion;
  const shared = conv.shared;
  check('anim: 5 skeletons converted', conv.skeletons.length === 5, `${conv.skeletons.length}`);
  check(
    'anim: shared atlas built',
    shared.width > 0 && shared.height > 0 && shared.sharedRegions.length > 0,
    `${shared.width}x${shared.height}, ${shared.sharedRegions.length} regions`
  );
  check(
    'anim: identical radial_glow deduplicated across 5 packages',
    shared.sharedRegions.filter((r) => r.name === 'radial_glow' && r.sharedBy.length === 5).length === 1,
    `deduped=${shared.dedupedCount}`
  );
  check(
    'anim: distinct symbol art NOT merged',
    shared.sharedRegions.filter((r) => /^lp\d$/.test(r.name)).length === 5,
    shared.sharedRegions.filter((r) => /^lp\d$/.test(r.name)).map((r) => r.name).join(',')
  );
  check(
    'anim: region count = 11 (5 symbols + 5 shadows + 1 shared glow)',
    shared.sharedRegions.length === 11,
    `${shared.sharedRegions.length}`
  );
  // The default converts a premultiplied source to straight alpha and drops the
  // flag, so the loader premultiplies on upload. The atlas must not claim the
  // texture is already multiplied when it no longer is.
  check(
    'anim: straight-alpha output drops pma:true',
    shared.straightAlphaOutput === true &&
      shared.pma === false &&
      !/pma:true/.test(shared.atlasText),
    `straight=${shared.straightAlphaOutput} pma=${shared.pma}`
  );
  check(
    'anim: atlas text uses bounds/offsets dialect',
    /bounds:\d+,\d+,\d+,\d+/.test(shared.atlasText) && shared.atlasText.startsWith('symbols.png'),
    shared.atlasText.split('\n')[0]
  );
  check(
    'anim: output atlas has no rotation entries',
    !/rotate:/.test(shared.atlasText)
  );
  check('anim: webp encoded', ui.webp.bytes.length > 0, `${ui.webp.bytes.length} bytes`);
  check(
    'anim: png is bit-exact at High quality',
    ui.png?.quality?.verified === true && ui.png.quality.lossless === true,
    `max=${ui.png?.quality?.max}`
  );
  check(
    // High quality encodes VP8L, so the only permitted deviation is RGB beneath
    // a zero alpha, which never reaches the screen.
    'anim: webp is lossless on every rendered pixel at High quality',
    ui.webp.quality?.verified === true && ui.webp.quality.renderedLossless === true,
    `maxOpaque=${ui.webp.quality?.maxOpaque} max=${ui.webp.quality?.max} mean=${ui.webp.quality?.mean?.toFixed(3)}`
  );

  // Animation renaming actually landed in the skeleton data.
  const lp1Out = conv.skeletons.find((s) => s.package === 'lp1');
  check(
    'anim: animations renamed in output skeleton',
    lp1Out.outAnimations.includes('lp1') && lp1Out.outAnimations.includes('lp1_land'),
    lp1Out.outAnimations.join(',')
  );
  const lp2Out = conv.skeletons.find((s) => s.package === 'lp2');
  check('anim: user-adjusted name applied', lp2Out.outAnimations.includes('lp2_static'));
  const lp1Src = ui.packages.find((p) => p.name === 'lp1').skeletons[0].json;
  check(
    'anim: skeleton structure preserved',
    lp1Out.skeleton.bones.length === lp1Src.bones.length &&
      lp1Out.skeleton.slots.length === lp1Src.slots.length
  );
  check('anim: blend modes preserved', JSON.stringify(lp1Out.skeleton.slots) === JSON.stringify(lp1Src.slots));
  check('anim: source spine version NOT rewritten', lp1Out.skeleton.skeleton.spine === '4.2.43');

  // ---- 6. Pixel fidelity --------------------------------------------------
  // The conversion itself (extract -> unrotate -> repack -> compose) must be
  // lossless: compared against the composed buffer, before any texture codec.
  const outAtlas = parseSpineAtlas(shared.atlasText);
  const composed = { data: shared.rgba, width: shared.width, height: shared.height };
  let worstDiff = null;
  let metadataDiff = null;
  let comparedRegions = 0;
  let sharedSkipped = 0;

  for (const pkg of ui.packages) {
    const regionMap = shared.regionMaps.get(pkg.name);
    if (!regionMap) continue;
    for (const page of pkg.atlas.pages) {
      const srcPixels = pkg.pages.get(page.name);
      for (const region of page.regions) {
        const outName = regionMap.get(region.name);
        const outRegion = outAtlas.pages[0].regions.find((r) => r.name === outName);
        if (!outRegion) {
          worstDiff = `region ${outName} missing from output atlas`;
          continue;
        }
        // Trim metadata must be carried over untouched.
        if (
          outRegion.offsetX !== region.offsetX ||
          outRegion.offsetY !== region.offsetY ||
          outRegion.origW !== region.origW ||
          outRegion.origH !== region.origH
        ) {
          metadataDiff = metadataDiff || `${region.name}: offsets/orig changed`;
        }
        // A deduplicated region intentionally stores one package's copy.
        const entry = shared.sharedRegions.find((r) => r.name === outName);
        if (entry && entry.sharedBy.length > 1 && entry.sharedBy[0] !== pkg.name) {
          sharedSkipped++;
          continue;
        }
        const srcImg = extractRegionPixels(srcPixels, region);
        const outImg = extractRegionPixels(composed, outRegion);
        const diff = comparePixels(srcImg, outImg);
        comparedRegions++;
        if (diff && !worstDiff) worstDiff = `${pkg.name}/${region.name}: ${diff}`;
      }
    }
  }
  check(
    'anim: repacked region pixels are byte-identical to the source',
    !worstDiff,
    worstDiff || `${comparedRegions} regions exact, ${sharedSkipped} deduplicated`
  );
  check('anim: trim metadata (offsets/orig) preserved exactly', !metadataDiff, metadataDiff || '');

  // The optional WebP companion must not alter any region that renders.
  const webpPage = await decodeTexture(ui.webp.bytes);
  let worstWebp = { maxOpaque: 0, name: null };
  for (const outRegion of outAtlas.pages[0].regions) {
    const a = extractRegionPixels(composed, outRegion);
    const b = extractRegionPixels(webpPage, outRegion);
    const d = compareImages(a, b);
    if (d && d.maxOpaque > worstWebp.maxOpaque) worstWebp = { ...d, name: outRegion.name };
  }
  check(
    'anim: webp texture preserves every region exactly',
    worstWebp.maxOpaque === 0,
    `worst=${worstWebp.name} maxOpaque=${worstWebp.maxOpaque}`
  );

  // ---- 7. Runtime verification -------------------------------------------
  check(
    'anim: every skeleton loads in the real Spine runtime',
    ui.verification.every((v) => v.ok),
    ui.verification
      .filter((v) => !v.ok)
      .map((v) => `${v.assetKey}: ${v.error}`)
      .join('; ')
  );
  check(
    'anim: every animation applies without error',
    ui.verification.every((v) => (v.animations || []).every((a) => a.ok))
  );
  check(
    'anim: attachments resolve to real geometry (non-zero bounds)',
    ui.verification.every((v) => v.bounds && v.bounds.width > 0 && v.bounds.height > 0),
    JSON.stringify(ui.verification[0]?.bounds)
  );

  // A broken reference must be caught, not silently rendered empty.
  const brokenSkeleton = structuredClone(lp1Out.skeleton);
  const firstSkin = brokenSkeleton.skins[0];
  const firstSlot = Object.keys(firstSkin.attachments)[0];
  const firstAttachment = Object.keys(firstSkin.attachments[firstSlot])[0];
  firstSkin.attachments[firstSlot][firstAttachment].path = 'does_not_exist_region';
  const brokenLoad = loadWithRuntime({
    atlasText: shared.atlasText,
    skeletonJson: brokenSkeleton,
    images: ui.previewImages,
  });
  check('anim: broken attachment reference is detected', brokenLoad.ok === false, brokenLoad.error || '');

  // ---- 8. Export ----------------------------------------------------------
  ui.targetKind = 'reference-export';
  const textFiles = [
    { name: `${ui.atlasName}.atlas`, text: shared.atlasText },
    ...conv.skeletons.map((s) => ({ name: s.jsonName, text: s.json })),
    { name: 'index.ts', text: conv.indexTs },
  ];
  const images = [
    { name: `${ui.atlasName}.webp`, encoding: 'raw', bytes: ui.webp.bytes },
    {
      name: `${ui.atlasName}.png`,
      encoding: 'raw',
      bytes: ui.png.bytes,
    },
  ];
  const packageDir = joinPath(outDir, ui.outputFolder);
  let res = await native.animWritePackage({ outDir: packageDir, textFiles, images, overwrite: true });
  check('anim: package written', res.ok, (res.written || []).length + ' files');
  ui.exported = { outDir: res.outDir, written: res.written, firstFile: joinPath(res.outDir, 'index.ts') };
  ui.renderExport();

  // Overwrite protection.
  const guard = await native.animWritePackage({ outDir: packageDir, textFiles, images, overwrite: false });
  check('anim: existing files are not overwritten silently', guard.ok === false && guard.conflict?.length > 0);

  // ---- 9. Re-read the exported package from disk --------------------------
  const readText = async (name) =>
    new TextDecoder().decode(await native.readFile(joinPath(packageDir, name)));
  const diskAtlas = await readText('symbols.atlas');
  const diskIndex = await readText('index.ts');
  const diskSkeleton = JSON.parse(await readText('lp1.json'));
  const diskPng = await native.readFile(joinPath(packageDir, 'symbols.png'));
  const diskImage = await decodeTexture(diskPng);

  check('anim: exported atlas parses', parseSpineAtlas(diskAtlas).pages.length === 1);
  check(
    'anim: index.ts follows the project asset-module shape',
    diskIndex.includes("import { createAsset } from 'pixi-svelte'") &&
      diskIndex.includes("import img from './symbols.png'") &&
      diskIndex.includes("import rawAtlas from './symbols.atlas?raw'") &&
      diskIndex.includes('spines: {') &&
      diskIndex.includes('LP1,')
  );
  check(
    'anim: exported skeleton references the shared atlas regions',
    JSON.stringify(diskSkeleton.skins).includes('radial_glow')
  );

  const diskCanvas = document.createElement('canvas');
  diskCanvas.width = diskImage.width;
  diskCanvas.height = diskImage.height;
  diskCanvas.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(diskImage.data), diskImage.width, diskImage.height),
    0,
    0
  );
  const diskVerify = verifyConverted({
    atlasText: diskAtlas,
    skeletonJson: diskSkeleton,
    image: diskCanvas,
  });
  check(
    'anim: package re-read from disk loads in the runtime',
    diskVerify.ok,
    diskVerify.error || `${diskVerify.animations?.length} animations`
  );

  // ---- 10. Source files untouched ----------------------------------------
  const sourceStillIntact = [];
  for (const pkg of ui.packages) {
    const atlasNow = new TextDecoder().decode(await native.readFile(pkg.atlasPath));
    const parsedNow = parseSpineAtlas(atlasNow);
    const pageNow = await decodeTexture(await native.readFile(pkg.textures[0].path));
    const original = pkg.pages.get(pkg.textures[0].name);
    const regionNow = extractRegionPixels(pageNow, parsedNow.pages[0].regions[0]);
    const regionThen = extractRegionPixels(original, pkg.atlas.pages[0].regions[0]);
    sourceStillIntact.push(hashPixels(regionNow) === hashPixels(regionThen));
  }
  check('anim: animator source files unmodified', sourceStillIntact.every(Boolean));

  // ---- 11. Registration ---------------------------------------------------
  if (cfg.animProject) {
    check(
      'anim: assets.ts entries generated with atlas+skeleton+scale',
      conv.assetEntries.length === 5 &&
        conv.assetEntries.every(
          (e) => e.atlas.endsWith('symbols.atlas') && e.skeleton.endsWith('.json') && Number.isFinite(e.scale)
        ),
      JSON.stringify(conv.assetEntries[0])
    );
    check(
      'anim: registration path matches the project asset layout',
      conv.assetEntries[0].atlas === 'spines/lowSymbols/symbols.atlas',
      conv.assetEntries[0].atlas
    );
    check(
      'anim: registration scale follows the project convention',
      conv.assetEntries.every((e) => e.scale === ui.target.dominantScale),
      `scale=${conv.assetEntries[0].scale}, project dominant=${ui.target.dominantScale}`
    );

    // Registration mutates the developer's project, so it is exercised against
    // a throwaway copy of the real assets.ts rather than the project itself.
    const sandbox = joinPath(cfg.outDir, 'register-sandbox');
    const realAssetsTs = new TextDecoder().decode(await native.readFile(ui.target.assetsTsPath));
    await native.writeFile(
      joinPath(sandbox, 'src/game/assets.ts'),
      new TextEncoder().encode(realAssetsTs)
    );
    const reg = await native.animRegister({
      appDir: sandbox,
      entries: conv.assetEntries,
      scale: ui.packing.registrationScale,
    });
    check('anim: registration succeeded', reg.ok, reg.error || reg.added?.join(','));
    check('anim: 5 entries appended', reg.added?.length === 5, (reg.added || []).join(','));

    const after = new TextDecoder().decode(
      await native.readFile(joinPath(sandbox, 'src/game/assets.ts'))
    );
    check(
      'anim: appended entry matches the project spine-entry shape',
      after.includes("\tLP1: {") &&
        after.includes("\t\ttype: 'spine',") &&
        after.includes("atlas: new URL('../../assets/spines/lowSymbols/symbols.atlas', import.meta.url).href,") &&
        after.includes("skeleton: new URL('../../assets/spines/lowSymbols/lp1.json', import.meta.url).href,")
    );
    check(
      'anim: existing entries are preserved (append-only)',
      after.includes('\tH1: {') && after.includes('\tloader: {') && after.length > realAssetsTs.length,
      `${realAssetsTs.length} -> ${after.length} bytes`
    );
    check(
      'anim: a backup of assets.ts was taken',
      (await native.fileExists(joinPath(sandbox, 'src/game/assets.ts.ae-backup'))) === true
    );

    // Re-registering must not duplicate keys.
    const again = await native.animRegister({
      appDir: sandbox,
      entries: conv.assetEntries,
      scale: ui.packing.registrationScale,
    });
    check(
      'anim: re-registering skips existing keys',
      again.ok && again.added.length === 0 && again.skipped.length === 5,
      `added=${again.added.length} skipped=${again.skipped.length}`
    );

    // The real project must be untouched by the whole run.
    const realNow = new TextDecoder().decode(await native.readFile(ui.target.assetsTsPath));
    check('anim: the real project assets.ts was NOT modified', realNow === realAssetsTs);
  }

  return { targetLabel, packageDir, shared, conv, ui };
}

/**
 * Multi-skeleton / multi-page scenario: one atlas, two texture pages and two
 * device-variant skeletons that share it.
 */
export async function runMeterSmokeTest(cfg, check) {
  const outDir = joinPath(cfg.outDir, 'meter');
  const ui = await openAnimationReExport();
  ui.reset();

  // ---- 1. Detection -------------------------------------------------------
  await ui.loadSource(cfg.meterSource);
  check('meter: one related package detected', ui.packages.length === 1, `got ${ui.packages.length}`);
  const pkg = ui.packages[0];
  check('meter: package named after the shared atlas', pkg.name === 'fs_meter', pkg.name);
  check('meter: package is complete', pkg.complete, pkg.problems.map((p) => p.message).join('; '));
  check(
    'meter: both skeletons attributed to the shared atlas',
    pkg.skeletons.length === 2 &&
      pkg.skeletons.some((s) => s.name === 'fs_meter_mobile') &&
      pkg.skeletons.some((s) => s.name === 'fs_meter_desktop'),
    pkg.skeletons.map((s) => s.name).join(', ')
  );
  check('meter: no orphan skeletons reported', (ui.source.looseJson || []).length === 0);
  check(
    'meter: device variants labelled',
    pkg.skeletons.find((s) => s.name === 'fs_meter_mobile')?.variantLabel === 'mobile' &&
      pkg.skeletons.find((s) => s.name === 'fs_meter_desktop')?.variantLabel === 'desktop'
  );

  // ---- 2. Multi-page atlas ------------------------------------------------
  check('meter: atlas declares 2 texture pages', pkg.atlas.pages.length === 2, `${pkg.atlas.pages.length}`);
  check(
    'meter: both pages decoded',
    pkg.pages.size === 2 &&
      pkg.pages.get('fs_meter.webp')?.width === 2045 &&
      pkg.pages.get('fs_meter_2.webp')?.width === 2005,
    [...pkg.pages.keys()].join(', ')
  );
  const page2Regions = pkg.atlas.pages[1].regions.map((r) => r.name);
  check('meter: second page carries regions', page2Regions.length > 0, `${page2Regions.length} regions`);
  // The desktop variant is the one that reaches onto the second page; the
  // mobile variant lives entirely on page 1. Getting this wrong (loading only
  // the first page) is exactly what would strip the desktop attachments.
  const mobileSk = pkg.skeletons.find((s) => s.name === 'fs_meter_mobile');
  const desktopSk = pkg.skeletons.find((s) => s.name === 'fs_meter_desktop');
  check(
    'meter: desktop skeleton spans both texture pages',
    (desktopSk.sourcePages || []).length === 2,
    (desktopSk.sourcePages || []).join(', ')
  );
  check(
    'meter: mobile skeleton uses only the first page',
    (mobileSk.sourcePages || []).length === 1 && mobileSk.sourcePages[0] === 'fs_meter.webp',
    (mobileSk.sourcePages || []).join(', ')
  );
  check(
    'meter: second-page regions belong to the desktop variant only',
    page2Regions.every((r) => desktopSk.summary.regions.includes(r)) &&
      page2Regions.every((r) => !mobileSk.summary.regions.includes(r)),
    `${page2Regions.length} page-2 regions`
  );

  // ---- 3. Region ownership ------------------------------------------------
  check(
    'meter: shared and variant-specific regions distinguished',
    pkg.sharedRegionCount > 0 && pkg.specificRegionCount > 0,
    `shared=${pkg.sharedRegionCount} specific=${pkg.specificRegionCount}`
  );

  // ---- 4. Target + mapping ------------------------------------------------
  if (cfg.animProject) {
    const apps = await native.animFindApps(cfg.animProject);
    const app = apps.find((a) => a.name === 'ways') || apps[0];
    ui.target = await native.animInspectApp(app.dir);
    ui.targetKind = 'project';
  } else {
    ui.target = { ok: true, reference: null, appName: null, dominantScale: 1, animationUsage: {} };
    ui.targetKind = 'reference';
  }
  ui.renderTarget();
  ui.buildMappings();
  ui.atlasName = 'fs_meter';
  ui.outputFolder = 'fsMeter';

  const mobileMap = ui.mappings.get('fs_meter::fs_meter_mobile');
  const desktopMap = ui.mappings.get('fs_meter::fs_meter_desktop');
  check('meter: a mapping exists per skeleton', !!mobileMap && !!desktopMap);
  check(
    'meter: distinct asset keys and json names',
    mobileMap.assetKey !== desktopMap.assetKey && mobileMap.jsonName !== desktopMap.jsonName,
    `${mobileMap.assetKey}/${mobileMap.jsonName} vs ${desktopMap.assetKey}/${desktopMap.jsonName}`
  );
  check(
    'meter: variant animation names are preserved, not symbol-renamed',
    Object.entries(mobileMap.animations).every(([from, to]) => from === to),
    JSON.stringify(Object.entries(mobileMap.animations).slice(0, 3))
  );
  ui.renderMapping();

  // Two variants must not be allowed to collide.
  const keyBackup = desktopMap.assetKey;
  desktopMap.assetKey = mobileMap.assetKey;
  check('meter: duplicate asset keys refused', (await ui.runConversion()) === false);
  desktopMap.assetKey = keyBackup;

  // ---- 5. Conversion ------------------------------------------------------
  const ok = await ui.runConversion();
  check('meter: conversion succeeded', ok === true);
  if (!ok) return { ui };
  const conv = ui.conversion;
  const shared = conv.shared;

  check('meter: both skeletons converted separately', conv.skeletons.length === 2);
  check(
    'meter: skeleton data NOT merged',
    conv.skeletons[0].skeleton.bones.length !== conv.skeletons[1].skeleton.bones.length &&
      conv.skeletons.every((s, i) => {
        const src = pkg.skeletons.find((sk) => sk.name === s.variantName).json;
        return (
          s.skeleton.bones.length === src.bones.length &&
          s.skeleton.slots.length === src.slots.length &&
          Object.keys(s.skeleton.animations).length === Object.keys(src.animations).length
        );
      }),
    conv.skeletons.map((s) => `${s.variantName}:${s.skeleton.bones.length}b`).join(' ')
  );
  check(
    'meter: variant-specific dimensions preserved',
    conv.skeletons.every((s) => {
      const src = pkg.skeletons.find((sk) => sk.name === s.variantName).json;
      return (
        s.skeleton.skeleton.width === src.skeleton.width &&
        s.skeleton.skeleton.height === src.skeleton.height &&
        s.skeleton.skeleton.x === src.skeleton.x
      );
    })
  );
  check(
    'meter: all 20 animations kept per skeleton',
    conv.skeletons.every((s) => s.outAnimations.length === 20),
    conv.skeletons.map((s) => s.outAnimations.length).join(',')
  );
  // Nothing needed renaming here, so the skeleton data must come through
  // completely untouched rather than merely equivalent.
  check(
    'meter: skeletons unchanged when no rename is required',
    conv.skeletons.every((s) => {
      const src = pkg.skeletons.find((sk) => sk.name === s.variantName).json;
      return s.json === JSON.stringify(src) && s.changes.length === 0;
    }),
    conv.skeletons.map((s) => `${s.variantName}:${s.changes.length} changes`).join(' ')
  );

  // Region consolidation: both source pages folded into the shared atlas.
  const sourceRegionCount = pkg.atlas.pages.reduce((n, p) => n + p.regions.length, 0);
  check(
    'meter: every source region present in the shared atlas',
    shared.sharedRegions.length === sourceRegionCount,
    `${shared.sharedRegions.length} of ${sourceRegionCount}`
  );
  check(
    'meter: regions shared between skeletons are stored once',
    conv.stats.sharedBetweenSkeletons > 0 && conv.stats.skeletonSpecific > 0,
    `shared=${conv.stats.sharedBetweenSkeletons} specific=${conv.stats.skeletonSpecific}`
  );
  check(
    'meter: no duplicate region names in the output atlas',
    new Set(shared.sharedRegions.map((r) => r.name)).size === shared.sharedRegions.length
  );
  check(
    'meter: source page count reported',
    conv.stats.sourcePages === 2 && conv.stats.pageCount >= 1,
    `in=${conv.stats.sourcePages} out=${conv.stats.pageCount}`
  );

  // Pixel fidelity across BOTH source pages.
  const outAtlas = parseSpineAtlas(shared.atlasText);
  const composedPages = shared.pixelPages.map((p) => ({
    data: p.rgba,
    width: p.width,
    height: p.height,
  }));
  const pageIndexOfRegion = new Map();
  outAtlas.pages.forEach((p, i) => p.regions.forEach((r) => pageIndexOfRegion.set(r.name, i)));

  const regionMap = shared.regionMaps.get(pkg.name);
  let worst = null;
  let compared = 0;
  for (const [pageIdx, page] of pkg.atlas.pages.entries()) {
    const srcPixels = pkg.pages.get(page.name);
    for (const region of page.regions) {
      const outName = regionMap.get(region.name);
      const outRegion = outAtlas.pages.flatMap((p) => p.regions).find((r) => r.name === outName);
      if (!outRegion) {
        worst = worst || `${region.name} missing from output`;
        continue;
      }
      const srcImg = extractRegionPixels(srcPixels, region);
      const outImg = extractRegionPixels(composedPages[pageIndexOfRegion.get(outName)], outRegion);
      const diff = comparePixels(srcImg, outImg);
      compared++;
      if (diff && !worst) worst = `page${pageIdx} ${region.name}: ${diff}`;
    }
  }
  check(
    'meter: all regions from both pages repacked byte-exactly',
    !worst,
    worst || `${compared} regions compared`
  );

  // ---- 6. Runtime verification of BOTH variants ---------------------------
  check(
    'meter: both skeletons load in the real Spine runtime',
    ui.verification.length === 2 && ui.verification.every((v) => v.ok),
    ui.verification.map((v) => `${v.assetKey}:${v.ok ? 'ok' : v.error}`).join(' | ')
  );
  check(
    'meter: every animation applies for both variants',
    ui.verification.every((v) => (v.animations || []).every((a) => a.ok && !a.empty))
  );
  check(
    'meter: no unresolved attachments in either variant',
    ui.verification.every((v) => (v.unresolvedAttachments || []).length === 0),
    ui.verification.flatMap((v) => v.unresolvedAttachments || []).join(', ')
  );
  check(
    'meter: variants have distinct bounds (mobile wide, desktop tall)',
    (() => {
      const m = ui.verification.find((v) => v.variantLabel === 'mobile');
      const d = ui.verification.find((v) => v.variantLabel === 'desktop');
      return m && d && m.bounds.width > m.bounds.height && d.bounds.height > d.bounds.width;
    })(),
    ui.verification.map((v) => `${v.variantLabel}:${v.bounds.width.toFixed(0)}x${v.bounds.height.toFixed(0)}`).join(' ')
  );

  // A skeleton needing a page whose texture is absent must fail loudly.
  const onePage = new Map([[shared.pages[0].name, ui.previewImages.get(shared.pages[0].name)]]);
  if (shared.pages.length > 1) {
    const partial = loadWithRuntime({
      atlasText: shared.atlasText,
      skeletonJson: conv.skeletons[0].skeleton,
      images: onePage,
    });
    check('meter: missing texture page detected', partial.ok === false, partial.error || '');
  }

  // ---- 6b. Multi-page OUTPUT ---------------------------------------------
  // Constrain the atlas so the regions genuinely cannot fit one page: the
  // converter must spill into additional pages rather than fail or drop art.
  const singlePageStats = { pages: shared.pageCount, regions: shared.sharedRegions.length };
  ui.packing.maxWidth = 2048;
  ui.packing.maxHeight = 2048;
  const multiOk = await ui.runConversion();
  check('meter: constrained conversion still succeeds', multiOk === true);
  if (multiOk) {
    const mShared = ui.conversion.shared;
    check(
      'meter: output spills to multiple pages when one will not fit',
      mShared.pageCount > 1,
      `${mShared.pageCount} pages at 2048²`
    );
    check(
      'meter: no regions lost across the multi-page split',
      mShared.sharedRegions.length === singlePageStats.regions,
      `${mShared.sharedRegions.length} vs ${singlePageStats.regions}`
    );
    check(
      'meter: page names follow the Spine convention',
      mShared.pages[0].name === 'fs_meter.png' && mShared.pages[1].name === 'fs_meter_2.png',
      mShared.pages.map((p) => p.name).join(', ')
    );
    check(
      'meter: every page fits the configured maximum',
      mShared.pages.every((p) => p.size.w <= 2048 && p.size.h <= 2048),
      mShared.pages.map((p) => `${p.size.w}x${p.size.h}`).join(', ')
    );
    check(
      'meter: each region appears on exactly one output page',
      (() => {
        const names = mShared.pages.flatMap((p) => p.regions.map((r) => r.name));
        return new Set(names).size === names.length && names.length === mShared.sharedRegions.length;
      })()
    );
    check(
      'meter: both skeletons still load against the multi-page atlas',
      ui.verification.length === 2 && ui.verification.every((v) => v.ok),
      ui.verification.map((v) => `${v.assetKey}:${v.ok ? 'ok' : v.error}`).join(' | ')
    );
    check(
      'meter: desktop variant draws from more than one output page',
      ui.verification.some((v) => (v.pagesUsed || []).length > 1),
      ui.verification.map((v) => `${v.variantLabel}:${(v.pagesUsed || []).join('+')}`).join(' ')
    );

    // A multi-page package must survive a disk round trip too.
    const mDir = joinPath(outDir, 'multipage');
    const mText = [
      { name: `${ui.atlasName}.atlas`, text: mShared.atlasText },
      ...ui.conversion.skeletons.map((s) => ({ name: s.jsonName, text: s.json })),
      { name: 'index.ts', text: ui.conversion.indexTs },
    ];
    const mImages = mShared.pages.map((page, i) => ({
      name: page.name,
      encoding: 'raw',
      bytes: ui.primaryTexturePages[i].bytes,
    }));
    const mRes = await native.animWritePackage({ outDir: mDir, textFiles: mText, images: mImages, overwrite: true });
    check('meter: multi-page package written', mRes.ok, (mRes.written || []).map((f) => f.name).join(', '));

    const mAtlas = new TextDecoder().decode(await native.readFile(joinPath(mDir, `${ui.atlasName}.atlas`)));
    const mParsed = parseSpineAtlas(mAtlas);
    check('meter: exported atlas declares every page', mParsed.pages.length === mShared.pageCount);
    const mImageMap = new Map();
    for (const page of mParsed.pages) {
      const decoded = await decodeTexture(await native.readFile(joinPath(mDir, page.name)));
      const canvas = document.createElement('canvas');
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      canvas
        .getContext('2d')
        .putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0);
      mImageMap.set(page.name, canvas);
    }
    let mOk = true;
    const mDetail = [];
    for (const s of ui.conversion.skeletons) {
      const skeletonJson = JSON.parse(
        new TextDecoder().decode(await native.readFile(joinPath(mDir, s.jsonName)))
      );
      const v = verifyConverted({ atlasText: mAtlas, skeletonJson, images: mImageMap });
      if (!v.ok) mOk = false;
      mDetail.push(`${s.jsonName}:${v.ok ? 'ok' : v.error}`);
    }
    check('meter: multi-page package loads from disk for both variants', mOk, mDetail.join(' | '));
  }

  // Restore the default limits and reconvert for the export step.
  ui.packing.maxWidth = 4096;
  ui.packing.maxHeight = 4096;
  await ui.runConversion();
  const shared2 = ui.conversion.shared;
  check('meter: reverts to a single page at 4096²', shared2.pageCount === 1, `${shared2.pageCount}`);

  // ---- 7. Export ----------------------------------------------------------
  const textFiles = [
    { name: `${ui.atlasName}.atlas`, text: shared2.atlasText },
    ...ui.conversion.skeletons.map((s) => ({ name: s.jsonName, text: s.json })),
    { name: 'index.ts', text: ui.conversion.indexTs },
  ];
  const images = shared2.pages.map((page, i) => ({
    name: page.name,
    encoding: 'raw',
    bytes: ui.primaryTexturePages[i].bytes,
  }));
  const packageDir = joinPath(outDir, ui.outputFolder);
  const res = await native.animWritePackage({ outDir: packageDir, textFiles, images, overwrite: true });
  check('meter: package written', res.ok, (res.written || []).map((f) => f.name).join(', '));

  // ---- 8. Re-read from disk and load both skeletons -----------------------
  const readText = async (name) => new TextDecoder().decode(await native.readFile(joinPath(packageDir, name)));
  const diskAtlas = await readText('fs_meter.atlas');
  const diskParsed = parseSpineAtlas(diskAtlas);
  const diskImages = new Map();
  for (const page of diskParsed.pages) {
    const bytes = await native.readFile(joinPath(packageDir, page.name));
    const decoded = await decodeTexture(bytes);
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0);
    diskImages.set(page.name, canvas);
  }
  check(
    'meter: every atlas page exists on disk',
    diskImages.size === diskParsed.pages.length,
    `${diskImages.size}/${diskParsed.pages.length}`
  );

  let diskOk = true;
  const diskDetail = [];
  for (const s of ui.conversion.skeletons) {
    const skeletonJson = JSON.parse(await readText(s.jsonName));
    const v = verifyConverted({ atlasText: diskAtlas, skeletonJson, images: diskImages });
    if (!v.ok) diskOk = false;
    diskDetail.push(`${s.jsonName}:${v.ok ? 'ok' : v.error}`);
  }
  check('meter: both exported skeletons load from disk', diskOk, diskDetail.join(' | '));

  const diskIndex = await readText('index.ts');
  check(
    'meter: index.ts registers both skeletons and every page',
    ui.conversion.skeletons.every((s) => diskIndex.includes(`${s.assetKey},`)) &&
      shared2.pages.every((p) => diskIndex.includes(`'./${p.name}'`)),
    diskIndex.split('\n').filter((l) => l.startsWith('import')).join(' ')
  );

  // ---- 9. Registration ----------------------------------------------------
  if (cfg.animProject) {
    check(
      'meter: an asset entry per skeleton, both against the same atlas',
      ui.conversion.assetEntries.length === 2 &&
        ui.conversion.assetEntries[0].atlas === ui.conversion.assetEntries[1].atlas &&
        ui.conversion.assetEntries[0].skeleton !== ui.conversion.assetEntries[1].skeleton,
      ui.conversion.assetEntries.map((e) => `${e.key}->${e.skeleton}`).join(' ')
    );
    const sandbox = joinPath(cfg.outDir, 'meter-register-sandbox');
    const realAssetsTs = new TextDecoder().decode(await native.readFile(ui.target.assetsTsPath));
    await native.writeFile(joinPath(sandbox, 'src/game/assets.ts'), new TextEncoder().encode(realAssetsTs));
    const reg = await native.animRegister({
      appDir: sandbox,
      entries: ui.conversion.assetEntries,
      scale: ui.packing.registrationScale,
    });
    check('meter: both variants registered', reg.ok && reg.added.length === 2, (reg.added || []).join(','));
    const after = new TextDecoder().decode(await native.readFile(joinPath(sandbox, 'src/game/assets.ts')));
    check(
      'meter: registration references the shared atlas for both',
      (after.match(/spines\/fsMeter\/fs_meter\.atlas/g) || []).length === 2
    );
  }

  // ---- 10. Sources untouched ---------------------------------------------
  const atlasNow = new TextDecoder().decode(await native.readFile(pkg.atlasPath));
  check('meter: source atlas unmodified', atlasNow.split('\n')[0].trim() === 'fs_meter.webp');
  check(
    'meter: source pages unmodified',
    (await Promise.all(
      pkg.textures.map(async (t) => {
        const now = await decodeTexture(await native.readFile(t.path));
        const then = pkg.pages.get(t.name);
        return now.width === then.width && now.height === then.height;
      })
    )).every(Boolean)
  );

  return { ui, conv, shared, packageDir };
}
