// Sidebar and Up Next: Music.app's sidebar and queue panel laid over Cider's own (whose content is hidden while ours shows).
// Pins / playlists / favourites / profile are read from Cider's hidden sidebar and clicks are forwarded to its real buttons.
// Event-driven: placement follows Cider's sidebar through a ResizeObserver, the scraped data refreshes when Cider's sidebar
// DOM changes, and the only timers are a slow route/visibility check and the queue refresh while the panel is open.
import { fitScale, compensate, needsCorrection, SEARCH, PRIMARY, LIBRARY, PLAYLISTS_ROOT, playlistPath, searchPath, activeNav, playlistsFromApi, artSized, initials, splitQueue, absoluteIndex, queueSignature, moveArgs, trackTitle, isExplicit, subtitleOf, fromLine, sourceName, cleanName, isFavouritesLabel, isActiveClass, pickArt, artByName, nowPlayingTrack, topIndex } from './sidebar-logic.js';
import { SIDE, sfCss, sfTag } from './sf.js';
import { app, rpc, ls, esc, bgImg, go, immersive, warn, reducedMotion, onAppearance, every, onFrames, trackFrames, CIDER_LEFT, CIDER_RIGHT } from './core.js';

const LS_PL = 'native/playlists', LS_PINS = 'native/pins-open';
const icon = (n) => sfTag(SIDE, n === 'favsq' ? 'star' : n);
const rowKey = (t, i) => `${t?.id ?? ''}|${trackTitle(t)}|${i}`;
export const DRAWER_EVENT = 'native:drawer';   // dispatched on window when something else opens/closes the right drawer

// ---- styles (one constructed sheet per panel type, shared by every instance) ----
const BASE = `
:host { all: initial; position: fixed; z-index: 100; -webkit-app-region: no-drag; display: none; box-sizing: border-box; color: var(--fg); font: 13px/1.3 var(--ff, -apple-system, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
@keyframes cardIn { from { opacity: 0; transform: translateX(var(--from, -16px)) scale(.985); } to { opacity: 1; transform: none; } }
:host { --ease: cubic-bezier(.32,.72,0,1); }
/* backwards fill only: an animation that keeps holding its end state would make the host a backdrop root, and the glass
   below could then only see the sidebar itself instead of the page under it */
:host(.on) { display: block; animation: cardIn .55s var(--ease) backwards; }
@media (prefers-reduced-motion: reduce) { :host(.on) { animation: none; } * { transition-duration: .01ms !important; } }
:host { --fg: #fff; --accent: #fa2d48; --sec: color-mix(in srgb, var(--fg) 50%, transparent); --solid: #2b2b2e; --hover: color-mix(in srgb, var(--fg) 8%, transparent); --fill: color-mix(in srgb, var(--fg) 11%, transparent); --sel: color-mix(in srgb, var(--fg) 15%, transparent); --line: color-mix(in srgb, var(--fg) 12%, transparent); --tint: rgba(255,255,255,.09); --glass: blur(50px) saturate(1.6) brightness(.6); }
:host(.light) { --tint: rgba(236,236,236,.55); --glass: blur(50px) saturate(1.8); --sel: rgba(0,0,0,.085); --hover: rgba(0,0,0,.045); --fill: rgba(0,0,0,.06); --solid: #f1f1f2; }
* { box-sizing: border-box; -webkit-app-region: no-drag; }
button { all: unset; box-sizing: border-box; cursor: default; }
/* Music's glass (macOS 26), matched on screenshots: the page runs under the panel, blurred heavily; in dark mode it is darkened
   to ~60% under a light veil (a pink card becomes a deep magenta glow, a pale photo a dark warm grey), in light mode lifted */
.card { position: absolute; inset: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--tint);
  -webkit-backdrop-filter: var(--glass); backdrop-filter: var(--glass); }
.wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
` + sfCss(SIDE);

