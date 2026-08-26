// Animation Re-Export: the guided workflow that turns an animator-delivered
// Spine delivery into a Stake Engine Web SDK asset package.
//
// Steps: Source -> Target -> Mapping -> Preview -> Export.

import { parseSpineAtlas } from './spine/spineAtlas.js';
import { summarizeSkeleton, assessCompatibility, spineMajorMinor } from './spine/spineSkeleton.js';
import {
  convertPackages,
  decodeTexture,
  mappingsForAnimationNameMode,
  suggestAnimationMapping,
} from './spine/spineConvert.js';
import { loadWithRuntime, verifyConverted, SpinePreview } from './spine/spinePreview.js';
import { analyzeSpineDrawCalls } from './spine/spineDrawCalls.js';
import {
  basename, dirname, stripExt, joinPath, formatBytes, escapeHtml,
  rgbaToCanvas, bytesToCanvas,
} from './util.js';

const native = window.native;
const $ = (id) => document.getElementById(id);

const STEPS = ['source', 'target', 'mapping', 'preview', 'export'];

/**
 * Texture quality levels, mirroring ANIM_TEXTURE_QUALITY in main.js. PNG has no
 * lossy mode and stays lossless at every level, so what the level actually
 * picks is the WebP encoder. Sizes below are the 3697x907 sample page.
 */
const TEXTURE_QUALITY_LEVELS = [
  { id: 'high', label: 'High', hint: 'Lossless WebP (VP8L) — exact, largest files' },
  { id: 'medium', label: 'Medium', hint: 'WebP quality 95 — roughly a third the size' },
  { id: 'low', label: 'Low', hint: 'WebP quality 80 — smallest files' },
];

/**
 * How the exported texture stores alpha.
 *
 * A premultiplied page adds colour beneath a transparent pixel straight to the
 * screen, so it has to avoid every WebP mode that touches those bytes — which is
 * all the lossy modes and every effort level above 0. Straight alpha has no such
 * constraint: the runtime multiplies by alpha at upload, so anything the codec
 * does under a zero alpha is multiplied away. Measured on a 4096x4096 page,
 * straight-alpha lossless is 9% smaller than premultiplied lossless *and*
 * renders identically; straight-alpha quality 90 is 73% smaller.
 */
const ALPHA_MODES = [
  {
    id: 'straight',
    label: 'Straight (recommended)',
    hint: 'Un-premultiply and let the runtime premultiply on upload. Renders identically and lets the quality level actually reduce file size.',
  },
  {
    id: 'premultiplied',
    label: 'Premultiplied (match source)',
    hint: 'Keep the source storage. Forces lossless WebP at the weakest compression setting, so files are much larger and the quality level cannot apply.',
  },
];

function qualityLevelLabel(id) {
  return TEXTURE_QUALITY_LEVELS.find((level) => level.id === id)?.label || 'High';
}

function uniqueWarnings(...groups) {
  const seen = new Set();
  const out = [];
  for (const warnings of groups) {
    for (const warning of warnings || []) {
      const key = [
        warning?.level || '',
        warning?.package || '',
        warning?.message || String(warning),
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(warning);
    }
  }
  return out;
}

function conversionWarnings(conversion) {
  return uniqueWarnings(conversion?.warnings, conversion?.shared?.warnings);
}

function replaceTextureExtension(name, extension) {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, `.${extension}`) : `${name}.${extension}`;
}

// Device / layout variant hints in skeleton file names.
const VARIANT_PATTERNS = [
  [/(^|[_-])mobile($|[_-])/i, 'mobile'],
  [/(^|[_-])desktop($|[_-])/i, 'desktop'],
  [/(^|[_-])tablet($|[_-])/i, 'tablet'],
  [/(^|[_-])portrait($|[_-])/i, 'portrait'],
  [/(^|[_-])landscape($|[_-])/i, 'landscape'],
  [/(^|[_-])(sm|small)($|[_-])/i, 'small'],
  [/(^|[_-])(lg|large)($|[_-])/i, 'large'],
  [/(^|[_-])(hd|4k)($|[_-])/i, 'hd'],
];

/** Label a skeleton variant from its file name relative to the package name. */
export function detectVariant(skeletonName, packageName) {
  for (const [re, label] of VARIANT_PATTERNS) {
    if (re.test(skeletonName)) return label;
  }
  // Fall back to whatever the name adds on top of the package name.
  if (packageName && skeletonName.toLowerCase().startsWith(packageName.toLowerCase())) {
    const suffix = skeletonName.slice(packageName.length).replace(/^[_-]+/, '');
    if (suffix) return suffix.toLowerCase();
  }
  return null;
}

export class AnimationReExport {
  constructor({ toast }) {
    this.toast = toast;
    this.step = 'source';
    this.reset();
    this.preview = null;
    this._bind();
  }

  reset() {
    this.source = null; // {root, packages:[...], fromArchive}
    this.packages = []; // loaded packages with atlas/skeleton/pages
    this.target = null; // inspection result
    this.targetKind = null; // 'project' | 'reference'
    this.mappings = new Map();
    this.conversion = null;
    this.verification = null;
    this.drawCallReports = [];
    this.exported = null;
    this.atlasName = 'symbols';
    this.outputFolder = 'symbols';
    // Source-name mode is an exact, non-destructive conversion override. The
    // editable target/custom map remains stored so switching back restores it.
    this.animationNameMode = 'target';
    this.packing = {
      padding: 2,
      border: 2,
      maxWidth: 4096,
      maxHeight: 4096,
      powerOfTwo: false,
      square: false,
      registrationScale: 1,
    };
    this.textureFormats = { webp: true, png: true };
    // PNG has no lossy mode, so this governs the WebP encoder: high keeps it
    // truly lossless (VP8L), medium/low trade visible fidelity for file size.
    this.textureQuality = 'high';
    // Straight alpha is both smaller and rendered-identical, and it is the only
    // way the quality level above can actually shrink a premultiplied source.
    this.alphaMode = 'straight';
    this.convertedTextureFormats = null;
    this.convertedTextureExtension = null;
    this.convertedTextureQuality = null;
    this.convertedAnimationNameMode = null;
    this.inexactSourcePages = [];
    // Off by default: this deletes files inside the user's project.
    this.cleanTarget = false;
  }

  get primaryTextureExtension() {
    if (this.textureFormats.png) return 'png';
    if (this.textureFormats.webp) return 'webp';
    return null;
  }

  hasHardConversionBlocker(conversion = this.conversion) {
    if (!conversion) return false;
    const errorWarnings = conversionWarnings(conversion).filter((w) => w.level === 'error');
    const compatibilityBlocking = conversion.skeletons?.some((s) => s.compatibility?.blocking);
    return errorWarnings.length > 0 || (!!conversion.blocking && !compatibilityBlocking);
  }

  // -------------------------------------------------------------------------
  open() {
    $('animRoot').classList.add('visible');
    this.goto(this.source ? this.step : 'source');
  }

  close() {
    this.preview?.stop();
    $('animRoot').classList.remove('visible');
  }

  _bind() {
    $('animClose').addEventListener('click', () => this.close());
    $('animBack').addEventListener('click', () => this.back());
    $('animNext').addEventListener('click', () => this.next());
    $('animRoot').addEventListener('click', (e) => {
      if (e.target === $('animRoot')) this.close();
    });

    $('animPickFolder').addEventListener('click', () => this.pickSource('folder'));
    $('animPickZip').addEventListener('click', () => this.pickSource('zip'));
    $('animPickProject').addEventListener('click', () => this.pickTarget('project'));
    $('animPickReference').addEventListener('click', () => this.pickTarget('reference'));
    $('animPickSample').addEventListener('click', () => this.useSampleReference());

    $('animOpenFolder').addEventListener('click', () => {
      if (this.exported?.firstFile) native.showInFolder(this.exported.firstFile);
    });
    $('animRegisterBtn').addEventListener('click', () => this.registerInProject());
  }

  goto(step) {
    this.step = step;
    for (const s of STEPS) {
      $(`animStep_${s}`).classList.toggle('hidden', s !== step);
      $(`animTab_${s}`).classList.toggle('active', s === step);
      $(`animTab_${s}`).classList.toggle(
        'done',
        STEPS.indexOf(s) < STEPS.indexOf(step)
      );
    }
    $('animBack').disabled = STEPS.indexOf(step) === 0;
    const next = $('animNext');
    next.textContent = step === 'preview' ? 'Export…' : step === 'export' ? 'Done' : 'Next →';
    next.disabled = !this.canAdvance();
    if (step !== 'preview') this.preview?.stop();
  }

  canAdvance() {
    switch (this.step) {
      case 'source':
        return this.packages.length > 0;
      case 'target':
        return !!this.target;
      case 'mapping':
        return (
          [...this.mappings.values()].some((m) => m.include) &&
          !!this.primaryTextureExtension
        );
      case 'preview':
        return (
          !!this.conversion?.ok &&
          !this.hasHardConversionBlocker() &&
          !!this.verification?.every((result) => result.ok)
        );
      default:
        return true;
    }
  }

  back() {
    const i = STEPS.indexOf(this.step);
    if (i > 0) this.goto(STEPS[i - 1]);
  }

  async next() {
    const i = STEPS.indexOf(this.step);
    if (this.step === 'export') return this.close();
    if (this.step === 'target') {
      this.buildMappings();
      this.renderMapping();
    }
    if (this.step === 'mapping') {
      const ok = await this.runConversion();
      if (!ok) return;
      // runConversion builds and verifies the in-memory preview, then moves to
      // Preview & Verify itself. Stop this click here: because `this.step` is
      // now "preview", falling through would call doExport() from the same
      // Mapping-page click before the user has had a chance to inspect it.
      return;
    }
    if (this.step === 'preview') {
      return this.doExport();
    }
    this.goto(STEPS[i + 1]);
  }

