// The conversion pipeline: animator spine packages -> Stake Engine asset package.
//
// Steps:
//   1. decode every source texture page once (single canvas round trip)
//   2. lift each atlas region into its own RGBA buffer, undoing pack rotation
//   3. deduplicate byte-identical regions, and rename genuine name collisions
//   4. repack everything into one shared atlas with the editor's MaxRects packer
//   5. emit the shared .atlas text, the remapped skeleton JSONs, textures and
//      the index.ts / assets.ts registration snippets
//
// Region pixels are copied verbatim: no trimming, no re-rotation, no scaling.
// Offsets (the trim metadata Spine uses to position attachments) are preserved
// exactly, so the converted animation is visually identical to the source.

import { pack } from '../packer.js';
import { bytesToCanvas } from '../util.js';
import {
  serializeSpineAtlas,
  extractRegionPixels,
  enforcePremultipliedAlpha,
  unpremultiplyAlpha,
  blitRegion,
  hashPixels,
  compareImages,
  regionFootprint,
} from './spineAtlas.js';
import {
  remapSkeleton,
  summarizeSkeleton,
  assessCompatibility,
  listSequenceFamilies,
  validateAnimationMap,
} from './spineSkeleton.js';

const SAFE_FILE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WINDOWS_RESERVED_FILE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const RESERVED_IDENTIFIERS = new Set([
  '__proto__', 'arguments', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield',
]);

function safeFilePart(value) {
  return typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    !value.endsWith('.') &&
    SAFE_FILE_PART.test(value) &&
    !/[\\/:]/.test(value) &&
    !WINDOWS_RESERVED_FILE.test(value);
}

function safeJsIdentifier(value) {
  return JS_IDENTIFIER.test(value || '') && !RESERVED_IDENTIFIERS.has(value);
}

function mappingError(variant, message) {
  return {
    ok: false,
    error: `${variant.sk.name}: ${message}`,
    warnings: [],
  };
}

function numberedSequenceBase(basePath, number) {
  return basePath.endsWith('_')
    ? `${basePath}${number}_`
    : `${basePath}_${number}_`;
}

function normalizedRepeat(value) {
  const text = String(value || '').toLowerCase();
  return `${text.includes('x') ? 'x' : ''}${text.includes('y') ? 'y' : ''}`;
}

function extrudeRegionPixels(target, targetWidth, image, x, y, amount) {
  if (!amount) return;
  const { data, width, height } = image;
  const copyPixel = (sourceX, sourceY, targetX, targetY) => {
    const sourceIndex = (sourceY * width + sourceX) * 4;
    const targetIndex = (targetY * targetWidth + targetX) * 4;
    target[targetIndex] = data[sourceIndex];
    target[targetIndex + 1] = data[sourceIndex + 1];
    target[targetIndex + 2] = data[sourceIndex + 2];
    target[targetIndex + 3] = data[sourceIndex + 3];
  };
  for (let distance = 1; distance <= amount; distance++) {
    for (let sourceX = 0; sourceX < width; sourceX++) {
      copyPixel(sourceX, 0, x + sourceX, y - distance);
      copyPixel(sourceX, height - 1, x + sourceX, y + height - 1 + distance);
    }
    for (let sourceY = 0; sourceY < height; sourceY++) {
      copyPixel(0, sourceY, x - distance, y + sourceY);
      copyPixel(width - 1, sourceY, x + width - 1 + distance, y + sourceY);
    }
    for (let xDistance = 1; xDistance <= amount; xDistance++) {
      copyPixel(0, 0, x - xDistance, y - distance);
      copyPixel(width - 1, 0, x + width - 1 + xDistance, y - distance);
      copyPixel(0, height - 1, x - xDistance, y + height - 1 + distance);
      copyPixel(
        width - 1,
        height - 1,
        x + width - 1 + xDistance,
        y + height - 1 + distance
      );
    }
  }
}

/**
 * Decode an image file into raw straight-alpha RGBA.
 *
 * The main process decodes exactly. A 2D canvas cannot: its backing store is
 * premultiplied 8-bit, so drawImage followed by getImageData quantizes RGB by
 * alpha/255 and throws away most of the colour under a low alpha — which is
 * precisely where soft edges and additive glow live. The canvas path is kept
 * only as a fallback for when the native decoder is unavailable, and it reports
 * `exact: false` so callers can tell the difference.
 */
export async function decodeTexture(bytes) {
  const native = globalThis.native;
  if (native?.animDecodeTexture) {
    try {
      const res = await native.animDecodeTexture(bytes);
      const data = res?.ok ? new Uint8ClampedArray(res.rgba) : null;
      if (data && data.length === res.width * res.height * 4) {
        return { data, width: res.width, height: res.height, exact: true };
      }
    } catch {
      // Fall through to the canvas decoder below.
    }
  }
  const canvas = await bytesToCanvas(bytes);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height, exact: false };
}

/**
 * Build the shared atlas + converted skeletons.
 *
 * @param {Array} packages  [{name, atlas: parsedAtlas, pages: Map<pageName, rgbaPage>,
 *                            skeleton: parsedJSON, mapping: {...}}]
 * @param {object} options  {padding, border, maxWidth, maxHeight, powerOfTwo, square,
 *                           allowRotation, extrude, atlasName, textureFile}
 */