// Music.app metrics, measured against it at the same window size: 32pt rows, glyph column centred at 38pt, labels at 55pt,
// 22pt artwork, 11pt section titles, no hover highlight.
const LEFT_CSS = BASE + `
.card { box-shadow: inset -.5px 0 0 var(--line); }
.wrap { padding-top: var(--top, 50px); }
.scroll { padding: 2px 10px 64px; }
.row { display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 8px 0 16px; border-radius: 10px; width: 100%; color: var(--fg); font-size: 13px; transition: background-color .15s var(--ease); }
.row.active, .row.search:focus-within { background: var(--sel); } .row.active .tx { font-weight: 600; }
.row.search { cursor: text; } .row.search .q { all: unset; flex: 1; min-width: 0; font: inherit; color: var(--fg); cursor: text; } .row.search .q::placeholder { color: var(--fg); opacity: 1; }
.row .ic { width: 24px; height: 24px; display: grid; place-items: center; color: var(--accent); flex: none; }
.row .tx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sec { padding: 16px 6px 3px; font-size: 11px; line-height: 13px; font-weight: 600; color: var(--sec); }
.art { width: 22px; height: 22px; border-radius: 4px; flex: none; background: var(--fill) center/cover; box-shadow: 0 0 0 .5px var(--line); display: grid; place-items: center; color: var(--sec); }
.pinhead { padding-left: 2px; } .pinhead .chev { width: 12px; margin-right: 2px; display: grid; place-items: center; color: var(--sec); transition: transform .3s var(--ease); flex: none; }
.pinhead.open .chev { transform: rotate(90deg); }
@keyframes unfold { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.children.unfold { animation: unfold .35s var(--ease) both; }
.children { padding-left: 13px; } .children .row { padding-left: 16px; gap: 6px; }
.row.pl { padding-left: 17px; gap: 6px; }
/* the account row floats over the end of the list, which blurs and fades under it (as in Music) */
.profile { position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 10px 15px; background: color-mix(in srgb, var(--solid) 55%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4); -webkit-mask: linear-gradient(to bottom, transparent, #000 14px); mask: linear-gradient(to bottom, transparent, #000 14px); }
.profile .row { gap: 6px; padding-left: 8px; }
.avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent) center/cover; color: #fff; font-size: 11px; font-weight: 600; display: grid; place-items: center; flex: none; box-shadow: 0 0 0 .5px var(--line); }
.who { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* inactive window: glyphs and labels fade to grey like every native sidebar */
:host(.inactive) .row .ic, :host(.inactive) .pinhead .chev { color: color-mix(in srgb, var(--fg) 28%, transparent); }
:host(.inactive) .row { color: color-mix(in srgb, var(--fg) 62%, transparent); }
:host(.inactive) .row.active { color: color-mix(in srgb, var(--fg) 78%, transparent); }
`;

const RIGHT_CSS = BASE + `
.card { box-shadow: inset .5px 0 0 var(--line); }
.wrap { padding-top: var(--top, 8px); }
.caps { display: flex; gap: 9px; padding: 0 10px 14px; }
.cap { flex: 1; height: 36px; border-radius: 18px; display: grid; place-items: center; color: var(--fg); background: var(--fill); transition: background-color .25s var(--ease), transform .45s var(--ease); }
.cap:hover { background: var(--sel); } .cap:active { transform: scale(.94); transition-duration: .1s; }
.cap.on { background: color-mix(in srgb, var(--fg) 17%, transparent); }   /* Music keeps the glyph black; only the pill darkens */
.head { display: flex; align-items: flex-start; padding: 2px 14px 8px; gap: 8px; }
.head .tt { flex: 1; min-width: 0; } .head h2 { all: unset; display: block; font-size: 15px; font-weight: 700; }
.from { color: var(--sec); font-size: 13px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clear { flex: none; color: var(--accent); font-size: 14px; padding: 2px 2px 0; } .clear:hover { opacity: .7; }
.lab { padding: 2px 16px 4px; font-size: 12px; font-weight: 600; color: var(--sec); }
.item.cur { margin: 0 6px 6px; background: var(--sel); } .item.cur::before { display: none; }
.rule { height: .5px; background: var(--line); margin: 2px 0; }
.scroll { padding: 0 6px 8px; }
.item { position: relative; display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 10px; min-height: 48px; padding: 7px 8px; border-radius: 8px; transition: background-color .2s var(--ease), box-shadow .2s var(--ease); }
.item + .item::before { content: ""; position: absolute; top: 0; left: 52px; right: 8px; height: .5px; background: var(--line); }
.item:hover { background: var(--hover); } .item:hover::before, .item:hover + .item::before { opacity: 0; }
.item.dragover { box-shadow: inset 0 2px 0 var(--accent); }
.cover { position: relative; width: 34px; height: 34px; border-radius: 4px; background: var(--fill) center/cover; box-shadow: 0 0 0 .5px var(--line); overflow: hidden; }
.cover .pl { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.45); color: #fff; opacity: 0; transition: opacity .2s var(--ease); } .item:hover .cover .pl { opacity: 1; }
.meta { min-width: 0; line-height: 1.25; } .t { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.a { color: var(--sec); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.exp { display: inline-block; font-size: 9px; font-weight: 700; padding: 0 3px; border-radius: 2px; background: var(--fill); color: var(--sec); margin-left: 5px; vertical-align: 1px; }
.dots { width: 26px; height: 26px; border-radius: 13px; display: grid; place-items: center; color: var(--sec); } .dots:hover { color: var(--accent); background: var(--hover); }
.empty { padding: 44px 18px; text-align: center; color: var(--sec); font-size: 13px; }
.more { display: block; width: 100%; padding: 10px; color: var(--sec); font-size: 12px; text-align: center; }
`;

