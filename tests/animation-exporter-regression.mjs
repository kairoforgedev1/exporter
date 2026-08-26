import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseSpineAtlas,
  regionFootprint,
  serializeSpineAtlas,
} from '../renderer/js/spine/spineAtlas.js';
import {
  buildSharedAtlas,
  convertPackages,
  mappingsForAnimationNameMode,
  suggestAnimationMapping,
} from '../renderer/js/spine/spineConvert.js';
import { verifyConverted } from '../renderer/js/spine/spinePreview.js';
import {
  listAttachments,
  listSequenceFamilies,
  remapSkeleton,
  requiredRegions,
  sequenceRegionNames,
} from '../renderer/js/spine/spineSkeleton.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacyWildFixture = join(root, 'sample_atlas', 'wild.atlas');

const packing = {
  padding: 0,
  border: 0,
  maxWidth: 64,
  maxHeight: 64,
  powerOfTwo: false,
  square: false,
  textureExtension: 'png',
  registrationScale: 1,
};

function region(name, x, y, w = 2, h = 2) {
  return {
    name,
    x,
    y,
    w,
    h,
    offsetX: 0,
    offsetY: 0,
    origW: w,
    origH: h,
    rotate: 0,
    index: -1,
    extra: [],
  };
}

function sourcePage(first, second) {
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = x < 2 ? first : second;
      data.set(rgba, (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

function sequenceSkeleton(animationNames = ['idle']) {
  return {
    skeleton: { hash: 'regression', spine: '4.2.0', width: 2, height: 2 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'slot', bone: 'root', attachment: 'fx_' }],
    skins: [
      {
        name: 'default',
        attachments: {
          slot: {
            fx_: {
              width: 2,
              height: 2,
              sequence: { count: 2, start: 0, digits: 2 },
            },
          },
        },
      },
    ],
    animations: Object.fromEntries(animationNames.map((name) => [name, {}])),
  };
}

function sequencePackage({
  name,
  first = [255, 0, 0, 255],
  second = [0, 255, 0, 255],
  pma = false,
  animationNames,
} = {}) {
  const pageName = `${name}.png`;
  const skeleton = sequenceSkeleton(animationNames);
  return {
    name,
    atlas: {
      pages: [
        {
          name: pageName,
          size: { w: 4, h: 2 },
          filter: 'Linear,Linear',
          pma,
          extra: [],
          regions: [region('fx_00', 0, 0), region('fx_01', 2, 0)],
        },
      ],
    },
    pages: new Map([[pageName, sourcePage(first, second)]]),
    skeletons: [
      {
        id: `${name}:skeleton`,
        name: `${name}.json`,
        json: skeleton,
      },
    ],
  };
}

function mappingsFor(packages, animationMaps = {}) {
  return new Map(
    packages.flatMap((pkg, packageIndex) =>
      pkg.skeletons.map((skeleton, skeletonIndex) => [
        skeleton.id,
        {
          include: true,
          jsonName: `${pkg.name}_${skeletonIndex}.json`,
          assetKey: `asset${packageIndex}_${skeletonIndex}`,
          animations:
            animationMaps[skeleton.id] ??
            Object.fromEntries(Object.keys(skeleton.json.animations || {}).map((name) => [name, name])),
        },
      ])
    )
  );
}

function convert(packages, overrides = {}) {
  return convertPackages({
    packages,
    mappings: overrides.mappings ?? mappingsFor(packages),
    atlasName: overrides.atlasName ?? 'sequence',
    outputFolder: overrides.outputFolder ?? 'sequence',
    runtimeVersion: '4.2.74',
    packing: { ...packing, ...(overrides.packing || {}) },
  });
}

function sequenceAttachment(skeleton) {
  return skeleton.skins[0].attachments.slot.fx_;
}

function stubImages(shared) {
  return new Map(
    shared.pixelPages.map((page) => [
      page.name,
      { width: page.width, height: page.height },
    ])
  );
}

test('sample_atlas/wild resolves every sf_ and smash_fx_ sequence frame', {
  skip: existsSync(legacyWildFixture) ? false : 'legacy wild fixture was replaced by the current character package',
}, () => {
  const atlasText = readFileSync(join(root, 'sample_atlas', 'wild.atlas'), 'utf8');
  const skeletonJson = JSON.parse(readFileSync(join(root, 'sample_atlas', 'wild.json'), 'utf8'));
  const textureBytes = readFileSync(join(root, 'sample_atlas', 'wild.webp'));
  const atlas = parseSpineAtlas(atlasText);
  assert.equal(atlas.pages.length, 1);

  const page = atlas.pages[0];
  assert.equal(page.regions.length, 99);
  assert.equal(textureBytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(textureBytes.toString('ascii', 8, 16), 'WEBPVP8X');
  const webpWidth =
    1 + textureBytes[24] + (textureBytes[25] << 8) + (textureBytes[26] << 16);
  const webpHeight =
    1 + textureBytes[27] + (textureBytes[28] << 8) + (textureBytes[29] << 16);
  assert.deepEqual([webpWidth, webpHeight], [page.size.w, page.size.h]);
  const regionNames = new Set();
  for (const atlasRegion of page.regions) {
    assert.equal(regionNames.has(atlasRegion.name), false, `duplicate ${atlasRegion.name}`);
    regionNames.add(atlasRegion.name);
    const footprint = regionFootprint(atlasRegion);
    assert.ok(atlasRegion.x >= 0 && atlasRegion.y >= 0);
    assert.ok(atlasRegion.x + footprint.w <= page.size.w);
    assert.ok(atlasRegion.y + footprint.h <= page.size.h);
  }

  const result = verifyConverted({
    atlasText,
    skeletonJson,
    images: new Map([[page.name, { width: page.size.w, height: page.size.h }]]),
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.unresolvedAttachments, []);
  assert.equal(result.animations.length, 8);
  assert.ok(result.setupDrawable > 0);

  const families = listSequenceFamilies(skeletonJson);
  assert.equal(families.length, 3);
  assert.equal(requiredRegions(skeletonJson).length, 99);
  assert.ok(families.some((family) => family.basePath === 'sf_' && family.regions.includes('sf_29')));
  assert.ok(
    families.some(
      (family) => family.basePath === 'smash_fx_' && family.regions.includes('smash_fx_00015')
    )
  );

  const brokenPages = structuredClone(atlas.pages);
  brokenPages[0].regions = brokenPages[0].regions.filter(
    (region) => region.name !== 'sf_17'
  );
  const broken = verifyConverted({
    atlasText: serializeSpineAtlas(brokenPages),
    skeletonJson,
    images: new Map([[page.name, { width: page.size.w, height: page.size.h }]]),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /sf_17/);
});

test('sequence frame numbering defaults to start 1 while preserving explicit start 0', () => {
  assert.deepEqual(sequenceRegionNames('fx_', { count: 3, digits: 2 }), [
    'fx_01',
    'fx_02',
    'fx_03',
  ]);
  assert.deepEqual(sequenceRegionNames('fx_', { count: 3, start: 0, digits: 2 }), [
    'fx_00',
    'fx_01',
    'fx_02',
  ]);
});

test('attachment region names follow SkeletonJson precedence: path, then name, then key', () => {
  // SkeletonJson.readAttachment:
  //     name = getValue(map, "name", attachmentKey);
  //     path = getValue(map, "path", name);
  // `name` is not decoration. An attachment carrying `name` but no `path`
  // resolves to `name`, and treating the key as the region reports a complete
  // package as incomplete while dropping artwork the skeleton references.

  // 1. Neither present: the attachment key is the region.
  const bare = sequenceSkeleton();
  assert.equal(listAttachments(bare)[0].regionName, 'fx_');
  assert.equal(listSequenceFamilies(bare)[0].basePath, 'fx_');

  // 2. `name` only: `name` is the region.
  const named = sequenceSkeleton();
  sequenceAttachment(named).name = 'art/fx_';
  assert.equal(listAttachments(named)[0].regionName, 'art/fx_');
  assert.equal(listSequenceFamilies(named)[0].basePath, 'art/fx_');

  // 3. Both present: `path` wins.
  const both = sequenceSkeleton();
  Object.assign(sequenceAttachment(both), { name: 'ignored', path: 'art/real_' });
  assert.equal(listAttachments(both)[0].regionName, 'art/real_');

  // Remapping keys off the resolved region and writes an explicit `path`,
  // which overrides `name` for the runtime.
  const { skeleton: remapped } = remapSkeleton(named, {
    sequenceBaseMap: new Map([['art/fx_', 'fx_2_']]),
  });
  assert.equal(sequenceAttachment(remapped).path, 'fx_2_');
});

test('a colliding sequence family is renamed atomically and both skeletons load', () => {
  const first = sequencePackage({
    name: 'first',
    first: [255, 0, 0, 255],
    second: [0, 255, 0, 255],
  });
  const second = sequencePackage({
    name: 'second',
    // Frame 0 is identical, but frame 1 is genuinely different. Per-frame
    // deduplication would produce an impossible fx_01_2 sequence here.
    first: [255, 0, 0, 255],
    second: [0, 0, 255, 255],
  });

  const result = convert([first, second]);
  assert.equal(result.ok, true, result.error);

  const firstBase = sequenceAttachment(result.skeletons[0].skeleton).path ?? 'fx_';
  const secondBase = sequenceAttachment(result.skeletons[1].skeleton).path ?? 'fx_';
  assert.equal(firstBase, 'fx_');
  assert.notEqual(secondBase, firstBase);

  const outputNames = new Set(result.shared.pages.flatMap((page) => page.regions.map((item) => item.name)));
  for (const name of sequenceRegionNames(firstBase, { count: 2, start: 0, digits: 2 })) {
    assert.ok(outputNames.has(name), `missing first sequence frame ${name}`);
  }
  for (const name of sequenceRegionNames(secondBase, { count: 2, start: 0, digits: 2 })) {
    assert.ok(outputNames.has(name), `missing renamed sequence frame ${name}`);
  }
  assert.equal([...outputNames].some((name) => /^fx_0[01]_\d+$/.test(name)), false);

  const images = stubImages(result.shared);
  for (const skeleton of result.skeletons) {
    const verified = verifyConverted({
      atlasText: result.shared.atlasText,
      skeletonJson: skeleton.skeleton,
      images,
    });
    assert.equal(verified.ok, true, `${skeleton.variantName}: ${verified.error}`);
    assert.deepEqual(verified.unresolvedAttachments, []);
  }
});

test('PNG texture selection is reflected in atlas pages and generated imports', () => {
  const result = convert([sequencePackage({ name: 'png_source' })]);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.shared.pages.every((page) => page.name.endsWith('.png')));
  assert.match(result.shared.atlasText, /^sequence\.png\r?$/m);
  assert.match(result.indexTs, /from '\.\/sequence\.png';/);

  const outputRegion = result.shared.pages[0].regions.find(
    (item) => item.name === 'fx_00'
  );
  const pixelPage = result.shared.pixelPages[0];
  const pixel = (x, y) =>
    [...pixelPage.rgba.slice((y * pixelPage.width + x) * 4, (y * pixelPage.width + x) * 4 + 4)];
  assert.deepEqual(
    pixel(outputRegion.x - 1, outputRegion.y),
    pixel(outputRegion.x, outputRegion.y),
    'the output should extrude edge pixels to prevent linear-filter bleeding'
  );

  const webpOnly = convert([sequencePackage({ name: 'webp_source' })], {
    packing: { textureExtension: 'webp' },
  });
  assert.equal(webpOnly.ok, true, webpOnly.error);
  assert.ok(webpOnly.shared.pages.every((page) => page.name.endsWith('.webp')));
  assert.match(webpOnly.indexTs, /from '\.\/sequence\.webp';/);
});

test('texture filter and repeat semantics are preserved in the generated atlas', () => {
  const pkg = sequencePackage({ name: 'sampling' });
  pkg.atlas.pages[0].filter = 'Nearest,Nearest';
  pkg.atlas.pages[0].repeat = 'x';

  const result = convert([pkg]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.shared.pages[0].filter, 'Nearest,Nearest');
  assert.equal(result.shared.pages[0].repeat, 'x');
  assert.match(result.shared.atlasText, /filter:Nearest,Nearest/);
  assert.match(result.shared.atlasText, /repeat:x/);

  const parsedWithoutFilter = parseSpineAtlas(
    'page.png\nsize:2,2\nregion\nbounds:0,0,2,2\n'
  );
  assert.equal(parsedWithoutFilter.pages[0].filter, 'Nearest,Nearest');
});

test('mixed PMA, filter, and repeat settings are rejected before packing', () => {
  const straight = sequencePackage({ name: 'straight', pma: false });
  const premultiplied = sequencePackage({ name: 'premultiplied', pma: true });
  const result = buildSharedAtlas([straight, premultiplied], {
    ...packing,
    atlasName: 'mixed',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /mix premultiplied-alpha and straight-alpha/i);

  const linear = sequencePackage({ name: 'linear' });
  const nearest = sequencePackage({ name: 'nearest' });
  nearest.atlas.pages[0].filter = 'Nearest,Nearest';
  const mixedFilter = buildSharedAtlas([linear, nearest], {
    ...packing,
    atlasName: 'mixed_filter',
  });
  assert.equal(mixedFilter.ok, false);
  assert.match(mixedFilter.error, /different texture filters/i);

  nearest.atlas.pages[0].filter = linear.atlas.pages[0].filter;
  nearest.atlas.pages[0].repeat = 'x';
  const mixedRepeat = buildSharedAtlas([linear, nearest], {
    ...packing,
    atlasName: 'mixed_repeat',
  });
  assert.equal(mixedRepeat.ok, false);
  assert.match(mixedRepeat.error, /different texture wrap\/repeat modes/i);
});

test('out-of-bounds source regions are rejected instead of becoming transparent pixels', () => {
  const pkg = sequencePackage({ name: 'outside' });
  pkg.atlas.pages[0].regions[1].x = 3;
  const result = buildSharedAtlas([pkg], { ...packing, atlasName: 'outside' });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid atlas input/i);
  assert.ok(result.warnings.some((warning) => /lies outside/i.test(warning.message)));
});

test('missing attachment and sequence-frame regions stop conversion', () => {
  const pkg = sequencePackage({ name: 'missing_frame' });
  pkg.atlas.pages[0].regions = pkg.atlas.pages[0].regions.filter(
    (item) => item.name !== 'fx_01'
  );
  const result = convert([pkg]);

  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved atlas reference/i);
  assert.ok(result.warnings.some((warning) => /fx_01/.test(warning.message)));
});

test('unsafe output names and invalid TypeScript asset keys are rejected', () => {
  const cases = [
    {
      label: 'atlas name',
      overrides: { atlasName: '../escape' },
      error: /atlas name must be a single safe filename/i,
    },
    {
      label: 'output folder',
      overrides: { outputFolder: '../escape' },
      error: /output folder must be one safe folder name/i,
    },
    {
      label: 'JSON name',
      mappingChange: { jsonName: '../escape.json' },
      error: /output JSON must be a safe basename/i,
    },
    {
      label: 'asset key',
      mappingChange: { assetKey: 'invalid-key' },
      error: /not a valid TypeScript identifier/i,
    },
    {
      label: 'reserved asset key',
      mappingChange: { assetKey: 'class' },
      error: /not a valid TypeScript identifier/i,
    },
  ];

  for (const item of cases) {
    const packages = [
      sequencePackage({ name: `invalid_${item.label.replaceAll(' ', '_')}` }),
    ];
    const mappings = mappingsFor(packages);
    if (item.mappingChange) Object.assign(mappings.values().next().value, item.mappingChange);
    const result = convert(packages, { ...item.overrides, mappings });
    assert.equal(result.ok, false, `${item.label} unexpectedly converted`);
    assert.match(result.error, item.error);
  }
});

test('duplicate animation targets return a conversion error without overwriting a timeline', () => {
  const pkg = sequencePackage({
    name: 'animations',
    animationNames: ['idle', 'win'],
  });
  const mappings = mappingsFor([pkg]);
  const mapping = mappings.get(pkg.skeletons[0].id);
  mapping.animations = { idle: 'same', win: 'same' };

  let result;
  assert.doesNotThrow(() => {
    result = convert([pkg], { mappings });
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /(duplicate output names|output names collide)/i);
});

// ---------------------------------------------------------------------------
// Transparent-pixel contamination on premultiplied pages.
//
// A lossy source cannot see colour underneath transparency, so it smears RGB
// into transparent areas. A pma page is blended as
// `dst = src.rgb + dst.rgb * (1 - src.a)`, so that smear is added straight to
// the screen and draws a visible rectangle around every symbol quad. Measured
// on sample_atlas/wild.webp it lifts the background by up to 163/255.
// ---------------------------------------------------------------------------

/** Colour far brighter than its own alpha — exactly what lossy WebP leaves behind. */
const SMEARED_TRANSPARENT = [213, 40, 190, 0];
const SMEARED_LOW_ALPHA = [73, 0, 72, 16];

function pixelsOf(shared, pageIndex = 0) {
  const page = shared.pixelPages[pageIndex];
  const out = [];
  for (let i = 0; i < page.rgba.length; i += 4) {
    out.push([page.rgba[i], page.rgba[i + 1], page.rgba[i + 2], page.rgba[i + 3]]);
  }
  return out;
}

test('a premultiplied page has colour brighter than its alpha cleaned away', () => {
  const result = convert([
    sequencePackage({
      name: 'smeared',
      pma: true,
      first: SMEARED_TRANSPARENT,
      second: SMEARED_LOW_ALPHA,
    }),
  ]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.shared.pma, true);

  for (const [r, g, b, a] of pixelsOf(result.shared)) {
    assert.ok(
      r <= a && g <= a && b <= a,
      `pma output must satisfy rgb <= alpha, got [${r},${g},${b},${a}]`
    );
  }

  // Fully transparent pixels must carry no colour at all: under pma blending
  // any residue there is pure additive light with nothing to attenuate it.
  for (const [r, g, b, a] of pixelsOf(result.shared)) {
    if (a === 0) assert.deepEqual([r, g, b], [0, 0, 0]);
  }

  assert.ok(result.shared.pmaCorrected.channels > 0, 'the cleanup should be reported');
  assert.equal(result.shared.pmaCorrected.regions, 2);
  const messages = [...(result.warnings || []), ...(result.shared.warnings || [])].map(
    (w) => w.message || String(w)
  );
  assert.ok(
    messages.some((m) => /rgb <= alpha/i.test(m)),
    `the conversion should say what it cleaned, got: ${messages.join(' | ')}`
  );
});

test('a straight-alpha page keeps its transparent colour, which filtering needs', () => {
  const result = convert([
    sequencePackage({
      name: 'straight',
      pma: false,
      first: SMEARED_TRANSPARENT,
      second: SMEARED_LOW_ALPHA,
    }),
  ]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.shared.pma, false);
  assert.equal(result.shared.pmaCorrected.channels, 0, 'straight alpha must not be touched');

  // Zeroing these would replace the boxes with dark halos, because bilinear
  // filtering blends towards whatever colour sits under the transparent side.
  const region = result.shared.pages[0].regions.find((item) => item.name === 'fx_00');
  const page = result.shared.pixelPages[0];
  const at = (x, y) => [...page.rgba.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 4)];
  assert.deepEqual(at(region.x, region.y), SMEARED_TRANSPARENT);
});

test('correctly premultiplied artwork is passed through untouched', () => {
  const result = convert([
    sequencePackage({
      name: 'clean_pma',
      pma: true,
      // rgb <= alpha throughout, as a real premultiplied export guarantees.
      first: [40, 20, 10, 255],
      second: [16, 8, 4, 16],
    }),
  ]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.shared.pmaCorrected.channels, 0);
  assert.equal(result.shared.pmaCorrected.regions, 0);

  const region = result.shared.pages[0].regions.find((item) => item.name === 'fx_00');
  const page = result.shared.pixelPages[0];
  const at = (x, y) => [...page.rgba.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 4)];
  assert.deepEqual(at(region.x, region.y), [40, 20, 10, 255]);
});

test('cleaning happens before extrusion, so no contamination is spread outward', () => {
  const result = convert([
    sequencePackage({
      name: 'extruded',
      pma: true,
      first: SMEARED_TRANSPARENT,
      second: SMEARED_LOW_ALPHA,
    }),
  ]);
  assert.equal(result.ok, true, result.error);

  // The extruded border copies the region's edge pixels. If cleaning ran after
  // extrusion the border would still carry the smear.
  for (const [r, g, b, a] of pixelsOf(result.shared)) {
    assert.ok(r <= a && g <= a && b <= a, 'extruded padding must be clean too');
  }
});

// ---------------------------------------------------------------------------
// Straight-alpha output.
//
// A premultiplied page adds colour beneath a transparent pixel straight to the
// screen, which forces the WebP encoder into lossless at effort 0 — its weakest
// setting. Straight alpha lifts that: the runtime multiplies RGB by alpha at
// upload (spine-pixi-v8 picks `premultiply-alpha-on-upload` when the page has no
// pma flag), so whatever the codec does under a zero alpha is multiplied away.
// ---------------------------------------------------------------------------

/** What the GPU does at upload for a straight-alpha texture. */
function premultiplyBack(rgba) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    out[i + 3] = a;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((rgba[i + c] * a) / 255);
  }
  return out;
}

