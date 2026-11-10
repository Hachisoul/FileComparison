'use strict';

const Diff = require('diff');

function normalizer({ ignoreWhitespace = false, ignoreCase = false } = {}) {
  return (s) => {
    let v = s;
    if (ignoreWhitespace) v = v.replace(/\s+/g, ' ').trim();
    if (ignoreCase) v = v.toLowerCase();
    return v;
  };
}

/**
 * Line-by-line comparison of two arrays of lines.
 * Returns { rows, stats } where each row is
 *   { t: 'eq'|'mod'|'del'|'add', l: leftLineNo|null, lt: leftText|null, r: rightLineNo|null, rt: rightText|null }
 */
function diffLines(left, right, opts = {}) {
  const norm = normalizer(opts);
  const a = left.map(norm);
  const b = right.map(norm);
  const rows = [];

  let changes = null;
  if (a.length + b.length > 0) {
    changes = Diff.diffArrays(a, b, { timeout: opts.timeoutMs || 8000 });
  } else {
    changes = [];
  }

  if (changes === undefined) {
    // Too expensive to align: compare line by line in place.
    const n = Math.max(left.length, right.length);
    for (let k = 0; k < n; k++) {
      const hasL = k < left.length;
      const hasR = k < right.length;
      let t = 'eq';
      if (hasL && hasR) t = a[k] === b[k] ? 'eq' : 'mod';
      else t = hasL ? 'del' : 'add';
      rows.push({ t, l: hasL ? k + 1 : null, lt: hasL ? left[k] : null, r: hasR ? k + 1 : null, rt: hasR ? right[k] : null });
    }
    return { rows, stats: statsOf(rows), approximate: true };
  }

  let i = 0;
  let j = 0;
  let pendDel = [];
  let pendAdd = [];
  const flush = () => {
    const n = Math.max(pendDel.length, pendAdd.length);
    for (let k = 0; k < n; k++) {
      const d = pendDel[k];
      const ad = pendAdd[k];
      if (d !== undefined && ad !== undefined) rows.push({ t: 'mod', l: d + 1, lt: left[d], r: ad + 1, rt: right[ad] });
      else if (d !== undefined) rows.push({ t: 'del', l: d + 1, lt: left[d], r: null, rt: null });
      else rows.push({ t: 'add', l: null, lt: null, r: ad + 1, rt: right[ad] });
    }
    pendDel = [];
    pendAdd = [];
  };

  for (const ch of changes) {
    const count = ch.count ?? ch.value.length;
    if (ch.removed) {
      for (let k = 0; k < count; k++) pendDel.push(i++);
    } else if (ch.added) {
      for (let k = 0; k < count; k++) pendAdd.push(j++);
    } else {
      flush();
      for (let k = 0; k < count; k++) {
        rows.push({ t: 'eq', l: i + 1, lt: left[i], r: j + 1, rt: right[j] });
        i++;
        j++;
      }
    }
  }
  flush();
  return { rows, stats: statsOf(rows), approximate: false };
}

function statsOf(rows) {
  const s = { modified: 0, added: 0, deleted: 0, same: 0 };
  for (const r of rows) {
    if (r.t === 'mod') s.modified++;
    else if (r.t === 'add') s.added++;
    else if (r.t === 'del') s.deleted++;
    else s.same++;
  }
  s.changed = s.modified + s.added + s.deleted;
  return s;
}

/**
 * Character-level highlight for a modified line pair.
 * Returns { left: [[text, changed]], right: [[text, changed]] }.
 */
function inlineDiff(lt, rt) {
  if (lt.length + rt.length > 4000) {
    return { left: [[lt, true]], right: [[rt, true]] };
  }
  const parts = lt.length + rt.length > 600 ? Diff.diffWordsWithSpace(lt, rt) : Diff.diffChars(lt, rt);
  const left = [];
  const right = [];
  for (const p of parts) {
    if (p.added) right.push([p.value, true]);
    else if (p.removed) left.push([p.value, true]);
    else {
      left.push([p.value, false]);
      right.push([p.value, false]);
    }
  }
  return { left, right };
}

module.exports = { diffLines, inlineDiff, statsOf };