const sheets = {};
const sheet = (key, css) => { if (!sheets[key]) { sheets[key] = new CSSStyleSheet(); sheets[key].replaceSync(css); } return sheets[key]; };

// Closed-loop placement: Cider's rect is the truth; we measure where the host really landed and compensate for any zoom.
function place(host, el) {
  const r = el.getBoundingClientRect();
  const target = { left: r.left, top: r.top, width: r.width, height: r.height };
  const set = (v) => { host.style.left = `${v.left}px`; host.style.top = `${v.top}px`; host.style.width = `${v.width}px`; host.style.height = `${v.height}px`; };
  set(target);
  const a = host.getBoundingClientRect();
  if (needsCorrection(target, { left: a.left, top: a.top, width: a.width, height: a.height })) set(compensate(target, fitScale(target.width, a.width)));
}
function paint(host, look) {
  host.style.setProperty('--fg', look.fg); host.style.setProperty('--accent', look.accent); host.style.setProperty('--ff', look.font);
  host.classList.toggle('light', look.light);
}

// ---- read Cider's own (hidden) sidebar: pins, playlists, favourites, profile ----
function scrape() {
  const root = document.querySelector(CIDER_LEFT); if (!root) return null;
  const nameOf = (e) => cleanName(e.querySelector('.nav-text-container')?.textContent ?? e.textContent);
  const artOf = (e) => { const img = e.querySelector('img'), box = e.querySelector('.sidebar-artwork'); return pickArt({ src: img?.getAttribute('src'), currentSrc: img?.currentSrc, dataSrc: img?.getAttribute('data-src'), bg: box ? box.style.backgroundImage || getComputedStyle(box).backgroundImage : '' }); };
  const activeOf = (e) => isActiveClass(e.className) || [...e.querySelectorAll('.nav-button-content')].some((c) => isActiveClass(c.className));
  const rows = (sel) => [...root.querySelectorAll(sel)].map((el) => ({ el, name: nameOf(el), art: artOf(el), active: activeOf(el) })).filter((r) => r.name);
  const fav = [...root.querySelectorAll('button.sidebar_nav-btn')].find((b) => isFavouritesLabel(nameOf(b)));
  const pb = root.querySelector('.profile-tab .profile-btn');
  return {
    top: [...root.querySelectorAll('.sidebar-apple-top button.sidebar_nav-btn')].map((el) => ({ el })),
    pins: rows('.pins-folder-body button.sidebar_nav-btn'), playlists: rows('.sidebar-draggable button.sidebar_nav-btn'),
    fav: fav ? { el: fav, name: nameOf(fav), art: artOf(fav), active: activeOf(fav) } : null,
    profile: pb ? { el: pb, name: cleanName(pb.querySelector('.profile-name')?.textContent), avatar: pb.querySelector('img')?.getAttribute('src') ?? null } : null,
  };
}
const sigOf = (s) => (s ? JSON.stringify([s.pins.map((r) => [r.name, r.art, r.active]), s.playlists.map((r) => [r.name, r.art, r.active]), s.fav && [s.fav.name, s.fav.active], s.profile && [s.profile.name, s.profile.avatar]]) : '');

