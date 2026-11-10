'use strict';

const fs = require('fs/promises');
const { classify } = require('./filetypes');

const MAX_TEXT_BYTES = 64 * 1024 * 1024; // larger files are compared byte for byte

/**
 * Reads a file and turns it into something comparable.
 * Returns one of:
 *   { kind: 'text', lines: string[], format }
 *   { kind: 'binary', buf: Buffer, format }
 *   { kind: 'skipped', reason }
 */
async function extract(absPath) {
  const type = classify(absPath);
  if (type === 'image') return { kind: 'skipped', reason: 'Image file (not compared)' };
  if (type === 'video') return { kind: 'skipped', reason: 'Video file (not compared)' };

  const buf = await fs.readFile(absPath);

  if (type === 'pdf') return { kind: 'text', lines: await pdfLines(buf), format: 'PDF text' };
  if (type === 'docx') return { kind: 'text', lines: await docxLines(buf), format: 'Word text' };
  if (type === 'xlsx') return { kind: 'text', lines: await xlsxLines(buf), format: 'Excel cells' };

  if (buf.length > MAX_TEXT_BYTES) return { kind: 'binary', buf, format: 'Large file' };
  const text = decodeText(buf);
  if (text === null) return { kind: 'binary', buf, format: 'Binary' };
  return { kind: 'text', lines: splitLines(text), format: 'Text' };
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline does not create an extra (empty) line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Decodes bytes as text, or returns null if the content looks binary. */
function decodeText(buf) {
  if (buf.length === 0) return '';
  // Byte order marks
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));

  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nul = 0;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      nul++;
      if (i % 2 === 0) evenNul++; else oddNul++;
    }
  }
  if (nul > 0) {
    // UTF-16 without BOM: NULs almost entirely on one side.
    const half = sample.length / 2;
    if (oddNul > half * 0.3 && evenNul < half * 0.02) return new TextDecoder('utf-16le').decode(buf);
    if (evenNul > half * 0.3 && oddNul < half * 0.02) return new TextDecoder('utf-16be').decode(buf);
    return null;
  }
  // Too many control characters means binary.
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  if (ctrl / sample.length > 0.1) return null;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---------- PDF ----------

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfLines(buf) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const lines = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      lines.push(`--- Page ${p} ---`);
      let current = '';
      let lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && current !== '') {
          lines.push(current.trimEnd());
          current = '';
        }
        current += item.str;
        if (item.hasEOL) {
          lines.push(current.trimEnd());
          current = '';
        }
        if (y !== null) lastY = y;
      }
      if (current.trim() !== '') lines.push(current.trimEnd());
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === ''));
}

// ---------- Word ----------

async function docxLines(buf) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  // mammoth separates paragraphs with a blank line; keep one line per paragraph.
  return splitLines(value.replace(/\n\n/g, '\n').replace(/\n+$/, ''));
}

// ---------- Excel ----------

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result); // formula: compare the value
    if ('formula' in v || 'sharedFormula' in v) return '';
    if ('text' in v) return cellText(v.text); // hyperlink
    if ('error' in v) return String(v.error);
    return JSON.stringify(v);
  }
  return String(v).replace(/\r?\n/g, ' ');
}

async function xlsxLines(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const lines = [];
  wb.eachSheet((sheet) => {
    lines.push(`--- Sheet: ${sheet.name} ---`);
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const vals = [];
      const count = row.cellCount;
      for (let c = 1; c <= count; c++) vals.push(cellText(row.getCell(c).value));
      while (vals.length && vals[vals.length - 1] === '') vals.pop();
      if (vals.length) lines.push(`Row ${rowNumber}: ${vals.join(' | ')}`);
    });
  });
  return lines;
}

module.exports = { extract, decodeText, splitLines };
