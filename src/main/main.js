'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const { compareFolders, pairDetail } = require('../core/compare');
const { buildCsv } = require('../core/csv');

let win = null;
let lastRun = null; // { left, right, opts, results }
let runToken = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    title: 'BulkCheck',
    backgroundColor: '#f6f7f9',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Choose Folder A…', accelerator: 'CmdOrCtrl+1', click: () => win?.webContents.send('menu', 'pick-left') },
        { label: 'Choose Folder B…', accelerator: 'CmdOrCtrl+2', click: () => win?.webContents.send('menu', 'pick-right') },
        { label: 'Compare', accelerator: 'F5', click: () => win?.webContents.send('menu', 'compare') },
        { label: 'Export CSV…', accelerator: 'CmdOrCtrl+E', click: () => win?.webContents.send('menu', 'export') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About BulkCheck',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'About BulkCheck',
            message: `BulkCheck ${app.getVersion()}`,
            detail: 'Compare files with the same name in two folders and see which lines differ.\n\nImages and videos are skipped. PDF, Word (.docx) and Excel (.xlsx) are compared by their text.',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

ipcMain.handle('pick-folder', async (_e, title) => {
  const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('check-folder', async (_e, p) => (typeof p === 'string' && await isDirectory(p) ? p : null));

ipcMain.handle('compare', async (event, left, right, opts) => {
  if (!(await isDirectory(left))) throw new Error('Folder A could not be opened.');
  if (!(await isDirectory(right))) throw new Error('Folder B could not be opened.');
  const token = ++runToken;
  const options = {
    recursive: !!opts?.recursive,
    ignoreWhitespace: !!opts?.ignoreWhitespace,
    ignoreCase: !!opts?.ignoreCase,
  };
  let lastSent = 0;
  const results = await compareFolders(left, right, options, (done, total) => {
    const now = Date.now();
    if (token === runToken && (now - lastSent > 50 || done === total)) {
      lastSent = now;
      event.sender.send('progress', { done, total });
    }
  });
  if (token !== runToken) return null; // a newer run replaced this one
  lastRun = { left, right, opts: options, results };
  return results;
});

ipcMain.handle('detail', async (_e, id) => {
  if (!lastRun) return null;
  const entry = lastRun.results[id];
  if (!entry) return null;
  return pairDetail(entry, lastRun.opts);
});

ipcMain.handle('export-csv', async () => {
  if (!lastRun) return { ok: false, message: 'Run a comparison first.' };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export results as CSV',
    defaultPath: path.join(app.getPath('documents'), `BulkCheck-${stamp}.csv`),
    filters: [{ name: 'CSV file', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  const details = {};
  for (const e of lastRun.results) {
    if (e.status === 'different' && !e.binary) {
      try {
        details[e.id] = await pairDetail(e, lastRun.opts);
      } catch { /* leave summary only */ }
    }
  }
  const csv = buildCsv({ leftRoot: lastRun.left, rightRoot: lastRun.right, results: lastRun.results, details });
  await fs.writeFile(res.filePath, csv, 'utf8');
  return { ok: true, path: res.filePath };
});

ipcMain.handle('open-path', async (_e, p) => {
  if (lastRun && typeof p === 'string' && lastRun.results.some((r) => r.left?.path === p || r.right?.path === p)) {
    shell.showItemInFolder(p);
  }
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
