// Adaptive input model: the app reacts to HOW you're driving it instead of shipping a separate "TV mode".
// One body class (input-pointer | input-touch | input-gamepad) drives every CSS affordance change, plus a
// Gamepad API polling loop that turns a controller's D-pad/stick into the same focus moves the arrow keys
// already make (moveGrid/goBack live in keyboard.js — this file only feeds them).

const INPUT_CLASSES = ['input-pointer', 'input-touch', 'input-gamepad'];
let inputMode = '';

function setInputMode(mode) {
  if (mode === inputMode) return;
  inputMode = mode;
  document.body.classList.remove(...INPUT_CLASSES);
  document.body.classList.add('input-' + mode);
}
setInputMode('pointer');

// A touch also emits compatibility mouse events, so only a real mouse *pointerdown* leaves touch mode;
// a bare mousemove is enough to leave gamepad mode (the pointer is back on the screen).
document.addEventListener('pointerdown', (e) => setInputMode(e.pointerType === 'touch' ? 'touch' : 'pointer'), true);
document.addEventListener('mousemove', () => { if (inputMode === 'gamepad') setInputMode('pointer'); }, true);

// ---------- touch: long-press = hover ----------

// Poster cards reveal their expand-preview on a ~1s hover, which touch can never do. Long-press is the
// touch equivalent. Delegated from document (no per-card listeners) — posterCard just stamps `_preview`.
let LONGPRESS_MS = 500;                    // bare global so e2e can zero it (like HOVER_MS)
let lpTimer = null, lpX = 0, lpY = 0, lpFired = false;
const cancelLongPress = () => clearTimeout(lpTimer);

document.addEventListener('pointerdown', (e) => {
  cancelLongPress();
  lpFired = false;   // a press that ended without a click (dragged off) must not swallow the NEXT one
  if (e.pointerType !== 'touch') return;
  const cardEl = e.target.closest && e.target.closest('.poster-card');
  if (!cardEl || !cardEl._preview) { hideHoverPreview(); return; } // tapping anywhere else dismisses it
  lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => {
    lpFired = true;                        // swallow the click this press will also produce
    showHoverPreview(cardEl, cardEl._preview.kind, { id: cardEl._preview.id });
  }, LONGPRESS_MS);
}, true);

document.addEventListener('pointermove', (e) => {
  if (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10) cancelLongPress(); // it's a scroll, not a press
}, true);
document.addEventListener('pointerup', cancelLongPress, true);
document.addEventListener('pointercancel', cancelLongPress, true);
document.addEventListener('click', (e) => {
  if (!lpFired) return;
  lpFired = false;
  e.stopPropagation(); e.preventDefault();  // a long-press opened the preview — don't also open the detail page
}, true);

// ---------- gamepad / TV remote D-pad ----------

const PAD_DEADZONE = 0.5;   // stick throw before it counts as a direction
const PAD_DELAY = 400;      // hold this long before the direction repeats
const PAD_REPEAT = 110;     // then one move per this many ms
const PAD_BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, START: 9 }; // standard mapping (Xbox layout)

let padRaf = null, padDir = null, padNextAt = 0;
const padDown = new Set();

const padPressed = (pad, i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
const firstPad = () => [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected) || null;

// One tick: read the first connected pad, translate it into focus moves / activations. Called from the
// rAF loop, and directly by the e2e suite with a stubbed navigator.getGamepads.
function pollPads() {
  const pad = firstPad();
  if (!pad) { padDir = null; padDown.clear(); return false; }

  // A modal (palette / help / wizard / lightbox) owns the input, exactly as in the keyboard dispatcher:
  // only B reaches through, and goBack() closes the topmost one.
  const blocked = modalOpen();

  const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
  let dir = null;
  if (blocked) dir = null;
  else if (padPressed(pad, 14) || ax <= -PAD_DEADZONE) dir = 'ArrowLeft';
  else if (padPressed(pad, 15) || ax >= PAD_DEADZONE) dir = 'ArrowRight';
  else if (padPressed(pad, 12) || ay <= -PAD_DEADZONE) dir = 'ArrowUp';
  else if (padPressed(pad, 13) || ay >= PAD_DEADZONE) dir = 'ArrowDown';

  const now = performance.now();
  if (dir !== padDir) {                       // fresh direction: move once, then wait out the hold delay
    padDir = dir; padNextAt = now + PAD_DELAY;
    if (dir) padMove(dir);
  } else if (dir && now >= padNextAt) {       // held: auto-repeat
    padNextAt = now + PAD_REPEAT;
    padMove(dir);
  }

  const edge = (i, run) => {                  // fire once per press, not once per frame
    if (padPressed(pad, i)) {
      if (padDown.has(i)) return;
      padDown.add(i); setInputMode('gamepad');
      if (!blocked || i === PAD_BTN.B) run(); // releases stay tracked even when a modal swallows the press
    } else padDown.delete(i);
  };
  edge(PAD_BTN.A, padActivate);
  edge(PAD_BTN.B, () => goBack());
  edge(PAD_BTN.X, () => showSearch());
  edge(PAD_BTN.Y, padPreview);
  edge(PAD_BTN.LB, () => padPage(-1));
  edge(PAD_BTN.RB, () => padPage(1));
  edge(PAD_BTN.START, () => openPalette());
  return true;
}

function padMove(dir) {
  setInputMode('gamepad');
  hideHoverPreview();     // the preview is anchored to a card that's about to lose focus
  moveGrid(dir);
}

// A = activate. Anything focused and clickable gets clicked; nothing focused seeds focus into the view.
function padActivate() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.click === 'function') el.click();
  else moveGrid('ArrowRight');
}

// Y = the card's extra info (the same panel hover/long-press opens); press again to dismiss.
function padPreview() {
  const el = document.activeElement;
  if (hp && !hp.hidden) { hideHoverPreview(); return; }
  if (el && el._preview) showHoverPreview(el, el._preview.kind, { id: el._preview.id });
}

// LB / RB = page sideways through the rail the focus is in; outside a rail, page the view vertically.
function padPage(dir) {
  const smooth = document.body.classList.contains('reduced-motion') ? 'auto' : 'smooth';
  const rail = document.activeElement && document.activeElement.closest && document.activeElement.closest('.rail');
  if (rail) { rail.scrollBy({ left: dir * rail.clientWidth * 0.9, behavior: smooth }); return; }
  const view = ['dashboard', 'browse', 'search', 'detail', 'person', 'home', 'settings'].map((id) => $(id)).find((el) => el && !el.hidden);
  if (view) view.scrollBy({ top: dir * view.clientHeight * 0.9, behavior: smooth });
}

function startPadLoop() {
  if (padRaf != null) return;
  const tick = () => { pollPads(); padRaf = requestAnimationFrame(tick); };
  tick();
}
function stopPadLoop() { if (padRaf != null) { cancelAnimationFrame(padRaf); padRaf = null; } }

// One-time nudge so the button map is discoverable without hunting for the "?" overlay.
function controlsHint() {
  if (load('padHintSeen', false)) return;
  store('padHintSeen', true);
  toast('Controller ready — D-pad moves · A opens · B goes back · Y previews');
}

window.addEventListener('gamepadconnected', () => { startPadLoop(); controlsHint(); });
window.addEventListener('gamepaddisconnected', () => { if (!firstPad()) stopPadLoop(); });
if (firstPad()) startPadLoop(); // a pad already awake at boot (Chromium usually needs input first)
