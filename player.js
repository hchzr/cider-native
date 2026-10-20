// Floating player: Music.app's glass pill in place of Cider's bottom bar, driven by Cider's RPC snapshot.
// Shown only while Cider renders its own bottom bar (the "mojave" layouts); hidden in the immersive and mini players.
// Cheap by design: one snapshot read per tick (0.02 ms), DOM writes only for values that changed, and the progress bar is a
// single Web Animation the compositor runs on its own (re-synced only when it drifts).
import { PLAYER, sfCss, sfTag } from './sf.js';
import { fmtTime, artworkUrl, ratioFromPointer, subtitle, nextRepeatLabel, clamp01, contentInsets, pillWidth, progressAt } from './player-logic.js';
import { app, rpc, warn, reducedMotion, immersive, onAppearance, every, onFrames, trackFrames, CIDER_LEFT, CIDER_RIGHT } from './core.js';
import { DRAWER_EVENT } from './sidebar.js';

const ORIGINAL = '.ns-bottom-toolbar_inline, .ns-bottom-toolbar';
const HIDE_ID = 'native-hide-cider-player';
const svg = (n) => sfTag(PLAYER, n);

const CSS = `
:host { all: initial; position: fixed; left: var(--np-left, 0px); right: var(--np-right, 0px); bottom: 20px; z-index: 100;
  display: flex; justify-content: center; pointer-events: none; color: var(--fg);
  font: 13px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
:host([hidden]) { display: none !important; }
:host { --ease: cubic-bezier(.32,.72,0,1); --fg: rgba(255,255,255,.94); --fg2: rgba(255,255,255,.55);
  --tint: rgba(58,58,62,.46); --track: rgba(255,255,255,.22); --hover: rgba(255,255,255,.12); --edge: rgba(255,255,255,.22); --shadow: rgba(0,0,0,.35); --accent: var(--np-accent, #fa2d48); }
:host(.light) { --fg: rgba(0,0,0,.85); --fg2: rgba(0,0,0,.45); --tint: rgba(206,206,211,.56); --track: rgba(0,0,0,.14); --hover: rgba(0,0,0,.06);
  --edge: rgba(255,255,255,.75); --shadow: rgba(0,0,0,.13); }
/* Geometry measured on Music.app at the same window size: 53pt tall, ~46% of the window wide, 20pt above the bottom edge.
   Glass matched side by side: a light frost that keeps shapes readable, a colour lift and a milky veil. */
.pill { zoom: var(--np-zoom, 1); pointer-events: auto; position: relative; display: flex; align-items: center; height: 53px; padding: 0 8px 0 9px; box-sizing: border-box;
  width: var(--np-w, 600px); border-radius: 26.5px; isolation: isolate;
  background: linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,0) 60%), var(--tint);
  -webkit-backdrop-filter: blur(9px) saturate(1.8) brightness(1.08); backdrop-filter: blur(9px) saturate(1.8) brightness(1.08);
  box-shadow: inset 0 .5px 0 var(--edge), inset 0 0 0 .5px color-mix(in srgb, var(--edge) 60%, transparent), 0 8px 24px var(--shadow), 0 1px 3px rgba(0,0,0,.06);
  animation: rise .6s var(--ease) both; }
@keyframes rise { from { opacity: 0; transform: translateY(22px) scale(.95); } to { opacity: 1; transform: none; } }
.group { display: flex; align-items: center; flex: none; }
button { all: unset; display: grid; place-items: center; width: 37px; height: 36px; border-radius: 18px; color: var(--fg); cursor: default;
  transition: background .18s var(--ease), color .18s var(--ease), transform .4s var(--ease), opacity .3s var(--ease); }
button:hover { background: var(--hover); }
button:active { transform: scale(.88); transition-duration: .08s, .08s, .1s; }
button.xl:active { transform: scale(.92); }
button.dim { color: var(--fg2); }
button.on { color: var(--accent); }
button.on.bg { background: color-mix(in srgb, var(--accent) 16%, transparent); }
/* left cluster: centres at 23/51/83/115/143pt from the pill edge; right cluster 37pt apart (as in Music) */
.group:first-child button { width: 28px; } .group:first-child button.xl { width: 36px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.display { flex: 1; min-width: 0; position: relative; display: flex; align-items: flex-start; gap: 10px; height: 47px; padding: 4px 4px 0 6px; margin: 0 10px; box-sizing: border-box; }
.art { position: relative; width: 38px; height: 38px; border-radius: 6px; flex: none; overflow: hidden; background: rgba(127,127,127,.28) center/cover;
  box-shadow: 0 0 0 .5px rgba(0,0,0,.18); transition: transform .45s var(--ease), opacity .3s var(--ease); }
.art:active { transform: scale(.94); }
.art::after { content: ""; position: absolute; inset: 0; background: rgba(0,0,0,.4); opacity: 0; transition: opacity .25s var(--ease); }
.art .sf { position: absolute; left: 50%; top: 50%; translate: -50% -50%; color: #fff; opacity: 0; transform: scale(.7); transition: opacity .25s var(--ease), transform .4s var(--ease); z-index: 1; }
.art:hover::after, .art:hover .sf { opacity: 1; } .art:hover .sf { transform: none; }
.meta { min-width: 0; flex: 1; height: 38px; display: flex; flex-direction: column; justify-content: center; transition: opacity .3s var(--ease); }
.title { display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.title .t { overflow: hidden; text-overflow: ellipsis; }
.title .fav { width: 18px; height: 18px; flex: none; border-radius: 9px; color: var(--fg2); }
.title .fav.show { color: var(--accent); }
.sub { color: var(--fg2); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.time { color: var(--fg2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; display: none; align-self: center; height: 30px; line-height: 30px; }
.display:hover .time { display: block; }
.scrub { position: absolute; left: 6px; right: 2px; bottom: 0; height: 10px; }
.scrub::before, .fill { content: ""; position: absolute; left: 0; right: 0; bottom: 2px; height: 2.5px; border-radius: 2px; transition: scale .2s var(--ease), background-color .2s; }
.scrub::before { background: var(--track); }
.fill { background: var(--fg2); transform-origin: left center; transform: scaleX(0); }   /* transform is the progress animation; hover uses the separate scale property */
.display:hover .scrub::before, .display:hover .fill { scale: 1 1.6; } .display:hover .fill { background: var(--fg); }
.vol { display: flex; align-items: center; }
.vol input { appearance: none; -webkit-appearance: none; width: 0; height: 3px; opacity: 0; border-radius: 2px; margin: 0;
  background: linear-gradient(to right, var(--fg2) var(--v, 100%), var(--track) var(--v, 100%)); transition: width .3s var(--ease), opacity .25s var(--ease), margin .3s var(--ease); }
.vol:hover input, .vol input:focus { width: 64px; opacity: 1; margin: 0 6px 0 4px; }
.vol input::-webkit-slider-thumb { -webkit-appearance: none; width: 9px; height: 9px; border-radius: 50%; background: var(--fg); }
/* idle: the Apple logo in the middle, which turns into the expand button on hover (as in Music) */
.logo { position: absolute; inset: 0; width: auto; height: auto; border-radius: 0; display: grid; place-items: center; opacity: 0; pointer-events: none; transition: opacity .35s var(--ease); }
.logo > * { grid-area: 1 / 1; transition: opacity .25s var(--ease), transform .4s var(--ease); }
.logo .apple { opacity: .22; } .logo .expand { opacity: 0; transform: scale(.8); display: grid; }
.empty .logo { opacity: 1; pointer-events: auto; }
.empty .logo:hover .apple { opacity: 0; transform: scale(.8); } .empty .logo:hover .expand { opacity: 1; transform: none; }
.empty .art, .empty .meta { opacity: 0; pointer-events: none; }
.empty .group:first-child button { opacity: .4; }
.empty .scrub, .empty .fav, .empty [data-a=more] { display: none; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition-duration: .01ms !important; } }
` + sfCss(PLAYER);

