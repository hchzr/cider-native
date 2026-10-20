// The Native settings sheet (opened from "… > Plugins > Native…"): a macOS-style grouped list with one switch per part.
// Changes apply immediately; nothing here needs a relaunch.
import { GROUPS, PARTS } from './settings.js';
import { esc, reducedMotion } from './core.js';

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 7000; display: grid; place-items: center; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; -webkit-app-region: no-drag; color: var(--fg);
  --fg: rgba(255,255,255,.88); --sec: rgba(255,255,255,.5); --win: rgb(36,36,38); --group: rgb(48,48,51); --line: rgba(255,255,255,.08); --ctl: rgba(255,255,255,.12); --knob: #fff; --accent: #fa2d48; }
:host(.light) { --fg: rgba(0,0,0,.86); --sec: rgba(0,0,0,.5); --win: rgb(236,236,238); --group: #fff; --line: rgba(0,0,0,.08); --ctl: rgba(0,0,0,.1); }
* { box-sizing: border-box; -webkit-app-region: no-drag; }
button { all: unset; cursor: default; }
.backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.24); animation: fade .25s ease both; }
@keyframes fade { from { opacity: 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(12px) scale(.97); } }
.sheet { position: relative; width: min(600px, calc(100vw - 48px)); max-height: min(760px, calc(100vh - 64px)); display: flex; flex-direction: column; border-radius: 14px; overflow: hidden;
  background: var(--win); box-shadow: 0 0 0 .5px rgba(0,0,0,.35), inset 0 .5px 0 rgba(255,255,255,.12), 0 24px 70px rgba(0,0,0,.45); animation: rise .38s cubic-bezier(.32,.72,0,1) both; }
