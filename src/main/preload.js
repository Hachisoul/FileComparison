'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bulk', {
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  checkFolder: (p) => ipcRenderer.invoke('check-folder', p),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  compare: (left, right, opts) => ipcRenderer.invoke('compare', left, right, opts),
  detail: (id) => ipcRenderer.invoke('detail', id),
  exportCsv: () => ipcRenderer.invoke('export-csv'),
  reveal: (p) => ipcRenderer.invoke('open-path', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
