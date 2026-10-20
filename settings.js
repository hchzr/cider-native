// Settings model for Native (tested in test/settings.test.mjs): which parts exist, their defaults, and how a stored
// settings object is read, migrated and resolved. No DOM, no Cider globals.
//
// A part is one of:
//   css     - stylesheets from css/ injected while the part is on
//   module  - a runtime module (sidebar, player, ...) started/stopped with the part
//   config  - a Cider setting; its state *is* Cider's config value, so Cider's own Settings and this panel never disagree
// `parent` makes a part depend on another (shown indented, inactive while the parent is off).

export const GROUPS = [
  { id: 'interface', title: 'Interface' },
  { id: 'pages', title: 'Pages' },
  { id: 'covers', title: 'Covers and Effects' },
  { id: 'system', title: 'System' },
];

export const PARTS = [
  { id: 'sidebar', group: 'interface', title: 'Sidebar', desc: "Music's sidebar with SF Symbols, a search field, pins and playlists.", module: 'sidebar' },
  { id: 'discover', group: 'interface', title: 'Discover', desc: "A page of new music picked from your listening, with mixes for each of your tastes; it learns from what you keep.", module: 'discover' },
  { id: 'upNext', group: 'interface', title: 'Up Next panel', desc: "Music's queue panel with Autoplay and AutoMix.", module: 'upNext' },
  { id: 'player', group: 'interface', title: 'Floating player', desc: "A glass player in place of Cider's bottom bar.", module: 'player' },
  { id: 'playerSize', group: 'interface', parent: 'player', title: 'Player size', choice: [['small', 'Smaller'], ['default', 'Default'], ['large', 'Larger']] },
  { id: 'toolbar', group: 'interface', title: 'Toolbar', desc: 'Plain toolbar buttons; library titles and controls sit in the title bar.', css: ['toolbar'] },
  { id: 'windowControls', group: 'interface', title: 'Window controls', desc: 'Close, minimise and zoom buttons where Music places them.', module: 'windowControls' },
  { id: 'icons', group: 'interface', title: 'SF Symbols', desc: "Draws Cider's icons with the macOS symbol set.", css: ['icons'], module: 'icons' },
  { id: 'font', group: 'interface', title: 'System font', desc: 'SF Pro for the interface and lyrics.', css: ['font'] },
  { id: 'accent', group: 'interface', title: 'Apple Music red', desc: "Music's red as the accent colour.", css: ['accent'] },

  { id: 'layout', group: 'pages', title: 'Window layout', desc: 'Content runs edge to edge and under the glass sidebar, on a plain background.', css: ['layout'] },
  { id: 'content', group: 'pages', title: 'Home and browse', desc: "Music's spacing and card corners; shelves run to the window edge.", css: ['content'] },
  { id: 'pages', group: 'pages', title: 'Album, playlist and artist pages', desc: "Music's page headers and track lists.", css: ['pages'] },
  { id: 'library', group: 'pages', title: 'Library lists', desc: 'Songs and Artists lists styled like Music.', css: ['library'] },
  { id: 'macSizing', group: 'pages', title: 'Compact Mac sizing', desc: "Cider's desktop density: smaller rows and text.", config: { path: 'visual.sizing', on: 'desktop', off: 'default' }, recommended: true },

  { id: 'motion', group: 'covers', title: 'Animations', desc: 'Apple-style menus, sheets, page changes and press feedback.', css: ['motion'] },
  { id: 'animatedCovers', group: 'covers', title: 'Animated covers', desc: 'Motion artwork on Home, albums and playlists.', config: { path: 'appleMusic.animatedArtwork', on: true, off: false }, recommended: true },
  { id: 'coversInBackground', group: 'covers', parent: 'animatedCovers', title: 'Keep covers moving in the background', desc: "Covers keep playing when Cider isn't the front window, as in Music.", config: { path: 'visual.pauseAnimatedOnBlur', on: false, off: true }, recommended: true },
  { id: 'efficientEffects', group: 'covers', title: 'Efficient background effects', desc: 'Caps animated backgrounds at 30 frames per second.', config: { path: 'visual.artworkBlurMap.fpsLimit', on: 30, off: 60 }, recommended: true },

  { id: 'scrollbars', group: 'system', title: 'Overlay scrollbars', desc: 'Thin macOS scrollbars that show while scrolling.', css: ['scrollbars'] },
  { id: 'arrowCursor', group: 'system', title: 'Arrow pointer', desc: 'The arrow pointer on buttons and items, like native apps.', css: ['cursor'] },
  { id: 'notifications', group: 'system', title: 'Song notifications', desc: 'A notification when the song changes while Cider is in the background.', module: 'notifications' },
  { id: 'shortcuts', group: 'system', title: 'Music keyboard shortcuts', desc: '⌘→ and ⌘← for next and previous, ⌘↑ and ⌘↓ for volume.', module: 'shortcuts' },
];