// ================= LEFT SIDEBAR =================
class NativeLeft extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' }); this.root.adoptedStyleSheets = [sheet('left', LEFT_CSS)];
    this.apiPlaylists = []; this.active = ''; this.scraped = null; this.sig = ''; this.pinsOpen = ls.get(LS_PINS) !== '0'; this.showDiscover = true;
    try { this.apiPlaylists = JSON.parse(ls.get(LS_PL) || '[]'); this.artMap = artByName(this.apiPlaylists.map((p) => ({ name: p.name, art: p.art ? artSized(p.art, 48) : null }))); } catch {}
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.root.addEventListener('input', (e) => {
      if (!e.target.classList?.contains('q')) return;
      this.q = e.target.value; clearTimeout(this.qTimer);
      const q = this.q.trim(); if (!q || q === this.lastQ) return;
      this.qTimer = setTimeout(() => { this.lastQ = q; go(searchPath(q)); }, 300);   // search as you type
    });
    this.render();
  }
  // Forward a click to Cider's own button so it navigates exactly as Cider does.
  proxy(kind, i) {
    const s = scrape(); if (!s) return;
    if (kind === 'top') { const el = s.top?.[i]?.el; if (el) el.click(); else go(PRIMARY[i]?.path ?? '/am/home'); return; }
    if (kind === 'profile') { this.profileMode = true; this.render(); s.profile?.el?.click(); return; }
    const el = kind === 'pin' ? s.pins[i]?.el : kind === 'pl' ? s.playlists[i]?.el : kind === 'fav' ? s.fav?.el : null;
    el?.click();
  }
  onClick(e) {
    if (this.profileMode && !e.target.closest('[data-proxy="profile:0"]')) { this.profileMode = false; this.active = ''; }
    const pr = e.target.closest('[data-proxy]'); if (pr) { const [k, i] = pr.dataset.proxy.split(':'); this.proxy(k, +i); return; }
    if (e.target.closest('[data-discover]')) { this.discover(); return; }
    const to = e.target.closest('[data-go]'); if (to) { go(to.dataset.go); return; }
    if (e.target.closest('[data-pins]')) { this.pinsOpen = !this.pinsOpen; this.unfold = this.pinsOpen; ls.set(LS_PINS, this.pinsOpen ? '1' : '0'); this.render(); }
  }
  async discover() {
    if (this.discovering) return;
    const d = window.CiderDiscover; if (!d?.runAndOpen) { this.discoverStatus = 'Smart Discover is not installed'; this.render(); return; }
    this.discovering = true; this.discoverStatus = 'Finding new music…'; this.render();
    try { await d.runAndOpen((m) => { this.discoverStatus = m; this.render(); }); this.discoverStatus = ''; }
    catch (err) { warn('discover failed', err); this.discoverStatus = 'Discover failed – try again'; setTimeout(() => { this.discoverStatus = ''; this.render(); }, 4000); }
    this.discovering = false; this.render();
  }
  setActive(path) {
    let a = activeNav(path);
    if (a !== 'home') this.profileMode = false; else if (this.profileMode) a = 'profile';
    if (a !== this.active) { this.active = a; this.render(); }
  }
  setDiscover(on) { if (this.showDiscover !== on) { this.showDiscover = on; this.render(); } }
  setApiPlaylists(list) { this.apiPlaylists = list; this.artMap = artByName(list.map((p) => ({ name: p.name, art: p.art ? artSized(p.art, 48) : null }))); ls.set(LS_PL, JSON.stringify(list.slice(0, 400))); this.render(); }
  refresh() { const s = scrape(), sig = sigOf(s); if (sig !== this.sig) { this.sig = sig; this.scraped = s; this.render(); } else if (s) this.scraped = s; }
  onSearchKey(e) {
    if (!e.target.classList?.contains('q')) return;
    e.stopPropagation(); this.q = e.target.value;
    if (e.key === 'Enter') { clearTimeout(this.qTimer); const q = e.target.value.trim(); this.lastQ = q; go(q ? searchPath(q) : SEARCH.path); }
  }
  row(n) { const ti = topIndex(n.id); const act = ti >= 0 ? `data-proxy="top:${ti}"` : `data-go="${esc(n.path)}"`; return `<button class="row ${this.active === n.id ? 'active' : ''}" ${act}><span class="ic">${icon(n.icon)}</span><span class="tx">${esc(n.label)}</span></button>`; }
  thumb(r) { const art = r.art || this.artMap?.get(cleanName(r.name)) || null; return `<span class="art" ${bgImg(art)}>${art ? '' : icon('list')}</span>`; }
  render() {
    const sc = this.root.querySelector('.scroll')?.scrollTop ?? 0, s = this.scraped;
    const qEl = this.root.querySelector('.q'), refocus = qEl && this.root.activeElement === qEl; if (qEl) this.q = qEl.value; const caret = refocus ? qEl.selectionStart : 0;
    const pins = s?.pins ?? [];
    const pinRows = pins.map((p, i) => `<button class="row ${p.active ? 'active' : ''}" data-proxy="pin:${i}">${this.thumb(p)}<span class="tx">${esc(p.name)}</span></button>`).join('');
    const plRows = s?.playlists?.length
      ? s.playlists.map((p, i) => `<button class="row pl ${p.active ? 'active' : ''}" data-proxy="pl:${i}">${this.thumb(p)}<span class="tx">${esc(p.name)}</span></button>`).join('')
      : this.apiPlaylists.map((p) => `<button class="row pl ${this.active === 'pl:' + p.id ? 'active' : ''}" data-go="${esc(playlistPath(p.id))}">${this.thumb({ art: p.art ? artSized(p.art, 48) : null })}<span class="tx">${esc(p.name)}</span></button>`).join('');
    const prof = s?.profile, name = prof?.name || app()?.config?.getValue?.('general.displayName') || 'Account';
    this.root.innerHTML = `<div class="card"><div class="wrap">
      <nav class="scroll">
        <label class="row search ${this.active === 'search' ? 'active' : ''}"><span class="ic">${icon('search')}</span><input class="q" type="text" placeholder="Search" value="${esc(this.q || '')}" spellcheck="false" autocomplete="off"></label>
        ${PRIMARY.map((n) => this.row(n)).join('')}
        <div class="sec">Library</div>
        ${pins.length ? `<button class="row pinhead ${this.pinsOpen ? 'open' : ''}" data-pins><span class="chev">${icon('chevron')}</span><span class="ic">${icon('pin')}</span><span class="tx">Pins</span></button>${this.pinsOpen ? `<div class="children${this.unfold ? ' unfold' : ''}">${pinRows}</div>` : ''}` : ''}
        ${LIBRARY.map((n) => this.row(n)).join('')}
        <div class="sec">Playlists</div>
        ${this.row(PLAYLISTS_ROOT)}
        ${this.showDiscover ? `<button class="row" data-discover><span class="ic">${icon('spark')}</span><span class="tx">${esc(this.discoverStatus || 'Discover New Music')}</span></button>` : ''}
        ${s?.fav ? `<button class="row ${s.fav.active ? 'active' : ''}" data-proxy="fav:0"><span class="ic">${icon('favsq')}</span><span class="tx">${esc(s.fav.name)}</span></button>` : ''}
        ${plRows}
      </nav>
      <div class="profile"><button class="row ${this.active === 'profile' ? 'active' : ''}" data-proxy="profile:0"><span class="avatar" ${bgImg(prof?.avatar)}>${prof?.avatar ? '' : esc(initials(name))}</span><span class="who">${esc(name)}</span></button></div>
    </div></div>`;
    const sc2 = this.root.querySelector('.scroll'); if (sc2) sc2.scrollTop = sc;
    this.unfold = false;
    if (refocus) { const q2 = this.root.querySelector('.q'); if (q2) { q2.focus(); q2.setSelectionRange(caret, caret); } }
  }
}
customElements.get('native-sidebar-left') || customElements.define('native-sidebar-left', NativeLeft);