export function buildSharedAtlas(packages, options) {
  if (!options || !safeFilePart(options.atlasName)) {
    return {
      ok: false,
      error: 'A safe atlas output name is required before packing.',
      warnings: [],
    };
  }
  const textureExtension = String(options.textureExtension || 'webp').toLowerCase();
  if (!['png', 'webp'].includes(textureExtension)) {
    return {
      ok: false,
      error: `Unsupported atlas texture format ".${textureExtension}". Choose PNG or WebP.`,
      warnings: [],
    };
  }

  const settings = {
    padding: options.padding ?? 2,
    border: options.border ?? 2,
    maxWidth: options.maxWidth ?? 4096,
    maxHeight: options.maxHeight ?? 4096,
    powerOfTwo: !!options.powerOfTwo,
    square: !!options.square,
    // Spine regions are packed without rotation: it keeps the emitted atlas
    // trivially correct and costs little space at these sizes.
    allowRotation: false,
    trim: false,
    // One copied edge pixel prevents Linear filtering from sampling transparent
    // padding or a neighbouring region.
    extrude: options.extrude ?? 1,
  };
  const invalidSetting =
    !Number.isInteger(settings.padding) ||
    settings.padding < 0 ||
    !Number.isInteger(settings.border) ||
    settings.border < 0 ||
    !Number.isInteger(settings.extrude) ||
    settings.extrude < 0 ||
    !Number.isInteger(settings.maxWidth) ||
    settings.maxWidth < 1 ||
    !Number.isInteger(settings.maxHeight) ||
    settings.maxHeight < 1;
  if (invalidSetting) {
    return {
      ok: false,
      error:
        'Packing padding, border and extrusion must be non-negative integers; maximum dimensions must be positive integers.',
      warnings: [],
    };
  }

  const warnings = [];
  const inputErrors = [];
  const entries = []; // {key, name, img, hash, sourcePackages:[], region}
  const byHash = new Map();
  const byName = new Map();
  const byGeometry = new Map(); // geometry key -> candidate entries (near-match dedupe)
  // Maps accept either the package object (collision-proof internal lookup) or
  // its display name (backward-compatible diagnostics/tests).
  const perPackageRegionMap = new Map();
  const perPackageSequenceBaseMap = new Map();
  const reservedSequenceNames = new Set();
  // Tolerance for treating regions from different lossy source textures as the
  // same artwork. `maxOpaque` guards visible pixels; `mean` guards overall drift.
  const dedupeTolerance = {
    mean: options.dedupeMean ?? 1.0,
    maxOpaque: options.dedupeMaxOpaque ?? 8,
  };
  const sourcePages = packages.flatMap((pkg) =>
    (pkg.atlas?.pages || []).filter((page) => page.regions?.length)
  );
  const sourcePmaFlags = new Set(sourcePages.map((page) => !!page.pma));
  if (sourcePmaFlags.size > 1) {
    return {
      ok: false,
      error:
        'The selected atlas pages mix premultiplied-alpha and straight-alpha textures. ' +
        'They cannot share one output page safely; re-export them with one PMA setting.',
      warnings: [],
    };
  }
  const sourceFilters = new Set(
    sourcePages.map((page) => page.filter || 'Nearest,Nearest')
  );
  if (!options.filter && sourceFilters.size > 1) {
    return {
      ok: false,
      error:
        'The selected atlas pages use different texture filters. They cannot share output pages without changing rendering.',
      warnings: [],
    };
  }
  const sourceRepeats = new Set(
    sourcePages.map((page) => normalizedRepeat(page.repeat))
  );
  if (options.repeat === undefined && sourceRepeats.size > 1) {
    return {
      ok: false,
      error:
        'The selected atlas pages use different texture wrap/repeat modes. They cannot share output pages safely.',
      warnings: [],
    };
  }
  // Colour recovered from underneath transparent pixels on premultiplied pages.
  const pmaCorrected = { channels: 0, regions: new Set() };

  // 'straight' un-premultiplies so the texture can actually be compressed;
  // 'premultiplied' keeps the source's storage and its encoder restrictions.
  const straightAlphaOutput =
    (options.alphaMode ?? 'premultiplied') === 'straight' && sourcePmaFlags.has(true);

  const outputFilter =
    options.filter || [...sourceFilters][0] || 'Nearest,Nearest';
  const outputRepeat =
    options.repeat !== undefined
      ? normalizedRepeat(options.repeat) || null
      : [...sourceRepeats][0] || null;

  for (const pkg of packages) {
    const regionMap = new Map();
    perPackageRegionMap.set(pkg, regionMap);
    perPackageRegionMap.set(pkg.name, regionMap);
    const sequenceBaseMap = new Map();
    const sequenceFrameMap = new Map();
    const seenSourceRegions = new Set();
    perPackageSequenceBaseMap.set(pkg, sequenceBaseMap);
    perPackageSequenceBaseMap.set(pkg.name, sequenceBaseMap);

    // Sequence attachments are one atomic naming unit. If any numbered frame
    // would collide with a region already emitted by another package, rename
    // the base and every frame together (sf_00… -> sf_2_00…). Renaming a lone
    // frame to sf_00_2 would be invalid because Spine only stores the base.
    const fallbackSkeletons = pkg.skeletons?.length
      ? pkg.skeletons.map((skeleton) => skeleton.json || skeleton)
      : pkg.skeleton
        ? [pkg.skeleton.json || pkg.skeleton]
        : [];
    const sequenceSkeletons =
      options.sequenceSkeletonsByPackage?.get(pkg) ?? fallbackSkeletons;
    const sequenceGroups = new Map();
    const seenFamilies = new Set();
    for (const skeleton of sequenceSkeletons) {
      for (const family of listSequenceFamilies(skeleton)) {
        if (seenFamilies.has(family.familyKey)) continue;
        seenFamilies.add(family.familyKey);
        if (typeof family.basePath !== 'string' || !family.basePath) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message:
              `Sequence attachment "${family.attachmentName}" has an invalid texture path.`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          continue;
        }
        if (
          !Number.isInteger(family.sequence.count) ||
          family.sequence.count < 1 ||
          !Number.isInteger(family.sequence.start) ||
          !Number.isInteger(family.sequence.digits) ||
          family.sequence.digits < 0 ||
          !Number.isInteger(family.sequence.setup) ||
          family.sequence.setup < 0
        ) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message:
              `Sequence attachment "${family.attachmentName}" has invalid count/start/digits/setup values.`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          continue;
        }
        if (!sequenceGroups.has(family.basePath)) {
          sequenceGroups.set(family.basePath, new Set());
        }
        for (const frame of family.regions) {
          sequenceGroups.get(family.basePath).add(frame);
        }
      }
    }

    for (const [basePath, sourceFramesSet] of sequenceGroups) {
      const sourceFrames = [...sourceFramesSet];
      let outputBase = basePath;
      let outputFrames = sourceFrames.slice();
      let suffix = 2;
      while (
        outputFrames.some(
          (name) => byName.has(name) || reservedSequenceNames.has(name)
        )
      ) {
        outputBase = numberedSequenceBase(basePath, suffix++);
        outputFrames = sourceFrames.map(
          (sourceName) => outputBase + sourceName.slice(basePath.length)
        );
      }

      sequenceBaseMap.set(basePath, outputBase);
      sourceFrames.forEach((sourceName, index) => {
        const outputName = outputFrames[index];
        const previous = sequenceFrameMap.get(sourceName);
        if (previous !== undefined && previous !== outputName) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message:
              `Sequence frame "${sourceName}" belongs to incompatible base families ` +
              `("${previous}" and "${outputName}").`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          return;
        }
        sequenceFrameMap.set(sourceName, outputName);
        reservedSequenceNames.add(outputName);
      });

      if (outputBase !== basePath) {
        warnings.push({
          level: 'info',
          package: pkg.name,
          message:
            `Sequence family "${basePath}" shares frame names with another package; ` +
            `renamed the complete family to "${outputBase}".`,
        });
      }
    }

    for (const page of pkg.atlas.pages) {
      const pixels = pkg.pages.get(page.name);
      if (!pixels) {
        const problem = {
          level: 'error',
          package: pkg.name,
          message: `Texture page "${page.name}" was not supplied; its regions cannot be converted.`,
        };
        warnings.push(problem);
        inputErrors.push(problem);
        continue;
      }
      if (
        !Number.isInteger(pixels.width) ||
        pixels.width < 1 ||
        !Number.isInteger(pixels.height) ||
        pixels.height < 1 ||
        !pixels.data ||
        typeof pixels.data.length !== 'number' ||
        pixels.data.length < pixels.width * pixels.height * 4
      ) {
        const problem = {
          level: 'error',
          package: pkg.name,
          message: `Texture page "${page.name}" did not decode to a complete RGBA image.`,
        };
        warnings.push(problem);
        inputErrors.push(problem);
        continue;
      }
      if (page.size.w && (page.size.w !== pixels.width || page.size.h !== pixels.height)) {
        warnings.push({
          level: 'warn',
          package: pkg.name,
          message:
            `Atlas declares ${page.name} as ${page.size.w}x${page.size.h} but the file is ` +
            `${pixels.width}x${pixels.height}; regions were read from the actual image.`,
        });
      }

      for (const region of page.regions) {
        if (seenSourceRegions.has(region.name)) {
          warnings.push({
            level: 'warn',
            package: pkg.name,
            message:
              `Atlas region "${region.name}" is declared more than once; ` +
              'only the first declaration is reachable by the Spine runtime.',
          });
          continue;
        }
        seenSourceRegions.add(region.name);

        const validGeometry =
          Number.isInteger(region.x) &&
          Number.isInteger(region.y) &&
          Number.isInteger(region.w) &&
          Number.isInteger(region.h) &&
          Number.isInteger(region.offsetX) &&
          Number.isInteger(region.offsetY) &&
          Number.isInteger(region.origW) &&
          Number.isInteger(region.origH) &&
          region.w > 0 &&
          region.h > 0 &&
          region.origW > 0 &&
          region.origH > 0 &&
          [0, 90, 180, 270].includes(region.rotate);
        if (!validGeometry) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message:
              `Region "${region.name}" has invalid bounds, trim metadata, or rotation in ${page.name}.`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          continue;
        }

        const foot = regionFootprint(region);
        if (
          region.x < 0 ||
          region.y < 0 ||
          region.x + foot.w > pixels.width ||
          region.y + foot.h > pixels.height
        ) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message: `Region "${region.name}" lies outside ${page.name} (${pixels.width}x${pixels.height}).`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          continue;
        }
        const img = extractRegionPixels(pixels, region);
        // A lossy source smears colour into its transparent areas. On a pma
        // page the runtime adds that colour straight to the screen, so clean it
        // before the pixels are hashed, deduplicated, blitted or extruded —
        // otherwise extrusion spreads the contamination and dedupe compares it.
        if (page.pma) {
          const corrected = enforcePremultipliedAlpha(img);
          if (corrected) {
            pmaCorrected.channels += corrected;
            pmaCorrected.regions.add(region.name);
          }
        }
        const sequenceOutputName = sequenceFrameMap.get(region.name);
        const lossySource = /\.(?:webp|jpe?g)$/i.test(page.name);
        // Geometry must match exactly before pixels are even considered.
        const geometry = `${region.name}|${region.w}x${region.h}|${region.offsetX},${region.offsetY},${region.origW},${region.origH}`;
        const identity = `${hashPixels(img)}|${geometry}`;

        // Never merge sequence frames independently. A sequence can only be
        // remapped through one base path, so partial deduplication would make
        // some numbered frames resolve to another package's artwork.
        let existing = sequenceOutputName === undefined ? byHash.get(identity) : null;
        if (!existing && sequenceOutputName === undefined) {
          // Animators deliver one lossily-encoded texture per package, so the
          // same artwork is never byte-identical across packages. Share it when
          // the difference is only codec noise: identical name and trim data,
          // a negligible average delta and no visible difference where the
          // pixels are actually opaque.
          for (const candidate of byGeometry.get(geometry) || []) {
            if (!lossySource || !candidate.lossySource) continue;
            const diff = compareImages(img, candidate.img);
            if (diff && diff.mean <= dedupeTolerance.mean && diff.maxOpaque <= dedupeTolerance.maxOpaque) {
              existing = candidate;
              if (diff.mean > 0) {
                candidate.mergeDeltas.push({ package: pkg.name, mean: +diff.mean.toFixed(3), maxOpaque: diff.maxOpaque });
              }
              break;
            }
          }
        }

        if (existing) {
          regionMap.set(region.name, existing.name);
          if (!existing.sourcePackages.includes(pkg.name)) existing.sourcePackages.push(pkg.name);
          if (existing.sourceName !== region.name) existing.aliasOf.add(region.name);
          continue;
        }

        // Same name, different pixels -> must be disambiguated.
        let outName = sequenceOutputName ?? region.name;
        if (
          sequenceOutputName === undefined &&
          (byName.has(outName) || reservedSequenceNames.has(outName))
        ) {
          let n = 2;
          while (
            byName.has(`${region.name}_${n}`) ||
            reservedSequenceNames.has(`${region.name}_${n}`)
          ) {
            n++;
          }
          outName = `${region.name}_${n}`;
          warnings.push({
            level: 'info',
            package: pkg.name,
            message: `Region "${region.name}" differs between packages; renamed to "${outName}" in the shared atlas.`,
          });
        } else if (sequenceOutputName !== undefined && byName.has(outName)) {
          const problem = {
            level: 'error',
            package: pkg.name,
            message:
              `Sequence frame "${region.name}" could not reserve output region "${outName}".`,
          };
          warnings.push(problem);
          inputErrors.push(problem);
          continue;
        }

        const entry = {
          name: outName,
          sourceName: region.name,
          img,
          hash: identity,
          geometry,
          offsetX: region.offsetX,
          offsetY: region.offsetY,
          origW: region.origW,
          origH: region.origH,
          sourcePackages: [pkg.name],
          aliasOf: new Set(),
          mergeDeltas: [],
          lossySource,
          pma: page.pma,
        };
        entries.push(entry);
        byHash.set(identity, entry);
        byName.set(outName, entry);
        if (!byGeometry.has(geometry)) byGeometry.set(geometry, []);
        byGeometry.get(geometry).push(entry);
        regionMap.set(region.name, outName);
      }
    }
  }

  if (inputErrors.length) {
    return {
      ok: false,
      error:
        `The selected Spine source has ${inputErrors.length} invalid atlas input` +
        `${inputErrors.length === 1 ? '' : 's'}; conversion stopped before export. ` +
        inputErrors[0].message,
      warnings,
    };
  }

  if (!entries.length) {
    return { ok: false, error: 'No atlas regions could be read from the selected packages.', warnings };
  }

  for (const entry of entries) {
    if (entry.mergeDeltas.length) {
      const worst = entry.mergeDeltas.reduce((a, b) => (b.mean > a.mean ? b : a));
      warnings.push({
        level: 'info',
        message:
          `"${entry.name}" is shared by ${entry.sourcePackages.join(', ')}: the copies differ only by ` +
          `lossy-texture noise (mean ${worst.mean}, max ${worst.maxOpaque} on opaque pixels), so one copy is stored.`,
      });
    }
  }

  // Source pages were checked before extraction, so one flag is safe for all
  // generated pages and for cross-package region deduplication. Converting to
  // straight alpha drops the flag, which is what tells the loader to
  // premultiply on upload instead of treating the bytes as already multiplied.
  const pma = sourcePmaFlags.has(true) && !straightAlphaOutput;

  // --- pack ----------------------------------------------------------------
  // Everything is packed into one page when it fits. Regions that do not fit
  // spill into additional pages rather than failing the conversion, so a
  // source that genuinely needs multiple pages keeps them.
  entries.forEach((e, i) => {
    e.id = i;
  });

  const oversized = entries.filter(
    (e) =>
      e.img.width + settings.extrude * 2 + settings.border * 2 > settings.maxWidth ||
      e.img.height + settings.extrude * 2 + settings.border * 2 > settings.maxHeight
  );
  if (oversized.length) {
    return {
      ok: false,
      error:
        `${oversized.length} region(s) are larger than the maximum atlas size ` +
        `(${settings.maxWidth}x${settings.maxHeight}): ` +
        oversized.map((e) => `${e.name} ${e.img.width}x${e.img.height}`).slice(0, 4).join(', ') +
        `. Raise the maximum atlas size.`,
      warnings,
    };
  }

  const pageLayouts = [];
  let remaining = entries.slice();
  while (remaining.length) {
    const result = pack(
      remaining.map((e) => ({
        id: e.id,
        w: e.img.width + settings.extrude * 2,
        h: e.img.height + settings.extrude * 2,
      })),
      settings
    );
    if (!result.placed.length) {
      return {
        ok: false,
        error: `Packing made no progress on ${remaining.length} remaining region(s).`,
        warnings,
      };
    }
    pageLayouts.push(result);
    const placedIds = new Set(result.placed.map((p) => p.id));
    remaining = remaining.filter((e) => !placedIds.has(e.id));
    if (pageLayouts.length > 16) {
      return { ok: false, error: 'Refusing to emit more than 16 texture pages.', warnings };
    }
  }

  if (pageLayouts.length > 1) {
    warnings.push({
      level: 'info',
      message:
        `The regions do not fit one ${settings.maxWidth}x${settings.maxHeight} page; ` +
        `the shared atlas uses ${pageLayouts.length} texture pages.`,
    });
  }

  // --- compose the pages ---------------------------------------------------
  const baseName = options.atlasName;
  const ext = textureExtension;
  const pages = [];
  const pixelPages = [];
  let usedPixels = 0;
  let totalPixels = 0;

  pageLayouts.forEach((layout, index) => {
    const rgba = new Uint8ClampedArray(layout.width * layout.height * 4);
    const placed = [];
    for (const placement of layout.placed) {
      const entry = entries[placement.id];
      const regionX = placement.x + settings.extrude;
      const regionY = placement.y + settings.extrude;
      blitRegion(rgba, layout.width, layout.height, entry.img, regionX, regionY);
      extrudeRegionPixels(
        rgba,
        layout.width,
        entry.img,
        regionX,
        regionY,
        settings.extrude
      );
      usedPixels += entry.img.width * entry.img.height;
      entry.page = index;
      placed.push({ ...placement, x: regionX, y: regionY, entry });
    }
    // Straight alpha is applied to the finished page, never to individual
    // regions. Un-premultiplying divides by alpha, which amplifies small
    // differences at a low alpha — doing it before deduplication makes two
    // copies of the same artwork stop matching within tolerance, and the atlas
    // grows instead of shrinking. Hashing, dedupe, blitting and extrusion all
    // run on premultiplied pixels; only the composed page is converted.
    if (straightAlphaOutput) unpremultiplyAlpha({ data: rgba });

    totalPixels += layout.width * layout.height;

    // Page naming mirrors the Spine exporter: name, name_2, name_3…
    const textureFile = index === 0 ? `${baseName}.${ext}` : `${baseName}_${index + 1}.${ext}`;
    pages.push({
      name: textureFile,
      size: { w: layout.width, h: layout.height },
      filter: outputFilter,
      repeat: outputRepeat,
      pma,
      extra: [],
      regions: placed
        .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
        .map(({ x, y, entry }) => ({
          name: entry.name,
          x,
          y,
          w: entry.img.width,
          h: entry.img.height,
          offsetX: entry.offsetX,
          offsetY: entry.offsetY,
          origW: entry.origW,
          origH: entry.origH,
          rotate: 0,
          index: -1,
        })),
    });
    pixelPages.push({ name: textureFile, rgba, width: layout.width, height: layout.height });
  });

  if (straightAlphaOutput) {
    warnings.push({
      level: 'info',
      message:
        'The premultiplied source was converted to straight alpha and the output atlas omits ' +
        '`pma:true`, so the runtime premultiplies on upload. The conversion is exact, and it lets ' +
        'the texture be compressed properly — premultiplied pages have to avoid every WebP mode ' +
        'that touches colour beneath a transparent pixel.',
    });
  }

  if (pmaCorrected.channels) {
    warnings.push({
      level: 'info',
      message:
        `Cleaned ${pmaCorrected.channels} colour channel(s) across ${pmaCorrected.regions.size} region(s): the ` +
        `premultiplied source stored colour brighter than its own alpha — lossy-codec smear that a pma page adds ` +
        `straight to the screen as a visible box around the region quad. Clamped to rgb <= alpha.`,
    });
  }

  return {
    ok: true,
    atlasText: serializeSpineAtlas(pages),
    pages,
    pixelPages,
    // Convenience aliases for the common single-page case.
    page: pages[0],
    rgba: pixelPages[0].rgba,
    width: pixelPages[0].width,
    height: pixelPages[0].height,
    pageCount: pages.length,
    usedPct: (usedPixels / totalPixels) * 100,
    entries,
    regionMaps: perPackageRegionMap,
    sequenceBaseMaps: perPackageSequenceBaseMap,
    sharedRegions: entries.map((e) => ({
      name: e.name,
      sourceName: e.sourceName,
      width: e.img.width,
      height: e.img.height,
      sharedBy: e.sourcePackages,
      aliases: [...e.aliasOf],
      page: e.page ?? 0,
    })),
    dedupedCount: entries.filter((e) => e.sourcePackages.length > 1).length,
    pma,
    straightAlphaOutput,
    pmaCorrected: { channels: pmaCorrected.channels, regions: pmaCorrected.regions.size },
    warnings,
  };
}

