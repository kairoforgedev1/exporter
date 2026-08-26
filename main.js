'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { encodePNG } = require('./pngenc');
const workspace = require('./spine/workspace');
const animTexture = require('./spine/texture');
const animCleanup = require('./spine/cleanup');
const fontWorkspace = require('./font/workspace');
const { loadSharp } = animTexture;

let win = null;
let isDirty = false;
const toPosixPath = (value) => value.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Smoke test configuration (automated end-to-end run):
//   electron . --smoke-test --smoke-atlas=<png> --smoke-json=<json> --smoke-out=<dir>
// ---------------------------------------------------------------------------
function parseSmokeConfig() {
  const argv = process.argv;
  if (!argv.includes('--smoke-test')) return null;
  const get = (name) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  return {
    atlasPng: get('smoke-atlas'),
    atlasJson: get('smoke-json'),
    outDir: get('smoke-out') || path.join(app.getPath('temp'), 'atlas-editor-smoke'),
    animSource: get('smoke-anim'),
    drawCallsSource: get('smoke-drawcalls'),
    animZip: get('smoke-anim-zip'),
    meterSource: get('smoke-meter'),
    blurTest: argv.includes('--smoke-blur'),
    animProject: get('smoke-project'),
    animReference: get('smoke-reference'),
    fontSource: get('smoke-font'),
  };
}
const smokeConfig = parseSmokeConfig();

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#141519',
    show: false,
    title: 'Exporter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', (e) => {
    if (isDirty && !smokeConfig) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Discard Changes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unsaved Changes',
        message: 'Exporter has unsaved changes.',
        detail: 'If you close now, changes in the active workflow since its last export will be lost.',
      });
      if (choice === 1) e.preventDefault();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  buildMenu();
}

function sendMenu(id) {
  if (win) win.webContents.send('menu', id);
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open Atlas…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-atlas') },
        { label: 'Add Images…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('add-images') },
        { type: 'separator' },
        { label: 'Export Atlas…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: '&Workflows',
      submenu: [
        {
          label: 'Texture Atlas',
          click: () => sendMenu('workflow-atlas'),
        },
        {
          label: 'Spine Animation…',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendMenu('workflow-spine'),
        },
        {
          label: 'Bitmap Font…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendMenu('workflow-font'),
        },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        // No accelerators here: the renderer handles Ctrl+Z/Y itself so text
        // fields keep their native undo behaviour.
        { label: 'Undo', click: () => sendMenu('undo') },
        { label: 'Redo', click: () => sendMenu('redo') },
        { type: 'separator' },
        { label: 'Select All Sprites', click: () => sendMenu('select-all') },
        { label: 'Delete Selected', click: () => sendMenu('delete-selected') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', click: () => sendMenu('zoom-in') },
        { label: 'Zoom Out', click: () => sendMenu('zoom-out') },
        { label: 'Fit to Screen', click: () => sendMenu('zoom-fit') },
        { label: 'Actual Size (100%)', click: () => sendMenu('zoom-100') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About Exporter',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About',
              message: 'Exporter',
              detail:
                'Stake Engine asset exporter for texture atlases, Spine animations, and bitmap fonts.\nIncludes preview, verification, automatic MaxRects packing, and runtime-ready registration.',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function validateDirectChildFilename(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} filenames must be non-empty strings.`);
  }
  if (
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    /[\\/]/.test(name) ||
    /[<>:"|?*\x00-\x1f]/.test(name) ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    path.basename(name) !== name
  ) {
    throw new Error(`Invalid ${label.toLowerCase()} filename: ${JSON.stringify(name)}.`);
  }
}

function validatedPackageDestination(resolvedOutDir, name, label) {
  validateDirectChildFilename(name, label);
  const dest = path.resolve(resolvedOutDir, name);
  const relative = path.relative(resolvedOutDir, dest);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} destination is outside the output directory: ${JSON.stringify(name)}.`);
  }
  return dest;
}

function rgbaBuffer(value, expectedBytes) {
  let buffer;
  if (Buffer.isBuffer(value)) {
    buffer = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof ArrayBuffer) {
    buffer = Buffer.from(value);
  } else if (Array.isArray(value)) {
    buffer = Buffer.from(value);
  } else {
    throw new Error('Bitmap font package has no raw RGBA pixel buffer.');
  }
  if (buffer.length !== expectedBytes) {
    throw new Error(`Bitmap font RGBA size mismatch: ${buffer.length} != ${expectedBytes}.`);
  }
  return buffer;
}

function webpChunkTypes(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return [];
  }
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length) break;
    chunks.push(type);
    offset = end + (size & 1);
  }
  return chunks;
}