// ================= UP NEXT =================
class NativeUpNext extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' }); this.root.adoptedStyleSheets = [sheet('right', RIGHT_CSS)];
    this.sig = ''; this.nowId = null; this.lastFull = 0; this.data = { current: null, next: [], position: 0 }; this.from = ''; this.flags = {}; this.drag = null; this.limit = 150; this.seen = new Set();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('dragstart', (e) => { const it = e.target.closest?.('.item[data-i]'); if (it) { this.drag = +it.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(this.drag)); } });
    this.root.addEventListener('dragover', (e) => { const it = e.target.closest?.('.item[data-i]'); if (it && this.drag !== null) { e.preventDefault(); this.root.querySelectorAll('.dragover').forEach((n) => n.classList.remove('dragover')); it.classList.add('dragover'); } });
    this.root.addEventListener('drop', (e) => { const it = e.target.closest?.('.item[data-i]'); if (it && this.drag !== null) { e.preventDefault(); const [a, b] = moveArgs(this.data.position, this.drag, +it.dataset.i); if (a !== b) try { rpc().queueMoveToPosition(a, b); } catch (err) { warn(err); } this.drag = null; this.refresh(true); } });
    this.root.addEventListener('dragend', () => { this.drag = null; this.root.querySelectorAll('.dragover').forEach((n) => n.classList.remove('dragover')); });
    this.render();
  }
  // New rows ease in with a small stagger; rows already on screen stay still on re-render.
  animateEntries(shown) {
    if (reducedMotion()) { shown.forEach((t, i) => this.seen.add(rowKey(t, i))); return; }
    let n = 0;
    this.root.querySelectorAll('.item[data-i]').forEach((el) => {
      const t = shown[+el.dataset.i], k = rowKey(t, +el.dataset.i); if (this.seen.has(k)) return; this.seen.add(k);
      el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: Math.min(n++, 9) * 28, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards' });
    });
  }
  async menu(btn, i) {
    const api = window.electronAPI, r = rpc(); if (!api?.spawnContextMenu || !r) return;
    const b = btn.getBoundingClientRect();
    const id = await api.spawnContextMenu({ items: [{ label: 'Play Now', actionId: 'play' }, { label: 'Remove from Queue', actionId: 'rm' }], x: Math.round(b.left), y: Math.round(b.bottom) });
    try { const abs = absoluteIndex(this.data.position, i); if (id === 'play') r.changeToMediaAtIndex(abs); else if (id === 'rm') r.removeFromQueue(abs); } catch (err) { warn(err); }
    setTimeout(() => this.refresh(true), 120);
  }
  onClick(e) {
    const r = rpc(); if (!r) return;
    const act = e.target.closest('[data-act]')?.dataset.act, dots = e.target.closest('[data-dots]'), it = e.target.closest('.item[data-i]');
    try {
      if (act === 'autoplay') r.toggleAutoPlay(); else if (act === 'clear') r.clearQueue();
      else if (act === 'automix') { const c = app().config; c.setValue('audio.automix.enabled', !c.getValue('audio.automix.enabled')); c.saveConfig?.(); }
      else if (act === 'more') { this.limit += 150; this.render(); return; }
      else if (dots) { this.menu(dots, +dots.dataset.dots); return; }
      else if (it) r.changeToMediaAtIndex(absoluteIndex(this.data.position, +it.dataset.i));
    } catch (err) { warn('Up Next action failed', err); }
    setTimeout(() => this.refresh(true), 120);
  }
  // Reads the queue cheaply (position/total) and re-reads the full list only when it can have changed.
  refresh(force = false) {
    const r = rpc(); if (!r) return;
    let head; try { head = r.getQueueSlice(0, 0); } catch { return; }
    const sig = queueSignature(head), now = performance.now();
    let snap = null; try { snap = r.playbackSnapshot; } catch {}
    const nid = snap?.nowPlaying?.name ?? null;
    const flags = { autoplay: (() => { try { return !!r.isAutoPlayEnabled; } catch { return false; } })(), automix: app()?.config?.getValue?.('audio.automix.enabled') === true };
    const flagsChanged = flags.autoplay !== this.flags.autoplay || flags.automix !== this.flags.automix;
    if (!force && sig === this.sig && nid === this.nowId && now - this.lastFull < 6000) { if (flagsChanged) { this.flags = flags; this.render(); } return; }
    let full; try { full = r.getQueueSlice(Math.max(0, head.position), 400); } catch { return; }
    this.data = splitQueue(full, Math.max(0, head.position)); this.now = this.data.current || nowPlayingTrack(snap); this.from = sourceName(full);
    this.sig = sig; this.nowId = nid; this.lastFull = now; this.flags = flags; this.render();
  }
  row(t, i) {
    const art = artSized(t?.attributes?.artwork?.url, 80), ex = isExplicit(t) ? '<span class="exp">E</span>' : '';
    return `<div class="item" data-i="${i}" draggable="true"><div class="cover" ${bgImg(art)}><div class="pl">${icon('play')}</div></div>
      <div class="meta"><div class="t">${esc(trackTitle(t))}${ex}</div><div class="a">${esc(subtitleOf(t))}</div></div>
      <button class="dots" data-dots="${i}" title="More">${icon('dots')}</button></div>`;
  }
  render() {
    const sc = this.root.querySelector('.scroll')?.scrollTop ?? 0, { next } = this.data, f = this.flags, shown = next.slice(0, this.limit), cur = this.now;
    this.root.innerHTML = `<div class="card"><div class="wrap">
      <div class="caps"><button class="cap ${f.autoplay ? 'on' : ''}" data-act="autoplay" title="Autoplay">${icon('infinity')}</button><button class="cap ${f.automix ? 'on' : ''}" data-act="automix" title="AutoMix">${icon('automix')}</button></div>
      ${cur ? `<div class="lab">Now Playing</div><div class="item cur"><div class="cover" ${bgImg(artSized(cur?.attributes?.artwork?.url, 80))}></div><div class="meta"><div class="t">${esc(trackTitle(cur))}</div><div class="a">${esc(subtitleOf(cur))}</div></div><span></span></div>` : ''}
      <div class="head"><div class="tt"><h2>${f.autoplay ? 'Continue Playing' : 'Playing Next'}</h2>${this.from ? `<div class="from">${esc(fromLine(this.from))}</div>` : ''}</div><button class="clear" data-act="clear">Clear</button></div>
      <div class="rule"></div>
      <div class="scroll">${next.length ? `${shown.map((t, i) => this.row(t, i)).join('')}${next.length > shown.length ? `<button class="more" data-act="more">Show ${Math.min(150, next.length - shown.length)} more</button>` : ''}` : `<div class="empty">Nothing up next.${f.autoplay ? '<br>Autoplay will keep the music going.' : '<br>Turn on autoplay or add songs to the queue.'}</div>`}</div>
    </div></div>`;
    const s = this.root.querySelector('.scroll'); if (s) s.scrollTop = sc;
    this.animateEntries(shown);
  }
}
customElements.get('native-up-next') || customElements.define('native-up-next', NativeUpNext);

