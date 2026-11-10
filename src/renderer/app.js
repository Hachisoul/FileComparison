'use strict';

const $ = (id) => document.getElementById(id);
const api = window.bulk;

const state = {
  left: null,
  right: null,
  results: [],
  filter: 'all',
  query: '',
  selected: null,
  view: 'changes', // 'changes' | 'full'
  rows: [],
  display: [],
  rendered: 0,
  totalBlocks: 0,
  blocks: [], // DOM elements that start each change block
  blockIdx: -1,
  running: false,
};

const FILTERS = [
  ['all', 'All', null],
  ['different', 'Different', 's-different'],
  ['identical', 'Identical', 's-identical'],
  ['only', 'Missing', 's-only'],
  ['skipped', 'Skipped', ''],
  ['error', 'Errors', 's-error'],
];

const STATUS_TEXT = {
  identical: 'Identical',
  different: 'Different',
  'only-left': 'Only in A',
  'only-right': 'Only in B',
  skipped: 'Skipped',
  error: 'Error',
};

const PAGE = 3000;

// ---------- helpers ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function matchesFilter(r) {
  switch (state.filter) {
    case 'all': return true;
    case 'only': return r.status === 'only-left' || r.status === 'only-right';
    default: return r.status === state.filter;
  }
}

function countFor(key) {
  if (key === 'all') return state.results.length;
  return state.results.filter((r) => (key === 'only' ? r.status.startsWith('only') : r.status === key)).length;
}

// ---------- sides (folder or files) ----------

const EMPTY_SIDE = 'Drop a folder or files here';

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function describeSide(src) {
  if (!src) return { text: EMPTY_SIDE, title: '' };
  if (src.kind === 'folder') return { text: src.path, title: src.path, rtl: true };
  if (src.paths.length === 1) return { text: src.paths[0], title: src.paths[0], rtl: true };
  const names = src.paths.map(baseName);
  return { text: `${names.length} files: ${names.join(', ')}`, title: src.paths.join('\n') };
}

function sameSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'folder') return a.path === b.path;
  return a.paths.length === b.paths.length && a.paths.every((p, i) => p === b.paths[i]);
}

function setSide(side, src) {
  state[side] = src || null;
  const box = side === 'left' ? $('folderA') : $('folderB');
  const label = side === 'left' ? $('pathA') : $('pathB');
  box.classList.toggle('set', !!src);
  const d = describeSide(src);
  // Paths are shown right-to-left so the end stays visible; isolate them so punctuation is not reordered.
  label.textContent = d.rtl ? `⁦${d.text}⁩` : d.text;
  label.style.direction = d.rtl ? 'rtl' : 'ltr';
  label.title = d.title;
  $('compare').disabled = !(state.left && state.right) || state.running;
}

async function pick(side, mode) {
  const src = await api.pick(side, mode);
  if (src) setSide(side, src);
}

function setupDrop(box, side) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  box.addEventListener('dragenter', (e) => { stop(e); box.classList.add('drop'); });
  box.addEventListener('dragover', (e) => { stop(e); box.classList.add('drop'); });
  box.addEventListener('dragleave', (e) => { stop(e); box.classList.remove('drop'); });
  box.addEventListener('drop', async (e) => {
    stop(e);
    box.classList.remove('drop');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const src = await api.sourceFromPaths(paths);
    if (src) setSide(side, src);
    else toast('Could not open what was dropped. Drop a folder or files.');
  });
}

// ---------- compare ----------

async function runCompare() {
  if (!state.left || !state.right || state.running) return;
  if (sameSource(state.left, state.right)) {
    toast('A and B are the same. Pick something different for one side.');
    return;
  }
  state.running = true;
  $('compare').disabled = true;
  $('export').disabled = true;
  $('compare').textContent = 'Comparing…';
  $('progress').hidden = false;
  $('progressFill').style.width = '0%';
  $('progressText').textContent = 'Scanning folders…';
  const opts = {
    recursive: $('optRecursive').checked,
    ignoreWhitespace: $('optWs').checked,
    ignoreCase: $('optCase').checked,
  };
  const prevName = state.selected != null ? state.results[state.selected]?.name : null;
  try {
    const results = await api.compare(state.left, state.right, opts);
    if (!results) return;
    state.results = results;
    $('export').disabled = results.length === 0;
    const diffCount = results.filter((r) => r.status === 'different').length;
    const missing = results.filter((r) => r.status.startsWith('only')).length;
    if (results.length === 0) toast('No files found in these folders.');
    else if (diffCount === 0 && missing === 0) toast(`All ${results.length} files match.`);
    renderFilters();
    renderList();
    const again = prevName && results.find((r) => r.name === prevName);
    const first = again || results.find((r) => r.status === 'different') || results[0];
    if (first) select(first.id);
    else showEmpty();
  } catch (err) {
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 6000);
  } finally {
    state.running = false;
    $('compare').textContent = 'Compare';
    $('compare').disabled = !(state.left && state.right);
    setTimeout(() => { $('progress').hidden = true; }, 600);
  }
}

