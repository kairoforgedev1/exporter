// Check whether a Spine texture on disk carries the contamination that draws
// boxes and pixelated halos around symbols.
//
// Point this at the folder the GAME loads, not at the exporter's output. The
// two are only the same bytes if nothing re-encoded the texture in between: a
// stale asset left over from an older export, a bundler's image optimizer, or a
// build step that converts PNG to WebP will all reintroduce the defect after a
// perfectly clean export.
//
//   npm run verify:spine -- <folder-or-atlas> [...more]

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSpineAtlas } from '../renderer/js/spine/spineAtlas.js';

const require = createRequire(import.meta.url);
const { decodeTextureBytes } = require('./texture.js');

/**
 * Measure additive contamination on a texture page.
 *
 * A premultiplied page is blended as `dst = src.rgb + dst.rgb * (1 - src.a)`,
 * so RGB stored beneath a transparent pixel is added straight to the screen.
 * `worstLift` is how much light the invisible part of a symbol quad adds.
 */
export function measurePage(rgba) {
  let dirtyAtZero = 0;
  let overAlpha = 0;
  let worstLift = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    const maxRgb = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (a === 0) {
      if (maxRgb > 0) {
        dirtyAtZero++;
        if (maxRgb > worstLift) worstLift = maxRgb;
      }
    } else if (maxRgb > a) {
      overAlpha++;
      if (maxRgb - a > worstLift) worstLift = maxRgb - a;
    }
  }
  return { dirtyAtZero, overAlpha, worstLift };
}

export async function verifyAtlas(atlasPath) {
  const dir = path.dirname(atlasPath);
  const atlas = parseSpineAtlas(readFileSync(atlasPath, 'utf8'));
  const results = [];
  for (const page of atlas.pages) {
    const texturePath = path.join(dir, page.name);
    if (!existsSync(texturePath)) {
      results.push({ page: page.name, reason: 'texture file is missing' });
      continue;
    }
    const decoded = await decodeTextureBytes(readFileSync(texturePath));
    if (!decoded.ok) {
      results.push({ page: page.name, reason: `could not decode: ${decoded.error}` });
      continue;
    }
    const m = measurePage(decoded.rgba);
    results.push({
      page: page.name,
      pma: page.pma,
      size: `${decoded.width}x${decoded.height}`,
      // On a straight-alpha page this colour is multiplied away and harmless.
      ok: !page.pma || (m.dirtyAtZero === 0 && m.overAlpha === 0),
      ...m,
    });
  }
  return { atlas: atlasPath, results };
}

function collectAtlases(target) {
  if (statSync(target).isFile()) return /\.atlas$/i.test(target) ? [target] : [];
  return readdirSync(target)
    .filter((name) => /\.atlas$/i.test(name))
    .map((name) => path.join(target, name));
}

async function main(argv) {
  const targets = argv.slice(2);
  if (!targets.length) {
    console.error('Usage: npm run verify:spine -- <folder-or-.atlas> [...more]');
    console.error('Point it at the folder the game actually loads.');
    return 2;
  }

  let failures = 0;
  let checked = 0;
  for (const target of targets) {
    let atlases;
    try {
      atlases = collectAtlases(path.resolve(target));
    } catch (error) {
      console.error(`Could not read ${target}: ${error.message}`);
      failures++;
      continue;
    }
    if (!atlases.length) console.error(`No .atlas files found in ${target}`);

    for (const atlasPath of atlases) {
      const { results } = await verifyAtlas(atlasPath);
      console.log(`\n${path.relative(process.cwd(), atlasPath)}`);
      for (const r of results) {
        checked++;
        if (r.reason) {
          console.log(`  ${r.page}: ${r.reason}`);
          failures++;
          continue;
        }
        console.log(
          `  ${r.page}  ${r.size}  ${r.pma ? 'pma:true' : 'straight alpha'}  ` +
            `${r.ok ? 'CLEAN' : 'CONTAMINATED'}`
        );
        if (!r.ok) {
          failures++;
          console.log(
            `    ${r.dirtyAtZero} transparent pixel(s) carry colour; ` +
              `${r.overAlpha} pixel(s) exceed their own alpha; worst adds ${r.worstLift}/255 of light.`
          );
          console.log(
            '    This texture will draw a box or halo around every symbol. Either it is not an ' +
              'Exporter output, or something re-encoded it afterwards.'
          );
        } else if (r.pma) {
          console.log('    No colour beneath any transparent pixel.');
        }
      }
    }
  }

  console.log(
    `\n${checked} page(s) checked, ${failures} problem(s).` +
      (failures ? '' : ' Every premultiplied page is clean.')
  );
  return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => process.exit(code));
}
