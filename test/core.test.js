'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { diffLines } = require('../src/core/diff');
const { decodeText, splitLines } = require('../src/core/extract');
const { matchPairs } = require('../src/core/scan');
const { compareFolders, compareSources, compareTexts, pairDetail } = require('../src/core/compare');
const { buildCsv } = require('../src/core/csv');

function tmpFolders(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkcheck-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { a: path.join(root, 'A'), b: path.join(root, 'B'), root };
}

test('diffLines pairs changed lines and reports added/removed', () => {
  const { rows, stats } = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'x', 'd']);
  assert.deepEqual(stats, { modified: 1, added: 1, deleted: 0, same: 3, changed: 2 });
  const mod = rows.find((r) => r.t === 'mod');
  assert.equal(mod.l, 2);
  assert.equal(mod.lt, 'b');
  assert.equal(mod.rt, 'B');
  const add = rows.find((r) => r.t === 'add');
  assert.equal(add.r, 4);
  assert.equal(add.rt, 'x');
});

test('diffLines honours ignore options', () => {
  assert.equal(diffLines(['A  b'], ['a b'], { ignoreWhitespace: true, ignoreCase: true }).stats.changed, 0);
  assert.equal(diffLines(['A  b'], ['a b']).stats.changed, 1);
});

test('decodeText handles BOMs, UTF-16 and binary', () => {
  assert.equal(decodeText(Buffer.from('\ufeffhi', 'utf8')), 'hi');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')])), 'héllo');
  assert.equal(decodeText(Buffer.from('héllo', 'utf16le')), 'héllo');
  assert.equal(decodeText(Buffer.from([0, 1, 2, 3, 0, 200, 0, 0, 7])), null);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café'); // windows-1252
});

test('splitLines treats CRLF and LF the same', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
});

test('matchPairs matches names case-insensitively and keeps unmatched files', () => {
  const pairs = matchPairs(
    [{ rel: 'Read.TXT' }, { rel: 'a.txt' }],
    [{ rel: 'read.txt' }, { rel: 'b.txt' }],
  );
  assert.equal(pairs.length, 3);
  const read = pairs.find((p) => p.key === 'read.txt');
  assert.ok(read.left && read.right);
  assert.equal(pairs.find((p) => p.key === 'a.txt').right, null);
  assert.equal(pairs.find((p) => p.key === 'b.txt').left, null);
});

test('compareFolders gives the right status for each kind of pair', async () => {
  const { a, b } = tmpFolders({
    'A/same.txt': 'one\ntwo\n',
    'B/same.txt': 'one\ntwo\n',
    'A/eol.txt': 'one\r\ntwo\r\n',
    'B/eol.txt': 'one\ntwo\n',
    'A/changed.csv': 'id,name\n1,ann\n2,bob\n',
    'B/changed.csv': 'id,name\n1,ann\n2,rob\n3,cat\n',
    'A/sub/deep.json': '{"a":1}',
    'B/sub/deep.json': '{"a":2}',
    'A/pic.png': 'x',
    'B/pic.png': 'y',
    'A/blob.bin': Buffer.from([0, 1, 2, 0, 3]),
    'B/blob.bin': Buffer.from([0, 1, 2, 0, 4]),
    'A/only-a.md': '#',
    'B/only-b.md': '#',
  });
  const res = await compareFolders(a, b, {});
  const by = Object.fromEntries(res.map((r) => [r.name, r]));
  assert.equal(by['same.txt'].status, 'identical');
  assert.equal(by['eol.txt'].status, 'identical');
  assert.equal(by['changed.csv'].status, 'different');
  assert.deepEqual([by['changed.csv'].stats.modified, by['changed.csv'].stats.added], [1, 1]);
  assert.equal(by['sub/deep.json'].status, 'different');
  assert.equal(by['pic.png'].status, 'skipped');
  assert.equal(by['blob.bin'].status, 'different');
  assert.equal(by['blob.bin'].binary, true);
  assert.equal(by['only-a.md'].status, 'only-left');
  assert.equal(by['only-b.md'].status, 'only-right');

  const flat = await compareFolders(a, b, { recursive: false });
  assert.equal(flat.some((r) => r.name.startsWith('sub/')), false);

  const det = await pairDetail(by['changed.csv'], {});
  const mod = det.rows.find((r) => r.t === 'mod');
  assert.equal(mod.lt, '2,bob');
  assert.equal(mod.rt, '2,rob');
  assert.ok(mod.hl.left.some(([t, changed]) => changed && t === 'b'));
});

