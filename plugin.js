// Native - makes Cider look and behave like Music on macOS.
// One plugin, one menu entry ("… > Plugins > Native…"), and every part can be switched on or off live from that sheet.
// Console: CiderNative.open() | .set('sidebar', false) | .setEnabled(false) | .diagnose()
import { PARTS, PART, STORAGE_KEY, LEGACY_KEYS, RENAMED_KEYS, PLAYER_SCALE, defaultSettings, parseSettings, migrateLegacy, isOn, configOn, activeStyles, recommendedPlan } from './settings.js';
import { STYLES } from './styles.js';
import { app, ls, warn, refreshAppearance } from './core.js';
import { startSidebar, stopSidebar, setDiscoverRow, startUpNext, stopUpNext, sidebarDiagnostics } from './sidebar.js';
import { startPlayer, stopPlayer, setPlayerScale, playerDiagnostics } from './player.js';
import { startNotifications, stopNotifications, startShortcuts, stopShortcuts, startWindowControls, stopWindowControls, startIcons, stopIcons, iconsDiagnostics, audioReport } from './system.js';
import { openPanel } from './panel.js';

const VERSION = '1.3.0';
const MODULES = {
  sidebar: { start: (s) => startSidebar({ discover: isOn(s, 'discoverRow') }), stop: stopSidebar },
  upNext: { start: startUpNext, stop: stopUpNext },
  player: { start: (s) => startPlayer({ scale: PLAYER_SCALE[s.playerSize] }), stop: stopPlayer },
  windowControls: { start: startWindowControls, stop: stopWindowControls },
  icons: { start: startIcons, stop: stopIcons },
  notifications: { start: startNotifications, stop: stopNotifications },
  shortcuts: { start: startShortcuts, stop: stopShortcuts },
};

let settings = defaultSettings();
const running = new Set();
const config = () => app()?.config;
const getValue = (path) => { try { return config()?.getValue?.(path); } catch { return undefined; } };
const save = () => ls.set(STORAGE_KEY, JSON.stringify(settings));

// ---- applying settings ----
function applyStyles() {
  const want = settings.enabled ? ['base', ...activeStyles(settings)] : [];
  for (const el of document.querySelectorAll('style[data-native]')) if (!want.includes(el.dataset.native)) el.remove();
  for (const id of want) {
    if (document.querySelector(`style[data-native="${id}"]`) || !STYLES[id]) continue;
    const st = document.createElement('style'); st.dataset.native = id; st.textContent = STYLES[id]; document.head.appendChild(st);
  }
  refreshAppearance();
}
function applyModules() {
  for (const p of PARTS) {
    if (!p.module) continue;
    const want = isOn(settings, p.id), mod = MODULES[p.module];
    try {
      if (want && !running.has(p.module)) { mod.start(settings); running.add(p.module); }
      else if (!want && running.has(p.module)) { mod.stop(); running.delete(p.module); }
    } catch (err) { warn(`${p.module} failed to ${want ? 'start' : 'stop'}`, err); }
  }
  setDiscoverRow(isOn(settings, 'discoverRow'));
  setPlayerScale(PLAYER_SCALE[settings.playerSize]);
}
const apply = () => { applyStyles(); applyModules(); };

function writeConfig(pairs) {
  const c = config(); if (!c?.setValue) return;
  for (const [path, value] of pairs) if (getValue(path) !== undefined) c.setValue(path, value);   // never creates unknown keys
  c.saveConfig?.();
}

// ---- public API (panel + console) ----
const api = {
  version: VERSION,
  state: () => ({ ...settings, parts: { ...settings.parts }, config: Object.fromEntries(PARTS.filter((p) => p.config).map((p) => [p.id, configOn(p, getValue)])) }),
  set(id, on) {
    const p = PART[id]; if (!p || p.choice) return;
    if (p.config) { writeConfig([[p.config.path, on ? p.config.on : p.config.off]]); return; }
    settings.parts[id] = !!on; save(); apply();
  },
  setEnabled(on) { settings.enabled = !!on; save(); apply(); },
  setPlayerSize(size) { if (PLAYER_SCALE[size]) { settings.playerSize = size; save(); setPlayerScale(PLAYER_SCALE[size]); } },
  reset() { settings = { ...defaultSettings(), recommendedApplied: true }; save(); writeConfig(recommendedPlan(getValue)); apply(); },
  open: () => openPanel(api),
  audioReport,
  diagnostics: () => ({
    version: VERSION, settings: api.state(), modules: [...running], styles: [...document.querySelectorAll('style[data-native]')].map((e) => e.dataset.native),
    path: (() => { try { return app()?.PodRouter?.()?.currentPath ?? null; } catch { return null; } })(),
    sidebar: sidebarDiagnostics(), player: playerDiagnostics(), icons: iconsDiagnostics(),
  }),
};

// ---- first run: settings from the four plugins and the theme this one replaces ----
function migrate() {
  const s = migrateLegacy(ls.get);
  // keep "already sized once" flags so the user's sidebar / Up Next widths are not reset
  if (ls.get('native-sidebars/width-v1') === '1') ls.set('native/sidebar-width', '1');
  if (ls.get('native-sidebars/upnext-width-v2') === '1') ls.set('native/upnext-width', '1');
  for (const [from, to] of Object.entries(RENAMED_KEYS)) { const v = ls.get(from); if (v !== null && ls.get(to) === null) ls.set(to, v); ls.del(from); }
  for (const k of LEGACY_KEYS) ls.del(k);
  // The old "Native" theme's stylesheets are part of this plugin now: switch them off in Cider's theme list, keeping the
  // user's choice of the two optional ones (red accent, system font).
  try {
    const vapp = (document.querySelector('[data-v-app]') || document.getElementById('q-app'))?.__vue_app__;
    const store = vapp?.config?.globalProperties?.$pinia?._s?.get('theme-store');
    const old = [...(store?.appliedThemes ?? [])].filter((t) => typeof t === 'string' && t.startsWith('native/'));
    if (old.length) {
      if (!old.includes('native/accent-red.css')) s.parts.accent = false;
      if (!old.includes('native/system-font.css')) s.parts.font = false;
      for (const t of old) { const i = t.indexOf('/'); store.toggleTheme(t.slice(0, i), t.slice(i + 1)); }
    }
  } catch (err) { warn('could not retire the old Native theme', err); }
  return s;
}

function registerMenu() {
  const menu = window.__PLUGINSYS__?.Components?.MainMenu; if (!menu) return false;
  menu.addMenuItem({ label: 'Native…', onClick: () => api.open() });
  return true;
}

export default {
  name: 'Native', identifier: 'native', pluginKitVersion: 1,
  setup() {
    const raw = ls.get(STORAGE_KEY);
    settings = raw ? parseSettings(raw) : migrate();
    if (!settings.recommendedApplied) { writeConfig(recommendedPlan(getValue)); settings.recommendedApplied = true; }
    save();
    window.CiderNative = api;
    apply();
    if (!registerMenu()) setTimeout(registerMenu, 1500);   // the plugin API object can appear slightly after plugins load
  },
};
