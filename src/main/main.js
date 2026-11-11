'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const { compareSources, pairDetail, compareTexts } = require('../core/compare');
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
        { label: 'Choose File(s) A…', accelerator: 'CmdOrCtrl+Shift+1', click: () => win?.webContents.send('menu', 'pick-left-files') },
        { label: 'Choose Folder B…', accelerator: 'CmdOrCtrl+2', click: () => win?.webContents.send('menu', 'pick-right') },
        { label: 'Choose File(s) B…', accelerator: 'CmdOrCtrl+Shift+2', click: () => win?.webContents.send('menu', 'pick-right-files') },
        { label: 'Paste Text Mode', accelerator: 'CmdOrCtrl+T', click: () => win?.webContents.send('menu', 'paste-mode') },
        { label: 'Compare', accelerator: 'F5', click: () => win?.webContents.send('menu', 'compare') },
        { label: 'Export CSV…', accelerator: 'CmdOrCtrl+E', click: () => win?.webContents.send('menu', 'export') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
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
            detail: 'Compare two folders, two files, or a set of files, and see which lines differ.\n\nImages and videos are skipped. PDF, Word (.docx) and Excel (.xlsx) are compared by their text.',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('pick', async (_e, side, mode) => {
  const label = side === 'left' ? 'A' : 'B';
  if (mode === 'files') {
    const res = await dialog.showOpenDialog(win, {
      title: `Choose file(s) for side ${label}`,
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled || !res.filePaths.length ? null : { kind: 'files', paths: res.filePaths };
  }
  const res = await dialog.showOpenDialog(win, { title: `Choose folder for side ${label}`, properties: ['openDirectory'] });
  return res.canceled ? null : { kind: 'folder', path: res.filePaths[0] };
});

async function statKind(p) {
  try {
    const st = await fs.stat(p);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
  } catch { /* missing */ }
  return null;
}

/** Turns dropped paths into a source: one folder, or a list of files. */
ipcMain.handle('source-from-paths', async (_e, paths) => {
  if (!Array.isArray(paths)) return null;
  const list = paths.filter((p) => typeof p === 'string' && p);
  const kinds = await Promise.all(list.map(statKind));
  const files = list.filter((_, i) => kinds[i] === 'file');
  if (files.length) return { kind: 'files', paths: files };
  const dir = list.find((_, i) => kinds[i] === 'dir');
  return dir ? { kind: 'folder', path: dir } : null;
});

async function validSource(src, label) {
  if (src?.kind === 'folder' && typeof src.path === 'string' && (await statKind(src.path)) === 'dir') {
    return { kind: 'folder', path: src.path };
  }
  if (src?.kind === 'files' && Array.isArray(src.paths) && src.paths.length) {
    const kinds = await Promise.all(src.paths.map((p) => (typeof p === 'string' ? statKind(p) : null)));
    const missing = src.paths.filter((_, i) => kinds[i] !== 'file');
    if (missing.length) throw new Error(`Side ${label}: could not open ${missing[0]}`);
    return { kind: 'files', paths: [...src.paths] };
  }
  throw new Error(`Side ${label} could not be opened.`);
}

function describeSource(src) {
  if (src.kind === 'folder') return src.path;
  return src.paths.length === 1 ? src.paths[0] : `${src.paths.length} files: ${src.paths.join('; ')}`;
}

ipcMain.handle('compare', async (event, leftSrc, rightSrc, opts) => {
  const left = await validSource(leftSrc, 'A');
  const right = await validSource(rightSrc, 'B');
  const token = ++runToken;
  const options = {
    recursive: !!opts?.recursive,
    ignoreWhitespace: !!opts?.ignoreWhitespace,
    ignoreCase: !!opts?.ignoreCase,
  };
  let lastSent = 0;
  const results = await compareSources(left, right, options, (done, total) => {
    const now = Date.now();
    if (token === runToken && (now - lastSent > 50 || done === total)) {
      lastSent = now;
      event.sender.send('progress', { done, total });
    }
  });
  if (token !== runToken) return null; // a newer run replaced this one
  lastRun = { left: describeSource(left), right: describeSource(right), opts: options, results };
  return results;
});

ipcMain.handle('compare-text', async (_e, a, b, opts) => compareTexts(String(a ?? ''), String(b ?? ''), {
  ignoreWhitespace: !!opts?.ignoreWhitespace,
  ignoreCase: !!opts?.ignoreCase,
}));

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