test('straight-alpha output drops pma:true so the runtime premultiplies on upload', () => {
  const pkg = () => sequencePackage({
    name: 'alpha', pma: true, first: [40, 20, 10, 255], second: [16, 8, 4, 32],
  });

  const straight = convert([pkg()], { packing: { alphaMode: 'straight' } });
  assert.equal(straight.ok, true, straight.error);
  assert.equal(straight.shared.pma, false);
  assert.equal(straight.shared.straightAlphaOutput, true);
  assert.doesNotMatch(straight.shared.atlasText, /pma:true/);

  const kept = convert([pkg()], { packing: { alphaMode: 'premultiplied' } });
  assert.equal(kept.shared.pma, true);
  assert.equal(kept.shared.straightAlphaOutput, false);
  assert.match(kept.shared.atlasText, /pma:true/);

  // Default must not silently change a straight-alpha source.
  const alreadyStraight = convert([sequencePackage({ name: 'plain', pma: false })], {
    packing: { alphaMode: 'straight' },
  });
  assert.equal(alreadyStraight.shared.pma, false);
  assert.equal(alreadyStraight.shared.straightAlphaOutput, false,
    'a source that was never premultiplied has nothing to convert');
});

test('un-premultiplying and premultiplying back returns the original pixels', () => {
  // Every alpha level, with colour at the premultiplied limit (rgb == alpha)
  // and below it, is exercised through the real conversion.
  const first = [16, 8, 4, 16];
  const second = [64, 32, 64, 64];
  const premultiplied = convert([
    sequencePackage({ name: 'exact_pma', pma: true, first, second }),
  ], { packing: { alphaMode: 'premultiplied' } });
  const straight = convert([
    sequencePackage({ name: 'exact_pma', pma: true, first, second }),
  ], { packing: { alphaMode: 'straight' } });
  assert.equal(premultiplied.ok, true, premultiplied.error);
  assert.equal(straight.ok, true, straight.error);

  const rendered = premultiplyBack(straight.shared.pixelPages[0].rgba);
  assert.deepEqual(
    Array.from(rendered),
    Array.from(premultiplied.shared.pixelPages[0].rgba),
    'the straight-alpha page must premultiply back to exactly the premultiplied page'
  );
});

