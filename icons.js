// Inline SVG icon set replacing the emoji glyphs (Material-outline-style 24x24 paths, no dependency).
// icon(name) returns an <svg> sized 1em and filled with currentColor, so every icon inherits its
// button's font-size and color — which makes themes/accents recolor glyphs for free.

const ICON_PATHS = {
  home: 'M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z',
  search: 'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  film: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4z',
  tv: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z',
  play: 'M8 5v14l11-7z',
  resume: 'M3 5v14l8-7zM14 5h3v14h-3zM19 5h3v14h-3z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z',
  forward: 'M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z',
  'next-ep': 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  sources: 'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  refresh: 'M17.65 6.35A8 8 0 1 0 19.73 14h-2.08a6 6 0 1 1-1.42-6.24L13 11h7V4z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  'chevron-l': 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  'chevron-r': 'M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON_PATHS[name] || '');
  svg.append(p);
  return svg;
}

// Populate the static chrome buttons (index.html ships them without glyphs). Runs at load — the
// buttons exist because scripts sit at the end of <body>. ids/titles are untouched (the e2e suite
// and users' muscle memory select by those, never by glyph).
(function applyChromeIcons() {
  const map = [
    ['dash-btn', 'home'], ['home-btn', 'search'], ['browse-btn', 'film'], ['live-btn', 'tv'],
    ['youtube-btn', 'play'], ['resume-btn', 'resume'], ['settings-btn', 'settings'],
    ['back', 'back'], ['forward', 'forward'], ['src-home', 'home'], ['autonext-btn', 'next-ep'],
  ];
  for (const [id, name] of map) {
    const b = $(id);
    if (!b) continue;
    b.replaceChildren(icon(name));
    if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.title || name);
  }
  const ls = $('live-sources');
  if (ls) { ls.replaceChildren(icon('sources'), document.createTextNode(' Sources')); ls.setAttribute('aria-label', ls.title); }
})();
