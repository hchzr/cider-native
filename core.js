// Shared runtime helpers for the Native modules: Cider handles, storage, escaping, the appearance watcher and a
// focus-aware timer. Everything here is cheap to call; nothing polls on its own.

export const app = () => window.CiderApp;
export const rpc = () => window.CiderApp?.RPC;
export const log = (...a) => console.log('[native]', ...a);
export const warn = (...a) => console.warn('[native]', ...a);

export const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const bgImg = (u) => (u ? `style="background-image:url('${esc(u)}')"` : '');
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.getAttribute('reduced-motion') === 'true';

// Navigation the way Cider's own sidebar does it.
export function go(path) {
  try { const pr = app().PodRouter?.(); if (pr?.openInCurrentTab) pr.openInCurrentTab(path); else app().router.push(path); }
  catch (err) { warn('navigate failed', path, err); }
}

// Cider owns the whole window in its immersive and mini players; our overlays step aside there.
export const immersive = () => { const st = app()?.appState; return st?.immersiveShown === true || (!!st?.appMode && st.appMode !== 'browser'); };

// ---- appearance: light/dark, text colour, accent, font - read once per change instead of on every tick ----
let look = null;
const lookSubs = new Set();
let lookObserver = null, lookQueued = false;
function readLook() {
  const cs = getComputedStyle(document.body);
  return { light: document.body.classList.contains('body--light'), fg: cs.color || '#fff', accent: cs.getPropertyValue('--keyColor').trim() || '#fa2d48', font: cs.fontFamily };
}
function lookChanged() {
  if (lookQueued) return; lookQueued = true;
  requestAnimationFrame(() => { lookQueued = false; const next = readLook(); if (JSON.stringify(next) === JSON.stringify(look)) return; look = next; lookSubs.forEach((f) => f(look)); });
}
export function onAppearance(fn) {
  if (!lookObserver) {
    look = readLook();
    lookObserver = new MutationObserver(lookChanged);
    for (const el of [document.documentElement, document.body]) lookObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  lookSubs.add(fn); fn(look);
  return () => { lookSubs.delete(fn); if (!lookSubs.size) { lookObserver.disconnect(); lookObserver = null; } };
}
// Our own stylesheets change the accent and font too.
export const refreshAppearance = lookChanged;

// ---- focus-aware timer: `focused` ms while Cider is the front window, `background` ms behind other windows, paused while hidden ----
export function every(fn, { focused = 500, background = 2000 } = {}) {
  let timer = 0, alive = true;
  const run = () => { if (!alive) return; if (!document.hidden) { try { fn(); } catch (err) { warn(err); } } arm(); };
  const arm = () => { clearTimeout(timer); if (alive && !document.hidden) timer = setTimeout(run, document.hasFocus() ? focused : background); };
  const wake = () => { if (alive) run(); };
  window.addEventListener('focus', wake); window.addEventListener('blur', arm); document.addEventListener('visibilitychange', wake);
  run();
  return () => { alive = false; clearTimeout(timer); window.removeEventListener('focus', wake); window.removeEventListener('blur', arm); document.removeEventListener('visibilitychange', wake); };
}

// ---- Cider's sidebar/drawer elements: rect changes arrive through one ResizeObserver ----
export const CIDER_LEFT = '.ns-sidebar--left', CIDER_RIGHT = '.ns-sidebar--right';
const frameSubs = new Set();
let frameObserver = null, observed = new Set(), frameQueued = false;
function frameChanged() {
  if (frameQueued) return; frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; frameSubs.forEach((f) => f()); });
}
// Re-attaches to Cider's elements if Cider re-created them (layout switches); cheap when nothing changed.
export function trackFrames() {
  if (!frameObserver) return;
  for (const sel of [CIDER_LEFT, CIDER_RIGHT]) {
    const el = document.querySelector(sel);
    if (el && !observed.has(el)) { frameObserver.observe(el); observed.add(el); frameChanged(); }
  }
  for (const el of observed) if (!el.isConnected) { frameObserver.unobserve(el); observed.delete(el); }
}
export function onFrames(fn) {
  if (!frameObserver) { frameObserver = new ResizeObserver(frameChanged); window.addEventListener('resize', frameChanged); }
  frameSubs.add(fn); trackFrames(); fn();
  return () => { frameSubs.delete(fn); if (!frameSubs.size) { frameObserver.disconnect(); frameObserver = null; observed = new Set(); window.removeEventListener('resize', frameChanged); } };
}