/**
 * Return the animation mappings conversion should use for the selected naming
 * mode. Source mode is a non-destructive identity-map view of the imported
 * animation keys; target mode keeps the existing editable records.
 */
export function mappingsForAnimationNameMode(mappings, mode = 'target') {
  // Target mode is the existing editable map. Returning it unchanged keeps the
  // normal conversion path allocation-free and preserves object identity for
  // callers that attach UI state to mapping records.
  if (mode !== 'source' || !(mappings instanceof Map)) return mappings;

  // Source mode is deliberately a conversion-only view. Clone each selected
  // record and replace only its animation map with an exact identity map; the
  // target/custom names underneath must still be there if the user switches
  // back after previewing.
  return new Map(
    [...mappings].map(([id, mapping]) => {
      const sourceAnimations = Array.isArray(mapping?.sourceAnimations)
        ? mapping.sourceAnimations
        : Object.keys(mapping?.animations || {});
      return [
        id,
        {
          ...mapping,
          animations: Object.fromEntries(sourceAnimations.map((name) => [name, name])),
        },
      ];
    })
  );
}

/**
 * Full conversion. Returns everything needed to preview and then write the
 * output package, without touching the filesystem.
 */
export function convertPackages({ packages, mappings, atlasName, outputFolder, runtimeVersion, packing }) {
  const warnings = [];
  const folderName = outputFolder || atlasName;

  if (!safeFilePart(atlasName)) {
    return {
      ok: false,
      error:
        'Atlas name must be a single safe filename using letters, numbers, dot, dash or underscore, and cannot be a reserved Windows name.',
      warnings,
    };
  }
  if (!safeFilePart(folderName)) {
    return {
      ok: false,
      error:
        'Output folder must be one safe folder name using letters, numbers, dot, dash or underscore, and cannot be a reserved Windows name.',
      warnings,
    };
  }
  const registrationScale = packing?.registrationScale ?? 1;
  if (!Number.isFinite(registrationScale) || registrationScale <= 0) {
    return {
      ok: false,
      error: 'Registration scale must be a positive finite number.',
      warnings,
    };
  }

  // A package is one atlas plus one or more skeleton variants. A variant is
  // included when its own mapping says so; a package participates in the
  // shared atlas when at least one of its variants is included.
  const variants = [];
  for (const pkg of packages) {
    for (const sk of pkg.skeletons || []) {
      const m = mappings.get(sk.id);
      if (m?.include) variants.push({ pkg, sk, mapping: m });
    }
  }
  if (!variants.length) {
    return { ok: false, error: 'No skeletons are selected for conversion.', warnings };
  }
  const enabled = packages.filter((p) => variants.some((v) => v.pkg === p));

  // Duplicate output names are a hard error: they would overwrite each other.
  const seenJson = new Map();
  const seenKey = new Map();
  for (const v of variants) {
    const { jsonName, assetKey } = v.mapping;
    if (!safeFilePart(jsonName) || !/\.json$/i.test(jsonName)) {
      return mappingError(v, 'output JSON must be a safe basename ending in ".json".');
    }
    if (!safeJsIdentifier(assetKey)) {
      return mappingError(v, `asset key "${assetKey || ''}" is not a valid TypeScript identifier.`);
    }
    for (const [sourceName, targetName] of Object.entries(v.mapping.animations || {})) {
      if (typeof targetName !== 'string' || !targetName.trim()) {
        return mappingError(v, `animation "${sourceName}" needs a non-empty output name.`);
      }
    }
    const animationMap = new Map(Object.entries(v.mapping.animations || {}));
    const animationCollisions = validateAnimationMap(v.sk.json, animationMap);
    if (animationCollisions.length) {
      const detail = animationCollisions
        .map(
          ({ target, sources }) =>
            `"${target}" from ${sources.map((source) => `"${source}"`).join(', ')}`
        )
        .join('; ');
      return mappingError(v, `animation output names collide: ${detail}.`);
    }

    const jsonKey = jsonName.toLowerCase();
    if (seenJson.has(jsonKey)) {
      return {
        ok: false,
        error: `Two skeletons both export as "${jsonName}" (${seenJson.get(jsonKey)} and ${v.sk.name}). Give them different output names.`,
        warnings,
      };
    }
    seenJson.set(jsonKey, v.sk.name);
    if (seenKey.has(assetKey)) {
      return {
        ok: false,
        error: `Two skeletons both register as "${assetKey}" (${seenKey.get(assetKey)} and ${v.sk.name}). Give them different asset keys.`,
        warnings,
      };
    }
    seenKey.set(assetKey, v.sk.name);
  }

  const sequenceSkeletonsByPackage = new Map();
  for (const pkg of enabled) {
    sequenceSkeletonsByPackage.set(
      pkg,
      variants.filter((variant) => variant.pkg === pkg).map((variant) => variant.sk.json)
    );
  }
  const shared = buildSharedAtlas(enabled, {
    ...packing,
    atlasName,
    sequenceSkeletonsByPackage,
  });
  if (!shared.ok) return shared;
  warnings.push(...shared.warnings);

  // Validate all skeleton-to-atlas mappings before emitting any converted
  // skeleton. Missing sequence frames and incoherent per-frame remaps are hard
  // failures; both otherwise create packages which cannot load at runtime.
  const preparedVariants = [];
  const skeletonInputErrors = [];
  for (const { pkg, sk, mapping } of variants) {
    const regionMap =
      shared.regionMaps.get(pkg) || shared.regionMaps.get(pkg.name) || new Map();
    const sequenceBaseMap =
      shared.sequenceBaseMaps.get(pkg) ||
      shared.sequenceBaseMaps.get(pkg.name) ||
      new Map();
    const animationMap = new Map(Object.entries(mapping.animations || {}));
    const summary = summarizeSkeleton(sk.json);

    // Every region the skeleton needs must exist in the shared atlas.
    const missing = summary.regions.filter((r) => !regionMap.has(r));
    for (const name of missing) {
      const problem = {
        level: 'error',
        package: `${pkg.name}/${sk.name}`,
        message: `Attachment region "${name}" is referenced by the skeleton but is not in its atlas.`,
      };
      warnings.push(problem);
      skeletonInputErrors.push(problem);
    }

    for (const family of listSequenceFamilies(sk.json)) {
      const outputBase = sequenceBaseMap.get(family.basePath) ?? family.basePath;
      for (const sourceFrame of family.regions) {
        const expectedFrame =
          outputBase + sourceFrame.slice(family.basePath.length);
        const actualFrame = regionMap.get(sourceFrame);
        if (actualFrame !== undefined && actualFrame !== expectedFrame) {
          const problem = {
            level: 'error',
            package: `${pkg.name}/${sk.name}`,
            message:
              `Sequence "${family.basePath}" mapped frame "${sourceFrame}" to ` +
              `"${actualFrame}" instead of coherent family frame "${expectedFrame}".`,
          };
          warnings.push(problem);
          skeletonInputErrors.push(problem);
        }
      }
    }

    preparedVariants.push({
      pkg,
      sk,
      mapping,
      regionMap,
      sequenceBaseMap,
      animationMap,
      summary,
      missing,
    });
  }

  if (skeletonInputErrors.length) {
    return {
      ok: false,
      error:
        `The selected skeletons have ${skeletonInputErrors.length} unresolved atlas reference` +
        `${skeletonInputErrors.length === 1 ? '' : 's'}; no package was produced. ` +
        skeletonInputErrors[0].message,
      warnings,
    };
  }

  // --- skeletons -----------------------------------------------------------
  const skeletons = [];
  for (const {
    pkg,
    sk,
    mapping,
    regionMap,
    sequenceBaseMap,
    animationMap,
    summary,
    missing,
  } of preparedVariants) {
    let remapped;
    try {
      remapped = remapSkeleton(sk.json, {
        regionMap,
        sequenceBaseMap,
        animationMap,
      });
    } catch (error) {
      return mappingError(
        { sk },
        error?.message || 'could not safely remap the skeleton.'
      );
    }
    const { skeleton, changes } = remapped;
    const compatibility = assessCompatibility({
      sourceVersion: summary.spine,
      runtimeVersion,
      features: summary.features,
    });

    // Which output pages this skeleton actually needs.
    const usedPages = new Set();
    for (const r of summary.regions) {
      const outName = regionMap.get(r);
      const entry = shared.sharedRegions.find((e) => e.name === outName);
      if (entry) usedPages.add(entry.page);
    }

    skeletons.push({
      package: pkg.name,
      variantId: sk.id,
      variantName: sk.name,
      variantLabel: sk.variantLabel || null,
      assetKey: mapping.assetKey,
      jsonName: mapping.jsonName,
      skeleton,
      json: JSON.stringify(skeleton),
      summary,
      changes,
      compatibility,
      missingRegions: missing,
      usedPages: [...usedPages].sort(),
      outAnimations: Object.keys(skeleton.animations || {}),
    });
  }

  // --- region ownership across the skeletons sharing each atlas ------------
  const regionOwners = new Map(); // shared region name -> Set(variantId)
  for (const { pkg, sk } of variants) {
    const regionMap =
      shared.regionMaps.get(pkg) || shared.regionMaps.get(pkg.name) || new Map();
    const summary = summarizeSkeleton(sk.json);
    for (const r of summary.regions) {
      const outName = regionMap.get(r);
      if (!outName) continue;
      if (!regionOwners.has(outName)) regionOwners.set(outName, new Set());
      regionOwners.get(outName).add(sk.id);
    }
  }
  const regionUsage = shared.sharedRegions.map((r) => ({
    ...r,
    usedBy: [...(regionOwners.get(r.name) || [])],
  }));
  const sharedBetweenSkeletons = regionUsage.filter((r) => r.usedBy.length > 1).length;
  const skeletonSpecific = regionUsage.filter((r) => r.usedBy.length === 1).length;
  const unusedRegions = regionUsage.filter((r) => r.usedBy.length === 0);
  if (unusedRegions.length) {
    warnings.push({
      level: 'info',
      message:
        `${unusedRegions.length} atlas region(s) are not referenced by any selected skeleton ` +
        `and were still packed: ${unusedRegions.slice(0, 5).map((r) => r.name).join(', ')}` +
        `${unusedRegions.length > 5 ? '…' : ''}.`,
    });
  }

  // --- registration snippets ----------------------------------------------
  const folder = folderName;
  const assetEntries = skeletons.map((s) => ({
    key: s.assetKey,
    atlas: `spines/${folder}/${atlasName}.atlas`,
    skeleton: `spines/${folder}/${s.jsonName}`,
    scale: registrationScale,
  }));

  const indexTs = buildIndexTs({
    atlasName,
    textureFiles: shared.pages.map((p) => p.name),
    skeletons,
  });

  const assetsTsSnippet = assetEntries
    .map(
      (e) =>
        `\t${e.key}: {\n\t\ttype: 'spine',\n\t\tsrc: {\n` +
        `\t\t\tatlas: new URL('../../assets/${e.atlas}', import.meta.url).href,\n` +
        `\t\t\tskeleton: new URL('../../assets/${e.skeleton}', import.meta.url).href,\n` +
        `\t\t\tscale: ${e.scale},\n\t\t},\n\t},`
    )
    .join('\n');

  return {
    ok: true,
    shared,
    skeletons,
    assetEntries,
    indexTs,
    assetsTsSnippet,
    atlasName,
    outputFolder: folder,
    regionUsage,
    stats: {
      packages: enabled.length,
      skeletons: skeletons.length,
      pageCount: shared.pageCount,
      sourcePages: enabled.reduce((n, p) => n + (p.atlas?.pages.length || 0), 0),
      sharedBetweenSkeletons,
      skeletonSpecific,
      dedupedAcrossPackages: shared.dedupedCount,
    },
    warnings,
    blocking: skeletons.some((s) => s.compatibility.blocking) || warnings.some((w) => w.level === 'error'),
  };
}

