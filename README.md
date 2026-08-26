# Exporter

A desktop Stake Engine asset exporter built with Electron. Its organized
workflows cover texture atlases, Spine animations, and bitmap fonts while
sharing preview, verification, packing, optimization, and project-registration
features. In the Texture Atlas workflow, all sprite placement is automatic —
you only manage images and names.

## Features

- **Import** a TexturePacker JSON (hash or array) atlas. The matching file is
  auto-detected when you pick either the PNG or the JSON. Rotated and trimmed
  frames are fully supported; each sprite is extracted into an in-memory
  working image (nothing is written to disk until you export).
- **Sprite library** with thumbnails, dimensions, status badges
  (added / replaced / renamed), search, name/size sorting, and
  single / multi selection (Ctrl+click, Shift+click).
- **Add images** via toolbar, menu (Ctrl+I), or drag & drop. Sprite names come
  from filenames; duplicates are auto-suffixed.
- **Replace** a sprite's image while keeping its name. By default the new
  image's own dimensions are used and the atlas relayouts automatically; if
  the size differs from the current sprite you are prompted to either use the
  new size (recommended) or scale the new image to keep the old size.
  Importing files whose names match existing sprites (Add Images or drag &
  drop) offers to replace those sprites in place instead of creating
  "name (2).png" copies.
- **Rename** (F2, double-click, or the inspector field) and **delete**
  (Delete key) sprites.
- **Create Blurred Version** — generate blurred twins of static symbols for use
  while the reels spin, keeping the sharp originals for when they stop. See
  below.
- **Automatic repacking** (MaxRects, best-short-side-fit, multiple sort
  heuristics) with optional 90° rotation, transparent-pixel trimming, edge
  extrusion, sprite/border padding, max size, power-of-two and square
  constraints. Every edit triggers a repack; the atlas grows/shrinks to the
  tightest size that fits.
- **Preview** with zoom (wheel / +/-), pan (drag), fit (Ctrl+0), 1:1 (Ctrl+1),
  checkerboard transparency, sprite outlines, optional name labels,
  click-to-select, selection highlight, and live size / space-usage readout.
- **Inspector** showing the sprite preview, name, source/trimmed size and the
  generated (read-only) atlas position.
- **Undo / redo** (Ctrl+Z / Ctrl+Y) for add, replace, rename, delete and
  settings changes; unsaved-changes indicator plus a close-confirmation.
- **Export** via native save dialog: writes a losslessly optimized PNG
  (adaptive scanline filters, max deflate, automatic palette mode when the
  image has ≤ 256 colors, RGB mode when fully opaque), a JSON matching the
  reference format exactly, and an `index.ts` pixi-svelte asset module
  (`createAsset({ img, atlas })`) referencing the exported filenames. The
  original files are never touched. An export summary shows paths, atlas size,
  sprite count, file size and space usage.

## Bitmap Font

Choose **Workflows > Bitmap Font** from the toolbar launcher or native menu to open a
separate four-step workspace for turning static PNG glyph artwork into a
Stake Engine-ready bitmap-font folder. Its glyphs, working data, packing settings
and unsaved state are isolated from the normal texture atlas and from
Spine Animation.

**Glyphs -> Layout & Metrics -> Preview & Verify -> Export & Register**

- **Glyph import and mapping** - import a folder, select multiple PNGs, drop
  PNG files, or reopen an existing compatible font folder/archive. Character
  detection accepts literal filenames, decimal and hexadecimal code points,
  `U+XXXX`/`uniXXXX` forms, and common names such as `space`, `comma`,
  `period`, `question`, and currency aliases. Each result shows its artwork,
  source filename, character, Unicode value, source dimensions, effective
  metrics and mapping status. Artwork can be renamed, replaced, removed or
  remapped without touching its source file. Invalid Unicode scalars,
  unmapped images and duplicate assignments are called out before export.
  A virtual space with a positive advance and transparent 1 x 1 texture cell
  can be added even when no space PNG exists.