api.onProgress(({ done, total }) => {
  $('progressFill').style.width = `${total ? (done / total) * 100 : 100}%`;
  $('progressText').textContent = `${done} / ${total} files`;
});

// ---------- sidebar ----------

function renderFilters() {
  const wrap = $('filters');
  wrap.replaceChildren();
  for (const [key, label, dotCls] of FILTERS) {
    const n = countFor(key);
    if (key !== 'all' && key !== 'different' && n === 0) continue;
    const chip = el('button', `chip${state.filter === key ? ' active' : ''}`);
    if (dotCls !== null) chip.append(el('span', `dot ${dotCls}`));
    chip.append(el('span', null, label), el('b', null, String(n)));
    chip.addEventListener('click', () => {
      state.filter = key;
      renderFilters();
      renderList();
    });
    wrap.append(chip);
  }
}

function visibleResults() {
  const q = state.query.trim().toLowerCase();
  return state.results.filter((r) => matchesFilter(r) && (!q || r.name.toLowerCase().includes(q)));
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  const items = visibleResults();
  if (!state.results.length) {
    list.append(el('li', 'list-empty', 'Results will appear here.'));
    return;
  }
  if (!items.length) {
    list.append(el('li', 'list-empty', 'No files match this filter.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of items) {
    const li = el('li', `item s-${r.status}${r.id === state.selected ? ' sel' : ''}`);
    li.dataset.id = r.id;
    li.setAttribute('role', 'option');
    li.append(el('span', 'dot'));
    const name = el('span', 'item-name', r.name);
    name.title = r.name;
    li.append(name);
    const counts = el('span', 'counts');
    if (r.stats && r.status === 'different') {
      if (r.stats.modified) counts.append(el('span', 'm', `±${r.stats.modified}`));
      if (r.stats.added) counts.append(el('span', 'a', `+${r.stats.added}`));
      if (r.stats.deleted) counts.append(el('span', 'd', `−${r.stats.deleted}`));
    }
    li.append(counts);
    li.append(el('span', 'item-msg', r.message));
    li.addEventListener('click', () => select(r.id));
    frag.append(li);
  }
  list.append(frag);
}

function moveSelection(delta) {
  const items = visibleResults();
  if (!items.length) return;
  let idx = items.findIndex((r) => r.id === state.selected);
  idx = idx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, idx + delta));
  select(items[idx].id);
}

// ---------- detail ----------

const CONTEXT = 3;
const FULL_LIMIT = 30000; // above this, "Full file" keeps long unchanged runs folded
const EXPAND_STEP = 2000;

function showEmpty() {
  $('empty').hidden = false;
  $('detailView').hidden = true;
}

function clearDetail(message) {
  state.rows = [];
  state.display = [];
  state.blocks = [];
  $('diff').replaceChildren(el('div', 'note', message));
  updateNav();
}