/**
 * index.ts in the folder-asset shape the project's own spine folders use.
 *
 * Note: no `createAsset` export exists in the pixi-svelte version this SDK
 * ships — these folder modules are legacy and nothing imports them; the game
 * loads spines through `src/game/assets.ts`. The file is emitted so the new
 * folder matches its neighbours, and every texture page is imported so a
 * bundler that does pick it up emits all of them.
 */
function buildIndexTs({ atlasName, textureFiles, skeletons }) {
  const pageImports = textureFiles
    .map((file, i) => `import img${i === 0 ? '' : i + 1} from './${file}';`)
    .join('\n');
  const imports = skeletons.map((s) => `import ${s.assetKey} from './${s.jsonName}';`).join('\n');
  const keys = skeletons.map((s) => `\t\t${s.assetKey},`).join('\n');
  // Only `img` is used by the folder-module shape found in this project. The
  // remaining pages are listed so they stay referenced; the atlas file names
  // its own pages, which is what the runtime actually resolves them by.
  const multiPageNote =
    textureFiles.length > 1
      ? `// ${atlasName}.atlas declares ${textureFiles.length} texture pages; the Spine atlas\n` +
        `// loader resolves them relative to the atlas file.\n`
      : '';
  const imgFields =
    textureFiles.length === 1
      ? '\timg,\n'
      : `\timg,\n\timgs: [${textureFiles.map((_, i) => (i === 0 ? 'img' : `img${i + 1}`)).join(', ')}],\n`;
  return (
    `import { createAsset } from 'pixi-svelte';\n\n` +
    `${pageImports}\n` +
    `import rawAtlas from './${atlasName}.atlas?raw';\n` +
    `${imports}\n\n` +
    multiPageNote +
    `export default createAsset({\n` +
    imgFields +
    `\trawAtlas,\n` +
    `\tspines: {\n${keys}\n\t},\n` +
    `});\n`
  );
}