  // =========================================================================
  // Step 1: source
  // =========================================================================
  async pickSource(kind) {
    let picked;
    if (kind === 'folder') {
      picked = await native.pickDirectory({ title: 'Select the animator-delivered folder' });
    } else {
      const files = await native.pickFiles({
        title: 'Select the animator-delivered archive',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      });
      picked = files[0];
    }
    if (!picked) return;
    await this.loadSource(picked);
  }

  async loadSource(sourcePath) {
    $('animSourceStatus').textContent = 'Scanning…';
    try {
      const scan = await native.animOpenSource(sourcePath);
      this.source = scan;
      await this.loadPackages(scan);
      this.renderSource();
      this.goto('source');
      $('animNext').disabled = !this.canAdvance();
    } catch (err) {
      console.error(err);
      $('animSourceStatus').textContent = '';
      this.toast(`Could not read the animation source: ${err.message}`, 'error', 7000);
    }
  }

  /** Read each detected package: atlas, every skeleton variant, every page. */
  async loadPackages(scan) {
    const loaded = [];
    this.inexactSourcePages = [];
    const skeletonIds = new Set();
    const uniqueSkeletonId = (preferred) => {
      if (!skeletonIds.has(preferred)) {
        skeletonIds.add(preferred);
        return preferred;
      }
      let suffix = 2;
      while (skeletonIds.has(`${preferred}::${suffix}`)) suffix++;
      const id = `${preferred}::${suffix}`;
      skeletonIds.add(id);
      return id;
    };
    for (const info of scan.packages) {
      const pkg = {
        name: info.name,
        dir: info.dir,
        atlasPath: info.atlasPath,
        textures: info.textures || [],
        problems: [],
        pages: new Map(),
        skeletons: [],
      };

      if (info.error) {
        pkg.problems.push({ level: 'error', message: info.error });
        loaded.push(pkg);
        continue;
      }

      try {
        pkg.atlas = parseSpineAtlas(info.atlasText);
      } catch (e) {
        pkg.problems.push({ level: 'error', message: `Atlas parse failed: ${e.message}` });
      }

      // --- skeleton variants sharing this atlas ---------------------------
      const paths = info.skeletonPaths || [];
      if (!paths.length) {
        pkg.problems.push({
          level: 'error',
          message: 'No Spine skeleton JSON found for this atlas — ask the animator for the .json export.',
        });
      }
      for (const p of paths) {
        const name = stripExt(basename(p));
        try {
          const bytes = await native.readFile(p);
          const json = JSON.parse(new TextDecoder().decode(bytes));
          if (!json.bones && !json.skeleton) {
            pkg.problems.push({ level: 'error', message: `${basename(p)} is not a Spine skeleton.` });
            continue;
          }
          pkg.skeletons.push({
            id: uniqueSkeletonId(`${pkg.name}::${name}`),
            name,
            path: p,
            json,
            summary: summarizeSkeleton(json),
            variantLabel: detectVariant(name, pkg.name),
          });
        } catch (e) {
          pkg.problems.push({ level: 'error', message: `${basename(p)} unreadable: ${e.message}` });
        }
      }

      // --- every declared texture page ------------------------------------
      for (const texture of pkg.textures) {
        if (texture.unsafe) {
          pkg.problems.push({
            level: 'error',
            message:
              `Texture page "${texture.name}" points outside the package folder and was refused.`,
          });
          continue;
        }
        if (!texture.exists) {
          pkg.problems.push({
            level: 'error',
            message: `Texture page "${texture.name}" referenced by the atlas was not supplied.`,
          });
          continue;
        }
        try {
          const bytes = await native.readFile(texture.path);
          const page = await decodeTexture(bytes);
          pkg.pages.set(texture.name, page);
          texture.width = page.width;
          texture.height = page.height;
          texture.bytes = bytes.length ?? bytes.byteLength;
          texture.exactDecode = page.exact !== false;
          if (!texture.exactDecode) this.inexactSourcePages.push(texture.name);
        } catch (e) {
          pkg.problems.push({ level: 'error', message: `Texture "${texture.name}" could not be decoded: ${e.message}` });
        }
      }
      if (pkg.atlas) {
        for (const page of pkg.atlas.pages) {
          if (!pkg.textures.some((t) => t.name === page.name)) {
            pkg.problems.push({
              level: 'error',
              message: `Atlas declares page "${page.name}" but no such file was supplied.`,
            });
          }
        }
      }

      // --- region ownership across the variants ---------------------------
      if (pkg.atlas && pkg.skeletons.length) {
        const available = new Set(pkg.atlas.pages.flatMap((p) => p.regions.map((r) => r.name)));
        const pageOf = new Map();
        for (const page of pkg.atlas.pages) {
          for (const r of page.regions) pageOf.set(r.name, page.name);
        }
        const usage = new Map(); // region -> [skeleton names]
        for (const sk of pkg.skeletons) {
          for (const r of sk.summary.regions) {
            if (!usage.has(r)) usage.set(r, []);
            usage.get(r).push(sk.name);
          }
          const missing = sk.summary.regions.filter((r) => !available.has(r));
          for (const name of missing) {
            pkg.problems.push({
              level: 'error',
              message: `${sk.name}: attachment "${name}" has no matching region in ${basename(info.atlasPath)}.`,
            });
          }
          // Which source pages this variant needs — proves multi-page usage.
          sk.sourcePages = [
            ...new Set(sk.summary.regions.map((r) => pageOf.get(r)).filter(Boolean)),
          ];
        }
        pkg.regionUsage = usage;
        pkg.sharedRegionCount = [...usage.values()].filter((v) => v.length > 1).length;
        pkg.specificRegionCount = [...usage.values()].filter((v) => v.length === 1).length;
      }

      pkg.complete = pkg.problems.filter((p) => p.level === 'error').length === 0;
      loaded.push(pkg);
    }

    // Skeletons no atlas claimed: incomplete delivery, surfaced not skipped.
    for (const orphan of scan.looseJson || []) {
      try {
        const bytes = await native.readFile(orphan);
        const json = JSON.parse(new TextDecoder().decode(bytes));
        // Guard against Photoshop→Spine import descriptors sneaking through as
        // orphan skeletons — the native scan already filters them, this mirrors
        // that so a runtime skeleton is the only thing that becomes a package.
        if (json.PhotoshopToSpine) continue;
        if (json.skeleton && !json.skeleton.spine) continue;
        if (json.bones || json.skeleton) {
          const name = stripExt(basename(orphan));
          loaded.push({
            name,
            dir: dirname(orphan),
            textures: [],
            pages: new Map(),
            skeletons: [
              {
                id: uniqueSkeletonId(`${name}::${name}`),
                name,
                path: orphan,
                json,
                summary: summarizeSkeleton(json),
              },
            ],
            complete: false,
            problems: [
              { level: 'error', message: 'No .atlas file found for this skeleton — the delivery is incomplete.' },
            ],
          });
        }
      } catch {
        /* not a skeleton */
      }
    }

    this.packages = loaded;
  }