- **Useful font metrics** - set the runtime face, design size, line height,
  artwork baseline, general letter spacing and space width. Per glyph, adjust
  X/Y placement and advance without forcing narrow and wide characters to a
  common width. Optional transparent trimming keeps the source placement by
  carrying removed padding into BMFont offsets. Compatible kerning pairs from
  an opened font are preserved for characters that remain mapped. All emitted
  metrics are integers because that is how the installed Pixi bitmap-font
  loader parses them.
- **Font-specific atlas packing** - glyphs use the editor's MaxRects packer
  and atlas compositor, but rotation is always disabled. Configurable
  padding, transparent border and extrusion protect outlines, shadows and
  glow artwork from linear-filter bleeding. The pack is one lossless page and
  fails visibly when the configured maximum cannot hold every glyph.
- **Compatible preview and verification** - enter custom text or use alphabet,
  number, currency, game-label, long-text and mixed-symbol presets. The canvas
  renderer follows the same line-height, base, offset and integer-advance rules
  as Pixi's BMFont path. Verification checks mappings, the space advance,
  atlas bounds, texture references, page IDs, glyph IDs, counts, transparent
  space pixels and missing preview characters; live baseline and frame guides
  expose overhangs, overlaps and visual alignment problems.
  Colored glyph artwork also produces a Pixi 8 compatibility warning: imported
  bitmap fonts multiply `style.fill` into their texture, so code that replaces
  the whole style must include `fill: 0xffffff`. The shared `pixi-svelte`
  `BitmapText` wrapper now supplies that neutral tint whenever fill is omitted.
- **Complete package export** - emit `<name>.png`, a true lossless VP8L
  `<name>.webp`, authoritative BMFont XML, coherent BMFont JSON, and a legacy
  `index.ts` compatibility module. PNG and WebP are encoded, decoded, and
  pixel-compared before the verified bytes are committed, including alpha.
  The pre-export page lists every file and
  warning; the result lists dimensions, sizes and verification status and can
  open the output folder.
- **Current SDK registration** - when a Stake Engine app is selected, the
  exporter inspects its real `src/game/assets.ts` and
  `static/assets/fonts/` conventions. A verified XML font can be registered
  there with a one-time backup. Unsafe asset keys, duplicate keys, duplicate
  runtime faces and path conflicts are refused.

The current Web SDK is the source of truth: Pixi loads the XML and its relative
PNG/WebP page, and the XML `<info face>` is the family used by `BitmapText`.
The supplied font's `index.ts`/JSON pair is retained as a useful
neighbour-compatible artifact, but the installed `pixi-svelte` does not export
`createAsset` and those files do not register a font in current games. The
exporter therefore fixes inconsistent reference counts/page names and repairs
the sample's malformed `?.png` character ID instead of reproducing it.

## Blurred static symbols (reel spinning)

Select one or more sprites and use **Create Blurred Version…** in the inspector
(it works for a single selection or a batch). The blurred copies are added to
the project as ordinary static sprites, so they rename, replace, delete, undo,
repack and export exactly like any other frame — and the exported JSON lists
them as normal static atlas frames the game can swap in while spinning.

Static images only. The action is disabled the moment the selection contains
anything that is not a static raster image, and dropping `.atlas` / `.skel` /
`.spine` files points you at the Spine Animation workflow instead. This feature never
touches Spine data.

Controls: **motion blur** (default, with a vertical direction because that is
the way reels travel) or **gaussian**; strength; direction/angle; softness; and
whether to expand the canvas so the falloff is not clipped.

Two properties are enforced rather than hoped for:

- **No halos.** Blurring straight-alpha RGBA averages the colour of fully
  transparent pixels — usually black — into the fringe and rings the symbol
  with a dark edge. All blurring happens in premultiplied space and is
  un-premultiplied afterwards, so a red symbol reads as pure red at every alpha
  level. The tests assert this on both a red and a white symbol.