// ================= lifecycle =================
// Cider's own sidebar/queue content is hidden (not removed) while ours shows: its DOM stays the source for pins and playlists.
const HIDE_ID = 'native-hide-cider-panels';
const HIDE_CSS = `html.nsb-left .ns-sidebar--left .q-list { visibility: hidden !important; } html.nsb-right .ns-sidebar--right .right-drawer-content, html.nsb-right .ns-sidebar--right .right-drawer-content-freeze { visibility: hidden !important; }`;
function ensureHideCss() { if (!document.getElementById(HIDE_ID)) { const s = document.createElement('style'); s.id = HIDE_ID; s.textContent = HIDE_CSS; document.head.appendChild(s); } }
function dropHideCss() { if (!left && !right) document.getElementById(HIDE_ID)?.remove(); }
const rootClass = (name, on) => document.documentElement.classList.toggle(name, on);

let left = null, leftStops = [];
function placeLeft() {
  if (!left) return;
  const el = document.querySelector(CIDER_LEFT), on = !!el && el.getBoundingClientRect().width >= 180 && !immersive();
  left.classList.toggle('on', on); rootClass('nsb-left', on);
  if (on) place(left, el);
}
async function loadPlaylists() {
  const v3 = app()?.v3; if (!v3 || !left) return;
  const all = []; let offset = 0;
  try {
    for (let page = 0; page < 6; page++) { const res = await v3('/v1/me/library/playlists', { limit: 100, offset }); const body = res?.data ?? {}; all.push(...playlistsFromApi(body.data ?? [])); if (!body.next) break; offset += 100; }
    if (all.length && left) left.setApiPlaylists(all);
  } catch (err) { warn('playlists failed', err); }
}
export function startSidebar({ discover = true } = {}) {
  if (left) { left.setDiscover(discover); return; }
  // once: Music.app's sidebar width (208pt); later drags by the user are kept
  if (ls.get('native/sidebar-width') !== '1') { ls.set('native/sidebar-width', '1'); try { app().appState.leftDrawerWidth = 208; ls.set('leftDrawerWidth', '208'); } catch {} }
  ensureHideCss();
  left = document.createElement('native-sidebar-left'); left.showDiscover = discover; document.body.append(left);
  left.refresh();
  // Cider re-renders its (hidden) sidebar when pins, playlists, the profile or the active row change: refresh from that.
  let scrapeQueued = 0, watched = null;
  const scrapeObserver = new MutationObserver(() => { clearTimeout(scrapeQueued); scrapeQueued = setTimeout(() => left?.refresh(), 250); });
  const watch = () => { const el = document.querySelector(CIDER_LEFT); if (el && el !== watched) { scrapeObserver.disconnect(); scrapeObserver.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'src'] }); watched = el; left?.refresh(); } };
  const inactive = () => left?.classList.toggle('inactive', !document.hasFocus());
  window.addEventListener('focus', inactive); window.addEventListener('blur', inactive); inactive();
  const plTimer = setInterval(loadPlaylists, 5 * 60 * 1000); loadPlaylists();
  leftStops = [
    onFrames(placeLeft),
    onAppearance((look) => left && paint(left, look)),
    // slow check: route (active row), immersive mode, Cider re-creating its sidebar element
    every(() => { trackFrames(); watch(); placeLeft(); try { const p = app()?.PodRouter?.()?.currentPath; if (typeof p === 'string') left?.setActive(p); } catch {} }, { focused: 400, background: 1500 }),
    () => { scrapeObserver.disconnect(); clearTimeout(scrapeQueued); clearInterval(plTimer); window.removeEventListener('focus', inactive); window.removeEventListener('blur', inactive); },
  ];
}
export function stopSidebar() {
  leftStops.forEach((f) => f()); leftStops = [];
  left?.remove(); left = null; rootClass('nsb-left', false); dropHideCss();
}
export const setDiscoverRow = (on) => left?.setDiscover(on);

