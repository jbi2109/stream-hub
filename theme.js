// Runs in <head> BEFORE first paint (external script — an inline one is blocked by the CSP).
// Applies the saved theme/accent/poster size to <html> so there's no light-then-dark flash.
// Defined as a global (classic script, shared scope) so settings.js can re-apply it live.
function applyThemeVars(s) {
  const d = document.documentElement;
  d.dataset.theme = (s && s.theme) || 'dark';
  d.style.setProperty('--accent', (s && s.accent) || '#4c8dff');
  d.style.setProperty('--poster-min', ((s && s.posterSize) || 160) + 'px');
}
try { applyThemeVars(JSON.parse(localStorage.getItem('settings') || 'null')); }
catch { applyThemeVars(null); }