  renderSource() {
    const scan = this.source;
    $('animSourceStatus').innerHTML =
      `<span class="mono">${escapeHtml(scan.originalPath)}</span>` +
      (scan.fromArchive ? ' <span class="pill">extracted to temp workspace</span>' : '') +
      ` <span class="pill">originals not modified</span>`;

    // One card per package, listing the skeleton variants that share its atlas.
    const cards = this.packages.map((pkg) => {
      const errors = pkg.problems.filter((p) => p.level === 'error');
      const status = pkg.complete
        ? '<span class="badge badge-added">complete</span>'
        : '<span class="badge badge-error">incomplete</span>';
      const pageCount = pkg.atlas?.pages.length || 0;
      const regions = pkg.atlas ? pkg.atlas.pages.reduce((n, p) => n + p.regions.length, 0) : 0;

      const relationship =
        pkg.skeletons.length > 1
          ? `<span class="pill accent">${pkg.skeletons.length} skeletons share this atlas</span>`
          : '<span class="pill">single skeleton</span>';
      const pagePill =
        pageCount > 1
          ? `<span class="pill accent">${pageCount} texture pages</span>`
          : `<span class="pill">${pageCount || 'no'} texture page</span>`;
      const sharePill =
        pkg.sharedRegionCount != null && pkg.skeletons.length > 1
          ? `<span class="pill">${pkg.sharedRegionCount} shared · ${pkg.specificRegionCount} variant-specific regions</span>`
          : '';

      const textures = pkg.textures.length
        ? pkg.textures
            .map(
              (t) =>
                `<li class="mono small">${escapeHtml(t.name)}` +
                (t.width ? ` <span class="dim">${t.width}×${t.height}</span>` : '') +
                (t.exists ? '' : ' <span class="err">missing</span>') +
                `</li>`
            )
            .join('')
        : '<li class="err small">no texture pages</li>';

      const variantRows = pkg.skeletons.length
        ? pkg.skeletons
            .map((sk) => {
              const s = sk.summary;
              const anims = s.animations;
              const shown = anims.slice(0, 6).map(escapeHtml).join(', ');
              const more = anims.length > 6 ? ` <span class="dim">+${anims.length - 6} more</span>` : '';
              const pagesUsed =
                sk.sourcePages && pageCount > 1
                  ? `<div class="dim small">uses ${sk.sourcePages.length} of ${pageCount} pages: ${sk.sourcePages
                      .map(escapeHtml)
                      .join(', ')}</div>`
                  : '';
              return (
                `<tr>` +
                `<td><b>${escapeHtml(sk.name)}</b>` +
                (sk.variantLabel ? ` <span class="badge badge-variant">${escapeHtml(sk.variantLabel)}</span>` : '') +
                pagesUsed +
                `</td>` +
                `<td class="mono">${escapeHtml(s.spine || '—')}</td>` +
                `<td class="mono">${s.bones}b / ${s.slots}s</td>` +
                `<td class="mono">${s.regions.length}</td>` +
                `<td>${anims.length}: <span class="dim">${shown}${more}</span></td>` +
                `</tr>`
              );
            })
            .join('')
        : `<tr><td colspan="5" class="err">no skeleton found for this atlas</td></tr>`;

      return (
        `<div class="pkg-card ${pkg.complete ? '' : 'bad'}">` +
        `<div class="pkg-head"><b>${escapeHtml(pkg.name)}</b> ${status} ${relationship} ${pagePill} ${sharePill}</div>` +
        `<div class="dim mono small">${escapeHtml(pkg.dir)}</div>` +
        `<div class="pkg-cols">` +
        `<div><div class="sub">Atlas</div><div class="mono small">${
          pkg.atlasPath ? escapeHtml(basename(pkg.atlasPath)) : '<span class="err">missing</span>'
        }</div><div class="dim small">${regions} regions across ${pageCount} page(s)</div>` +
        `<div class="sub">Texture pages</div><ul class="tight">${textures}</ul></div>` +
        `<div><div class="sub">Skeletons</div><table class="anim-table"><thead><tr>` +
        `<th>Name</th><th>Spine</th><th>Rig</th><th>Regions</th><th>Animations</th>` +
        `</tr></thead><tbody>${variantRows}</tbody></table></div>` +
        `</div>` +
        (errors.length
          ? `<div class="pkg-errors">${errors
              .map((p) => `<div class="err small">⚠ ${escapeHtml(p.message)}</div>`)
              .join('')}</div>`
          : '') +
        `</div>`
      );
    });

    $('animPackageTable').innerHTML = cards.join('');

    const complete = this.packages.filter((p) => p.complete).length;
    const skeletonCount = this.packages.reduce((n, p) => n + p.skeletons.length, 0);
    const multiSkeleton = this.packages.filter((p) => p.skeletons.length > 1).length;
    const multiPage = this.packages.filter((p) => (p.atlas?.pages.length || 0) > 1).length;
    const bits = [
      `${this.packages.length} package${this.packages.length === 1 ? '' : 's'}`,
      `${skeletonCount} skeleton${skeletonCount === 1 ? '' : 's'}`,
      `${complete} complete`,
    ];
    if (multiSkeleton) bits.push(`${multiSkeleton} with multiple skeletons sharing one atlas`);
    if (multiPage) bits.push(`${multiPage} multi-page`);
    if (complete < this.packages.length) bits.push(`${this.packages.length - complete} need attention`);

    // Photoshop→Spine import descriptors are ignored, not skeletons — name them
    // so a "missing" skeleton is never a mystery.
    const sourceJson = scan.spineSourceJson || [];
    if (sourceJson.length) {
      bits.push(
        `${sourceJson.length} Spine source file${sourceJson.length === 1 ? '' : 's'} ignored`
      );
    }
    $('animSourceCount').innerHTML =
      escapeHtml(bits.join(' · ')) +
      (sourceJson.length
        ? ` <span class="dim small" title="${sourceJson
            .map((p) => escapeHtml(basename(p)))
            .join(', ')}">(Photoshop→Spine import descriptors, not runtime exports)</span>`
        : '');
  }

  // =========================================================================
  // Step 2: target
  // =========================================================================
  async pickTarget(kind) {
    const dir = await native.pickDirectory({
      title:
        kind === 'project'
          ? 'Select the Stake Engine project (or the app folder)'
          : 'Select a reference asset folder to copy conventions from',
    });
    if (!dir) return;

    if (kind === 'project') {
      const apps = await native.animFindApps(dir);
      if (!apps.length) {
        this.toast('No web-sdk app with src/game/assets.ts found under that folder.', 'error', 7000);
        return;
      }
      let appDir = apps[0].dir;
      if (apps.length > 1) {
        const choice = await this.chooseApp(apps);
        if (!choice) return;
        appDir = choice;
      }
      const info = await native.animInspectApp(appDir);
      if (!info.ok) {
        this.toast(info.error, 'error', 7000);
        return;
      }
      this.target = info;
      this.targetKind = 'project';
    } else {
      const info = await native.animInspectFolder(dir);
      if (!info) {
        this.toast('That folder could not be inspected.', 'error');
        return;
      }
      this.target = { ok: true, reference: info, appName: null, dominantScale: 1, animationUsage: {} };
      this.targetKind = 'reference';
    }
    this.renderTarget();
    $('animNext').disabled = !this.canAdvance();
  }

  async useSampleReference() {
    const dir = joinPath(joinPath(await this.appRoot(), 'sample_animation'), 'sample_output');
    const info = await native.animInspectFolder(dir);
    if (!info) {
      this.toast('The bundled sample_output reference was not found.', 'error');
      return;
    }
    this.target = { ok: true, reference: info, appName: null, dominantScale: 1, animationUsage: {} };
    this.targetKind = 'reference';
    this.renderTarget();
    $('animNext').disabled = !this.canAdvance();
  }

