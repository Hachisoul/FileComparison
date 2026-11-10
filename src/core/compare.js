'use strict';

const fs = require('fs/promises');
const { listFiles, matchPairs } = require('./scan');
const { extract } = require('./extract');
const { diffLines, inlineDiff } = require('./diff');
const { classify } = require('./filetypes');

const FORMAT_NAME = { pdf: 'PDF text', docx: 'Word text', xlsx: 'Excel cells', auto: 'File' };

async function sameBytes(aPath, bPath, aSize, bSize) {
  if (aSize !== bSize) return false;
  const [a, b] = await Promise.all([fs.readFile(aPath), fs.readFile(bPath)]);
  return a.equals(b);
}

/** Compares one matched pair. Returns the summary entry (no line rows). */
async function comparePair(pair, opts = {}) {
  const base = {
    name: pair.name,
    left: pair.left ? { path: pair.left.abs, size: pair.left.size } : null,
    right: pair.right ? { path: pair.right.abs, size: pair.right.size } : null,
  };
  if (!pair.left) return { ...base, status: 'only-right', message: 'Only in Folder B' };
  if (!pair.right) return { ...base, status: 'only-left', message: 'Only in Folder A' };

  try {
    const type = classify(pair.left.abs);
    if (type === 'image') return { ...base, status: 'skipped', message: 'Image file (not compared)' };
    if (type === 'video') return { ...base, status: 'skipped', message: 'Video file (not compared)' };

    if (await sameBytes(pair.left.abs, pair.right.abs, pair.left.size, pair.right.size)) {
      return { ...base, status: 'identical', format: FORMAT_NAME[type] || 'File', message: 'Files are identical' };
    }

    const [l, r] = await Promise.all([extract(pair.left.abs), extract(pair.right.abs)]);

    if (l.kind === 'text' && r.kind === 'text') {
      const { stats, approximate } = diffLines(l.lines, r.lines, opts);
      const status = stats.changed === 0 ? 'identical' : 'different';
      let message;
      if (status === 'identical') {
        message = l.format === 'Text' ? 'Same content (only line endings, encoding or ignored differences)' : 'Same content';
      } else {
        message = stats.changed === 1 ? '1 line differs' : `${stats.changed} lines differ`;
      }
      return {
        ...base,
        status,
        format: l.format,
        stats,
        approximate,
        lineCount: { left: l.lines.length, right: r.lines.length },
        message,
      };
    }

    // At least one side is binary: we can only say whether the bytes differ.
    return {
      ...base,
      status: 'different',
      format: 'Binary',
      binary: true,
      message: 'Binary content differs (no line view for this file type)',
    };
  } catch (err) {
    return { ...base, status: 'error', message: `Could not read: ${err.message}` };
  }
}

/**
 * Compares two folders. `onProgress(done, total, entry)` is called after each pair.
 */
async function compareFolders(leftRoot, rightRoot, opts = {}, onProgress = () => {}) {
  const [lf, rf] = await Promise.all([
    listFiles(leftRoot, { recursive: opts.recursive !== false }),
    listFiles(rightRoot, { recursive: opts.recursive !== false }),
  ]);
  const pairs = matchPairs(lf, rf);
  const results = new Array(pairs.length);
  let next = 0;
  let done = 0;
  const workers = Math.min(4, pairs.length);
  async function worker() {
    while (next < pairs.length) {
      const idx = next++;
      const entry = await comparePair(pairs[idx], opts);
      entry.id = idx;
      results[idx] = entry;
      done++;
      onProgress(done, pairs.length, entry);
      // Let the event loop breathe between files.
      await new Promise((res) => setImmediate(res));
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** Full line rows for one compared entry, with inline highlights on modified lines. */
async function pairDetail(entry, opts = {}) {
  if (!entry.left || !entry.right) return { rows: [], note: entry.message };
  const [l, r] = await Promise.all([extract(entry.left.path), extract(entry.right.path)]);
  if (l.kind !== 'text' || r.kind !== 'text') return { rows: [], note: entry.message };
  const res = diffLines(l.lines, r.lines, opts);
  for (const row of res.rows) {
    if (row.t === 'mod') row.hl = inlineDiff(row.lt, row.rt);
  }
  return res;
}

module.exports = { compareFolders, comparePair, pairDetail };
