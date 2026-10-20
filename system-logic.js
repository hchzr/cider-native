// Pure logic for system integration (tested in test/system-logic.test.mjs): no DOM, no Cider globals.

// ---- keyboard shortcuts ----
// Shortcuts are ignored while typing, and never hijack combos the app or OS already owns.
export const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
};

// Music.app's player shortcuts: Cmd+Right/Left = next/previous, Cmd+Up/Down = volume. (Space is Cider's own.)
export const shortcutAction = (e) => {
  if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return null;
  return { ArrowRight: 'next', ArrowLeft: 'previous', ArrowUp: 'volumeUp', ArrowDown: 'volumeDown' }[e.key] ?? null;
};

export const stepVolume = (v, dir, step = 0.05) => Math.round(Math.min(1, Math.max(0, (Number.isFinite(v) ? v : 0) + dir * step)) * 100) / 100;

// ---- track-change notifications ----
// Stable identity of a track, so a notification is shown once per song.
export const trackKey = (np) => (np && np.name ? [np.name, np.artistName, np.albumName].join('␟') : '');

export const notificationFor = (np) => ({ title: np.name, body: [np.artistName, np.albumName].filter(Boolean).join(' — ') });

// ---- window controls ----
// Traffic-light positions in window points: Music.app's (measured) and Cider's own default.
export const TRAFFIC_LIGHTS = { music: { x: 19, y: 19 }, cider: { x: 15, y: 16 } };

// ---- SF Symbols for Quasar icons ----
// A QIcon name ("casino", "o_album", "sym_r_home", "ion-ios-star") reduced to the key used by the generated icon CSS,
// or '' when the theme has no SF Symbol for it (images, svg paths, unknown names).
export const sfIconName = (name, known) => {
  const n = String(name ?? '').trim();
  if (!n || /^(img:|svguse:|M\d|<)/.test(n)) return '';
  const base = n.startsWith('ion-') ? n : n.replace(/^(sym_[ors]_|[ors]_)/, '');
  return known.has(base) ? base : '';
};

// ---- audio path diagnostic ----
// Condenses Cider's runtime audio facts into a verdict that separates what was observed from what is inferred.
export const atmosVerdict = ({ flavor, mode, ec3Supported, outChannels, supportsAtmos, supportedCodecs }) => {
  const observed = { flavor, mode, ec3Supported, outChannels, supportsAtmos, supportedCodecs: supportedCodecs?.length ? supportedCodecs.join(', ') : null };
  const ch = outChannels == null ? 'an unknown number of' : outChannels + '-channel';
  let inference;
  if (flavor !== 'atmos') inference = 'The current stream is not Atmos (flavor=' + flavor + ').';
  else if (!ec3Supported) inference = 'An Atmos stream is playing but this engine cannot decode ec-3, so Cider uses a binaural stereo mix.';
  else if (outChannels != null && outChannels <= 2) inference = 'Atmos (ec-3) is decoded by the browser engine and delivered as ' + ch + ' PCM. macOS cannot treat that as Atmos, so AirPods will not offer Spatial Audio for it.';
  else inference = 'Atmos (ec-3) is decoded by the browser engine and delivered as ' + ch + ' PCM channels. Atmos objects are not preserved, and it is not an Atmos bitstream to the OS.';
  if (mode === 'off') inference += " Cider's Atmos setting is off for this output, yet the stream is Atmos: the stream choice comes from the service, not from this setting.";
  return { observed, inference };
};
