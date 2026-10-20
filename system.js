// System integration: song notifications, Music.app keyboard shortcuts, window-control position, SF Symbols for Quasar
// icons, and the audio path diagnostic.
import { isTypingTarget, shortcutAction, stepVolume, trackKey, notificationFor, TRAFFIC_LIGHTS, sfIconName, atmosVerdict } from './system-logic.js';
import { SF_QICONS } from './sf.js';
import { app, rpc, warn, every } from './core.js';

// ---- song notifications (only while Cider is in the background, and never twice with Cider's own) ----
let stopNotify = null, lastKey = '';
export function startNotifications() {
  if (stopNotify) return;
  lastKey = '';
  stopNotify = every(() => {
    if (app()?.config?.getValue?.('connectivity.playbackNotifications') === true) return;
    let np; try { np = rpc()?.playbackSnapshot?.nowPlaying; } catch { return; }
    const key = trackKey(np);
    if (!key || key === lastKey) return;
    const first = lastKey === ''; lastKey = key;   // the song already playing at startup is not announced
    if (!first && !document.hasFocus()) window.electronAPI?.showNotification?.(notificationFor(np));
  }, { focused: 2000, background: 1000 });
}
export function stopNotifications() { stopNotify?.(); stopNotify = null; }

// ---- Music.app keyboard shortcuts ----
let keyHandler = null;
export function startShortcuts() {
  if (keyHandler) return;
  keyHandler = (e) => {
    if (e.defaultPrevented || e.repeat || isTypingTarget(document.activeElement)) return;
    const a = shortcutAction(e), r = rpc(); if (!a || !r) return;
    e.preventDefault();
    try {
      if (a === 'next') r.next(); else if (a === 'previous') r.previous();
      else r.volume = stepVolume(r.volume, a === 'volumeUp' ? 1 : -1);
    } catch (err) { warn('shortcut failed', a, err); }
  };
  window.addEventListener('keydown', keyHandler, true);
}
export function stopShortcuts() { if (keyHandler) window.removeEventListener('keydown', keyHandler, true); keyHandler = null; }

// ---- window controls: Music.app's traffic-light position (Cider re-applies its own once during startup, so send it twice) ----
const sendWindow = (evt, payload) => window.electronAPI?.sendWindowEvent?.(evt, payload);
let tlTimer = 0;
export function startWindowControls() {
  sendWindow('set-osx-control-position', { position: TRAFFIC_LIGHTS.music });
  clearTimeout(tlTimer); tlTimer = setTimeout(() => sendWindow('set-osx-control-position', { position: TRAFFIC_LIGHTS.music }), 1500);
}
export function stopWindowControls() { clearTimeout(tlTimer); sendWindow('reset-osx-control-position', {}); }

// ---- SF Symbols for Quasar font icons ----
// New icons: QIcon's setup is wrapped so its render output carries data-sf=<name> (the icons stylesheet draws the symbol).
// Icons rendered before the plugin loaded are tagged once and watched individually until they unmount.
let patch = null, legacyObserver = null;
const domName = (el) => { for (const c of el.classList) if (c.startsWith('ion-')) return c; return /material-icons|material-symbols/.test(el.className) ? el.textContent.trim() : ''; };
function tag(el) {
  const n = sfIconName(domName(el), SF_QICONS);
  if (n) { if (el.dataset.sf !== n) el.dataset.sf = n; } else if (el.dataset.sf) delete el.dataset.sf;
}
export function startIcons() {
  const Q = window.__PLUGINSYS__?.Quasar?.QIcon;
  if (Q && typeof Q.setup === 'function' && !patch) {
    const orig = Q.setup;
    patch = { Q, orig };
    Q.setup = function (props, ctx) {
      const render = orig.call(this, props, ctx);
      if (typeof render !== 'function') return render;
      return function (...args) {
        const vnode = render.apply(this, args);
        const n = vnode?.props ? sfIconName(props.name, SF_QICONS) : '';
        if (n) vnode.props['data-sf'] = n;
        return vnode;
      };
    };
  }
  if (!legacyObserver) {
    legacyObserver = new MutationObserver((recs) => { for (const r of recs) { const el = (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.('i.q-icon'); if (el) tag(el); } });
    for (const el of document.querySelectorAll('i.q-icon')) { tag(el); legacyObserver.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }); }
  }
}
export function stopIcons() {
  if (patch) { patch.Q.setup = patch.orig; patch = null; }
  legacyObserver?.disconnect(); legacyObserver = null;
  for (const el of document.querySelectorAll('i.q-icon[data-sf]')) delete el.dataset.sf;
}
export const iconsDiagnostics = () => ({ patched: !!patch, tagged: document.querySelectorAll('i.q-icon[data-sf]').length, untagged: document.querySelectorAll('i.q-icon:not([data-sf])').length });

// ---- audio path diagnostic (why AirPods show "Spatial Audio unavailable") ----
function atmosMode(cfg) {
  const dev = cfg?.deviceOutput || 'default', pref = cfg?.atmos?.devicePreferences?.[dev];
  if (pref) return pref;
  return cfg?.atmos?.enabled ? (cfg.atmos.binaural ? 'binaural' : 'passthrough') : 'off';
}
export async function audioReport() {
  const cfg = app()?.config?.getValue?.('audio') ?? {};
  const info = (() => { try { return rpc()?.audioQualityInfo; } catch { return null; } })() || {};
  const dev = info.deviceAudioConfig || {};
  let ctxMax = null;
  try { const c = new AudioContext(); ctxMax = c.destination.maxChannelCount; c.close(); } catch {}
  return atmosVerdict({
    flavor: info.flavor ?? null, mode: atmosMode(cfg), supportsAtmos: dev.supportsAtmos ?? null,
    ec3Supported: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"'),
    outChannels: dev.channelCount ?? ctxMax, supportedCodecs: dev.supportedCodecs ?? [],
  });
}