test('straight-alpha output still carries no colour beneath a transparent pixel', () => {
  const result = convert([
    sequencePackage({
      name: 'smeared_straight', pma: true,
      first: SMEARED_TRANSPARENT, second: SMEARED_LOW_ALPHA,
    }),
  ], { packing: { alphaMode: 'straight' } });
  assert.equal(result.ok, true, result.error);

  for (const [r, g, b, a] of pixelsOf(result.shared)) {
    if (a === 0) {
      assert.deepEqual([r, g, b], [0, 0, 0],
        'a fully transparent pixel must stay black so the codec can compress it');
    }
  }
});

/**
 * A package whose page is lossily encoded and whose attachment is a plain
 * region, so it takes the cross-package tolerance dedupe path. Sequence frames
 * are deliberately excluded from that path, so they cannot exercise it.
 */
function lossyPackage({ name, rgba }) {
  const pageName = `${name}.webp`;
  const width = 2;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return {
    name,
    atlas: {
      pages: [{
        name: pageName,
        size: { w: width, h: height },
        filter: 'Linear,Linear',
        pma: true,
        extra: [],
        regions: [region('art', 0, 0)],
      }],
    },
    pages: new Map([[pageName, { data, width, height }]]),
    skeletons: [{
      id: `${name}:skeleton`,
      name: `${name}.json`,
      json: {
        skeleton: { hash: name, spine: '4.2.0', width: 2, height: 2 },
        bones: [{ name: 'root' }],
        slots: [{ name: 'slot', bone: 'root', attachment: 'art' }],
        skins: [{ name: 'default', attachments: { slot: { art: { width: 2, height: 2 } } } }],
        animations: { idle: {} },
      },
    }],
  };
}

