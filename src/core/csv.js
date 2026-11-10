'use strict';

const STATUS_LABEL = {
  identical: 'Identical',
  different: 'Different',
  'only-left': 'Only in Folder A',
  'only-right': 'Only in Folder B',
  skipped: 'Skipped',
  error: 'Error',
};

const CHANGE_LABEL = { mod: 'Changed', add: 'Added in B', del: 'Missing in B' };

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Stop spreadsheet apps from treating content as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Builds a CSV report. `details` maps entry id -> { rows } for entries that differ.
 */
function buildCsv({ leftRoot, rightRoot, results, details }) {
  const lines = [];
  const push = (arr) => lines.push(arr.map(cell).join(','));
  push(['BulkCheck report', new Date().toLocaleString()]);
  push(['Folder A', leftRoot]);
  push(['Folder B', rightRoot]);
  lines.push('');
  push(['File', 'Status', 'Summary', 'Change', 'Line in A', 'Content in A', 'Line in B', 'Content in B']);
  for (const e of results) {
    const det = details && details[e.id];
    const changed = det ? det.rows.filter((r) => r.t !== 'eq') : [];
    if (!changed.length) {
      push([e.name, STATUS_LABEL[e.status] || e.status, e.message]);
      continue;
    }
    for (const r of changed) {
      push([e.name, STATUS_LABEL[e.status], e.message, CHANGE_LABEL[r.t], r.l, r.lt, r.r, r.rt]);
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { buildCsv, STATUS_LABEL };