test('buildCsv lists every changed line and neutralises formulas', () => {
  const csv = buildCsv({
    leftRoot: 'C:\\A',
    rightRoot: 'C:\\B',
    results: [
      { id: 0, name: 'x.txt', status: 'different', message: '1 line differs' },
      { id: 1, name: 'y.txt', status: 'identical', message: 'Files are identical' },
    ],
    details: { 0: { rows: [{ t: 'eq', l: 1, lt: 'a', r: 1, rt: 'a' }, { t: 'mod', l: 2, lt: '=SUM(1)', r: 2, rt: 'say "hi", ok' }] } },
  });
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes(`x.txt,Different,1 line differs,Changed,2,'=SUM(1),2,"say ""hi"", ok"`));
  assert.ok(csv.includes('y.txt,Identical,Files are identical'));
});

test('compareSources compares two single files even when names differ', async () => {
  const { a, b } = tmpFolders({ 'A/old.txt': 'x\ny\n', 'B/new.txt': 'x\nz\n' });
  const res = await compareSources(
    { kind: 'files', paths: [path.join(a, 'old.txt')] },
    { kind: 'files', paths: [path.join(b, 'new.txt')] },
  );
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'old.txt ↔ new.txt');
  assert.equal(res[0].status, 'different');
  assert.equal(res[0].stats.modified, 1);
});

test('compareSources matches several files by name, and files against a folder', async () => {
  const { a, b } = tmpFolders({
    'A/one.txt': '1', 'A/two.txt': '2', 'A/three.txt': '3',
    'B/one.txt': '1', 'B/two.txt': 'changed', 'B/extra.txt': 'e',
  });
  const files = { kind: 'files', paths: ['one.txt', 'two.txt'].map((n) => path.join(a, n)) };

  const vsFiles = await compareSources(files, { kind: 'files', paths: ['one.txt', 'extra.txt'].map((n) => path.join(b, n)) });
  assert.deepEqual(vsFiles.map((r) => [r.name, r.status]), [
    ['extra.txt', 'only-right'], ['one.txt', 'identical'], ['two.txt', 'only-left'],
  ]);

  // Files vs folder: other files in the folder are ignored.
  const vsFolder = await compareSources(files, { kind: 'folder', path: b });
  assert.deepEqual(vsFolder.map((r) => [r.name, r.status]), [['one.txt', 'identical'], ['two.txt', 'different']]);
  const reverse = await compareSources({ kind: 'folder', path: a }, { kind: 'files', paths: [path.join(b, 'two.txt')] });
  assert.deepEqual(reverse.map((r) => [r.name, r.status]), [['two.txt', 'different']]);
});

test('compareTexts compares pasted text line by line', () => {
  const res = compareTexts('one\r\ntwo\nthree', 'one\nTWO\nthree\nfour\n');
  assert.deepEqual([res.stats.modified, res.stats.added, res.stats.deleted], [1, 1, 0]);
  const mod = res.rows.find((r) => r.t === 'mod');
  assert.equal(mod.lt, 'two');
  assert.equal(mod.rt, 'TWO');
  assert.equal(compareTexts('one\ntwo', 'ONE\ntwo', { ignoreCase: true }).stats.changed, 0);
  assert.equal(compareTexts('', '').rows.length, 0);
});