test('straight-alpha conversion runs after dedupe, so shared artwork still merges', () => {
  // Un-premultiplying divides by alpha, which amplifies small differences where
  // alpha is low: [8,8,8,16] and [9,8,8,16] differ by 1 premultiplied but by 15
  // once divided. Converting per region, before deduplication, pushed copies of
  // the same lossy artwork outside the merge tolerance and the atlas grew
  // instead of shrinking. The conversion has to happen on the composed page.
  const pair = () => [
    lossyPackage({ name: 'shared_a', rgba: [8, 8, 8, 16] }),
    lossyPackage({ name: 'shared_b', rgba: [9, 8, 8, 16] }),
  ];

  const premultiplied = convert(pair(), { packing: { alphaMode: 'premultiplied' } });
  const straight = convert(pair(), { packing: { alphaMode: 'straight' } });
  assert.equal(premultiplied.ok, true, premultiplied.error);
  assert.equal(straight.ok, true, straight.error);

  assert.ok(
    premultiplied.shared.dedupedCount > 0,
    'the fixture must actually merge artwork, or it cannot guard the regression'
  );
  assert.equal(
    straight.shared.dedupedCount,
    premultiplied.shared.dedupedCount,
    'straight alpha must not change which regions deduplicate'
  );

  const pageA = premultiplied.shared.pixelPages[0];
  const pageB = straight.shared.pixelPages[0];
  assert.equal(pageB.width, pageA.width, 'straight alpha must not change the packed width');
  assert.equal(pageB.height, pageA.height, 'straight alpha must not change the packed height');

  // And the composed page must still premultiply back to exactly the pma page.
  assert.deepEqual(Array.from(premultiplyBack(pageB.rgba)), Array.from(pageA.rgba));
});

