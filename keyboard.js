// Keyboard navigation, the Ctrl+K command palette, and the "?" shortcuts overlay.
// One document-level dispatcher; grid arrow-nav over the focusable item classes; Esc follows a single
// precedence chain (modal → settings → detail/live-picker → player) shared with exitPlayer, which is
// also reachable from the main process while the guest webview owns the keyboard.

const NAV_SEL = '.card, .tile, .episode, .match-card, .src-row, .cast';

// True while a form control owns the keyboard — native select arrows / text entry / wizard Enter win.
const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

// ---------- modals (palette / help / wizard) ----------

let paletteEl = null, helpEl = null, whatsNewEl = null;

const modalOpen = () => !!paletteEl || !!helpEl || !!whatsNewEl || !$('wizard').hidden || !!lightboxEl;
function closeTopModal() {
  if (lightboxEl) { closeLightbox(); return true; } // topmost — a photo lightbox over the detail page
  if (paletteEl) { closePalette(); return true; }
  if (helpEl) { closeHelp(); return true; }
  if (whatsNewEl) { closeWhatsNew(); return true; }
  if (!$('wizard').hidden) { $('wizard').hidden = true; $('wizard').replaceChildren(); return true; } // wizard close() is a private closure
  return false;
}

// ---------- command palette ----------

// Curated actions, rebuilt on open (Resume only shows once something is resumable).
function paletteActions() {
  const acts = [
    ['Open Dashboard', showDashboard],
    ['Search', focusBrowseSearch],
    ['Browse Movies', () => { browseQuery = ''; browseTab = 'movie'; showBrowse(); }],
    ['Browse TV', () => { browseQuery = ''; browseTab = 'tv'; showBrowse(); }],
    ['Browse Anime', () => { browseQuery = ''; browseTab = 'anime'; showBrowse(); }],
    ['Open Live TV', () => { browseTab = 'live'; showBrowse(); }],
    ['Open YouTube', () => open('https://www.youtube.com', false)], // untracked: never clobbers ⏯ Resume
    ['Open Library', showHome],
    ['Open Settings', showSettings],
  ];
  if (lastPlayed && lastPlayed.url) acts.push(['Resume watching', resumeLast]);
  acts.push(
    ['Add player / source', () => openAddWizard()],
    ['Refresh live catalogs', () => { liveCatalogCache.clear(); resolvedCache.clear(); browseTab = 'live'; showBrowse(); }],
  );
  return acts;
}

function openPalette() {
  if (paletteEl) return;
  closeTopModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay palette';
  const cardEl = mk('div', 'palette-card');
  const input = document.createElement('input');
  input.className = 'palette-input';
  input.placeholder = 'Type a command…';
  const list = mk('div', 'palette-list');
  cardEl.append(input, list);
  overlay.append(cardEl);
  overlay.onclick = (e) => { if (e.target === overlay) closePalette(); };

  let idx = 0, shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = paletteActions().filter(([label]) => label.toLowerCase().includes(q));
    if (idx >= shown.length) idx = Math.max(0, shown.length - 1);
    list.replaceChildren(...shown.map(([label], i) => {
      const row = mk('div', 'palette-row' + (i === idx ? ' on' : ''), label);
      row.onclick = () => run(i);
      return row;
    }));
  };
  const run = (i) => { const a = shown[i]; closePalette(); if (a) a[1](); };
  input.oninput = () => { idx = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') run(idx);
    else if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
  };

  document.body.append(overlay);
  paletteEl = overlay;
  draw();
  input.focus();
}
function closePalette() { if (paletteEl) { paletteEl.remove(); paletteEl = null; } }

// ---------- "?" shortcuts overlay ----------

const SHORTCUTS = [
  ['0', 'Open the dashboard'],
  ['1 / 2 / 3', 'Browse Movies / TV / Anime'],
  ['4', 'Open Live TV'],
  ['5', 'Open YouTube'],
  ['← ↑ → ↓', 'Move around a grid'],
  ['Enter', 'Open the focused item'],
  ['/', 'Search Movies / TV / Anime'],
  ['Ctrl+K', 'Command palette (works while watching too)'],
  ['Esc', 'Close / back / exit the player'],
  ['?', 'This overlay'],
];