let right = null, rightStops = [], rightOn = false;
function updateRight() {
  if (!right) return;
  const st = app()?.appState, el = document.querySelector(CIDER_RIGHT);
  const on = !!el && !!st?.rightDrawerOpen && st?.rightDrawerView === 'queue' && el.getBoundingClientRect().width >= 180 && !immersive();
  if (on && !rightOn) right.seen = new Set();
  rightOn = on; right.classList.toggle('on', on); rootClass('nsb-right', on);
  if (on) {
    // once: Music.app's Up Next width (260pt); later drags by the user are kept
    if (ls.get('native/upnext-width') !== '1') { ls.set('native/upnext-width', '1'); try { st.rightDrawerWidth = 260; ls.set('rightDrawerWidth', '260'); } catch {} }
    place(right, el); right.refresh();
  }
}
export function startUpNext() {
  if (right) return;
  ensureHideCss();
  right = document.createElement('native-up-next'); right.style.setProperty('--from', '16px'); document.body.append(right);
  const kick = () => setTimeout(updateRight, 60);
  window.addEventListener(DRAWER_EVENT, kick);
  rightStops = [
    onFrames(updateRight),
    onAppearance((look) => right && paint(right, look)),
    every(() => { trackFrames(); updateRight(); }, { focused: 1000, background: 3000 }),
    () => window.removeEventListener(DRAWER_EVENT, kick),
  ];
}
export function stopUpNext() {
  rightStops.forEach((f) => f()); rightStops = [];
  right?.remove(); right = null; rightOn = false; rootClass('nsb-right', false); dropHideCss();
}

export function sidebarDiagnostics() {
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const s = scrape();
  return { left: { on: !!left?.classList.contains('on'), cider: rect(document.querySelector(CIDER_LEFT)), ours: rect(left), active: left?.active ?? null },
    upNext: { on: rightOn, cider: rect(document.querySelector(CIDER_RIGHT)), ours: rect(right) },
    scraped: s ? { pins: s.pins.length, playlists: s.playlists.length, fav: !!s.fav, profile: !!s.profile } : null };
}