- **No jump.** Kernels are symmetric about the source pixel and padding is
  applied symmetrically per axis, so the alpha-weighted centre of the artwork
  stays put. The dialog shows the measured centre drift (0.00 px for the sample
  symbols) and the tests fail if it exceeds a sub-pixel threshold.

Names default to `<symbol>_blur.<ext>`, are editable per item, and generation is
blocked while any name collides with an existing sprite or another name in the
batch — nothing is ever silently overwritten.

## Spine Animation (Spine → Stake Engine Web SDK)

A separate guided workflow (**Workflows > Spine Animation**, or Ctrl+R) that
turns an animator-delivered Spine package into a ready-to-drop
Stake Engine asset folder. The normal atlas editing workflow is unaffected;
the Spine runtime is only loaded when this feature is first opened.

**Source → Target → Mapping → Preview & Verify → Export**

- **Source** — pick the animator's folder or `.zip`. Files are grouped into
  packages around each `.atlas`, showing Spine version, animations, texture
  sizes, region counts and completeness. Incomplete deliveries (missing
  skeleton, atlas or texture page) are reported, never silently skipped.

  A package is **one atlas, any number of skeletons, any number of texture
  pages**. Skeletons are attributed to an atlas by name — exact base name
  first (`lp1.json` ← `lp1.atlas`), then prefix (`fs_meter_mobile.json` ←
  `fs_meter.atlas`), then the sole atlas in the folder — so a folder of
  independent one-to-one packages and a folder holding one shared
  multi-skeleton package both resolve correctly. Device/layout variants
  (mobile, desktop, tablet, portrait, landscape, …) are labelled from the file
  name, and the card shows which regions are shared between the variants,
  which are variant-specific, and which texture pages each variant needs.
- **Target** — point at the Stake Engine project (preferred) or a reference
  asset folder. The tool reads the app's real conventions: registration
  through `src/game/assets.ts`, the `static/assets/spines/<folder>/` layout,
  the shipped Spine runtime version, the dominant registration `scale`, and
  which animation names the game actually requests (parsed from the game
  source, e.g. `SYMBOL_INFO_MAP`).
- **Mapping** — per skeleton: asset key, output JSON name, and source→target
  animation names, pre-filled from the target's convention and editable. The
  **Animation names** control can instead keep every imported Spine animation
  key exactly as-is (including spelling and capitalization); switching modes
  does not discard any custom target-name edits.
  Skeletons that are device variants of one feature keep their animation names
  (renaming them would break the shared contract); single-skeleton packages get
  the symbol convention applied. Duplicate output names, duplicate animation
  targets, unsafe filenames and invalid TypeScript asset keys are refused.
- **Preview & Verify** — every generated atlas page is shown, and every
  converted skeleton is loaded and played independently with
  `@esotericsoftware/spine-core` (the same core `spine-pixi-v8` wraps), against
  the actual exported textures with each page bound to its own image.
  Verification catches missing texture pages, missing attachment regions,
  incorrect page references, and skeletons that load but would render nothing
  (unresolved attachments, empty animations, zero bounds). Spine 4.2 sequence
  attachments are resolved frame-by-frame before validation and drawing.
  Runtime verification failures block export rather than producing a package
  known not to load.
  The same step reports **Expected Pixi draw calls** for every skeleton and
  animation: minimum, average and maximum calls, the worst timestamp,
  attachment/triangle/page ranges, and the exact batch sequence. It samples at
  60 Hz plus timeline key boundaries and models Pixi 8 batch breaks caused by
  blend mode, two-color tint renderer, topology and texture capacity. One Pixi
  batch maps to one WebGL draw or WebGPU `drawIndexed`, so the result remains
  useful with the SDK's WebGPU renderer. It is explicitly an isolated-asset
  count; filters, render textures, masks, slot containers and surrounding game
  objects can add calls in a complete scene.
