'use strict';

const fs = require('fs/promises');
const path = require('path');

const IGNORED_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

/**
 * Lists files under `root`. Returns [{ rel, abs, size }], where `rel` uses "/" separators.
 */
async function listFiles(root, { recursive = true } = {}) {
  const out = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) throw err;
      return; // unreadable subfolder: skip it
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (recursive) await walk(abs, rel);
      } else if (e.isFile()) {
        if (IGNORED_NAMES.has(e.name.toLowerCase()) || e.name.startsWith('~$')) continue;
        let size = 0;
        try {
          size = (await fs.stat(abs)).size;
        } catch { /* ignore */ }
        out.push({ rel, abs, size });
      }
    }
  }
  await walk(root, '');
  return out;
}

/**
 * Matches files of two folders by relative path (case-insensitive, like Windows).
 * Returns [{ key, name, left, right }] sorted by name; left/right may be null.
 */
function matchPairs(leftFiles, rightFiles) {
  const map = new Map();
  for (const f of leftFiles) {
    map.set(f.rel.toLowerCase(), { key: f.rel.toLowerCase(), name: f.rel, left: f, right: null });
  }
  for (const f of rightFiles) {
    const k = f.rel.toLowerCase();
    const existing = map.get(k);
    if (existing) existing.right = f;
    else map.set(k, { key: k, name: f.rel, left: null, right: f });
  }
  return [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

module.exports = { listFiles, matchPairs };