let detailToken = 0;
async function select(id) {
  state.selected = id;
  for (const li of $('list').children) li.classList.toggle('sel', Number(li.dataset.id) === id);
  const sel = $('list').querySelector('.item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });

  const r = state.results[id];
  $('empty').hidden = true;
  $('detailView').hidden = false;
  $('dName').textContent = r.name;
  const sub = $('dSub');
  sub.replaceChildren();
  const badge = el('span', `badge s-${r.status}`);
  badge.append(el('span', `dot s-${r.status.startsWith('only') ? 'only' : r.status}`), el('span', null, STATUS_TEXT[r.status]));
  sub.append(badge, el('span', null, r.message));
  if (r.format) sub.append(el('span', null, `· ${r.format}`));
  if (r.left && r.right) sub.append(el('span', null, `· ${fmtSize(r.left.size)} → ${fmtSize(r.right.size)}`));
  if (r.approximate) sub.append(el('span', null, '· very different files, lines compared in order'));

  setColPath($('dPathA'), r.left?.path);
  setColPath($('dPathB'), r.right?.path);

  const canDiff = r.left && r.right && !r.binary && (r.status === 'different' || r.status === 'identical');
  $('viewChanges').disabled = !canDiff;
  $('viewFull').disabled = !canDiff;
  if (!canDiff) return clearDetail(r.message);
  if (r.status === 'identical' && state.view === 'changes') {
    return clearDetail(`${r.message}. Switch to “Full file” to view the content.`);
  }

  clearDetail('Loading…');
  const token = ++detailToken;
  try {
    const det = await api.detail(id);
    if (token !== detailToken) return;
    state.rows = det?.rows || [];
    buildDisplay();
    renderDisplay(true);
  } catch (err) {
    if (token === detailToken) clearDetail(`Could not load: ${err.message}`);
  }
}

/** Builds the display list: row indices, plus { gap, from, to } for folded runs. */
function buildDisplay() {
  const rows = state.rows;
  const full = state.view === 'full';
  const context = full ? (rows.length > FULL_LIMIT ? 500 : -1) : CONTEXT;
  const out = [];
  if (context < 0) {
    for (let i = 0; i < rows.length; i++) out.push(i);
  } else {
    const keep = new Uint8Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].t !== 'eq') {
        const a = Math.max(0, i - context);
        const b = Math.min(rows.length - 1, i + context);
        for (let k = a; k <= b; k++) keep[k] = 1;
      }
    }
    let gapFrom = -1;
    for (let i = 0; i <= rows.length; i++) {
      if (i < rows.length && !keep[i]) {
        if (gapFrom < 0) gapFrom = i;
        continue;
      }
      if (gapFrom >= 0) {
        out.push({ gap: true, from: gapFrom, to: i });
        gapFrom = -1;
      }
      if (i < rows.length) out.push(i);
    }
  }
  state.display = out;
}

function setColPath(node, p) {
  node.textContent = p ? `⁦${p}⁩` : '— not present —';
  node.title = p ? `${p}\nClick to show in File Explorer` : '';
  node.onclick = p ? () => api.reveal(p) : null;
}

function appendCode(parent, segs, plain) {
  if (!segs) {
    parent.textContent = plain ?? '';
    return;
  }
  for (const [text, changed] of segs) {
    if (changed) parent.append(el('mark', null, text));
    else parent.append(document.createTextNode(text));
  }
}

function gapNode(item, pos) {
  const n = item.to - item.from;
  const g = el('div', 'gap', `⋯ ${n.toLocaleString()} unchanged line${n === 1 ? '' : 's'} hidden. Click to show${n > EXPAND_STEP ? ` ${EXPAND_STEP.toLocaleString()} more` : ''}.`);
  g.addEventListener('click', () => expandGap(pos));
  return g;
}

function expandGap(pos) {
  const item = state.display[pos];
  if (!item || !item.gap) return;
  const end = Math.min(item.to, item.from + EXPAND_STEP);
  const shown = [];
  for (let i = item.from; i < end; i++) shown.push(i);
  if (end < item.to) shown.push({ gap: true, from: end, to: item.to });
  state.display.splice(pos, 1, ...shown);
  const scroll = $('diff').scrollTop;
  renderDisplay(true, Math.max(state.rendered, pos + shown.length));
  $('diff').scrollTop = scroll;
}

/** Renders the display list. `upTo` forces rendering at least that many items. */
function renderDisplay(reset, upTo = 0) {
  const diff = $('diff');
  let table;
  if (reset) {
    state.rendered = 0;
    state.blocks = [];
    state.blockIdx = -1;
    if (!state.display.length) return clearDetail('Both files are empty.');
    table = el('div', 'diff-table');
    diff.replaceChildren(table);
  } else {
    table = diff.querySelector('.diff-table');
    table.querySelector('.more')?.remove();
  }
  const rows = state.rows;
  const frag = document.createDocumentFragment();
  const end = Math.min(state.display.length, Math.max(state.rendered + PAGE, upTo));
  for (let p = state.rendered; p < end; p++) {
    const item = state.display[p];
    if (typeof item !== 'number') {
      frag.append(gapNode(item, p));
      continue;
    }
    const row = rows[item];
    const wrap = el('div', `row ${row.t}`);
    const prev = state.display[p - 1];
    if (row.t !== 'eq' && (typeof prev !== 'number' || rows[prev].t === 'eq')) state.blocks.push(wrap);
    const cl = el('div', 'code l');
    const cr = el('div', 'code r');
    appendCode(cl, row.hl?.left, row.lt);
    appendCode(cr, row.hl?.right, row.rt);
    wrap.append(el('div', 'ln l', row.l ?? ''), cl, el('div', 'ln r', row.r ?? ''), cr);
    frag.append(wrap);
  }
  state.rendered = end;
  if (end < state.display.length) {
    const more = el('div', 'more');
    const btn = el('button', 'btn', 'Show more');
    btn.addEventListener('click', () => renderDisplay(false));
    more.append(btn);
    frag.append(more);
  }
  table.append(frag);
  state.totalBlocks = countBlocks();
  updateNav();
}