// Controller/D-pad map (input.js polls the Gamepad API) — standard Xbox button layout.
const PAD_HELP = [
  ['D-pad / stick', 'Move around'],
  ['A', 'Open the focused item'],
  ['B', 'Back'],
  ['X', 'Search'],
  ['Y', 'Preview the focused title'],
  ['LB / RB', 'Page a rail sideways'],
  ['Start', 'Command palette'],
];

function openHelp() {
  if (helpEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay palette';
  const cardEl = mk('div', 'palette-card help-card');
  cardEl.append(mk('h3', null, 'Keyboard shortcuts'));
  for (const [key, what] of SHORTCUTS) {
    const row = mk('div', 'help-row');
    row.append(mk('span', 'help-key', key), mk('span', null, what));
    cardEl.append(row);
  }
  cardEl.append(mk('h3', null, 'Controller'));
  for (const [key, what] of PAD_HELP) {
    const row = mk('div', 'help-row');
    row.append(mk('span', 'help-key', key), mk('span', null, what));
    cardEl.append(row);
  }
  overlay.append(cardEl);
  overlay.onclick = (e) => { if (e.target === overlay) closeHelp(); };
  document.body.append(overlay);
  helpEl = overlay;
}
function closeHelp() { if (helpEl) { helpEl.remove(); helpEl = null; } }

// ---------- "What's New" modal (post-update, once per version) ----------

// One changelog line -> DOM: "- " lines become bullet rows; inline **x** becomes <strong>.
// textContent only — the notes come from a fetched release body, never trust it into innerHTML.
function notesLine(text) {
  const bullet = text.startsWith('- ');
  const line = mk('div', bullet ? 'wn-bullet' : 'wn-text');
  (bullet ? text.slice(2) : text).split('**')
    .forEach((p, i) => line.append(i % 2 ? mk('strong', null, p) : document.createTextNode(p)));
  return line;
}

// notes = the markdown release body (or null -> a short fallback + link). Shown by the app.js
// bootstrap when the stored lastSeenVersion differs from the running version.
function openWhatsNew(version, notes) {
  if (whatsNewEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay palette';
  const cardEl = mk('div', 'palette-card help-card whats-new');
  cardEl.append(mk('h3', null, `What's new in v${version}`));
  if (notes) {
    // drop headings/rules; re-join a wrapped bullet's indented continuation lines
    const lines = [];
    for (const raw of notes.split('\n')) {
      const t = raw.trim();
      if (!t || t.startsWith('#') || t === '---') continue;
      if (/^\s+\S/.test(raw) && lines.length) lines[lines.length - 1] += ' ' + t;
      else lines.push(t);
    }
    cardEl.append(...lines.map(notesLine));
  } else {
    cardEl.append(mk('div', 'wn-text', `Updated to v${version}.`));
    const a = mk('a', 'about-link', 'Read the full release notes on GitHub');
    a.href = `https://github.com/jbi2109/stream-hub/releases/tag/v${version}`;
    a.target = '_blank';
    cardEl.append(a);
  }
  const okBtn = mk('button', 'set-btn wn-ok', 'Got it');
  okBtn.onclick = () => closeWhatsNew();
  cardEl.append(okBtn);
  overlay.append(cardEl);
  overlay.onclick = (e) => { if (e.target === overlay) closeWhatsNew(); };
  document.body.append(overlay);
  whatsNewEl = overlay;
}
function closeWhatsNew() { if (whatsNewEl) { whatsNewEl.remove(); whatsNewEl = null; } }

// ---------- grid navigation ----------

function moveGrid(key) {
  const active = document.activeElement;
  const onItem = active && active.matches && active.matches(NAV_SEL);
  if (!onItem) {
    // seed: focus the first item in the visible view
    const view = ['dashboard', 'browse', 'detail', 'person', 'home', 'settings'].map((id) => $(id)).find((el) => el && !el.hidden);
    const first = view && view.querySelector(NAV_SEL);
    if (!first) return false;
    first.focus();
    first.scrollIntoView({ block: 'nearest' });
    return true;
  }
  const container = active.closest('.grid, .episodes, .src-list, .rail') || active.parentElement;
  const items = [...container.querySelectorAll(NAV_SEL)];
  const i = items.indexOf(active);
  if (container.classList.contains('rail')) {
    // dashboard rails are flex rows, not grids: ←/→ walk the rail, ↑/↓ hop to the neighbouring rail
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const next = Math.max(0, Math.min(items.length - 1, i + (key === 'ArrowRight' ? 1 : -1)));
      if (next !== i) { items[next].focus(); items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    } else {
      // hop to the nearest rail in that direction that already has a focusable item — lazy rails below
      // the fold are skeleton-only (no NAV_SEL child) until scrolled into view, so skip over them.
      const rails = [...$('dashboard').querySelectorAll('.rail')];
      const step = (key === 'ArrowDown') ? 1 : -1;
      for (let ti = rails.indexOf(container) + step; ti >= 0 && ti < rails.length; ti += step) {
        const firstItem = rails[ti].querySelector(NAV_SEL);
        if (firstItem) { firstItem.focus(); firstItem.scrollIntoView({ block: 'nearest', inline: 'nearest' }); break; }
      }
    }
    return true;
  }
  const style = getComputedStyle(container);
  // one px token per track in the used value; non-grid containers (src-list) navigate as a column
  const cols = style.display === 'grid' ? style.gridTemplateColumns.split(' ').length : 1;
  const delta = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? cols : -cols;
  const next = Math.max(0, Math.min(items.length - 1, i + delta)); // clamp — auto-fill counts empty tracks
  if (next !== i) { items[next].focus(); items[next].scrollIntoView({ block: 'nearest' }); }
  return true;
}

// ---------- Esc model ----------

function goBack() {
  if (closeTopModal()) return;
  if (!$('person').hidden) { detailOrigin ? showDetail(detailOrigin.kind, detailOrigin.id) : showBrowse(); return; }
  if (!$('settings').hidden) { showBrowse(); return; }
  if (!$('detail').hidden) {
    // #detail doubles as the live source page — go back to the Live grid there (its Back button's path);
    // the stream stays loaded, ⏯ Resume returns to it.
    if (currentLiveMatch) { browseTab = 'live'; showBrowse(); } else showBrowse();
    return;
  }
  if (!webview.hidden) exitPlayer();
}

// Exit the player back to WHERE IT WAS LAUNCHED FROM (core.js records openedFrom in open()).
// Reachable from the main process (guest owns the keyboard) — so re-run the modal check here too:
// one Esc never both closes a modal and tears down the player. No-op while the guest is fullscreen
// (that Esc is the fullscreen exit).
function exitPlayer() {
  if (closeTopModal()) return;
  if (webview.classList.contains('fullscreen')) return;
  if (webview.hidden) return;
  if (openedFrom === 'dashboard') showDashboard();
  else if (openedFrom === 'home') showHome();
  else if (openedFrom === 'live') { browseTab = 'live'; showBrowse(); }
  else showBrowse();
}

// ---------- dispatcher ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (paletteEl) closePalette(); else openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (typing()) { document.activeElement.blur(); return; } // first Esc leaves the field
    goBack();
    return;
  }
  if (modalOpen() || typing()) return; // palette input / wizard / form controls own their keys
  if (e.key === '?') { openHelp(); return; }
  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) { e.preventDefault(); focusBrowseSearch(); return; } // / and Ctrl+F focus the Browse search box
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '0' && e.key <= '5') {
    if (e.key === '0') showDashboard();
    else if (e.key === '4') { browseTab = 'live'; showBrowse(); }
    else if (e.key === '5') open('https://www.youtube.com', false);
    else { browseQuery = ''; browseTab = ['movie', 'tv', 'anime'][+e.key - 1]; showBrowse(); }
    return;
  }
  if (e.key.startsWith('Arrow')) { if (moveGrid(e.key)) e.preventDefault(); return; }
  if (e.key === 'Enter') {
    const el = document.activeElement;
    if (el && el.matches && el.matches(NAV_SEL)) el.click();
  }
});

// main-process routes: the only keys that reach us while the guest webview is focused
window.sh?.onExitPlayer?.(() => exitPlayer());
window.sh?.onOpenPalette?.(() => { if (!paletteEl) openPalette(); });