  async appRoot() {
    if (this._appRoot) return this._appRoot;
    this._appRoot = dirname(dirname(decodeURIComponent(new URL('.', import.meta.url).pathname.replace(/^\//, ''))));
    return this._appRoot;
  }

  chooseApp(apps) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'choice-overlay';
      overlay.innerHTML =
        `<div class="modal"><div class="modal-title">Select the game app</div>` +
        `<div class="choice-message">This project contains several web-sdk apps. Which one is the target?</div>` +
        `<div class="app-list">${apps
          .map((a) => `<button class="btn wide app-pick" data-dir="${escapeHtml(a.dir)}">${escapeHtml(a.name)}</button>`)
          .join('')}</div>` +
        `<div class="modal-actions"><button class="btn" data-cancel>Cancel</button></div></div>`;
      overlay.addEventListener('click', (e) => {
        const pick = e.target.closest('.app-pick');
        if (pick) {
          overlay.remove();
          resolve(pick.dataset.dir);
        } else if (e.target.hasAttribute('data-cancel') || e.target === overlay) {
          overlay.remove();
          resolve(null);
        }
      });
      document.body.appendChild(overlay);
    });
  }

  get runtimeVersion() {
    return this.target?.runtime?.version || null;
  }

  renderTarget() {
    const t = this.target;
    const ref = t.reference || this.pickReferenceFolder();
    const runtime = t.runtime;
    const rows = [];

    if (this.targetKind === 'project') {
      rows.push(['Project app', `${t.appName} <span class="dim mono">${escapeHtml(t.appDir)}</span>`]);
      rows.push(['Registration', `<span class="mono">src/game/assets.ts</span> — <span class="dim">an entry per asset, appended automatically</span>`]);
      rows.push(['Asset folder', `<span class="mono">static/assets/spines/&lt;folder&gt;/</span>`]);
      rows.push([
        'Spine runtime',
        runtime
          ? `<span class="mono">${escapeHtml(runtime.package)} ${escapeHtml(runtime.version)}</span>`
          : '<span class="err">not detected</span>',
      ]);
      rows.push([
        'Shipped asset versions',
        t.shippedVersions?.length ? `<span class="mono">${t.shippedVersions.map(escapeHtml).join(', ')}</span>` : '—',
      ]);
      rows.push(['Registration scale', `<span class="mono">${t.dominantScale}</span> <span class="dim">(used by every spine entry in this app)</span>`]);
    }

    if (ref) {
      rows.push(['Reference folder', `<span class="mono">${escapeHtml(ref.dir)}</span>`]);
      rows.push([
        'Atlas usage',
        ref.sharedAtlas
          ? `one shared atlas <span class="mono">${escapeHtml(ref.atlasFiles[0] || '')}</span> for ${ref.skeletons.length} skeletons`
          : `${ref.atlasFiles.length} atlas file(s)`,
      ]);
      rows.push(['Texture formats', ref.textureFormats.length ? ref.textureFormats.join(', ') : '—']);
      rows.push([
        'index.ts',
        ref.hasIndexTs ? 'present <span class="dim">(asset-module style)</span>' : 'not present',
      ]);
      if (ref.atlasFiles.length === 0) {
        rows.push([
          'Reference completeness',
          `<span class="err">This reference folder has no .atlas file.</span> ` +
            `<span class="dim">Its index.ts imports one, so the reference is incomplete — the converter generates the missing atlas.</span>`,
        ]);
      }
      const refAnims = [...new Set(ref.skeletons.flatMap((s) => s.animations))];
      if (refAnims.length) {
        rows.push([
          'Animation naming',
          `<span class="mono">${refAnims.slice(0, 8).map(escapeHtml).join(', ')}${refAnims.length > 8 ? '…' : ''}</span>`,
        ]);
      }
    }

    // Compatibility of every skeleton in every package against this runtime.
    const compatRows = [];
    for (const pkg of this.packages) {
      for (const sk of pkg.skeletons) {
        if (!sk.summary) continue;
        const c = assessCompatibility({
          sourceVersion: sk.summary.spine,
          runtimeVersion: this.runtimeVersion,
          features: sk.summary.features,
        });
        sk.compatibility = c;
        pkg.compatibility = pkg.compatibility?.blocking ? pkg.compatibility : c;
        compatRows.push(
          `<tr><td><b>${escapeHtml(sk.name)}</b>` +
            (pkg.skeletons.length > 1 ? ` <span class="dim">in ${escapeHtml(pkg.name)}</span>` : '') +
            (sk.variantLabel ? ` <span class="badge badge-variant">${escapeHtml(sk.variantLabel)}</span>` : '') +
            `</td>` +
            `<td class="mono">${escapeHtml(sk.summary.spine || '—')}</td>` +
            `<td><span class="badge badge-${c.status}">${escapeHtml(c.title)}</span></td>` +
            `<td class="dim">${escapeHtml(c.detail)}${
              sk.summary.features.length
                ? ` <span class="mono small">[${sk.summary.features.slice(0, 4).map(escapeHtml).join(', ')}]</span>`
                : ''
            }</td></tr>`
        );
      }
    }

    $('animTargetInfo').innerHTML =
      `<div class="info-grid wide">` +
      rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('') +
      `</div>`;

    $('animCompat').innerHTML = this.runtimeVersion
      ? `<table class="anim-table"><thead><tr><th>Package</th><th>Spine</th><th>Compatibility</th><th>Detail</th></tr></thead>` +
        `<tbody>${compatRows.join('')}</tbody></table>`
      : `<div class="note">Select a project to check Spine compatibility against its actual runtime.</div>`;

    // Sensible defaults from the reference.
    if (ref?.atlasFiles?.length) this.atlasName = stripExt(ref.atlasFiles[0]);
    else if (ref?.name) this.atlasName = ref.name;
    this.outputFolder = ref?.name || this.atlasName;
    if (this.targetKind === 'project') this.packing.registrationScale = this.target.dominantScale ?? 1;
  }

  pickReferenceFolder() {
    // Prefer a project folder that already uses one shared atlas for many spines.
    const folders = this.target?.spineFolders || [];
    return folders.find((f) => f.sharedAtlas) || folders[0] || null;
  }

  // =========================================================================
  // Step 3: mapping
  // =========================================================================
  buildMappings() {
    const ref = this.target?.reference || this.pickReferenceFolder();
    const refAnimations = ref ? [...new Set(ref.skeletons.flatMap((s) => s.animations))] : [];
    const usage = this.target?.animationUsage || {};

    for (const pkg of this.packages) {
      for (const sk of pkg.skeletons) {
        const existing = this.mappings.get(sk.id);
        const sourceAnimations = [...(sk.summary?.animations || [])];
        const assetKey = existing?.assetKey || sk.name.toUpperCase().replace(/[^A-Z0-9_$]/g, '_');
        // A package whose skeletons are device variants of one feature keeps
        // its animation names; only single-skeleton packages get the symbol
        // convention applied, where the bare symbol name is the contract.
        const isVariant = pkg.skeletons.length > 1;
        const suggestion = isVariant
          ? {
              map: Object.fromEntries(sourceAnimations.map((a) => [a, a])),
              unmet: [],
            }
          : suggestAnimationMapping({
              sourceAnimations,
              assetKey,
              referenceAnimations: refAnimations,
              requestedAnimations: usage[assetKey] || [],
            });
        if (existing) {
          // Re-scanning/reopening a package can add or remove animations. Keep
          // manual target names for animations that still exist, but make the
          // authoritative source-name list match the current Spine JSON.
          existing.package = pkg.name;
          existing.skeleton = sk.name;
          existing.sourceAnimations = sourceAnimations;
          existing.animations = Object.fromEntries(
            sourceAnimations.map((name) => [
              name,
              existing.animations?.[name] ?? suggestion.map[name] ?? name,
            ])
          );
          existing.unmet = suggestion.unmet;
          continue;
        }
        this.mappings.set(sk.id, {
          include: !!pkg.complete,
          package: pkg.name,
          skeleton: sk.name,
          assetKey,
          jsonName: `${sk.name.toLowerCase()}.json`,
          sourceAnimations,
          animations: suggestion.map,
          unmet: suggestion.unmet,
        });
      }
    }
  }

  renderMapping() {
    const usage = this.target?.animationUsage || {};
    const rows = [];

    for (const pkg of this.packages) {
      if (pkg.skeletons.length > 1) {
        rows.push(
          `<tr class="group-row"><td colspan="4">` +
            `<b>${escapeHtml(pkg.name)}</b> <span class="dim">— ${pkg.skeletons.length} skeletons sharing one atlas` +
            `${(pkg.atlas?.pages.length || 0) > 1 ? ` (${pkg.atlas.pages.length} source pages)` : ''}` +
            `; each stays a separate skeleton file registered against the same atlas.</span>` +
            `</td></tr>`
        );
      }
      for (const sk of pkg.skeletons) {
        const m = this.mappings.get(sk.id);
        if (!m) continue;
        const anims = m.sourceAnimations || sk.summary?.animations || [];
        const keepSourceNames = this.animationNameMode === 'source';
        // Long animation lists (the meter has 20) collapse behind a toggle.
        const many = anims.length > 6;
        // Say what the mapping actually does. This used to claim "kept as-is"
        // unconditionally, which hid the fact that names were being renamed.
        const renamed = keepSourceNames
          ? 0
          : anims.filter((a) => (m.animations[a] ?? a) !== a).length;
        const summaryNote = renamed
          ? `${renamed} of ${anims.length} renamed`
          : 'names kept as-is';
        const animRows = anims
          .map(
            (a) =>
              `<div class="anim-map-row">` +
              `<span class="mono src">${escapeHtml(a)}</span><span class="arrow">→</span>` +
              `<input class="anim-input anim-anim" data-id="${escapeHtml(sk.id)}" data-anim="${escapeHtml(a)}" ` +
              `value="${escapeHtml(keepSourceNames ? a : (m.animations[a] ?? ''))}" ` +
              `${keepSourceNames ? 'readonly aria-readonly="true" title="The imported Spine animation name will be kept exactly."' : ''} />` +
              `</div>`
          )
          .join('');
        const requested = usage[m.assetKey] || [];
        const requestedNote = requested.length
          ? `<div class="dim small">Game requests: <span class="mono">${requested.map(escapeHtml).join(', ')}</span></div>`
          : '';
        rows.push(
          `<tr class="${pkg.complete ? '' : 'row-error'}">` +
            `<td><label class="chk"><input type="checkbox" class="anim-include" data-id="${escapeHtml(sk.id)}" ${m.include ? 'checked' : ''} ${pkg.complete ? '' : 'disabled'} /> <b>${escapeHtml(sk.name)}</b></label>` +
            (sk.variantLabel ? ` <span class="badge badge-variant">${escapeHtml(sk.variantLabel)}</span>` : '') +
            (pkg.complete ? '' : '<div class="err small">incomplete — cannot convert</div>') +
            `</td>` +
            `<td><input class="anim-input anim-key" data-id="${escapeHtml(sk.id)}" value="${escapeHtml(m.assetKey)}" />${requestedNote}</td>` +
            `<td><input class="anim-input anim-json" data-id="${escapeHtml(sk.id)}" value="${escapeHtml(m.jsonName)}" /></td>` +
            `<td>${
              many
                ? `<details><summary class="dim small">${anims.length} animations — ${summaryNote}</summary>${animRows}</details>`
                : animRows
            }</td>` +
            `</tr>`
        );
      }
    }

    $('animMappingTable').innerHTML =
      `<table class="anim-table"><thead><tr><th>Skeleton</th><th>Asset key</th>` +
      `<th>Output JSON</th><th>Animation names</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;

    $('animAtlasName').value = this.atlasName;
    $('animFolderName').value = this.outputFolder;
    $('animScale').value = this.packing.registrationScale;
    $('animMaxW').value = this.packing.maxWidth;
    $('animMaxH').value = this.packing.maxHeight;
    $('animPadding').value = this.packing.padding;
    $('animWebp').checked = this.textureFormats.webp;
    $('animPng').checked = this.textureFormats.png;
    $('animNameMode').value = this.animationNameMode;

    const quality = $('animQuality');
    quality.innerHTML = TEXTURE_QUALITY_LEVELS.map(
      (level) =>
        `<option value="${level.id}" title="${escapeHtml(level.hint)}">${escapeHtml(level.label)}</option>`
    ).join('');
    quality.value = this.textureQuality;

    const alpha = $('animAlphaMode');
    alpha.innerHTML = ALPHA_MODES.map(
      (mode) =>
        `<option value="${mode.id}" title="${escapeHtml(mode.hint)}">${escapeHtml(mode.label)}</option>`
    ).join('');
    alpha.value = this.alphaMode;
    this.renderAnimationNameModeHint();
    this.renderQualityHint();

    const root = $('animStep_mapping');
    root.oninput = (e) => {
      const el = e.target;
      const id = el.dataset.id;
      if (el.classList.contains('anim-key')) this.mappings.get(id).assetKey = el.value.trim();
      else if (el.classList.contains('anim-json')) this.mappings.get(id).jsonName = el.value.trim();
      else if (el.classList.contains('anim-anim'))
        this.mappings.get(id).animations[el.dataset.anim] = el.value.trim();
      else if (el.id === 'animAtlasName') this.atlasName = el.value.trim() || 'symbols';
      else if (el.id === 'animFolderName') this.outputFolder = el.value.trim() || this.atlasName;
      else if (el.id === 'animScale') this.packing.registrationScale = Number(el.value) || 1;
      else if (el.id === 'animMaxW') this.packing.maxWidth = Number(el.value) || 4096;
      else if (el.id === 'animMaxH') this.packing.maxHeight = Number(el.value) || 4096;
      else if (el.id === 'animPadding') this.packing.padding = Number(el.value) || 0;
    };
    root.onchange = (e) => {
      const el = e.target;
      if (el.classList.contains('anim-include')) {
        this.mappings.get(el.dataset.id).include = el.checked;
      } else if (el.id === 'animWebp') this.textureFormats.webp = el.checked;
      else if (el.id === 'animPng') this.textureFormats.png = el.checked;
      else if (el.id === 'animNameMode') {
        this.animationNameMode = el.value === 'source' ? 'source' : 'target';
        this.renderMapping();
        return;
      } else if (el.id === 'animQuality') this.textureQuality = el.value;
      else if (el.id === 'animAlphaMode') this.alphaMode = el.value;
      if (['animWebp', 'animPng', 'animQuality', 'animAlphaMode'].includes(el.id)) {
        this.renderQualityHint();
      }
      $('animNext').disabled = !this.canAdvance();
    };
  }

  renderAnimationNameModeHint() {
    const el = $('animNameModeHint');
    if (!el) return;
    el.textContent = this.animationNameMode === 'source'
      ? 'Every animation key is exported with its exact imported spelling and capitalization. The selected game may request different target names; verify those calls before registering the asset.'
      : 'Names are suggested from the selected project or reference. Edit any target name in the table before previewing.';
  }

  /**
   * Say plainly what the level does. PNG has no lossy mode, so when PNG is the
   * primary texture the level changes nothing the game loads — better to state
   * that than to let someone pick Low and wonder why nothing got smaller.
   */
  renderQualityHint() {
    const el = $('animQualityHint');
    if (!el) return;
    const level = TEXTURE_QUALITY_LEVELS.find((l) => l.id === this.textureQuality);
    const parts = [level?.hint];
    // Known before conversion runs: every source page shares one PMA setting,
    // and mixed settings are refused earlier.
    const sourcePma = this.packages?.some((p) => p.atlas?.pages?.some((page) => page.pma));
    const keepingPma = sourcePma && this.alphaMode !== 'straight';
    if (!this.textureFormats.webp) {
      parts.push('No WebP selected, so this has no effect: PNG is always lossless.');
    } else if (keepingPma && this.textureQuality !== 'high') {
      parts.push(
        'Premultiplied output forces WebP to lossless, so this level cannot apply — a lossy WebP ' +
          'rewrites the colour under transparent pixels, which a premultiplied page draws as a box ' +
          'around every symbol. Switch alpha to Straight to use it.'
      );
    } else if (keepingPma) {
      parts.push(
        'Premultiplied output also pins WebP to its weakest compression setting. Straight alpha ' +
          'renders identically and is smaller.'
      );
    } else if (this.primaryTextureExtension === 'png' && this.textureQuality !== 'high') {
      parts.push('PNG stays the lossless primary — uncheck .png to ship the smaller WebP.');
    }
    el.textContent = parts.filter(Boolean).join(' ');
  }

  // =========================================================================
  // Step 4: preview + verification
  // =========================================================================
  async runConversion() {
    const textureFormats = { ...this.textureFormats };
    const textureExtension = textureFormats.png ? 'png' : textureFormats.webp ? 'webp' : null;
    if (!textureExtension) {
      this.toast('Select at least one texture format (.webp or .png).', 'warn');
      return false;
    }

    const usable = this.packages.filter(
      (p) => p.complete && p.skeletons.some((sk) => this.mappings.get(sk.id)?.include)
    );
    if (!usable.length) {
      this.toast('Select at least one complete skeleton to convert.', 'warn');
      return false;
    }

    const conversion = convertPackages({
      packages: usable,
      mappings: mappingsForAnimationNameMode(this.mappings, this.animationNameMode),
      atlasName: this.atlasName,
      outputFolder: this.outputFolder,
      runtimeVersion: this.runtimeVersion,
      packing: { ...this.packing, textureExtension, alphaMode: this.alphaMode },
    });

    if (!conversion.ok) {
      this.toast(conversion.error, 'error', 9000);
      this.conversion = null;
      this.convertedAnimationNameMode = null;
      return false;
    }
    this.conversion = conversion;
    this.convertedTextureFormats = textureFormats;
    this.convertedTextureExtension = textureExtension;
    this.convertedTextureQuality = this.textureQuality;
    this.convertedAnimationNameMode = this.animationNameMode;
    this.convertedAlphaMode = this.alphaMode;

    // Encode every output page from the exact packed pixels. The canvases below
    // exist only to draw the preview — they are never the source of the bytes
    // we write, because a canvas round trip re-quantizes RGB by alpha/255.
    this.pageCanvases = conversion.shared.pixelPages.map((p) => rgbaToCanvas(p.rgba, p.width, p.height));
    this.sharedCanvas = this.pageCanvases[0];
    this.webpPages = [];
    this.pngPages = [];
    try {
      const encoded = await Promise.all(
        conversion.shared.pixelPages.map((page) =>
          native.animEncodeTexture({
            width: page.width,
            height: page.height,
            rgba: page.rgba,
            formats: textureFormats,
            quality: this.textureQuality,
            // Decides whether RGB beneath a transparent pixel is invisible or
            // is added straight to the screen — which changes both the encoder
            // settings that are safe and what counts as lossless.
            pma: conversion.shared.pma,
          })
        )
      );
      const failed = encoded.find((res) => !res?.ok);
      if (failed) throw new Error(failed?.error || 'the texture encoder returned no data');
      if (textureFormats.webp) this.webpPages = encoded.map((res) => res.webp);
      if (textureFormats.png) this.pngPages = encoded.map((res) => res.png);
    } catch (error) {
      this.toast(
        `Could not encode the texture pages: ${error.message || error}`,
        'error',
        9000
      );
      this.conversion = null;
      this.convertedTextureFormats = null;
      this.convertedTextureExtension = null;
      this.convertedTextureQuality = null;
      this.convertedAnimationNameMode = null;
      return false;
    }
    this.primaryTexturePages =
      textureExtension === 'png' ? this.pngPages : this.webpPages;
    this.webp = this.webpPages[0] || null;
    this.png = this.pngPages[0] || null;
    this.primaryTexture = this.primaryTexturePages[0] || null;
    this.previewImages = new Map();
    for (let i = 0; i < this.primaryTexturePages.length; i++) {
      this.previewImages.set(
        conversion.shared.pages[i].name,
        await bytesToCanvas(this.primaryTexturePages[i].bytes)
      );
    }
    this.previewImage = this.previewImages.get(conversion.shared.pages[0].name);

    this.verification = [];
    this.drawCallReports = [];
    for (const s of conversion.skeletons) {
      const result = verifyConverted({
        atlasText: conversion.shared.atlasText,
        skeletonJson: s.skeleton,
        images: this.previewImages,
        scale: 1,
      });
      this.verification.push({
        assetKey: s.assetKey,
        jsonName: s.jsonName,
        variantName: s.variantName,
        variantLabel: s.variantLabel,
        ...result,
      });

      // The normal preview deliberately stays light-weight Canvas2D. Draw-call
      // analysis instead walks the same parsed Spine 4.2 runtime state and
      // applies Pixi 8's batching rules, which map to both WebGL draw calls and
      // WebGPU drawIndexed calls in the Stake SDK.
      const runtimeLoad = loadWithRuntime({
        atlasText: conversion.shared.atlasText,
        skeletonJson: s.skeleton,
        images: this.previewImages,
        scale: 1,
      });
      this.drawCallReports.push({
        assetKey: s.assetKey,
        jsonName: s.jsonName,
        variantLabel: s.variantLabel,
        report: runtimeLoad.ok
          ? analyzeSpineDrawCalls({
              skeletonData: runtimeLoad.skeletonData,
              sampleRate: 60,
              maxTextures: 16,
              includeKeyframes: true,
            })
          : {
              ok: false,
              animations: [],
              summary: null,
              warnings: [runtimeLoad.error],
              error: runtimeLoad.error,
            },
      });
    }

    this.renderPreview();
    this.goto('preview');
    $('animNext').disabled = !this.canAdvance();
    return true;
  }

  /**
   * Describe a measured encode result. Every badge here comes from decoding the
   * bytes we are about to write and comparing them to the packed pixels — never
   * from assuming a format is lossless.
   */
  textureQualityBadge(entry, primary) {
    const suffix = primary ? ' · primary' : '';
    const q = entry?.quality;
    if (!q || q.verified === false) {
      return `<span class="badge badge-variant">unverified${suffix}</span>`;
    }
    if (q.lossless) return `<span class="badge badge-added">lossless${suffix}</span>`;
    if (q.renderedLossless) {
      return (
        `<span class="badge badge-added">lossless${suffix}</span>` +
        `<div class="dim small">exact on every rendered pixel; only RGB beneath a zero alpha was canonicalized</div>`
      );
    }
    const level = qualityLevelLabel(this.convertedTextureQuality);
    return (
      `<span class="badge ${q.maxOpaque <= 2 ? 'badge-added' : 'badge-replaced'}">` +
      `${escapeHtml(level)} · lossy${suffix}</span>` +
      `<div class="dim small">max deviation ${q.maxOpaque} on visible pixels ` +
      `(${q.max} incl. near-transparent)</div>`
    );
  }

  /** Note when a premultiplied page overrode the requested WebP level. */
  webpLevelNote() {
    if (!this.webp?.forcedLossless) return '';
    return (
      `<div class="k">WebP level</div><div class="v"><span class="badge badge-variant">forced lossless</span>` +
      `<div class="dim small">This atlas is premultiplied, where colour beneath a transparent pixel is added ` +
      `to the screen. Lossy WebP rewrites that colour and would draw a box around every symbol, so ` +
      `${escapeHtml(qualityLevelLabel(this.convertedTextureQuality))} could not be applied to the WebP. ` +
      `PNG is unaffected — it is lossless at every level.</div></div>`
    );
  }

  renderPreview() {
    const c = this.conversion;
    const shared = c.shared;

    // Shared atlas image(s) — one thumbnail per generated page.
    const holder = $('animAtlasPreview');
    holder.textContent = '';
    const maxSide = shared.pages.length > 1 ? 260 : 420;
    shared.pages.forEach((page, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'atlas-page';
      const display = document.createElement('canvas');
      const scale = Math.min(maxSide / page.size.w, maxSide / page.size.h, 1);
      display.width = Math.round(page.size.w * scale);
      display.height = Math.round(page.size.h * scale);
      const dctx = display.getContext('2d');
      dctx.imageSmoothingQuality = 'high';
      dctx.drawImage(this.pageCanvases[i], 0, 0, display.width, display.height);
      const label = document.createElement('div');
      label.className = 'dim small mono';
      label.textContent = `${page.name} · ${page.size.w}×${page.size.h} · ${page.regions.length} regions`;
      wrap.append(display, label);
      holder.appendChild(wrap);
    });

    const st = c.stats;
    const textureRow = (label, ext, pages) => {
      if (!pages?.length) return '';
      const total = pages.reduce((n, p) => n + p.bytes.length, 0);
      return (
        `<div class="k">${label}</div><div class="v">${formatBytes(total)}` +
        (pages.length > 1 ? ` <span class="dim">(${pages.length} pages)</span>` : '') +
        ` ${this.textureQualityBadge(pages[0], this.convertedTextureExtension === ext)}</div>`
      );
    };

    $('animAtlasInfo').innerHTML =
      `<div class="info-grid">` +
      `<div class="k">Skeletons</div><div class="v mono">${st.skeletons} from ${st.packages} package(s)</div>` +
      `<div class="k">Animation names</div><div class="v mono">${
        this.convertedAnimationNameMode === 'source'
          ? 'imported names kept exactly'
          : 'target / custom mapping applied'
      }</div>` +
      `<div class="k">Texture pages</div><div class="v mono">${st.sourcePages} in → ${st.pageCount} out</div>` +
      `<div class="k">Atlas size</div><div class="v mono">${shared.pages
        .map((p) => `${p.size.w}×${p.size.h}`)
        .join(', ')}</div>` +
      `<div class="k">Space used</div><div class="v mono">${shared.usedPct.toFixed(1)}%</div>` +
      `<div class="k">Regions</div><div class="v mono">${shared.sharedRegions.length}</div>` +
      `<div class="k">Region sharing</div><div class="v mono">${st.sharedBetweenSkeletons} shared between skeletons · ${st.skeletonSpecific} skeleton-specific</div>` +
      (st.dedupedAcrossPackages
        ? `<div class="k">Deduplicated</div><div class="v mono">${st.dedupedAcrossPackages} reused across packages</div>`
        : '') +
      `<div class="k">Alpha</div><div class="v mono">${
        shared.pma ? 'pma:true' : 'straight alpha'
      }${
        shared.straightAlphaOutput
          ? ' <span class="dim">(un-premultiplied; the runtime multiplies on upload)</span>'
          : ''
      }</div>` +
      (shared.pmaCorrected?.channels
        ? `<div class="k">Transparency</div><div class="v"><span class="badge badge-added">cleaned</span>` +
          `<div class="dim small">${shared.pmaCorrected.channels} channel(s) across ` +
          `${shared.pmaCorrected.regions} region(s) held colour brighter than their alpha — ` +
          `lossy smear a pma page would draw as a box around the symbol.</div></div>`
        : '') +
      `<div class="k">Quality</div><div class="v mono">${escapeHtml(
        qualityLevelLabel(this.convertedTextureQuality)
      )}</div>` +
      textureRow('PNG', 'png', this.pngPages) +
      textureRow('WebP', 'webp', this.webpPages) +
      this.webpLevelNote() +
      (this.inexactSourcePages.length
        ? `<div class="k">Source decode</div><div class="v"><span class="badge badge-replaced">approximate</span>` +
          `<div class="dim small">${escapeHtml(
            this.inexactSourcePages.join(', ')
          )} fell back to the canvas decoder, which loses colour under a low alpha.</div></div>`
        : '') +
      `</div>`;

    // Per-symbol verification + live playback.
    const list = $('animSymbolList');
    list.innerHTML = c.skeletons
      .map((s, i) => {
        const v = this.verification[i];
        const status = v.ok
          ? '<span class="badge badge-added">runtime OK</span>'
          : '<span class="badge badge-error">runtime FAILED</span>';
        const anims = (v.animations || [])
          .map(
            (a) =>
              `<button class="chip" data-idx="${i}" data-anim="${escapeHtml(a.animation)}">${escapeHtml(a.animation)}` +
              `<span class="dim"> ${a.duration.toFixed(2)}s</span></button>`
          )
          .join('');
        const problems = [
          ...(v.ok ? [] : [`<div class="err">${escapeHtml(v.error || 'failed to load')}</div>`]),
          ...(s.missingRegions.length
            ? [`<div class="err">Missing regions: ${s.missingRegions.map(escapeHtml).join(', ')}</div>`]
            : []),
          ...(s.compatibility.blocking
            ? [`<div class="err">${escapeHtml(s.compatibility.title)}: ${escapeHtml(s.compatibility.detail)}</div>`]
            : []),
        ].join('');
        const pagesNote =
          shared.pages.length > 1 && v.pagesUsed?.length
            ? ` <span class="dim small">pages: ${v.pagesUsed.map(escapeHtml).join(', ')}</span>`
            : '';
        return (
          `<div class="symbol-card ${v.ok ? '' : 'bad'}">` +
          `<div class="symbol-head"><b>${escapeHtml(s.assetKey)}</b>` +
          (s.variantLabel ? ` <span class="badge badge-variant">${escapeHtml(s.variantLabel)}</span>` : '') +
          ` ${status}<span class="dim mono">${escapeHtml(s.jsonName)}</span></div>` +
          `<div class="chips">${anims}</div>` +
          (v.bounds
            ? `<div class="dim small mono">bounds ${v.bounds.width.toFixed(0)}×${v.bounds.height.toFixed(0)} · ` +
              `${v.setupDrawable} drawable attachments${pagesNote}</div>`
            : '') +
          problems +
          `</div>`
        );
      })
      .join('');

    list.onclick = (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      for (const el of list.querySelectorAll('.chip')) el.classList.remove('active');
      chip.classList.add('active');
      const index = Number(chip.dataset.idx);
      this.playAnimation(index, chip.dataset.anim);
      this.renderDrawCallDetails(index, chip.dataset.anim);
    };

    this.renderDrawCallAnalysis();

    // Changes + warnings.
    const changes = c.skeletons.flatMap((s) =>
      s.changes.map((ch) => `${s.assetKey}: ${ch.kind} "${ch.from}" → "${ch.to}"`)
    );
    const warnings = conversionWarnings(c);
    $('animChanges').innerHTML =
      (changes.length
        ? `<div class="sub">Changes applied</div><ul class="tight">${changes
            .map((t) => `<li class="mono small">${escapeHtml(t)}</li>`)
            .join('')}</ul>`
        : '') +
      (warnings.length
        ? `<div class="sub">Warnings</div><ul class="tight">${warnings
            .map(
              (w) =>
                `<li class="small ${w.level === 'error' ? 'err' : w.level === 'warn' ? 'warn' : 'dim'}">` +
                `${w.package ? `<b>${escapeHtml(w.package)}</b>: ` : ''}${escapeHtml(w.message)}</li>`
            )
            .join('')}</ul>`
        : '<div class="dim small">No warnings.</div>');

    const cleanToggle = $('animCleanTarget');
    cleanToggle.checked = this.cleanTarget;
    cleanToggle.onchange = () => {
      this.cleanTarget = cleanToggle.checked;
    };

    // Auto-play the first animation of the first symbol.
    const firstChip = list.querySelector('.chip');
    if (firstChip) {
      firstChip.classList.add('active');
      const index = Number(firstChip.dataset.idx);
      this.playAnimation(index, firstChip.dataset.anim);
      this.renderDrawCallDetails(index, firstChip.dataset.anim);
    }
  }

  renderDrawCallAnalysis() {
    const entries = (this.drawCallReports || []).flatMap((asset, assetIndex) =>
      (asset.report?.animations || []).map((animation) => ({ asset, assetIndex, animation }))
    );
    const successful = entries.filter(({ animation }) => animation.ok);
    const samples = successful.reduce((sum, entry) => sum + entry.animation.sampleCount, 0);
    const average = samples
      ? successful.reduce(
          (sum, entry) =>
            sum + entry.animation.averageDrawCalls * entry.animation.sampleCount,
          0
        ) / samples
      : 0;
    const peak = successful.reduce(
      (best, entry) =>
        !best || entry.animation.maxDrawCalls > best.animation.maxDrawCalls ? entry : best,
      null
    );
    const pageMax = successful.reduce(
      (max, entry) => Math.max(max, entry.animation.texturePages.max),
      0
    );
    const fmt = (value, digits = 1) =>
      Number.isInteger(value) ? String(value) : Number(value || 0).toFixed(digits);

    $('animDrawCallSummary').innerHTML = [
      ['Peak calls', peak ? peak.animation.maxDrawCalls : 0],
      ['Average calls', fmt(average, 2)],
      ['Animations sampled', `${successful.length}/${entries.length}`],
      ['Texture pages at once', pageMax],
    ]
      .map(
        ([label, value]) =>
          `<div class="draw-call-stat"><span class="dim small">${escapeHtml(String(label))}</span>` +
          `<span class="value">${escapeHtml(String(value))}</span></div>`
      )
      .join('');

    const table = $('animDrawCallTable');
    if (!entries.length) {
      table.innerHTML = '<div class="dim small">No animations were available to analyse.</div>';
      $('animDrawCallReasons').innerHTML = '';
      return;
    }

    table.innerHTML =
      '<table class="anim-table draw-call-table"><thead><tr>' +
      '<th>Spine file</th><th>Animation</th><th>Calls min / avg / max</th>' +
      '<th>Peak time</th><th>Attachments</th><th>Triangles</th><th>Pages</th><th>Samples</th>' +
      '</tr></thead><tbody>' +
      entries
        .map(({ asset, assetIndex, animation }) => {
          if (!animation.ok) {
            return (
              `<tr class="row-error"><td class="draw-call-file mono">${escapeHtml(asset.jsonName)}</td>` +
              `<td class="mono">${escapeHtml(animation.animation || 'unknown')}</td>` +
              `<td colspan="6" class="err">${escapeHtml(animation.error || 'analysis failed')}</td></tr>`
            );
          }
          const calls = `${animation.minDrawCalls} / ${fmt(animation.averageDrawCalls)} / ${animation.maxDrawCalls}`;
          return (
            `<tr class="draw-call-row" data-idx="${assetIndex}" data-anim="${escapeHtml(animation.animation)}">` +
            `<td class="draw-call-file mono">${escapeHtml(asset.jsonName)}` +
            `${asset.variantLabel ? ` <span class="badge badge-variant">${escapeHtml(asset.variantLabel)}</span>` : ''}</td>` +
            `<td class="mono">${escapeHtml(animation.animation)}</td>` +
            `<td class="mono ${animation.maxDrawCalls > animation.minDrawCalls ? 'peak' : ''}">${calls}</td>` +
            `<td class="mono">${animation.worstTimestamp.toFixed(3)}s</td>` +
            `<td class="mono">${animation.attachments.min}\u2013${animation.attachments.max}</td>` +
            `<td class="mono">${animation.triangles.min}\u2013${animation.triangles.max}</td>` +
            `<td class="mono">${animation.texturePages.min}\u2013${animation.texturePages.max}</td>` +
            `<td class="mono">${animation.sampleCount}</td></tr>`
          );
        })
        .join('') +
      '</tbody></table>';

    table.onclick = (event) => {
      const row = event.target.closest('.draw-call-row');
      if (!row) return;
      const index = Number(row.dataset.idx);
      const animationName = row.dataset.anim;
      for (const chip of $('animSymbolList').querySelectorAll('.chip')) {
        chip.classList.toggle(
          'active',
          Number(chip.dataset.idx) === index && chip.dataset.anim === animationName
        );
      }
      this.playAnimation(index, animationName);
      this.renderDrawCallDetails(index, animationName);
    };

    if (peak) this.renderDrawCallDetails(peak.assetIndex, peak.animation.animation);
  }

  renderDrawCallDetails(index, animationName) {
    const asset = this.drawCallReports?.[index];
    const animation = asset?.report?.animations?.find(
      (entry) => entry.animation === animationName
    );
    const frame = animation?.worstFrame;
    if (!animation?.ok || !frame) {
      $('animDrawCallReasons').innerHTML =
        '<span class="dim">No batch details are available for this animation.</span>';
      return;
    }

    const reasonLabels = {
      blendMode: 'Blend mode changes',
      batcher: 'Renderer / two-colour tint changes',
      topology: 'Geometry topology changes',
      textureCapacity: 'Texture-capacity breaks',
    };
    const reasonRows = Object.entries(reasonLabels)
      .map(
        ([key, label]) =>
          `<div>${escapeHtml(label)}</div><div class="mono">${frame.breakReasons?.[key] || 0}</div>`
      )
      .join('');
    const warnings = (animation.warnings || []).filter(
      (warning) => !warning.startsWith('Expected calls cover this Spine object only')
    );
    $('animDrawCallReasons').innerHTML =
      `<div class="draw-call-reason-grid">${reasonRows}` +
      `<div>Peak batch sequence</div><div class="draw-call-sequence">${escapeHtml(
        frame.batchSequence.join(' \u2192 ') || 'no drawable batches'
      )}</div>` +
      `<div>Peak frame</div><div class="mono">${escapeHtml(asset.jsonName)} \u00b7 ${escapeHtml(
        animation.animation
      )} @ ${animation.worstTimestamp.toFixed(3)}s \u00b7 ${frame.drawableAttachments} attachments \u00b7 ` +
      `${frame.triangles} triangles</div></div>` +
      (warnings.length
        ? `<ul class="tight warn">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
        : '');
  }