export const PART = Object.fromEntries(PARTS.map((p) => [p.id, p]));
export const PLAYER_SCALE = { small: 0.92, default: 1, large: 1.1 };
export const STORAGE_KEY = 'native/settings';

// Parts whose state lives in this plugin (everything except Cider settings and choices).
const OWN = PARTS.filter((p) => !p.config && !p.choice);

export const defaultSettings = () => ({ v: 1, enabled: true, parts: Object.fromEntries(OWN.map((p) => [p.id, true])), playerSize: 'default', recommendedApplied: false });

// Stored JSON -> a complete, valid settings object (unknown keys dropped, wrong types replaced by defaults).
export function parseSettings(raw) {
  const d = defaultSettings();
  let o; try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  if (!o || typeof o !== 'object') return d;
  const parts = { ...d.parts };
  for (const id of Object.keys(parts)) if (typeof o.parts?.[id] === 'boolean') parts[id] = o.parts[id];
  if (typeof o.parts?.discoverRow === 'boolean' && typeof o.parts?.discover !== 'boolean') parts.discover = o.parts.discoverRow;   // before 1.4
  return {
    v: 1, parts,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    playerSize: PLAYER_SCALE[o.playerSize] ? o.playerSize : d.playerSize,
    recommendedApplied: o.recommendedApplied === true,
  };
}

// Settings carried over from the four separate plugins this one replaces (read through `get(key)`).
export function migrateLegacy(get) {
  const s = defaultSettings();
  if (get('native-sidebars/enabled') === '0') s.parts.sidebar = false;
  if (get('native-player/enabled') === '0') s.parts.player = false;
  if (get('native-extras/notify') === '0') s.parts.notifications = false;
  if (get('native-extras/shortcuts') === '0') s.parts.shortcuts = false;
  const scale = +get('native-player/scale');
  if (scale && scale < 0.97) s.playerSize = 'small'; else if (scale > 1.03) s.playerSize = 'large';
  return s;
}
export const LEGACY_KEYS = ['native-sidebars/enabled', 'native-sidebars/hide-buttons', 'native-sidebars/width-v1', 'native-sidebars/upnext-width-v2',
  'native-player/enabled', 'native-player/scale', 'native-extras/notify', 'native-extras/notifyWhenFocused', 'native-extras/shortcuts', 'native-extras/perf-applied',
  'native-extras/material', 'native-window/settings'];
// Legacy keys whose values are still useful, under their new names.
export const RENAMED_KEYS = { 'native-sidebars/playlists': 'native/playlists', 'native-sidebars/pins-open': 'native/pins-open' };

// Whether a plugin-owned part should be running: the master switch, the part itself, and its parent chain.
export function isOn(settings, id) {
  const p = PART[id];
  if (!p || p.config || p.choice) return false;
  if (!settings.enabled || settings.parts[id] !== true) return false;
  return p.parent ? isOn(settings, p.parent) : true;
}

// State of a Cider-setting part, read from Cider's config.
export const configOn = (part, getValue) => getValue(part.config.path) === part.config.on;

// The stylesheet ids that should be injected for a settings object.
export const activeStyles = (settings) => [...new Set(PARTS.filter((p) => p.css && isOn(settings, p.id)).flatMap((p) => p.css))];

// Cider settings to write once so a fresh install gets the recommended behaviour (only keys Cider actually has).
export const recommendedPlan = (getValue) => PARTS
  .filter((p) => p.config && p.recommended && getValue(p.config.path) !== undefined && getValue(p.config.path) !== p.config.on)
  .map((p) => [p.config.path, p.config.on]);