// ---------------------------------------------------------------------------
// Animation name suggestions.
//
// The convention is `<assetKey>` for the main animation and `<assetKey>_<role>`
// for the rest. Applying it to a name that already carries the prefix produced
// `bigwin_bigwin_intro` — and because that output is a valid input for the next
// run, every re-export added another prefix.
// ---------------------------------------------------------------------------

test('source animation-name mode keeps exact names without mutating custom mappings', () => {
  const mapping = {
    include: true,
    assetKey: 'FEATURE',
    jsonName: 'feature.json',
    sourceAnimations: ['Idle', 'Win_LOOP', 'bonus intro'],
    animations: {
      Idle: 'feature',
      Win_LOOP: 'feature_win',
      'bonus intro': 'my_manual_bonus',
    },
  };
  const mappings = new Map([['feature::feature', mapping]]);
  const savedCustomNames = { ...mapping.animations };

  const effective = mappingsForAnimationNameMode(mappings, 'source');
  assert.notEqual(effective, mappings, 'source mode should create a conversion-only map');
  assert.notEqual(effective.get('feature::feature'), mapping, 'mapping records must be cloned');
  assert.deepEqual(effective.get('feature::feature').animations, {
    Idle: 'Idle',
    Win_LOOP: 'Win_LOOP',
    'bonus intro': 'bonus intro',
  });
  assert.deepEqual(mapping.animations, savedCustomNames, 'manual target names must survive');

  assert.equal(
    mappingsForAnimationNameMode(mappings, 'target'),
    mappings,
    'target mode should use the stored editable mappings'
  );
  assert.equal(
    mappingsForAnimationNameMode(mappings, 'unknown'),
    mappings,
    'an unknown mode must safely fall back to the existing target behavior'
  );
});