:host(.light) .sheet { box-shadow: 0 0 0 .5px rgba(0,0,0,.18), 0 24px 70px rgba(0,0,0,.25); }
header { display: flex; align-items: center; gap: 12px; padding: 18px 20px 14px; }
header .tt { flex: 1; min-width: 0; } header h1 { all: unset; display: block; font-size: 15px; font-weight: 700; }
header p { margin: 2px 0 0; font-size: 12px; color: var(--sec); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 20px 6px; scrollbar-width: thin; }
.body.off .grp:not(.keep) { opacity: .45; pointer-events: none; }
h2 { all: unset; display: block; font-size: 13px; font-weight: 600; margin: 14px 4px 6px; }
.grp { background: var(--group); border-radius: 10px; box-shadow: 0 0 0 .5px var(--line); transition: opacity .2s ease; }
.row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 12px; position: relative; }
.row + .row::before { content: ""; position: absolute; top: 0; left: 12px; right: 0; height: .5px; background: var(--line); }
.row.child { padding-left: 30px; } .row.child + .row::before, .row.child::before { left: 30px; }
.row.dim .txt, .row.dim .ctl { opacity: .4; pointer-events: none; }
.txt { flex: 1; min-width: 0; } .txt b { display: block; font-weight: 400; } .txt > span { display: block; font-size: 11px; color: var(--sec); margin-top: 1px; }
.tag { font-size: 10px; color: var(--sec); border: .5px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 6px; vertical-align: 1px; }
/* macOS switch */
.sw { position: relative; width: 38px; height: 22px; border-radius: 11px; background: var(--ctl); flex: none; transition: background-color .2s ease; }
.sw::after { content: ""; position: absolute; top: 1px; left: 1px; width: 20px; height: 20px; border-radius: 50%; background: var(--knob); box-shadow: 0 1px 2px rgba(0,0,0,.3), 0 0 0 .5px rgba(0,0,0,.06); transition: transform .22s cubic-bezier(.32,.72,0,1); }
.sw[aria-checked=true] { background: var(--accent); } .sw[aria-checked=true]::after { transform: translateX(16px); }
.sw:focus-visible, .seg button:focus-visible, .btn:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; }
/* macOS segmented control */
.seg { display: inline-flex; padding: 2px; border-radius: 7px; background: var(--ctl); flex: none; }
.seg button { padding: 2px 12px; border-radius: 5px; font-size: 12px; }
.seg button[aria-pressed=true] { background: var(--knob); color: #000; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.btn { padding: 3px 12px; border-radius: 6px; background: var(--ctl); font-size: 13px; flex: none; }
.btn:active { filter: brightness(.9); }
.btn.primary { background: var(--accent); color: #fff; padding: 3px 16px; }
.note { font-size: 11px; color: var(--sec); margin: 6px 4px 0; }
footer { display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: .5px solid var(--line); }
footer .grow { flex: 1; }
.out { white-space: pre-wrap; font: 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color: var(--sec); padding: 10px 12px; border-top: .5px solid var(--line); max-height: 180px; overflow: auto; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition-duration: .01ms !important; } }
`;
let sheetCache = null;
const sheet = () => { if (!sheetCache) { sheetCache = new CSSStyleSheet(); sheetCache.replaceSync(CSS); } return sheetCache; };

class NativeSettings extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' }); this.root.adoptedStyleSheets = [sheet()];
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } }, true);
  }
  open(api) {
    this.api = api;
    this.classList.toggle('light', document.body.classList.contains('body--light'));
    this.style.setProperty('--accent', getComputedStyle(document.body).getPropertyValue('--keyColor').trim() || '#fa2d48');
    this.render();
  }
  close() {
    const s = this.root.querySelector('.sheet');
    if (!s || reducedMotion()) { this.remove(); return; }
    s.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    this.root.querySelector('.backdrop').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).onfinish = () => this.remove();
  }
  async onClick(e) {
    const t = e.target.closest('[data-act]');
    if (e.target.classList.contains('backdrop')) return this.close();
    if (!t) return;
    const { act, id, v } = t.dataset, api = this.api;
    if (act === 'part') api.set(id, t.getAttribute('aria-checked') !== 'true');
    else if (act === 'master') api.setEnabled(t.getAttribute('aria-checked') !== 'true');
    else if (act === 'size') api.setPlayerSize(v);
    else if (act === 'reset') api.reset();
    else if (act === 'done') return this.close();
    else if (act === 'audio') { this.output = 'Checking…'; this.render(); const r = await api.audioReport(); this.output = Object.entries(r.observed).map(([k, x]) => `${k}: ${x ?? 'unknown'}`).join('\n') + '\n\n' + r.inference; }
    else if (act === 'diag') { const d = JSON.stringify(api.diagnostics(), null, 1); try { await navigator.clipboard.writeText(d); } catch {} this.output = 'Copied to the clipboard:\n' + d; }
    this.render();
  }
  render() {
    const st = this.api.state(), scroll = this.root.querySelector('.body')?.scrollTop ?? 0;
    const sw = (checked, act, id, label) => `<button class="sw ctl" role="switch" aria-label="${esc(label)}" aria-checked="${checked}" data-act="${act}"${id ? ` data-id="${id}"` : ''} tabindex="0"></button>`;
    const row = (p) => {
      const parentOff = p.parent && !this.isChecked(st, p.parent);
      const desc = p.desc ? `<span>${esc(p.desc)}</span>` : '';
      const ctl = p.choice
        ? `<div class="seg ctl" role="group" aria-label="${esc(p.title)}">${p.choice.map(([v, l]) => `<button data-act="size" data-v="${v}" aria-pressed="${st.playerSize === v}">${esc(l)}</button>`).join('')}</div>`
        : sw(this.isChecked(st, p.id), 'part', p.id, p.title);
      return `<div class="row${p.parent ? ' child' : ''}${parentOff ? ' dim' : ''}"><div class="txt"><b>${esc(p.title)}${p.config ? '<span class="tag">Cider setting</span>' : ''}</b>${desc}</div>${ctl}</div>`;
    };
    const groups = GROUPS.map((g) => {
      const parts = PARTS.filter((p) => p.group === g.id);
      const keep = parts.every((p) => p.config) ? ' keep' : '';
      return `<h2>${esc(g.title)}</h2><div class="grp${keep}">${parts.map(row).join('')}</div>`;
    }).join('');
    this.root.innerHTML = `<div class="backdrop"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Native">
        <header><div class="tt"><h1>Native</h1><p>Make Cider look and behave like Music on macOS. Every change applies immediately.</p></div>${sw(st.enabled, 'master', '', 'Native')}</header>
        <div class="body${st.enabled ? '' : ' off'}">
          ${groups}
          <p class="note">Cider settings are the same switches as in Cider's own Settings, shown here so everything is in one place.</p>
          <h2>Troubleshooting</h2>
          <div class="grp keep">
            <div class="row"><div class="txt"><b>Audio path report</b><span>Why AirPods show Spatial Audio as unavailable for Cider.</span></div><button class="btn" data-act="audio">Show</button></div>
            <div class="row"><div class="txt"><b>Diagnostics</b><span>Copies the state of every part, for bug reports.</span></div><button class="btn" data-act="diag">Copy</button></div>
            ${this.output ? `<div class="out">${esc(this.output)}</div>` : ''}
          </div>
          <div style="height:10px"></div>
        </div>
        <footer><button class="btn" data-act="reset">Reset to Defaults</button><span class="grow"></span><button class="btn primary" data-act="done">Done</button></footer>
      </div>`;
    const b = this.root.querySelector('.body'); if (b) b.scrollTop = scroll;
  }
  isChecked(st, id) { const p = PARTS.find((x) => x.id === id); return p?.config ? !!st.config[id] : !!st.parts[id]; }
}
customElements.get('native-settings') || customElements.define('native-settings', NativeSettings);

export function openPanel(api) {
  document.querySelector('native-settings')?.remove();
  const el = document.createElement('native-settings');
  document.body.appendChild(el); el.open(api);
  return el;
}