let sheetCache = null;
const sheet = () => { if (!sheetCache) { sheetCache = new CSSStyleSheet(); sheetCache.replaceSync(CSS); } return sheetCache; };

class NativePlayer extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' }); this.root.adoptedStyleSheets = [sheet()];
    this.v = {};   // last values written to the DOM
    this.root.innerHTML = `
      <div class="pill empty">
        <div class="group">
          <button data-a="shuffle" class="dim bg" title="Shuffle">${svg('shuffle')}</button>
          <button data-a="prev" title="Previous">${svg('prev')}</button>
          <button data-a="play" class="xl" title="Play">${svg('play')}</button>
          <button data-a="next" title="Next">${svg('next')}</button>
          <button data-a="repeat" class="dim bg" title="Repeat">${svg('repeat')}</button>
        </div>
        <div class="display">
          <button class="art" data-a="immersive" title="Open Immersive Player">${svg('expand')}</button>
          <div class="meta"><div class="title"><span class="t">Not Playing</span><button class="fav" data-a="fav" title="Favorite">${svg('star')}</button></div><div class="sub"></div></div>
          <button class="logo" data-a="immersive" title="Open Immersive Player"><span class="apple">${svg('apple')}</span><span class="expand">${svg('expand')}</span></button>
          <div class="time"></div>
          <div class="scrub"><div class="fill"></div></div>
        </div>
        <div class="group">
          <button data-a="more" title="More">${svg('more')}</button>
          <button data-a="lyrics" title="Lyrics">${svg('lyrics')}</button>
          <button data-a="queue" title="Up Next">${svg('queue')}</button>
          <button data-a="airplay" title="AirPlay">${svg('airplay')}</button>
          <div class="vol"><input type="range" min="0" max="1" step="0.01" data-a="volume" aria-label="Volume"><button data-a="mute" title="Volume">${svg('vol')}</button></div>
        </div>
      </div>`;
    const q = (s) => this.root.querySelector(s), b = (a) => q(`[data-a=${a}]`);
    this.el = { pill: q('.pill'), art: q('.art'), t: q('.t'), meta: q('.meta'), fav: q('.fav'), sub: q('.sub'), time: q('.time'), fill: q('.fill'), scrub: q('.scrub'), display: q('.display'),
      play: b('play'), shuffle: b('shuffle'), repeat: b('repeat'), lyrics: b('lyrics'), queue: b('queue'), vol: b('volume'), mute: b('mute') };
    this.progress = this.el.fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 1000, fill: 'both', easing: 'linear' });
    this.progress.pause();
    this.root.addEventListener('click', (e) => { const x = e.target.closest('button[data-a]'); if (x) this.act(x.dataset.a, x); });
    this.el.vol.addEventListener('input', () => { const v = clamp01(parseFloat(this.el.vol.value)); rpc().volume = v; this.paintVol(v); });
    const seek = (e) => { const r = this.el.scrub.getBoundingClientRect(), d = this.snap?.time?.duration || 0; if (d > 0) rpc().seekToTime(ratioFromPointer(e.clientX, r.left, r.width) * d); };
    this.el.scrub.addEventListener('pointerdown', (e) => { this.dragging = true; this.el.scrub.setPointerCapture(e.pointerId); seek(e); });
    this.el.scrub.addEventListener('pointermove', (e) => { if (this.dragging) seek(e); });
    this.el.scrub.addEventListener('pointerup', () => { this.dragging = false; setTimeout(() => this.poll(), 80); });
    // the elapsed / remaining label only shows on hover, so it only updates then
    this.el.display.addEventListener('pointerenter', () => { this.paintTime(); this.timeTimer = setInterval(() => this.paintTime(), 1000); });
    this.el.display.addEventListener('pointerleave', () => clearInterval(this.timeTimer));
  }
  set(key, value, apply) { if (this.v[key] !== value) { this.v[key] = value; apply(value); } }
  anim(el, frames, opts) { if (el?.animate && !reducedMotion()) el.animate(frames, opts); }
  paintVol(v) { this.el.vol.style.setProperty('--v', `${Math.round(v * 100)}%`); this.set('mute', v === 0, (m) => { this.el.mute.innerHTML = svg(m ? 'mute' : 'vol'); }); }
  paintTime() {
    const s = this.snap, d = s?.time?.duration || 0, t = (this.progress.currentTime || 0) / 1000;
    this.el.time.textContent = d > 0 ? `${fmtTime(t)} / -${fmtTime(Math.max(0, d - t))}` : '';
  }
  drawer(view) {
    const st = app().appState;
    if (st.rightDrawerOpen && st.rightDrawerView === view) st.rightDrawerOpen = false;
    else { st.rightDrawerView = view; st.rightDrawerOpen = true; }
    window.dispatchEvent(new Event(DRAWER_EVENT));
  }
  async more(btn) {
    const r = rpc(), api = window.electronAPI; if (!api?.spawnContextMenu) return;
    const st = await r.getCurrentSongStatus().catch(() => ({ rating: 0, is_added: false }));
    const rect = btn.getBoundingClientRect();
    const items = [
      { label: st.is_added ? 'Remove from Library' : 'Add to Library', actionId: 'lib' },
      { label: st.rating === 1 ? 'Unfavorite' : 'Favorite', actionId: 'love' },
      { type: 'separator' },
      { label: 'Suggest Less Like This', actionId: 'dislike' },
    ];
    const id = await api.spawnContextMenu({ items, x: Math.round(rect.left), y: Math.round(rect.top) });
    try { if (id === 'lib') await r.toggleAdd(); else if (id === 'love') await r.toggleLoved(); else if (id === 'dislike') await r.toggleDisliked(); } catch (e) { warn(e); }
    this.poll();
  }
  act(a, btn) {
    const r = rpc();
    try {
      if (a === 'play') r.togglePlayPause(); else if (a === 'next') r.next(); else if (a === 'prev') r.previous();
      else if (a === 'shuffle') r.toggleShuffle(); else if (a === 'repeat') r.toggleRepeat();
      else if (a === 'lyrics' || a === 'queue') this.drawer(a);
      // The companion app (if running) shows the native AirPlay picker; otherwise launch it through its URL scheme.
      else if (a === 'airplay') fetch('http://127.0.0.1:10771/airplay', { mode: 'no-cors' }).catch(() => window.electronAPI?.sendWindowEvent('open-external', { url: 'cidercompanion://airplay' }));
      else if (a === 'immersive') app().dialogs.immersive();
      else if (a === 'fav') r.toggleLoved();
      else if (a === 'mute') r.volume = r.volume > 0 ? 0 : 1;
      else if (a === 'more') return this.more(btn);
    } catch (e) { warn('player action failed', a, e); }
    setTimeout(() => this.poll(), 60);
  }
  layout() {
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const { left, right } = contentInsets(window.innerWidth, rect(CIDER_LEFT), rect(CIDER_RIGHT));
    const w = Math.min(pillWidth(window.innerWidth), window.innerWidth - left - right - 32);
    this.set('layout', `${left}|${right}|${w}`, () => { this.style.setProperty('--np-left', `${left}px`); this.style.setProperty('--np-right', `${right}px`); this.style.setProperty('--np-w', `${w}px`); });
  }
  setLook(look) { this.classList.toggle('light', look.light); this.style.setProperty('--np-accent', look.accent); }
  setScale(z) { this.style.setProperty('--np-zoom', z); }
  // Keeps the progress animation on the playback clock; touches it only when the state, the track or the position moved.
  syncProgress(time, duration, playing) {
    const a = this.progress, ms = Math.max(1, duration * 1000);
    if (a.effect.getTiming().duration !== ms) a.effect.updateTiming({ duration: ms });
    if (Math.abs((a.currentTime || 0) - time * 1000) > 400) a.currentTime = progressAt(time, duration) * ms;
    if (playing && duration > 0 && a.playState !== 'running') a.play(); else if ((!playing || !duration) && a.playState === 'running') a.pause();
  }
  poll() {
    let s; try { s = rpc().playbackSnapshot; } catch { return; }
    this.snap = s;
    const np = s?.nowPlaying, playing = s?.state === 'playing';
    this.toggleAttribute('hidden', immersive());
    this.set('empty', !np, (e) => this.el.pill.classList.toggle('empty', e));
    const title = np?.name || 'Not Playing';
    this.set('title', title, (t) => {
      if (this.v.titleShown) {
        this.anim(this.el.meta, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.32,.72,0,1)' });
        this.anim(this.el.art, [{ transform: 'scale(.9)', opacity: .5 }, { transform: 'none', opacity: 1 }], { duration: 460, easing: 'cubic-bezier(.32,.72,0,1)' });
      }
      this.v.titleShown = true; this.el.t.textContent = t;
    });
    this.set('sub', subtitle(np), (t) => { this.el.sub.textContent = t; });
    this.set('fav', !!np?.inFavorites, (f) => { this.el.fav.classList.toggle('show', f); this.el.fav.innerHTML = svg(f ? 'starFill' : 'star'); });
    this.set('art', artworkUrl(np?.artwork, 120), (u) => { this.el.art.style.backgroundImage = u ? `url("${u}")` : ''; });
    this.set('playing', playing, (p) => {
      this.el.play.innerHTML = svg(p ? 'pause' : 'play'); this.el.play.title = p ? 'Pause' : 'Play';
      if (this.v.playShown) this.anim(this.el.play.firstElementChild, [{ transform: 'scale(.55)', opacity: .2 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' });
      this.v.playShown = true;
    });
    this.set('shuffle', s?.shuffleMode === true || s?.shuffleMode === 1, (on) => { this.el.shuffle.classList.toggle('on', on); this.el.shuffle.classList.toggle('dim', !on); });
    this.set('repeat', s?.repeatMode || 'none', (rep) => {
      this.el.repeat.classList.toggle('on', rep !== 'none'); this.el.repeat.classList.toggle('dim', rep === 'none');
      this.el.repeat.innerHTML = svg(rep === 'one' ? 'repeatOne' : 'repeat'); this.el.repeat.title = nextRepeatLabel(rep);
    });
    const st = app().appState, open = !!st?.rightDrawerOpen, view = st?.rightDrawerView;
    for (const k of ['lyrics', 'queue']) this.set(k, open && (view === k || view === 'split-queue-lyrics'), (on) => this.el[k].classList.toggle('on', on));
    if (typeof s?.volume === 'number' && this.root.activeElement !== this.el.vol) this.set('volume', s.volume, (v) => { this.el.vol.value = v; this.paintVol(v); });
    if (!this.dragging) this.syncProgress(s?.time?.currentTime || 0, s?.time?.duration || 0, playing);
  }
}
if (!customElements.get('native-player-pill')) customElements.define('native-player-pill', NativePlayer);

// ---- lifecycle: replace Cider's bar only while Cider actually renders it ----
let node = null, stops = [], nodeStops = [], scale = 1;
function setHidden(on) {
  const cur = document.getElementById(HIDE_ID);
  if (on && !cur) { const st = document.createElement('style'); st.id = HIDE_ID; st.textContent = `${ORIGINAL} { display: none !important; }`; document.head.appendChild(st); }
  if (!on && cur) cur.remove();
}
function reconcile() {
  const should = !!document.querySelector(ORIGINAL);
  if (should && !node) {
    node = document.createElement('native-player-pill'); node.setScale(scale); document.body.appendChild(node);
    nodeStops = [onAppearance((look) => node?.setLook(look)), onFrames(() => node?.layout())];
    node.poll();
  }
  if (!should && node) { nodeStops.forEach((f) => f()); nodeStops = []; node.remove(); node = null; }
  setHidden(should);
}
export function startPlayer({ scale: z = 1 } = {}) {
  setPlayerScale(z);
  if (stops.length || node) return;
  stops = [
    every(() => node?.poll(), { focused: 400, background: 2000 }),
    every(() => { trackFrames(); reconcile(); }, { focused: 2000, background: 5000 }),
  ];
  reconcile();
}
export function stopPlayer() {
  stops.forEach((f) => f()); stops = []; nodeStops.forEach((f) => f()); nodeStops = [];
  node?.remove(); node = null; setHidden(false);
}
export function setPlayerScale(z) { scale = z; node?.setScale(z); }
export const playerDiagnostics = () => ({ on: !!node, hidden: !!node?.hasAttribute('hidden'), scale, ciderBar: !!document.querySelector(ORIGINAL) });