  playAnimation(index, animationName) {
    const s = this.conversion.skeletons[index];
    if (!s) return;
    const canvas = $('animSpineCanvas');
    if (!this.preview) this.preview = new SpinePreview(canvas);
    const load = loadWithRuntime({
      atlasText: this.conversion.shared.atlasText,
      skeletonJson: s.skeleton,
      images: this.previewImages,
      scale: 1,
    });
    if (!load.ok) {
      this.toast(`${s.assetKey}: ${load.error}`, 'error', 7000);
      return;
    }
    this.preview.stop();
    this.preview.setSkeleton({ skeletonData: load.skeletonData, image: this.previewImage });
    this.preview.play(animationName, true);
    $('animPlayingLabel').textContent =
      `${s.assetKey}${s.variantLabel ? ` (${s.variantLabel})` : ''} · ${animationName}`;
  }

  // =========================================================================
  // Step 5: export
  // =========================================================================
  async doExport() {
    const c = this.conversion;
    if (!c?.ok) return;

    const errorWarnings = conversionWarnings(c).filter((w) => w.level === 'error');
    if (this.hasHardConversionBlocker(c)) {
      const detail = errorWarnings[0]?.message || 'The conversion reported a blocking error.';
      const more = errorWarnings.length > 1 ? ` (${errorWarnings.length - 1} more)` : '';
      this.toast(`Export blocked: ${detail}${more}`, 'error', 10000);
      return;
    }

    if (
      !this.primaryTextureExtension ||
      this.primaryTextureExtension !== this.convertedTextureExtension ||
      this.textureFormats.webp !== this.convertedTextureFormats?.webp ||
      this.textureFormats.png !== this.convertedTextureFormats?.png ||
      this.textureQuality !== this.convertedTextureQuality ||
      this.alphaMode !== this.convertedAlphaMode ||
      this.animationNameMode !== this.convertedAnimationNameMode
    ) {
      this.toast(
        'Export blocked: mapping or texture settings changed — rebuild the preview.',
        'error',
        8000
      );
      return;
    }

    const blockers = this.verification.filter((v) => !v.ok);
    if (blockers.length) {
      const detail = blockers
        .slice(0, 2)
        .map((blocker) => `${blocker.assetKey}: ${blocker.error || 'runtime verification failed'}`)
        .join('; ');
      this.toast(
        `Export blocked because runtime verification failed. ${detail}`,
        'error',
        12000
      );
      return;
    }
    if (c.skeletons.some((s) => s.compatibility.blocking)) {
      const ok = confirm(
        'Some packages are flagged as needing a re-export from a different Spine version.\n\n' +
          'The files will be written unchanged (no version faking). Continue?'
      );
      if (!ok) return;
    }

    // Destination: the project's own spines folder when a project is selected.
    let outDir;
    if (this.targetKind === 'project') {
      outDir = joinPath(this.target.spinesRoot, this.outputFolder);
    } else {
      const picked = await native.pickDirectory({ title: 'Choose where to write the asset package' });
      if (!picked) return;
      outDir = joinPath(picked, this.outputFolder);
    }

    const textFiles = [
      { name: `${this.atlasName}.atlas`, text: c.shared.atlasText },
      ...c.skeletons.map((s) => ({ name: s.jsonName, text: s.json })),
      { name: 'index.ts', text: c.indexTs },
    ];

    // Every generated page is written; the .atlas names them and the loader
    // resolves them relative to the atlas file.
    const images = [];
    c.shared.pages.forEach((page, i) => {
      if (this.convertedTextureFormats.webp) {
        images.push({
          name: replaceTextureExtension(page.name, 'webp'),
          encoding: 'raw',
          bytes: this.webpPages[i].bytes,
        });
      }
      if (this.convertedTextureFormats.png) {
        images.push({
          name: replaceTextureExtension(page.name, 'png'),
          encoding: 'raw',
          bytes: this.pngPages[i].bytes,
        });
      }
    });

    let res;
    try {
      res = await native.animWritePackage({ outDir, textFiles, images, overwrite: false });
      if (!res.ok && res.conflict) {
        const ok = confirm(
          `The target folder already contains ${res.conflict.length} file(s) that would be overwritten:\n\n` +
            `${res.conflict.slice(0, 10).join('\n')}${res.conflict.length > 10 ? '\n…' : ''}\n\nOverwrite them?`
        );
        if (!ok) return;
        res = await native.animWritePackage({ outDir, textFiles, images, overwrite: true });
      }
    } catch (error) {
      this.toast(
        `Could not write the package: ${error?.message || error}`,
        'error',
        10000
      );
      return;
    }
    if (!res.ok) {
      this.toast(`Could not write the package: ${res.error || 'unknown error'}`, 'error', 8000);
      return;
    }

    this.exported = {
      outDir: res.outDir,
      written: res.written,
      firstFile: joinPath(res.outDir, textFiles[0].name),
      cleanup: null,
    };

    if (this.cleanTarget) {
      // Runs after the write, never before it, and the manifest it protects is
      // what the main process reports actually landed on disk — not what we
      // asked it to write.
      this.exported.cleanup = await this.cleanTargetFolder(
        res.outDir,
        res.written.map((f) => f.name)
      );
    }

    this.renderExport();
    this.goto('export');
  }