function compareRenderedRgba(expected, actual) {
  let exact = expected.length === actual.length;
  let alphaPreserved = exact;
  let renderedEquivalent = exact;
  let inputHasTransparency = false;
  if (!exact) {
    return { exact: false, alphaPreserved: false, renderedEquivalent: false, inputHasTransparency: false };
  }
  for (let i = 0; i < expected.length; i += 4) {
    const alpha = expected[i + 3];
    if (alpha !== 255) inputHasTransparency = true;
    if (actual[i + 3] !== alpha) {
      alphaPreserved = false;
      renderedEquivalent = false;
    }
    if (
      actual[i] !== expected[i] ||
      actual[i + 1] !== expected[i + 1] ||
      actual[i + 2] !== expected[i + 2]
    ) {
      exact = false;
      // RGB under a fully transparent pixel has no rendered effect. Lossless
      // WebP encoders are permitted to canonicalize those invisible channels.
      if (alpha !== 0 || actual[i + 3] !== 0) renderedEquivalent = false;
    }
  }
  return { exact, alphaPreserved, renderedEquivalent, inputHasTransparency };
}

async function verifyEncodedTexture(sharp, name, format, bytes, rgba, width, height) {
  let decoded;
  let metadata;
  try {
    metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    decoded = await sharp(bytes, { failOn: 'error' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(`Could not decode generated ${format.toUpperCase()} ${JSON.stringify(name)}: ${error.message}`);
  }
  const dimensionsMatch = decoded.info.width === width && decoded.info.height === height;
  const comparison = compareRenderedRgba(rgba, decoded.data);
  const chunks = format === 'webp' ? webpChunkTypes(bytes) : [];
  const vp8l = format !== 'webp' || chunks.includes('VP8L');
  const signatureValid =
    format === 'png'
      ? bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : chunks.length > 0;
  const ok =
    signatureValid &&
    dimensionsMatch &&
    comparison.alphaPreserved &&
    comparison.renderedEquivalent &&
    vp8l;
  return {
    name,
    format,
    bytes: bytes.length,
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
    hasAlpha: metadata.hasAlpha,
    inputHasTransparency: comparison.inputHasTransparency,
    dimensionsMatch,
    alphaPreserved: comparison.alphaPreserved,
    exactAlpha: comparison.alphaPreserved,
    rawPixelEquivalent: comparison.exact,
    renderedPixelEquivalent: comparison.renderedEquivalent,
    codec: format === 'webp' ? (vp8l ? 'VP8L' : chunks.join(',')) : 'PNG',
    vp8l: format === 'webp' ? vp8l : null,
    lossless: format === 'png' || vp8l,
    signatureValid,
    ok,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-launch-config', () => ({ smoke: smokeConfig }));

ipcMain.handle('pick-files', async (e, opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || 'Select File',
    defaultPath: opts.defaultPath || undefined,
    filters: opts.filters || [],
    properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('pick-save', async (e, opts) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title || 'Save File',
    defaultPath: opts.defaultPath || undefined,
    filters: opts.filters || [],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('read-file', async (e, filePath) => {
  return fs.readFile(filePath);
});

ipcMain.handle('file-exists', async (e, filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('write-file', async (e, { path: filePath, data }) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(data));
  return true;
});

// Encode + write the optimized atlas PNG, its JSON and the optional TS asset
// module in one step.
ipcMain.handle('write-export', async (e, { pngPath, jsonPath, width, height, rgba, jsonText, tsPath, tsText }) => {
  const png = encodePNG(rgba, width, height);
  await fs.mkdir(path.dirname(pngPath), { recursive: true });
  await fs.writeFile(pngPath, png);
  await fs.writeFile(jsonPath, jsonText, 'utf8');
  if (tsPath && tsText) await fs.writeFile(tsPath, tsText, 'utf8');
  return { pngBytes: png.length, jsonBytes: Buffer.byteLength(jsonText, 'utf8') };
});

ipcMain.handle('show-in-folder', (e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('set-dirty', (e, dirty) => {
  isDirty = !!dirty;
});

ipcMain.handle('capture-page', async (e, outPath) => {
  const image = await win.webContents.capturePage();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, image.toPNG());
  return true;
});

// --- Spine Animation ---------------------------------------------------------
ipcMain.handle('pick-directory', async (e, opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts?.title || 'Select Folder',
    defaultPath: opts?.defaultPath || undefined,
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// --- Bitmap Font ------------------------------------------------------------
ipcMain.handle('font-open-source', (e, sourcePath) => {
  const selected = typeof sourcePath === 'string'
    ? sourcePath
    : sourcePath?.path || sourcePath?.sourcePath;
  return fontWorkspace.openSource(selected);
});
ipcMain.handle('font-list-folder', (e, dir) => {
  const selected = typeof dir === 'string' ? dir : dir?.path || dir?.dir;
  return fontWorkspace.listFolder(selected);
});
ipcMain.handle('font-find-apps', (e, root) => {
  const selected = typeof root === 'string' ? root : root?.path || root?.root;
  return fontWorkspace.findApps(selected);
});
ipcMain.handle('font-inspect-app', (e, appDir) => {
  const selected = typeof appDir === 'string' ? appDir : appDir?.path || appDir?.appDir;
  return fontWorkspace.inspectApp(selected);
});
ipcMain.handle('font-register', (e, opts) => fontWorkspace.registerFontAsset(opts));
ipcMain.handle('font-cleanup', (e, root) => fontWorkspace.cleanup(root));

function verifyFontPackageStructure(textFiles, textureNames, width, height) {
  const errors = [];
  const warnings = [];
  const xml = [];
  const json = [];
  const names = new Set([...textureNames, ...textFiles.map((file) => file.name)]);

  for (const file of textFiles) {
    const ext = path.extname(file.name).toLowerCase();
    if (ext === '.xml') {
      if (!fontWorkspace.isXml10Text(file.text)) {
        errors.push(`${file.name} contains characters forbidden by XML 1.0.`);
      }
      const metadata = fontWorkspace.parseXmlMetadata(file.text);
      if (!metadata) {
        errors.push(`${file.name} is not valid BMFont XML.`);
        continue;
      }
      xml.push({ name: file.name, text: file.text, metadata });
    } else if (ext === '.json') {
      const metadata = fontWorkspace.parseJsonMetadata(file.text);
      if (!metadata) {
        errors.push(`${file.name} is not valid BMFont JSON.`);
        continue;
      }
      json.push({ name: file.name, metadata });
    } else if (/^index\.ts$/i.test(file.name)) {
      for (const match of file.text.matchAll(/from\s+(['"])\.\/([^'"]+)\1/g)) {
        const imported = match[2].replace(/\?.*$/, '');
        if (!names.has(imported)) {
          errors.push(`${file.name} imports missing package file ${imported}.`);
        }
      }
      if (/\bcreateAsset\s*\(/.test(file.text)) {
        warnings.push('index.ts uses legacy createAsset registration; assets.ts XML registration remains the runtime source of truth.');
      }
    }
  }

  if (!xml.length) errors.push('A Stake Engine bitmap-font package requires BMFont XML metadata.');
  for (const item of [...xml, ...json]) {
    const metadata = item.metadata;
    if (metadata.format === 'xml' && !/<font>/.test(item.text)) {
      errors.push(`${item.name} must use the Pixi-detectable literal <font> root tag.`);
    }
    if (!metadata.face) errors.push(`${item.name} has no bitmap-font face name.`);
    if (!Number.isInteger(metadata.lineHeight) || metadata.lineHeight <= 0) {
      errors.push(`${item.name} has an invalid line height.`);
    }
    if (
      !Number.isInteger(metadata.size) ||
      metadata.size <= 0 ||
      !Number.isInteger(metadata.scaleW) ||
      !Number.isInteger(metadata.scaleH) ||
      !Number.isInteger(metadata.base) ||
      metadata.scaleW <= 0 ||
      metadata.scaleH <= 0 ||
      metadata.base < 0
    ) {
      errors.push(`${item.name} has invalid integer common metrics.`);
    }
    if (!metadata.chars.length) errors.push(`${item.name} contains no characters.`);
    if (metadata.scaleW !== width || metadata.scaleH !== height) {
      errors.push(
        `${item.name} declares ${metadata.scaleW}x${metadata.scaleH}, but the packed texture is ${width}x${height}.`
      );
    }
    if (metadata.invalidCharacterIds.length) {
      errors.push(`${item.name} has invalid character IDs: ${metadata.invalidCharacterIds.join(', ')}.`);
    }
    if (metadata.duplicateCharacterIds.length) {
      errors.push(`${item.name} has duplicate character IDs: ${metadata.duplicateCharacterIds.join(', ')}.`);
    }
    if (
      metadata.pages.length !== 1 ||
      Number(metadata.pages[0]?.id) !== 0 ||
      metadata.declaredPages !== 1
    ) {
      errors.push(`${item.name} must declare exactly one texture page with id 0 and common pages="1".`);
    }
    for (const page of metadata.pageFiles) {
      if (
        page !== path.basename(page) ||
        /[\\/\0]/.test(page) ||
        !textureNames.includes(page)
      ) {
        errors.push(`${item.name} references missing or unsafe texture page ${JSON.stringify(page)}.`);
      }
    }
    if (metadata.pageFiles.length !== 1) {
      errors.push(`${item.name} must reference exactly one generated texture page.`);
    }
    let hasPositiveFrame = false;
    let validSpace = false;
    for (const glyph of metadata.chars) {
      const x = Number(glyph.x);
      const y = Number(glyph.y);
      const glyphWidth = Number(glyph.width);
      const glyphHeight = Number(glyph.height);
      const xoffset = Number(glyph.xoffset);
      const yoffset = Number(glyph.yoffset);
      const xadvance = Number(glyph.xadvance);
      const glyphPage = glyph.page == null || glyph.page === '' ? 0 : Number(glyph.page);
      if (
        ![x, y, glyphWidth, glyphHeight, xoffset, yoffset, xadvance, glyphPage].every(Number.isInteger) ||
        glyphPage !== 0 ||
        x < 0 ||
        y < 0 ||
        glyphWidth < 0 ||
        glyphHeight < 0 ||
        x + glyphWidth > width ||
        y + glyphHeight > height
      ) {
        errors.push(`${item.name} has an out-of-bounds glyph: ${String(glyph.id ?? '')}.`);
        break;
      }
      if (glyphWidth > 0 && glyphHeight > 0) hasPositiveFrame = true;
      if (Number(glyph.id) === 32 && xadvance > 0) validSpace = true;
    }
    if (!hasPositiveFrame) errors.push(`${item.name} has no positive in-bounds glyph frame.`);
    if (!validSpace) {
      errors.push(`${item.name} must include U+0020 SPACE with a positive integer xadvance.`);
    }
  }

  if (xml.length && json.length) {
    const runtime = xml[0].metadata;
    const compatibility = json[0].metadata;
    if (runtime.face !== compatibility.face) {
      warnings.push('XML and JSON font face names differ; the XML face controls the Stake Engine runtime.');
    }
    const xmlIds = runtime.characterIds.join(',');
    const jsonIds = compatibility.characterIds.join(',');
    if (xmlIds !== jsonIds) warnings.push('XML and JSON character ID lists differ.');
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    runtimeMetadata: xml.map((item) => item.name),
    compatibilityMetadata: json.map((item) => item.name),
    runtimeTextureReferences: xml.flatMap((item) => item.metadata.pageFiles),
  };
}

ipcMain.handle('font-write-package', async (e, request) => {
  const {
    outDir,
    width,
    height,
    rgba,
    textFiles,
    overwrite = false,
    dryRun = false,
  } = request || {};
  const pngName = request?.pngName || request?.textures?.png || null;
  const webpName = request?.webpName || request?.textures?.webp || null;
  if (typeof outDir !== 'string' || !outDir || outDir.includes('\0')) {
    throw new Error('Bitmap font package output directory must be a non-empty string.');
  }
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 32768 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 32768
  ) {
    throw new Error('Bitmap font texture dimensions must be integers from 1 to 32768.');
  }
  const pixelBytes = width * height * 4;
  if (!Number.isSafeInteger(pixelBytes) || pixelBytes > 512 * 1024 * 1024) {
    throw new Error('Bitmap font texture exceeds the 512 MB raw-pixel safety limit.');
  }
  if (!Array.isArray(textFiles)) {
    throw new Error('Bitmap font text files must be supplied as an array.');
  }
  if (!pngName && !webpName) {
    throw new Error('Request at least one PNG or lossless WebP texture output.');
  }
  if (pngName && !/\.png$/i.test(pngName)) {
    throw new Error('Bitmap font PNG output filename must end in .png.');
  }
  if (webpName && !/\.webp$/i.test(webpName)) {
    throw new Error('Bitmap font WebP output filename must end in .webp.');
  }

  const pixels = rgbaBuffer(rgba, pixelBytes);
  const resolvedOutDir = path.resolve(outDir);
  const targets = [];
  const seenNames = new Set();
  for (const file of textFiles) {
    if (!file || typeof file.text !== 'string') {
      throw new Error(`Bitmap font text entry ${JSON.stringify(file?.name)} has no text content.`);
    }
    if (
      typeof file.name === 'string' &&
      !/\.(?:xml|json)$/i.test(file.name) &&
      !/^index\.ts$/i.test(file.name)
    ) {
      throw new Error(`Unsupported bitmap font text filename: ${JSON.stringify(file.name)}.`);
    }
    targets.push({ type: 'text', name: file.name, text: file.text });
  }
  if (pngName) targets.push({ type: 'texture', format: 'png', name: pngName });
  if (webpName) targets.push({ type: 'texture', format: 'webp', name: webpName });

  for (const target of targets) {
    target.dest = validatedPackageDestination(resolvedOutDir, target.name, 'Bitmap font package');
    const duplicateKey = process.platform === 'win32' ? target.name.toLowerCase() : target.name;
    if (seenNames.has(duplicateKey)) {
      throw new Error(`Duplicate bitmap font package filename: ${JSON.stringify(target.name)}.`);
    }
    seenNames.add(duplicateKey);
  }

  const textureNames = [pngName, webpName].filter(Boolean);
  const structure = verifyFontPackageStructure(textFiles, textureNames, width, height);
  const existing = [];
  for (const target of targets) {
    const targetStat = await fs.lstat(target.dest).catch(() => null);
    if (!targetStat) continue;
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link ${JSON.stringify(target.name)}.`);
    }
    if (!targetStat.isFile()) {
      throw new Error(`Bitmap font package target is not a regular file: ${JSON.stringify(target.name)}.`);
    }
    existing.push(target.name);
  }
  if (existing.length && !overwrite) {
    return {
      ok: false,
      dryRun: !!dryRun,
      conflict: existing,
      outDir: toPosixPath(resolvedOutDir),
      verification: {
        ok: false,
        complete: false,
        structure,
        textures: [],
      },
    };
  }

  if (!structure.ok) {
    return {
      ok: false,
      dryRun: !!dryRun,
      conflict: [],
      outDir: toPosixPath(resolvedOutDir),
      verification: {
        ok: false,
        complete: false,
        structure,
        textures: [],
      },
    };
  }

  const sharp = loadSharp();
  const encoded = new Map();
  for (const target of targets) {
    if (target.type === 'text') {
      encoded.set(target.name, Buffer.from(target.text, 'utf8'));
    } else if (target.format === 'png') {
      encoded.set(target.name, encodePNG(pixels, width, height));
    } else {
      try {
        const webp = await sharp(pixels, {
          raw: { width, height, channels: 4 },
          failOn: 'error',
        })
          .webp({ lossless: true, effort: 6 })
          .toBuffer();
        encoded.set(target.name, webp);
      } catch (error) {
        throw new Error(`Could not encode lossless WebP ${JSON.stringify(target.name)}: ${error.message}`);
      }
    }
  }

  const textureVerification = [];
  for (const target of targets.filter((item) => item.type === 'texture')) {
    const result = await verifyEncodedTexture(
      sharp,
      target.name,
      target.format,
      encoded.get(target.name),
      pixels,
      width,
      height
    );
    textureVerification.push(result);
  }
  const verification = {
    ok: structure.ok && textureVerification.every((item) => item.ok),
    complete: true,
    width,
    height,
    structure,
    textures: textureVerification,
    transparencyPreserved: textureVerification.every((item) => item.alphaPreserved),
    renderedPixelEquivalent: textureVerification.every((item) => item.renderedPixelEquivalent),
    losslessWebp:
      !webpName ||
      textureVerification.some((item) => item.name === webpName && item.codec === 'VP8L' && item.lossless),
  };
  if (!verification.ok) {
    return {
      ok: false,
      dryRun: !!dryRun,
      conflict: [],
      outDir: toPosixPath(resolvedOutDir),
      verification,
    };
  }

  const planned = targets.map((target) => ({
    name: target.name,
    bytes: encoded.get(target.name).length,
    format: target.format || 'text',
  }));
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      written: [],
      planned,
      outDir: toPosixPath(resolvedOutDir),
      verification,
    };
  }

  await fs.mkdir(resolvedOutDir, { recursive: true });
  const written = [];
  for (const target of targets) {
    const bytes = encoded.get(target.name);
    await fs.writeFile(target.dest, bytes);
    written.push({
      name: target.name,
      bytes: bytes.length,
      format: target.format || 'text',
    });
  }
  return {
    ok: true,
    dryRun: false,
    written,
    planned,
    outDir: toPosixPath(resolvedOutDir),
    verification,
  };
});

ipcMain.handle('anim-open-source', async (e, sourcePath) => {
  let root = sourcePath;
  let fromArchive = false;
  const stat = await fs.stat(sourcePath);
  if (stat.isFile()) {
    if (!/\.zip$/i.test(sourcePath)) throw new Error('Select a folder or a .zip archive.');
    root = await workspace.extractZip(sourcePath);
    fromArchive = true;
  }
  const scan = await workspace.scanAnimationSource(root);
  return { ...scan, fromArchive, originalPath: sourcePath.split(path.sep).join('/') };
});

ipcMain.handle('anim-find-apps', (e, root) => workspace.findApps(root));
ipcMain.handle('anim-inspect-app', (e, appDir) => workspace.inspectApp(appDir));
ipcMain.handle('anim-inspect-folder', (e, dir) => workspace.inspectSpineFolder(dir));
ipcMain.handle('anim-register', (e, opts) => workspace.registerSpineAssets(opts));

ipcMain.handle('anim-texture-quality-levels', () => animTexture.qualityLevels());

/**
 * Decode an animator's texture page to exact straight-alpha RGBA.
 * The renderer falls back to its canvas decoder when this reports `ok: false`,
 * so a missing Sharp build degrades quality instead of breaking the workflow.
 */
ipcMain.handle('anim-decode-texture', (e, { bytes } = {}) => animTexture.decodeTextureBytes(bytes));

/** Encode one output page from exact RGBA, then decode it back and measure it. */
ipcMain.handle('anim-encode-texture', (e, request) => animTexture.encodeTexturePage(request));

/** List the stale files a cleanup would remove. Deletes nothing. */
ipcMain.handle('anim-plan-cleanup', (e, opts) => animCleanup.planPackageCleanup(opts));

/** Delete stale files, re-validating every one against a fresh plan. */
ipcMain.handle('anim-cleanup-package', (e, opts) => animCleanup.applyPackageCleanup(opts));

/** Write the converted package: text files plus encoded texture pages. */
ipcMain.handle('anim-write-package', async (e, { outDir, textFiles, images, overwrite }) => {
  if (
    typeof outDir !== 'string' ||
    outDir.length === 0 ||
    outDir.includes('\0')
  ) {
    throw new Error('Animation package output directory must be a non-empty string.');
  }
  if (!Array.isArray(textFiles) || !Array.isArray(images)) {
    throw new Error('Animation package files must be supplied as text and image arrays.');
  }

  const resolvedOutDir = path.resolve(outDir);
  const targets = [
    ...textFiles.map((file) => ({ type: 'text', file, name: file?.name })),
    ...images.map((file) => ({ type: 'image', file, name: file?.name })),
  ];
  const seenNames = new Set();

  // Validate the complete request before touching the output directory. Package
  // entries are deliberately limited to direct children of outDir.
  for (const target of targets) {
    const { name } = target;
    validateDirectChildFilename(name, 'Animation package');
    if (target.type === 'text') {
      if (typeof target.file.text !== 'string') {
        throw new Error(`Text package entry ${JSON.stringify(name)} has no text content.`);
      }
    } else if (target.file.encoding === 'png-raw') {
      const { rgba, width, height } = target.file;
      if (
        !Number.isInteger(width) ||
        width < 1 ||
        !Number.isInteger(height) ||
        height < 1 ||
        !rgba ||
        typeof rgba.length !== 'number' ||
        rgba.length < width * height * 4
      ) {
        throw new Error(`PNG package entry ${JSON.stringify(name)} has invalid RGBA data.`);
      }
    } else if (
      target.file.encoding !== 'raw' ||
      !target.file.bytes ||
      (!ArrayBuffer.isView(target.file.bytes) &&
        !(target.file.bytes instanceof ArrayBuffer)) ||
      target.file.bytes.byteLength < 1
    ) {
      throw new Error(`Texture package entry ${JSON.stringify(name)} has invalid encoded bytes.`);
    }

    const duplicateKey = process.platform === 'win32' ? name.toLowerCase() : name;
    if (seenNames.has(duplicateKey)) {
      throw new Error(`Duplicate animation package filename: ${JSON.stringify(name)}.`);
    }
    seenNames.add(duplicateKey);

    target.dest = validatedPackageDestination(resolvedOutDir, name, 'Animation package');
  }

  const existing = [];
  for (const target of targets) {
    if (await fs.access(target.dest).then(() => true, () => false)) existing.push(target.name);
  }
  if (existing.length && !overwrite) {
    return { ok: false, conflict: existing };
  }
  await fs.mkdir(resolvedOutDir, { recursive: true });
  const written = [];
  for (const target of targets) {
    if (target.type === 'text') {
      await fs.writeFile(target.dest, target.file.text, 'utf8');
      written.push({
        name: target.name,
        bytes: Buffer.byteLength(target.file.text, 'utf8'),
      });
    } else {
      let bytes;
      if (target.file.encoding === 'png-raw') {
        bytes = encodePNG(target.file.rgba, target.file.width, target.file.height);
      } else {
        bytes = Buffer.from(target.file.bytes);
      }
      await fs.writeFile(target.dest, bytes);
      written.push({ name: target.name, bytes: bytes.length });
    }
  }
  return { ok: true, written, outDir: outDir.split(path.sep).join('/') };
});

ipcMain.handle('quit-app', (e, code) => {
  isDirty = false;
  if (typeof code === 'number') process.exitCode = code;
  app.quit();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