- **Export** — writes the package, then optionally appends `type: 'spine'`
  entries to `src/game/assets.ts` (append-only, with a one-time backup) using
  the same mechanism as the Layout Editor's asset recheck.

  **Remove stale files from the target folder** (off by default, on the Preview
  step) deletes leftovers from a previous export — the old `symbols_2.png` that
  a smaller repack no longer needs, a renamed skeleton's orphaned JSON. See
  below for exactly what it will and will not touch.

  Registration deliberately goes through `assets.ts`, not the folder's
  `index.ts`: a search of the whole web-sdk finds **no `createAsset` export** in
  the pixi-svelte version it ships, so the `index.ts` files sitting in the
  existing spine folders are legacy and nothing imports them. One is still
  emitted so a converted folder matches its neighbours, and for a multi-page
  atlas it imports every page — but it is not what loads the asset.

Multiple skeletons sharing an atlas stay **separate skeleton files** — bones,
slots, skins, timelines and variant-specific dimensions are never merged — and
are registered individually against the same converted atlas. Source pages are
consolidated into one page when they fit; when they do not, the output keeps as
many pages as it needs (for example `atlas.png`, `atlas_2.png`, …, which the
atlas file itself declares so the loader resolves them). PNG is the primary
runtime texture whenever PNG is selected; WebP is primary only for a WebP-only
export. If both are selected, WebP is emitted as an optional companion and the
atlas references PNG.

### Texture quality

Textures never travel through a 2D canvas. Chromium's canvas backing store is
premultiplied 8-bit, so every `drawImage`/`getImageData` and
`putImageData`/`toBlob` hop re-quantizes RGB by a factor of `alpha/255`.
Measured on the 3697×907 `pma:true` sample page, one decode-and-encode round
trip moved **~24% of the non-transparent pixels by up to 57/255 of RGB**, all of
it in the soft falloff and additive glow that Spine symbol art is made of — and
the result was still labelled "lossless". Decoding and encoding now happen in
the main process (`spine/texture.js`) and the pixels stay in straight RGBA from
the animator's file to the exported one.

### Alpha storage, and why it decides your file size

A premultiplied page is blended as `dst = src.rgb + dst.rgb * (1 - src.a)`, so
colour stored beneath a transparent pixel is *added straight to the screen*.
That makes the format hostile to WebP (see below), and pins the encoder to its
weakest setting. The **Alpha** control on the Mapping step chooses:

- **Straight** (default) — un-premultiply and emit the page *without* `pma:true`,
  so the runtime multiplies by alpha at upload. `spine-pixi-v8` selects
  `premultiply-alpha-on-upload` when the flag is absent, so whatever the codec
  did beneath a zero alpha is multiplied away. The conversion is exact:
  `round(round(p*255/a)*a/255)` returns `p`, so a lossless straight-alpha page
  premultiplies back to the original bytes.
- **Premultiplied** — keep the source's storage and accept the restrictions.

Un-premultiplying is applied to the **composed page**, never to individual
regions. It divides by alpha, which amplifies small differences where alpha is
low, so doing it before deduplication pushes copies of the same lossy artwork
outside the merge tolerance and the atlas *grows* — measured once at 23 regions
becoming 33, and a 1085×898 page becoming 1643×1268. Hashing, dedupe, blitting
and extrusion all run on premultiplied pixels.

### Texture quality

PNG has no lossy mode, so it is lossless at every level and the level governs
WebP. Measured on the 10-package symbol set (1085×898, 23 regions, WebP):

| Level | Premultiplied | Straight |
|-------|---------------|----------|
| **High** (default) | 423 KB | **360 KB** (−15%, still exact) |
| Medium | 423 KB *(level ignored)* | 241 KB (−43%) |
| Low | 423 KB *(level ignored)* | 171 KB (−60%) |

On a 4096×4096 page the same comparison runs 4.83 MB → 4.40 MB lossless, or
1.33 MB at quality 90.

Because PNG stays lossless, picking Medium or Low only shrinks what ships if
WebP is the primary texture — uncheck `.png` to get that. The dialog says so
rather than letting the setting look like it did nothing.