test('an animation the animator already namespaced is not namespaced again', () => {
  const { map } = suggestAnimationMapping({
    sourceAnimations: ['bigwin', 'bigwin_intro', 'bigwin_outro', 'insane_idle'],
    assetKey: 'BIGWIN',
  });

  assert.equal(map.bigwin, 'bigwin', 'the main animation takes the bare key');
  assert.equal(map.bigwin_intro, 'bigwin_intro', 'must not become bigwin_bigwin_intro');
  assert.equal(map.bigwin_outro, 'bigwin_outro');
  assert.equal(map.insane_idle, 'bigwin_insane_idle', 'an unprefixed name still gets the convention');
});

test('re-exporting an already-converted package is idempotent', () => {
  // Feed the output of one suggestion back in as the source, the way a
  // re-export does. The names must stop growing.
  const assetKey = 'BIGWIN';
  let names = ['bigwin', 'bigwin_intro', 'mega_idle'];
  for (let pass = 0; pass < 4; pass++) {
    const { map } = suggestAnimationMapping({ sourceAnimations: names, assetKey });
    names = names.map((n) => map[n]);
  }
  assert.deepEqual(names, ['bigwin', 'bigwin_intro', 'bigwin_mega_idle'],
    `names grew across re-exports: ${names.join(', ')}`);
});