  /**
   * Delete files the export did not produce, after showing exactly what will go.
   * Returns null when nothing was removed, so the summary can stay quiet.
   */
  async cleanTargetFolder(outDir, keep) {
    let plan;
    try {
      plan = await native.animPlanCleanup({ outDir, keep });
    } catch (error) {
      this.toast(`Could not check the folder for stale files: ${error?.message || error}`, 'warn', 8000);
      return null;
    }
    if (!plan?.ok) {
      this.toast(`Skipped cleanup: ${plan?.error || 'unknown error'}`, 'warn', 8000);
      return null;
    }
    if (!plan.removable.length) {
      this.toast('Nothing to clean up — the folder holds only this export.', 'info', 5000);
      return { removed: [], failed: [], nothingToDo: true };
    }

    const list = plan.removable
      .slice(0, 20)
      .map((f) => `  ${f.name}  (${formatBytes(f.bytes)})`)
      .join('\n');
    const more = plan.removable.length > 20 ? `\n  …and ${plan.removable.length - 20} more` : '';
    const total = plan.removable.reduce((n, f) => n + f.bytes, 0);
    const ok = confirm(
      `Permanently delete ${plan.removable.length} file(s) (${formatBytes(total)}) from\n${plan.outDir}?\n\n` +
        `${list}${more}\n\n` +
        `These are not part of the export you just wrote. This cannot be undone.`
    );
    if (!ok) {
      this.toast('Cleanup cancelled — nothing was deleted.', 'info', 5000);
      return null;
    }

    let result;
    try {
      result = await native.animCleanupPackage({
        outDir,
        keep,
        names: plan.removable.map((f) => f.name),
      });
    } catch (error) {
      this.toast(`Could not remove the stale files: ${error?.message || error}`, 'error', 9000);
      return null;
    }
    if (!result?.ok) {
      this.toast(`Could not remove the stale files: ${result?.error || 'unknown error'}`, 'error', 9000);
      return null;
    }
    if (result.failed.length) {
      this.toast(
        `Removed ${result.removed.length} file(s); ${result.failed.length} could not be deleted ` +
          `(${result.failed[0].name}: ${result.failed[0].error})`,
        'warn',
        9000
      );
    }
    return result;
  }