**On a `pma:true` page the level does not apply to WebP.** libwebp rewrites RGB
underneath fully transparent pixels with whatever compresses best, at every
effort above 0 and in every lossy mode. That is free on a straight-alpha page,
where those bytes are multiplied away, and destructive on a premultiplied one,
where they are added straight to the screen — the same visible boxes described
below, reintroduced by the encoder *after* the pixels were cleaned. libwebp can
be told to stop (its `exact` flag) but libvips/sharp does not expose it, so a
premultiplied page is always encoded lossless at effort 0. Measured on the
sample page:

| WebP setting | Transparent pixels rewritten | Additive lift | Size |
|---|---|---|---|
| lossless effort 0 | **0** | **0** | 2.93 MB |
| lossless effort 1–3 | 345,458 | 255 | 2.54 MB |
| lossless effort 5–6 | 297,284 | 255 | 2.48 MB |
| quality 95 | 115,134 | 211 | 1.50 MB |
| quality 80 | 160,293 | 211 | 1.28 MB |

Effort 0 is the only setting that keeps a
premultiplied page correct, which is why Straight alpha is the default. The
preview says when a level was overridden for this reason.

Nothing is described as lossless without being measured: every encoded page is
decoded again and compared to the packed pixels, and the badge reports what was
actually found. What counts as *rendered*-lossless depends on the blend mode —
under straight alpha a codec may canonicalize RGB beneath a zero alpha because
it cannot be seen, but under premultiplied alpha that same byte is added to the
screen and nothing is forgiven. A premultiplied page whose transparent areas the
encoder rewrote is refused rather than written, so a future libwebp change fails
loudly instead of silently reintroducing the defect. If the native decoder is
unavailable the workflow falls back to the canvas path and labels the source
decode **approximate** instead of silently degrading.

### Removing stale files after an export

A repack that produces fewer pages, or a renamed skeleton, leaves files behind
that the game no longer loads. The **Remove stale files from the target folder**
checkbox on the Preview step clears them out after the package is written.

It is off by default, and it deletes files inside a real project, so every rule
is a refusal:

- **Direct children only.** Subfolders are never entered and never removed.
- **Regular files only.** Symlinks are skipped, never followed into a delete.
- **Only file types this exporter writes** — `.png`, `.webp`, `.atlas`, `.json`,
  `.ts`. A `README.md`, `.gitkeep`, `.psd`, `.zip` or `symbols.atlas.bak` is
  left alone, because nothing here can know it is safe to remove.
- **Never the export itself.** The protected manifest is what the main process
  reports actually landed on disk, compared case-insensitively so a case
  difference cannot delete a file that was just written.
- **Never an empty manifest.** If the list of exported files is missing or
  empty, cleanup is refused rather than read as "delete everything".
- **Confirmed first.** The exact list, with sizes, is shown in a confirmation
  dialog before anything is deleted, and the deletion is re-validated against a
  fresh scan — anything that changed on disk in between is skipped.

Removed files are listed in the export summary. Deletion is permanent; the files
do not go to the recycle bin.

### Transparent-pixel contamination (visible boxes around symbols)

A lossy source texture cannot see colour underneath transparency, so its encoder
smears RGB into fully transparent areas. That is harmless under straight-alpha
blending, where RGB is multiplied by alpha. It is not harmless on a `pma:true`
page, which the runtime blends as:

```
dst = src.rgb + dst.rgb * (1 - src.a)
```

RGB is *added straight to the screen* and alpha only controls how much
background survives — so a pixel storing `alpha = 0, rgb = 213` adds 213 of
light instead of disappearing. Across the transparent part of a region quad that
draws a **visible rectangle around every symbol**.

On `sample_atlas/wild.webp` (lossy WebP, `pma:true`), 103,312 pixels at
`alpha = 0` carried RGB up to 213, and 140,750 pixels at `alpha 1–31` carried
RGB above their own alpha. Composited over a dark background, **82 of its 99
regions** lifted the background by more than 8/255, the worst by 213.