function countBlocks() {
  let n = 0;
  const rows = state.rows;
  for (let p = 0; p < state.display.length; p++) {
    const item = state.display[p];
    if (typeof item !== 'number' || rows[item].t === 'eq') continue;
    const prev = state.display[p - 1];
    if (typeof prev !== 'number' || rows[prev].t === 'eq') n++;
  }
  return n;
}

function updateNav() {
  const none = !state.totalBlocks || !state.blocks.length;
  $('prevChange').disabled = none;
  $('nextChange').disabled = none;
}

function jump(delta) {
  if (!state.blocks.length) return;
  let next = state.blockIdx + delta;
  // Render further if the next change has not been drawn yet.
  while (next >= state.blocks.length && state.rendered < state.display.length) renderDisplay(false);
  if (next >= state.blocks.length) next = 0;
  if (next < 0) next = state.blocks.length - 1;
  state.blocks[state.blockIdx]?.classList.remove('focus');
  state.blockIdx = next;
  const target = state.blocks[next];
  target.classList.add('focus');
  const diff = $('diff');
  diff.scrollTop = target.firstElementChild.offsetTop - diff.clientHeight / 3;
}

function setView(v) {
  state.view = v;
  $('viewChanges').classList.toggle('active', v === 'changes');
  $('viewFull').classList.toggle('active', v === 'full');
  if (state.selected != null) select(state.selected);
}

// ---------- export ----------

async function exportCsv() {
  if (!state.results.length) return;
  $('export').disabled = true;
  try {
    const res = await api.exportCsv();
    if (res?.ok) toast(`Saved ${res.path}`, 5000);
    else if (res?.message) toast(res.message);
  } catch (err) {
    toast(`Export failed: ${err.message}`, 6000);
  } finally {
    $('export').disabled = false;
  }
}

// ---------- wiring ----------

$('folderBtnA').addEventListener('click', () => pick('left', 'folder'));
$('filesBtnA').addEventListener('click', () => pick('left', 'files'));
$('folderBtnB').addEventListener('click', () => pick('right', 'folder'));
$('filesBtnB').addEventListener('click', () => pick('right', 'files'));
setupDrop($('folderA'), 'left');
setupDrop($('folderB'), 'right');
$('swap').addEventListener('click', () => {
  const { left, right } = state;
  setSide('left', right);
  setSide('right', left);
});
$('compare').addEventListener('click', runCompare);
$('export').addEventListener('click', exportCsv);
$('viewChanges').addEventListener('click', () => setView('changes'));
$('viewFull').addEventListener('click', () => setView('full'));
$('prevChange').addEventListener('click', () => jump(-1));
$('nextChange').addEventListener('click', () => jump(1));
$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderList();
});
for (const id of ['optWs', 'optCase', 'optRecursive']) {
  $(id).addEventListener('change', () => { if (state.results.length) runCompare(); });
}

// Stop the window from navigating when something is dropped outside the boxes.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT';
  if (e.key === 'Enter' && e.ctrlKey) { runCompare(); return; }
  if (typing) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'n' || e.key === 'N') jump(1);
  else if (e.key === 'p' || e.key === 'P') jump(-1);
});

api.onMenu((action) => {
  if (action === 'pick-left') pick('left', 'folder');
  else if (action === 'pick-right') pick('right', 'folder');
  else if (action === 'pick-left-files') pick('left', 'files');
  else if (action === 'pick-right-files') pick('right', 'files');
  else if (action === 'compare') runCompare();
  else if (action === 'export') exportCsv();
});

renderFilters();
renderList();

// Used by automated UI checks to preload folders.
window.__bulkcheckSetSides = (a, b) => { setSide('left', a); setSide('right', b); };
