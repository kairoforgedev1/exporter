'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  getLaunchConfig: () => ipcRenderer.invoke('get-launch-config'),
  getPathForFile: (file) => {
    if (!file || !webUtils?.getPathForFile) return null;
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts),
  pickSave: (opts) => ipcRenderer.invoke('pick-save', opts),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', { path: p, data }),
  writeExport: (opts) => ipcRenderer.invoke('write-export', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  setDirty: (d) => ipcRenderer.invoke('set-dirty', d),
  capturePage: (p) => ipcRenderer.invoke('capture-page', p),
  quit: (code) => ipcRenderer.invoke('quit-app', code),
  onMenu: (cb) => ipcRenderer.on('menu', (e, id) => cb(id)),

  // Animation Re-Export
  pickDirectory: (opts) => ipcRenderer.invoke('pick-directory', opts),
  animOpenSource: (p) => ipcRenderer.invoke('anim-open-source', p),
  animFindApps: (root) => ipcRenderer.invoke('anim-find-apps', root),
  animInspectApp: (dir) => ipcRenderer.invoke('anim-inspect-app', dir),
  animInspectFolder: (dir) => ipcRenderer.invoke('anim-inspect-folder', dir),
  animRegister: (opts) => ipcRenderer.invoke('anim-register', opts),
  animWritePackage: (opts) => ipcRenderer.invoke('anim-write-package', opts),
  animTextureQualityLevels: () => ipcRenderer.invoke('anim-texture-quality-levels'),
  animDecodeTexture: (bytes) => ipcRenderer.invoke('anim-decode-texture', { bytes }),
  animEncodeTexture: (opts) => ipcRenderer.invoke('anim-encode-texture', opts),
  animPlanCleanup: (opts) => ipcRenderer.invoke('anim-plan-cleanup', opts),
  animCleanupPackage: (opts) => ipcRenderer.invoke('anim-cleanup-package', opts),

  // Bitmap Font Exporter
  fontOpenSource: (p) => ipcRenderer.invoke('font-open-source', p),
  fontListFolder: (p) => ipcRenderer.invoke('font-list-folder', p),
  fontFindApps: (root) => ipcRenderer.invoke('font-find-apps', root),
  fontInspectApp: (dir) => ipcRenderer.invoke('font-inspect-app', dir),
  fontRegister: (opts) => ipcRenderer.invoke('font-register', opts),
  fontWritePackage: (opts) => ipcRenderer.invoke('font-write-package', opts),
  fontCleanup: (root) => ipcRenderer.invoke('font-cleanup', root),
});