A correct premultiplied export always satisfies `rgb <= alpha`, so any violation
is by definition corruption. Regions extracted from a `pma:true` page are
clamped to that invariant before they are hashed, deduplicated, blitted or
extruded — cleaning first matters, otherwise extrusion spreads the smear into
the padding and dedupe compares contaminated pixels. Afterwards no region lifts
the background by more than 8/255 (worst 213 → 7.5, mean 74.5 → 5.5), and the
preview reports how many channels were cleaned.

Straight-alpha pages are deliberately left alone: there the colour under a
transparent pixel is what bilinear filtering blends towards at region edges, and
zeroing it would trade the boxes for dark halos.

The repacking stage is otherwise lossless: region pixels are copied verbatim
(rotation undone, never re-rotated), and trim metadata (`offsets`/`orig`) is
preserved exactly. Artwork shared between packages — the animator ships one
texture per package, so identical art is never byte-identical — is merged when
the difference is only codec noise, and the measured delta is reported.

Sequence frames are treated as one atomic family. When two packages both use a
base such as `sf_`, a collision renames the full numbered family coherently
(`sf_00`… becomes `sf_2_00`…) and updates the skeleton's base path; individual
frames are never renamed into paths the Spine runtime cannot construct.

Malformed or incomplete texture inputs stop conversion before export. This
includes missing/out-of-bounds regions and sources that mix incompatible PMA,
filter, or repeat settings on pages that would be consolidated.

Spine versions are checked against the target's actual runtime, and the tool
never fakes compatibility by rewriting a version string: a source newer than
the runtime is reported as needing a re-export from the correct Spine Editor.

## Run

```bash
npm install
npm start
npm test
```

`npm test` runs four node suites: the conversion/packing rules
(`test:exporter`), the texture codec and quality levels (`test:texture`), the
guarded stale-file cleanup (`test:cleanup`), and the bitmap font exporter
(`test:font`).

## Build a Windows executable

```bash
npm run dist        # NSIS installer + portable exe in dist/
```

The build config disables exe signing/resource editing
(`signAndEditExecutable: false`) so it builds without administrator
rights / Developer Mode. If you want a custom icon and version metadata in the
exe, enable Developer Mode on Windows, remove that flag, and add an
`icon` field under `build.win`.

## Automated end-to-end test

```bash
npx electron . --smoke-test --smoke-atlas=<atlas.png> --smoke-json=<atlas.json> --smoke-out=<dir>
```

Loads the atlas, performs rename/delete/add/replace/settings edits, checks
undo/redo, verifies pack geometry (no overlaps, in bounds, trim), exports,
re-imports the exported files and pixel-compares the round trip, then writes
`smoke-result.json` and a window screenshot to the output directory.

Add the Spine Animation scenario with:

```bash
npx electron . --smoke-test \
  --smoke-atlas=<atlas.png> --smoke-json=<atlas.json> \
  --smoke-anim=sample_animation/my_animation \
  --smoke-anim-zip=<my_animation.zip> \
  --smoke-meter=sample_animation/meter_animation \
  --smoke-project=<path to stake/web-sdk> \
  --smoke-out=<dir>
```

`--smoke-blur` runs the blurred-static-symbol scenario: halo correctness on red
and white symbols, transparency retention, centre alignment for vertical,
angled and gaussian blur, directionality, clip detection, the static-only
eligibility guard (including the inspector button state), batch generation
through the real dialog, name-collision blocking and auto-fix, undo/redo,
inclusion in repacking, and presence in the exported PNG and JSON.

`--smoke-meter` runs the multi-skeleton / multi-page scenario: one atlas with
two texture pages shared by a mobile and a desktop skeleton. It checks package
grouping, variant labelling, per-page region ownership, that skeleton data is
not merged, byte-exact repacking of regions from both source pages, runtime
loading of both variants, multi-page output when the atlas is constrained, and
registration of both variants against the same atlas.

