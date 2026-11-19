'use strict';

/*
 * Find in page (Ctrl+F).
 *
 * Searches the text that is shown in the window, highlights every match with the
 * CSS Custom Highlight API (the page itself is not changed), and lets you step
 * through them with Enter / Shift+Enter, F3 / Shift+F3 or the arrow buttons.
 * The page is searched again whenever its content changes while the bar is open.
 */
window.FindBar = (() => {
  const MAX_MATCHES = 10000;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'NOSCRIPT']);

  const bar = document.getElementById('findBar');
  const input = document.getElementById('findInput');
  const countEl = document.getElementById('findCount');
  const extraEl = document.getElementById('findExtra');
  const caseBtn = document.getElementById('findCase');
  const prevBtn = document.getElementById('findPrev');
  const nextBtn = document.getElementById('findNext');
  const closeBtn = document.getElementById('findClose');

  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  let matches = []; // Range[]
  let current = -1;
  let matchCase = false;
  let truncated = false;
  let hiddenCounter = null; // (regex) => number of matches in lines that are not on screen
  let observer = null;
  let refreshTimer = null;
  let restoreFocus = null;
  let hiddenCount = 0;

  function isOpen() {
    return !bar.hidden;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildRegex() {
    const q = input.value;
    if (!q) return null;
    return new RegExp(escapeRegex(q), matchCase ? 'g' : 'gi');
  }

  /** Closest ancestor that is not displayed inline: text inside it reads as one run. */
  function blockOf(node, cache) {
    let e = node.parentElement;
    while (e && e !== document.body) {
      let d = cache.get(e);
      if (d === undefined) {
        d = getComputedStyle(e).display;
        cache.set(e, d);
      }
      if (!d.startsWith('inline') || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid') return e;
      e = e.parentElement;
    }
    return document.body;
  }

  function visible(elem, cache) {
    let v = cache.get(elem);
    if (v === undefined) {
      v = elem.checkVisibility ? elem.checkVisibility({ visibilityProperty: true }) : !!elem.getClientRects().length;
      cache.set(elem, v);
    }
    return v;
  }

  /** Visible text nodes in page order, grouped into runs that belong to the same block. */
  function collectRuns() {
    const runs = [];
    const visCache = new Map();
    const dispCache = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n === bar || SKIP_TAGS.has(n.tagName) || n.hidden) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        if (!n.nodeValue) return NodeFilter.FILTER_SKIP;
        return visible(n.parentElement, visCache) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let run = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = blockOf(n, dispCache);
      if (!run || run.block !== block) {
        run = { block, nodes: [], starts: [], text: '' };
        runs.push(run);
      }
      run.starts.push(run.text.length);
      run.nodes.push(n);
      run.text += n.nodeValue;
    }
    return runs;
  }

  /** Maps an offset in a run's text to a [node, offset] position. */
  function position(run, offset, isEnd) {
    let lo = 0;
    let hi = run.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const s = run.starts[mid];
      if (s < offset || (!isEnd && s === offset)) lo = mid;
      else hi = mid - 1;
    }
    return [run.nodes[lo], offset - run.starts[lo]];
  }

  function paint() {
    if (!supported) return;
    if (!matches.length) {
      CSS.highlights.delete('find-match');
      CSS.highlights.delete('find-current');
      return;
    }
    CSS.highlights.set('find-match', new Highlight(...matches));
    if (current >= 0) CSS.highlights.set('find-current', new Highlight(matches[current]));
    else CSS.highlights.delete('find-current');
  }

  function updateCount() {
    const hidden = hiddenCount;
    const q = input.value;
    bar.classList.toggle('none', !!q && !matches.length);
    if (!q) countEl.textContent = '';
    else if (!matches.length) countEl.textContent = 'No matches';
    else countEl.textContent = `${current + 1} of ${matches.length.toLocaleString()}${truncated ? '+' : ''}`;
    if (hidden > 0) {
      extraEl.hidden = false;
      extraEl.textContent = `+${hidden.toLocaleString()} in hidden lines`;
    } else {
      extraEl.hidden = true;
    }
    prevBtn.disabled = matches.length === 0;
    nextBtn.disabled = matches.length === 0;
  }

  function scrollToCurrent() {
    const r = matches[current];
    if (!r) return;
    const target = r.startContainer.parentElement;
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Keep the match away from the very edge of its scroll area, like a browser does.
    const rect = r.getBoundingClientRect();
    let sc = target.parentElement;
    while (sc && sc !== document.body) {
      const st = getComputedStyle(sc);
      if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight) break;
      sc = sc.parentElement;
    }
    if (sc && sc !== document.body) {
      const box = sc.getBoundingClientRect();
      if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
        sc.scrollTop += rect.top - box.top - sc.clientHeight / 3;
      }
    }
  }

  /** Searches the page. `keep` tries to stay on the match the user was looking at. */
  function search({ keep = false, scroll = true } = {}) {
    const re = buildRegex();
    const prevRange = keep ? matches[current] : null;
    matches = [];
    truncated = false;
    current = -1;
    if (re) {
      outer: for (const run of collectRuns()) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(run.text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          if (matches.length >= MAX_MATCHES) { truncated = true; break outer; }
          const range = document.createRange();
          const [sn, so] = position(run, m.index, false);
          const [en, eo] = position(run, m.index + m[0].length, true);
          range.setStart(sn, so);
          range.setEnd(en, eo);
          matches.push(range);
        }
      }
    }
    if (matches.length) {
      current = 0;
      if (prevRange) {
        // Stay on the same match, or the first one after it.
        const idx = matches.findIndex((r) => {
          try {
            return r.compareBoundaryPoints(Range.START_TO_START, prevRange) >= 0;
          } catch {
            return false;
          }
        });
        current = idx >= 0 ? idx : 0;
      } else {
        // Start from the first match that is on screen, like a browser does.
        const idx = matches.findIndex((r) => {
          const rect = r.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        });
        if (idx >= 0) current = idx;
      }
    }
    hiddenCount = 0;
    if (re && hiddenCounter) {
      try { hiddenCount = hiddenCounter(new RegExp(re.source, re.flags)); } catch { hiddenCount = 0; }
    }
    paint();
    updateCount();
    if (scroll && current >= 0) scrollToCurrent();
  }

  function step(delta) {
    if (!isOpen()) {
      open();
      return;
    }
    if (!matches.length) return;
    current = (current + delta + matches.length) % matches.length;
    paint();
    updateCount();
    scrollToCurrent();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => search({ keep: true, scroll: false }), 150);
  }

  function open() {
    const wasOpen = isOpen();
    if (!wasOpen) {
      restoreFocus = document.activeElement;
      bar.hidden = false;
      // Search with the selected text, if there is a short single-line selection.
      const sel = String(window.getSelection() || '');
      if (sel && sel.length <= 200 && !/[\r\n]/.test(sel)) input.value = sel;
      observer = new MutationObserver((records) => {
        if (records.some((r) => !bar.contains(r.target))) scheduleRefresh();
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      search();
    }
    input.focus();
    input.select();
  }

  function close() {
    if (!isOpen()) return;
    bar.hidden = true;
    observer?.disconnect();
    observer = null;
    clearTimeout(refreshTimer);
    const keepRange = matches[current];
    matches = [];
    current = -1;
    paint();
    // Leave the last match selected so it can be copied, unless focus goes back to a text box.
    const back = restoreFocus;
    restoreFocus = null;
    if (back && back !== document.body && document.contains(back) && typeof back.focus === 'function') back.focus();
    else if (keepRange) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(keepRange);
    }
  }

  input.addEventListener('input', () => search());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    // Keep the page's own shortcuts (N, P, arrow keys) out of the find box.
    e.stopPropagation();
  });
  caseBtn.addEventListener('click', () => {
    matchCase = !matchCase;
    caseBtn.classList.toggle('active', matchCase);
    caseBtn.setAttribute('aria-pressed', String(matchCase));
    search();
    input.focus();
  });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    // The Edit menu shows these shortcuts but leaves the keys to the page (see main.js).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      open();
    } else if (e.key === 'F3') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  }, true);

  return {
    open,
    close,
    isOpen,
    next: () => step(1),
    prev: () => step(-1),
    refresh: () => isOpen() && scheduleRefresh(),
    setHiddenCounter: (fn) => { hiddenCounter = fn; },
    get count() { return matches.length; },
    get current() { return current; },
  };
})();