test('the reported bigWin animation set converts without duplicated prefixes', () => {
  // Exactly the skeleton from the screenshot, whose source names had already
  // been doubled by an earlier run.
  const sourceAnimations = [
    'bigwin',
    'bigwin_bigwin_bigwin_intro',
    'bigwin_bigwin_bigwin_outro',
    'bigwin_bigwin_insane_idle',
    'bigwin_bigwin_insane_intro',
    'bigwin_bigwin_insane_outro',
    'bigwin_bigwin_legendary_idle',
    'bigwin_bigwin_mega_idle',
    'bigwin_bigwin_nice_idle',
  ];
  const { map } = suggestAnimationMapping({ sourceAnimations, assetKey: 'BIGWIN' });

  for (const [source, target] of Object.entries(map)) {
    assert.equal(target, source.toLowerCase(),
      `${source} must be left alone, got ${target}`);
  }
  // And nothing gained a further prefix.
  for (const target of Object.values(map)) {
    assert.doesNotMatch(target, /^bigwin_bigwin_bigwin_bigwin/,
      `prefix was added again: ${target}`);
  }
});

test('name collisions are still disambiguated rather than silently merged', () => {
  const { map } = suggestAnimationMapping({
    sourceAnimations: ['idle', 'bigwin_idle'],
    assetKey: 'BIGWIN',
  });
  const targets = Object.values(map);
  assert.equal(new Set(targets).size, targets.length, `collision produced duplicates: ${targets}`);
});