This drives the real workflow controller: package detection, archive import,
project inspection, compatibility rules, mapping, conversion, pixel-exactness
of the repack, runtime loading of every converted skeleton, export,
re-reading the package from disk, and registration into a sandboxed copy of
`assets.ts` (the real project is never written to by the test).

Run the bitmap-font scenario against the supplied reference with:

```bash
npm run smoke:font
```

The scenario opens the existing package, checks the malformed reference-ID
repair, extracts an unpacked glyph set, exercises filename detection/manual
remapping, space, duplicate and missing-character diagnostics, preserves
variable widths and vertical offsets, previews mixed sample text, exports PNG
plus lossless WebP/XML/JSON/`index.ts`, reopens the generated package, and
verifies texture pixels, coordinates, counts and page references. Screenshots
of the glyph, metrics, preview and export steps and a machine-readable result
are written to the smoke output directory.

## JSON format

The exported JSON mirrors the imported reference (TexturePacker "JSON hash"):

```json
{"frames": {
  "sprite.png": {
    "frame": {"x":1,"y":857,"w":937,"h":806},
    "rotated": true,
    "trimmed": true,
    "spriteSourceSize": {"x":69,"y":38,"w":937,"h":806},
    "sourceSize": {"w":1080,"h":900}
  }},
  "meta": {"app":"Exporter","version":"1.0","image":"sprite_atlas.png",
           "format":"RGBA8888","size":{"w":1791,"h":1909},"scale":"1"}
}
```

`rotated: true` means the sprite is stored rotated 90° clockwise (TexturePacker
convention); `frame.w/h` are the unrotated trimmed dimensions.

## Project structure

```
main.js               Electron main process (window, dialogs, IPC, export)
pngenc.js             Lossless optimized PNG encoder (pure JS)
preload.js            Context-isolated IPC bridge
font/
  workspace.js        Font source/archive scanning, project inspection,
                      package verification and assets.ts registration
spine/
  workspace.js        Zip reading, animator-source scanning, Stake Engine
                      project inspection, assets.ts registration
  texture.js          Exact (non-canvas) texture decode/encode, quality levels
                      and measured lossless verification
  cleanup.js          Guarded removal of stale files from an export folder
renderer/
  index.html          Layout: toolbar / library / preview / inspector
  style.css           Dark editor theme
  js/
    app.js            Wiring, import/export flows, drag & drop, shortcuts
    state.js          Project state, undo/redo, repack pipeline
    blur.js           Premultiplied motion/gaussian blur, padding, centroid
    blurui.js         Create Blurred Version dialog (preview, names, batch)
    packer.js         MaxRects packing + automatic atlas sizing
    atlasio.js        JSON parse/serialize, sprite extraction, atlas compose
    preview.js        Zoom/pan canvas preview with overlays
    library.js        Sprite list panel
    inspector.js      Sprite inspector + packing settings form
    animre.js         Spine Animation workflow controller
    bitmapfont.js     Bitmap Font workflow controller
    font/
      fontCore.js     Mapping, Unicode, BMFont parse/serialize and checks
      fontAtlas.js    Unrotated single-page glyph packing and metric output
      fontImport.js   Non-destructive existing-font extraction/reopen
      fontPreview.js  Pixi-compatible text layout and canvas preview
    spine/
      spineAtlas.js   libgdx/Spine .atlas parse + serialize, region extraction,
                      premultiplied-alpha invariant cleanup
      spineSkeleton.js Skeleton inspection, remapping, compatibility rules
      spineConvert.js Shared-atlas build + skeleton conversion pipeline
      spinePreview.js Real spine-core loading, verification and playback
    smoketest.js      Automated end-to-end test
    fontsmoke.js      Bitmap-font import/export/reopen end-to-end test
    animsmoke.js      Spine Animation end-to-end test
    blursmoke.js      Blurred static symbol end-to-end test
```
