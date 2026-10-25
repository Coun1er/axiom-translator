// Axiom Translator — standalone extension
// Translates only requested tweet bodies and account biographies on axiom.trade.
// Preserves HTML markup; links (<a>) are never translated.
(() => {
  'use strict';

  const LOG = '[AxiomTr]';

  // ── Translation core ───────────────────────────────────────────────────────

  const CACHE_MAX = 4000;      // axiom is an SPA: this Map lives for the whole
  const cache   = new Map();   // browser session, so it needs a ceiling
  const pending = new Map();   // requestId → resolve

  const BATCH_SEP = '\n\n';
  const REQ_TIMEOUT = 15000;   // must outlast the background retry ladder
  const MAX_REQS_PER_POPUP = 12;

  function genId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function hasCyrillic(t) {
    return /[а-яёА-ЯЁ]/.test(t);
  }

  function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }

  // A node's own text may contain blank lines (tweets often do). Left as-is it
  // would parse as extra batch separators and shift every later result by one —
  // silently writing wrong translations into the cache for the rest of the
  // session. Collapse them so BATCH_SEP only ever separates nodes.
  function normalize(text) {
    return text.trim().replace(/\n\s*\n+/g, '\n');
  }

  // Resolves { ok, translated } — never a bare string, because "" from a failed
  // request and "" from untranslatable text must not look the same.
  function fetchTranslation(text) {
    const id = genId();
    return new Promise(resolve => {
      pending.set(id, resolve);

      try {
        chrome.runtime.sendMessage({
          type: 'TRANSLATE_REQ',
          payload: { requestId: id, text, targetLang: 'ru' },
        });
      } catch (e) {
        // Extension was reloaded/updated — this context is dead until the page
        // reloads. Fail loudly instead of hanging the popup on "...".
        pending.delete(id);
        console.warn(LOG, 'context invalidated, reload the page:', e.message);
        resolve({ ok: false, error: 'context invalidated' });
        return;
      }

      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        console.warn(LOG, 'translation request timed out');
        resolve({ ok: false, error: 'timeout' });
      }, REQ_TIMEOUT);
    });
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || msg.type !== 'TRANSLATE_RES') return;
    const { requestId, ok, translated, error } = msg.payload || {};
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    if (!ok) console.warn(LOG, 'translation failed:', error);
    resolve({ ok: !!ok, translated: translated || '', error });
  });

  // Translate `items` ([{ idx, key }]) into `out`, keyed by item.idx.
  // Returns false if the request failed (as opposed to translating to nothing).
  // `budget` caps the recursive splitting below so a systematically misaligning
  // popup can't fan out into dozens of requests and trip the endpoint's 429.
  async function translateChunk(items, out, budget) {
    if (budget.left <= 0) {
      console.warn(LOG, 'request budget exhausted');
      return false;
    }
    budget.left--;

    const joined = items.map(t => t.key).join(BATCH_SEP);
    const res    = await fetchTranslation(joined);
    if (!res.ok) return false;

    const parts = res.translated.split(BATCH_SEP);

    // A single item can't misalign — blank lines inside it are its own content.
    if (items.length === 1) {
      const part = res.translated.trim();
      if (part) { cacheSet(items[0].key, part); out[items[0].idx] = part; }
      return true;
    }

    // Google dropped or invented a separator. Assigning by position now would
    // cache every later item under the wrong key, permanently. Split and retry
    // instead — this isolates the offending item in O(log n) requests.
    if (parts.length !== items.length) {
      console.warn(LOG, `batch misaligned (${items.length} sent, ${parts.length} back), splitting`);
      const mid = Math.ceil(items.length / 2);
      const a = await translateChunk(items.slice(0, mid), out, budget);
      const b = await translateChunk(items.slice(mid), out, budget);
      return a && b;
    }

    items.forEach(({ idx, key }, j) => {
      const part = (parts[j] || '').trim();
      if (part) { cacheSet(key, part); out[idx] = part; }
    });
    return true;
  }

  // Translate all texts in one request; returns { ok, results } (same length).
  async function translateBatch(texts) {
    const results = new Array(texts.length).fill('');
    const toFetch = [];

    for (let i = 0; i < texts.length; i++) {
      const key = normalize(texts[i]);
      if (!key || key.length < 2 || hasCyrillic(key)) continue;
      if (cache.has(key)) { results[i] = cache.get(key); continue; }
      toFetch.push({ idx: i, key });
    }

    if (!toFetch.length) return { ok: true, results };

    const ok = await translateChunk(toFetch, results, { left: MAX_REQS_PER_POPUP });
    return { ok, results };
  }

  // ── Text-node helpers ──────────────────────────────────────────────────────

  // Collect non-empty text nodes under `root` that are NOT inside <a> tags.
  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        // Skip link text — links stay original
        let el = node.parentElement;
        while (el && el !== root) {
          if (el.tagName === 'A') return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Snapshot current values of text nodes.
  function snapshot(nodes) {
    return nodes.map(n => ({ node: n, original: n.nodeValue }));
  }

  // Translate all snapped nodes in one batch request.
  // Returns { ok, results: [{node, original, translated, changed}] }.
  async function translateSnaps(snaps) {
    const texts = snaps.map(({ original }) => original.trim());
    const { ok, results: translated } = await translateBatch(texts);

    const results = snaps.map(({ node, original }, i) => {
      const result = translated[i];
      if (!result || result === original.trim()) {
        return { node, original, translated: original, changed: false };
      }
      const lead  = original.match(/^\s*/)[0];
      const trail = original.match(/\s*$/)[0];
      return { node, original, translated: lead + result + trail, changed: true };
    });

    return { ok, results };
  }

  function applyTranslation(results) {
    for (const r of results) r.node.nodeValue = r.translated;
  }

  function applyOriginal(results) {
    for (const r of results) r.node.nodeValue = r.original;
  }

  // ── Popup detection ────────────────────────────────────────────────────────

  function isPopup(el) {
    if (!(el instanceof Element) || el.tagName !== 'DIV') return false;
    const c = el.className || '';
    return c.includes('pointer-events-auto') && c.includes('fixed');
  }

  let hoverIntent = null;
  const handledPopups = new WeakSet();
  document.addEventListener('mouseover', event => {
    if (!(event.target instanceof Element)) return;
    const icon = event.target.closest('i.ri-quill-pen-line, i.ri-user-line');
    hoverIntent = icon ? { icon, kind: icon.matches('i.ri-user-line') ? 'account' : 'tweet' } : null;
  }, true);
  document.addEventListener('mouseout', event => {
    if (hoverIntent && hoverIntent.icon.contains(event.target) &&
        !(event.relatedTarget instanceof Node && hoverIntent.icon.contains(event.relatedTarget))) {
      hoverIntent = null;
    }
  }, true);

  // ── Sticky viewport toggle button ──────────────────────────────────────────
  // Appears in the bottom-right corner whenever a translated popup is visible.
  // Stays fixed during any scrolling of the page or the popup.

  let stickyBtn   = null;
  let activeState = null;  // { groups, isTranslated, syncLabel? }

  function ensureSticky() {
    if (stickyBtn) return;
    stickyBtn = document.createElement('button');
    stickyBtn.id = 'axiom-tr-sticky';
    Object.assign(stickyBtn.style, {
      position:       'fixed',
      bottom:         '22px',
      right:          '22px',
      zIndex:         '2147483647',
      display:        'none',
      alignItems:     'center',
      gap:            '6px',
      padding:        '8px 18px',
      borderRadius:   '9999px',
      border:         '1px solid rgba(108,201,251,0.6)',
      background:     'rgba(12,20,34,0.97)',
      color:          '#6CC9FB',
      fontSize:       '13px',
      fontWeight:     '600',
      cursor:         'pointer',
      fontFamily:     'inherit',
      backdropFilter: 'blur(10px)',
      boxShadow:      '0 2px 20px rgba(0,0,0,0.55)',
      transition:     'opacity 120ms,transform 120ms',
      whiteSpace:     'nowrap',
      lineHeight:     '1',
    });
    stickyBtn.addEventListener('mouseenter', () => { stickyBtn.style.opacity = '0.85'; });
    stickyBtn.addEventListener('mouseleave', () => { stickyBtn.style.opacity = '1'; });
    stickyBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!activeState) return;
      activeState.isTranslated = !activeState.isTranslated;
      for (const grp of activeState.groups) {
        activeState.isTranslated ? applyTranslation(grp) : applyOriginal(grp);
      }
      refreshStickyLabel();
      // Keep the in-popup toggle in sync (it owns its own markup, so it
      // repaints itself rather than having its text overwritten from here).
      activeState.syncLabel?.();
    });
    document.body.appendChild(stickyBtn);
  }

  function showSticky(state) {
    ensureSticky();
    activeState = state;
    stickyBtn.style.display = 'flex';
    refreshStickyLabel();
  }

  function hideSticky() {
    if (stickyBtn) stickyBtn.style.display = 'none';
    activeState = null;
  }

  function refreshStickyLabel() {
    if (!stickyBtn || !activeState) return;
    stickyBtn.textContent = activeState.isTranslated ? '🔤 Оригинал' : '🌐 Перевести';
  }

  // ── In-popup toggle button ─────────────────────────────────────────────────

  const IDLE_COLOR   = '#8B98A6';
  const ACTIVE_COLOR = '#6CC9FB';
  const IDLE_BORDER  = 'rgba(139,152,166,0.35)';
  const ACTIVE_BORDER = 'rgba(108,201,251,0.45)';

  // Created up-front showing "..." so the popup acknowledges the work in flight.
  function createToggleButton(className) {
    const btn = document.createElement('button');
    btn.className = className;
    Object.assign(btn.style, {
      position:       'absolute',
      top:            '10px',
      right:          '12px',
      zIndex:         '20',
      display:        'flex',
      alignItems:     'center',
      gap:            '4px',
      background:     'rgba(12,20,34,0.75)',
      border:         '1px solid ' + IDLE_BORDER,
      borderRadius:   '9999px',
      padding:        '3px 10px 3px 8px',
      color:          IDLE_COLOR,
      cursor:         'default',
      fontFamily:     'inherit',
      backdropFilter: 'blur(6px)',
      transition:     'color 120ms, border-color 120ms',
      lineHeight:     '1',
    });
    btn.innerHTML =
      '<span style="font-size:13px;line-height:1">🌐</span>' +
      '<span style="font-size:12px;font-weight:500">...</span>';
    return btn;
  }

  function setButtonFace(btn, icon, text, active) {
    btn.firstElementChild.textContent = icon;
    btn.lastElementChild.textContent  = text;
    btn.style.color       = active ? ACTIVE_COLOR : IDLE_COLOR;
    btn.style.borderColor = active ? ACTIVE_BORDER : IDLE_BORDER;
  }

  // The popup is live and the text is on screen — a failed request must stay
  // visible and retryable, not vanish and leave the user with untranslated text
  // and no control.
  function showRetry(btn, retry) {
    setButtonFace(btn, '⚠️', 'Повторить', false);
    btn.style.cursor = 'pointer';
    btn.onclick = e => {
      e.stopPropagation();
      e.preventDefault();
      btn.onclick = null;
      setButtonFace(btn, '🌐', '...', false);
      btn.style.cursor = 'default';
      retry();
    };
  }

  // Wire a finished translation onto the button + sticky toggle.
  function activate(btn, results) {
    applyTranslation(results);
    const state = { groups: [results], isTranslated: true, popup: btn.parentElement };

    const paint = () => setButtonFace(
      btn, '🌐', state.isTranslated ? 'Оригинал' : 'Перевести', state.isTranslated);

    state.syncLabel = paint;
    paint();
    btn.style.cursor = 'pointer';

    btn.addEventListener('mouseenter', () => {
      btn.style.color       = '#e2e8f0';
      btn.style.borderColor = 'rgba(108,201,251,0.65)';
    });
    btn.addEventListener('mouseleave', paint);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      state.isTranslated = !state.isTranslated;
      for (const grp of state.groups) {
        state.isTranslated ? applyTranslation(grp) : applyOriginal(grp);
      }
      paint();
      refreshStickyLabel();
    });

    showSticky(state);
  }

  // Shared flow for every popup kind: translate the snapshot, then either
  // activate the toggle, offer a retry, or drop the button if there was
  // genuinely nothing to translate.
  async function runTranslation(popup, btn, snaps) {
    const { ok, results } = await translateSnaps(snaps);
    if (!document.contains(popup)) return;

    if (!ok) {
      showRetry(btn, () => runTranslation(popup, btn, snaps));
      return;
    }
    if (!results.some(r => r.changed)) {
      btn.remove();
      return;
    }
    activate(btn, results);
  }

  // ── Tweet popup ────────────────────────────────────────────────────────────
  // Auto-translates on appear (like community/account).
  // Selects main and quoted tweet bodies, leaving metadata untouched.

  async function setupTweetPopup(popup) {
    const box = popup.querySelector('[class*="gap-[6px]"]');
    if (!box) return;
    if (popup.querySelector('.axiom-tr-btn')) return;

    // Find tweet text — axiom uses different font sizes depending on tweet length
    // (short tweets → 22px/20px, long tweets → 18px/16px).
    const mainEl =
      box.querySelector('[class*="text-[22px]"]') ||
      box.querySelector('[class*="text-[20px]"]') ||
      box.querySelector('[class*="text-[18px]"]') ||
      box.querySelector('[class*="text-[16px]"]') ||
      box.querySelector('[class*="text-wrap"]');
    if (!mainEl) return;

    const mainText = mainEl.textContent.trim();
    if (!mainText || mainText.length < 2) return;
    // Skip if the tweet is already in Russian.
    if (hasCyrillic(mainText)) return;

    const btn = createToggleButton('axiom-tr-btn');
    // Append before translating — snapshot is taken from text nodes that exist now.
    popup.appendChild(btn);

    const bodies = [mainEl, ...popup.querySelectorAll(
      '[data-testid="tweetText"], span.text-wrap.break-words, p.text-wrap.break-words'
    )].filter(el => !el.closest('a, button'));
    const snaps = snapshot([...new Set(bodies.flatMap(getTextNodes))]);

    await runTranslation(popup, btn, snaps);
  }

  // ── Community / Account popup ──────────────────────────────────────────────
  // Auto-translates on appear; adds a sticky in-popup toggle above "View" button.

  async function setupDescPopup(popup) {
    if (popup.querySelector('.axiom-tr-toggle')) return;

    // Only a biography paragraph is eligible; never translate the whole card.
    const descEl = popup.querySelector('p.break-words');
    if (!descEl) return;
    const root = descEl;

    const text = root.textContent.trim();
    if (!text || text.length < 4) return;
    // For targeted bio elements, skip if already Russian.
    // For whole-popup fallback, let translateBatch filter per-node.
    if (descEl && hasCyrillic(text)) return;

    const toggleBtn = createToggleButton('axiom-tr-toggle');
    popup.appendChild(toggleBtn);

    const snaps = snapshot(getTextNodes(root).filter(n => !toggleBtn.contains(n)));

    await runTranslation(popup, toggleBtn, snaps);
  }

  // ── Main popup handler ─────────────────────────────────────────────────────

  // Wait until the popup has loaded its real content (not loading skeleton).
  // Strategy:
  //  1. Resolve immediately if specific content markers are already present.
  //  2. Watch for those markers to appear (API response rendered).
  //  3. Allow a slow first-hover response up to the request timeout.
  function waitForPopupContent(popup, kind) {
    return new Promise(resolve => {
      function hasRealContent() {
        if (kind === 'tweet') {
          return !!popup.querySelector('[class*="gap-[6px]"] span.text-wrap.break-words');
        }
        const desc = popup.querySelector('p.break-words');
        if (desc && desc.textContent.trim().length > 4) return true;
        return false;
      }

      if (hasRealContent()) { resolve(); return; }

      const safetyT = setTimeout(() => {
        obs.disconnect(); resolve();
      }, REQ_TIMEOUT);

      function done() {
        obs.disconnect(); clearTimeout(safetyT); resolve();
      }

      const obs = new MutationObserver(() => {
        if (hasRealContent()) { done(); return; }
      });
      obs.observe(popup, { childList: true, subtree: true, characterData: true });
    });
  }

  async function onPopupAdded(popup) {
    if (!hoverIntent?.icon.isConnected || handledPopups.has(popup)) return;
    const kind = hoverIntent.kind;
    handledPopups.add(popup);
    await waitForPopupContent(popup, kind);
    if (!document.contains(popup)) return;

    if (kind === 'tweet') await setupTweetPopup(popup);
    else                  await setupDescPopup(popup);
  }

  function onPopupRemoved(popup) {
    handledPopups.delete(popup);
    if (activeState?.popup !== popup) return;
    // Restore originals in the (now detached) nodes so the next hover is clean.
    if (activeState) {
      for (const grp of activeState.groups) {
        try { applyOriginal(grp); } catch {}
      }
    }
    hideSticky();
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  ensureSticky();

  new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (isPopup(node)) onPopupAdded(node);
        for (const popup of node.querySelectorAll('div.fixed.pointer-events-auto')) onPopupAdded(popup);
      }
      for (const node of mut.removedNodes) { if (isPopup(node)) onPopupRemoved(node); }
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