/**
 * Suggest a mapping from source animations to the target's naming convention.
 * `targetAnimations` are the names the selected project actually requests for
 * this kind of asset (read from the game source), when known.
 */
export function suggestAnimationMapping({ sourceAnimations, assetKey, referenceAnimations, requestedAnimations }) {
  const lower = assetKey.toLowerCase();
  const out = {};
  const used = new Set();

  const pick = (candidate) => {
    let name = candidate;
    let n = 2;
    while (used.has(name)) name = `${candidate}_${n++}`;
    used.add(name);
    return name;
  };

  // Heuristic: the "win"/main animation takes the bare symbol name (that is
  // what the reference assets and the game's SYMBOL_INFO_MAP use); other
  // animations keep their role as a suffix.
  const mainCandidates = ['win', 'animation', 'play', 'idle', 'loop'];
  const main =
    sourceAnimations.find((a) => mainCandidates.includes(a.toLowerCase())) || sourceAnimations[0] || null;

  // An animation the animator already namespaced must not be namespaced again.
  // Prefixing unconditionally turns `bigwin_intro` into `bigwin_bigwin_intro`,
  // and because the result is a valid source for the next run it compounds
  // every time a package is re-exported.
  const alreadyPrefixed = (name) => {
    const n = name.toLowerCase();
    return n === lower || n.startsWith(`${lower}_`);
  };

  for (const anim of sourceAnimations) {
    const n = anim.toLowerCase();
    if (anim === main) {
      // The bare symbol name is the contract the game's SYMBOL_INFO_MAP uses.
      out[anim] = pick(lower);
    } else {
      out[anim] = pick(alreadyPrefixed(anim) ? n : `${lower}_${n}`);
    }
  }

  // If the game explicitly asks for names we did not produce, surface them.
  const unmet = (requestedAnimations || []).filter((r) => !Object.values(out).includes(r));
  return { map: out, unmet };
}