  renderExport() {
    const c = this.conversion;
    const e = this.exported;
    const totalAnimations = c.skeletons.reduce((n, s) => n + s.outAnimations.length, 0);
    const webpFiles = e.written.filter((f) => f.name.endsWith('.webp'));
    const pngFiles = e.written.filter((f) => f.name.endsWith('.png'));
    const webpFile = webpFiles.length
      ? { bytes: webpFiles.reduce((n, f) => n + f.bytes, 0), count: webpFiles.length }
      : null;
    const pngFile = pngFiles.length
      ? { bytes: pngFiles.reduce((n, f) => n + f.bytes, 0), count: pngFiles.length }
      : null;

    $('animExportSummary').innerHTML =
      `<div class="info-grid">` +
      `<div class="k">Output folder</div><div class="v mono">${escapeHtml(e.outDir)}</div>` +
      `<div class="k">Skeletons converted</div><div class="v mono">${c.skeletons.length}${
        c.skeletons.some((s) => s.variantLabel)
          ? ` <span class="dim">(${c.skeletons
              .filter((s) => s.variantLabel)
              .map((s) => s.variantLabel)
              .join(', ')})</span>`
          : ''
      }</div>` +
      `<div class="k">Animations</div><div class="v mono">${totalAnimations}</div>` +
      `<div class="k">Animation names</div><div class="v mono">${
        this.convertedAnimationNameMode === 'source'
          ? 'imported names kept exactly'
          : 'target / custom mapping applied'
      }</div>` +
      `<div class="k">Shared atlas</div><div class="v mono">${c.shared.pages
        .map((p) => `${p.size.w} × ${p.size.h}`)
        .join(', ')} (${c.shared.usedPct.toFixed(1)}% used, ${c.shared.pageCount} page${
        c.shared.pageCount === 1 ? '' : 's'
      })</div>` +
      `<div class="k">Texture quality</div><div class="v mono">${escapeHtml(
        qualityLevelLabel(this.convertedTextureQuality)
      )}</div>` +
      (webpFile
        ? `<div class="k">WebP</div><div class="v">${formatBytes(webpFile.bytes)}` +
          `${webpFile.count > 1 ? ` <span class="dim">across ${webpFile.count} pages</span>` : ''} ` +
          this.textureQualityBadge(this.webp, this.convertedTextureExtension === 'webp') +
          `</div>`
        : '') +
      (pngFile
        ? `<div class="k">PNG</div><div class="v">${formatBytes(pngFile.bytes)}` +
          `${pngFile.count > 1 ? ` <span class="dim">across ${pngFile.count} pages</span>` : ''} ` +
          this.textureQualityBadge(this.png, this.convertedTextureExtension === 'png') +
          `</div>`
        : '') +
      `<div class="k">Runtime check</div><div class="v">${
        this.verification.every((v) => v.ok)
          ? `<span class="badge badge-added">all ${this.verification.length} loaded in Spine ${this.runtimeVersion || '4.2'}</span>`
          : `<span class="badge badge-error">${this.verification.filter((v) => !v.ok).length} failed</span>`
      }</div>` +
      `</div>` +
      `<div class="sub">Files written</div>` +
      `<ul class="tight">${e.written
        .map((f) => `<li class="mono small">${escapeHtml(f.name)} <span class="dim">${formatBytes(f.bytes)}</span></li>`)
        .join('')}</ul>` +
      (e.cleanup?.removed?.length
        ? `<div class="sub">Stale files removed</div>` +
          `<ul class="tight">${e.cleanup.removed
            .map(
              (f) =>
                `<li class="mono small">${escapeHtml(f.name)} ` +
                `<span class="dim">${formatBytes(f.bytes)}</span></li>`
            )
            .join('')}</ul>` +
          (e.cleanup.failed.length
            ? `<ul class="tight">${e.cleanup.failed
                .map(
                  (f) =>
                    `<li class="small warn">${escapeHtml(f.name)} could not be deleted: ` +
                    `${escapeHtml(f.error)}</li>`
                )
                .join('')}</ul>`
            : '')
        : '') +
      (e.cleanup?.nothingToDo
        ? `<div class="dim small">Cleanup found no stale files in the target folder.</div>`
        : '');

    const registerable = this.targetKind === 'project';
    $('animRegisterBtn').classList.toggle('hidden', !registerable);
    $('animRegisterNote').innerHTML = registerable
      ? `Registering appends ${c.assetEntries.length} <span class="mono">type: 'spine'</span> entries to ` +
        `<span class="mono">${escapeHtml(this.target.assetsTsPath)}</span> ` +
        `(append-only, with a one-time backup) — the same mechanism the Layout Editor's asset recheck uses.`
      : `<div class="note">Snippet for <span class="mono">src/game/assets.ts</span>:</div>` +
        `<pre class="snippet">${escapeHtml(c.assetsTsSnippet)}</pre>`;

    const unresolved = uniqueWarnings(
      conversionWarnings(c).filter((w) => w.level === 'error' || w.level === 'warn'),
      this.verification
        .filter((v) => !v.ok)
        .map((v) => ({ level: 'error', message: `${v.assetKey}: ${v.error}` }))
    );
    $('animExportWarnings').innerHTML = unresolved.length
      ? `<div class="sub">Unresolved warnings</div><ul class="tight">${unresolved
          .map((w) => `<li class="small ${w.level === 'error' ? 'err' : 'warn'}">${escapeHtml(w.message)}</li>`)
          .join('')}</ul>`
      : '';
  }

  async registerInProject() {
    const c = this.conversion;
    let res;
    try {
      res = await native.animRegister({
        appDir: this.target.appDir,
        entries: c.assetEntries,
        scale: this.packing.registrationScale,
      });
    } catch (error) {
      this.toast(
        `Could not register the assets: ${error?.message || error}`,
        'error',
        10000
      );
      return;
    }
    if (!res.ok) {
      this.toast(res.error, 'error', 8000);
      return;
    }
    const parts = [];
    if (res.added.length) parts.push(`registered ${res.added.join(', ')}`);
    if (res.skipped.length) parts.push(`${res.skipped.length} already present`);
    this.toast(parts.join(' · ') || 'Nothing to register', 'info', 6000);
    $('animRegisterNote').innerHTML =
      `<span class="badge badge-added">registered</span> ` +
      `${res.added.length} entries appended to <span class="mono">${escapeHtml(res.file)}</span>. ` +
      `<span class="dim">A backup was saved as assets.ts.ae-backup.</span>`;
  }
}