test('an attachment whose region comes from `name` does not make a package incomplete', () => {
  // The intro_panel case: three skins share the attachment key `intro_txt2`,
  // and one of them carries only `name`. Resolving the key instead of `name`
  // reported a missing region for a package the runtime loads cleanly.
  const skeleton = {
    skeleton: { hash: 'panels', spine: '4.2.0', width: 4, height: 4 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'hidden_spins_awarded', bone: 'root', attachment: 'intro_txt2' }],
    skins: [
      {
        name: 'ban_hammer',
        attachments: {
          hidden_spins_awarded: {
            // No `path`; `name` is the region.
            intro_txt2: { name: 'panels/hidden_spins_awarded', width: 685, height: 41 },
          },
        },
      },
      {
        name: 'timeout',
        attachments: {
          hidden_spins_awarded: {
            intro_txt2: {
              name: 'freespins_awarded_txt',
              path: 'panels/freespins_awarded_txt',
              width: 627,
              height: 41,
            },
          },
        },
      },
    ],
    animations: { idle: {} },
  };

  const required = requiredRegions(skeleton).sort();
  assert.deepEqual(required, [
    'panels/freespins_awarded_txt',
    'panels/hidden_spins_awarded',
  ], 'both skins must resolve to their real regions, not the shared attachment key');
  assert.ok(!required.includes('intro_txt2'), 'the attachment key is not a region here');
});

test('rebuilding mappings refreshes current Spine names while preserving manual targets', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { native: {} };

  try {
    const { AnimationReExport } = await import('../renderer/js/animre.js');
    const workflow = Object.create(AnimationReExport.prototype);
    workflow.target = { animationUsage: {}, spineFolders: [] };
    workflow.packages = [
      {
        name: 'feature',
        complete: true,
        skeletons: [
          {
            id: 'feature::feature',
            name: 'feature',
            summary: { animations: ['Idle', 'New_Move'] },
          },
        ],
      },
    ];
    workflow.mappings = new Map([
      [
        'feature::feature',
        {
          include: true,
          package: 'feature',
          skeleton: 'feature',
          assetKey: 'FEATURE',
          jsonName: 'feature.json',
          sourceAnimations: ['Idle', 'Removed'],
          animations: { Idle: 'my_manual_idle', Removed: 'old_removed_name' },
        },
      ],
    ]);

    workflow.buildMappings();
    const rebuilt = workflow.mappings.get('feature::feature');
    assert.deepEqual(rebuilt.sourceAnimations, ['Idle', 'New_Move']);
    assert.deepEqual(rebuilt.animations, {
      Idle: 'my_manual_idle',
      New_Move: 'feature_new_move',
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('Mapping Next stops on Preview and waits for a separate Export click', async () => {
  // animre.js reads the Electron bridge from window when the module is loaded.
  // The navigation method itself can be exercised without constructing the UI.
  const previousWindow = globalThis.window;
  globalThis.window = { native: {} };

  try {
    const { AnimationReExport } = await import('../renderer/js/animre.js');
    const workflow = Object.create(AnimationReExport.prototype);
    let exportCalls = 0;

    workflow.step = 'mapping';
    workflow.goto = (step) => {
      workflow.step = step;
    };
    workflow.runConversion = async () => {
      workflow.goto('preview');
      return true;
    };
    workflow.doExport = async () => {
      exportCalls += 1;
      workflow.goto('export');
    };

    await workflow.next();
    assert.equal(workflow.step, 'preview', 'Mapping Next must land on Preview');
    assert.equal(exportCalls, 0, 'landing on Preview must not write an export');

    await workflow.next();
    assert.equal(exportCalls, 1, 'Export should run only after a second click on Preview');
    assert.equal(workflow.step, 'export');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('Export refuses a preview built with a different animation-name mode', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { native: {} };

  try {
    const { AnimationReExport } = await import('../renderer/js/animre.js');
    const workflow = Object.create(AnimationReExport.prototype);
    let message = '';

    workflow.conversion = { ok: true, warnings: [], shared: { warnings: [] }, skeletons: [] };
    workflow.convertedTextureExtension = 'png';
    workflow.textureFormats = { webp: true, png: true };
    workflow.convertedTextureFormats = { webp: true, png: true };
    workflow.textureQuality = 'high';
    workflow.convertedTextureQuality = 'high';
    workflow.alphaMode = 'straight';
    workflow.convertedAlphaMode = 'straight';
    workflow.animationNameMode = 'source';
    workflow.convertedAnimationNameMode = 'target';
    workflow.toast = (text) => {
      message = text;
    };

    await workflow.doExport();
    assert.match(message, /settings changed.+rebuild the preview/i);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
