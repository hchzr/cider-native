// Pure logic for the sidebar and Up Next panel (tested in test/sidebar-logic.test.mjs). No DOM, no Cider globals.

// Rows copied from Apple Music's sidebar. Search comes first, like Music's.
export const SEARCH = { id: 'search', label: 'Search', path: '/am/search', icon: 'search' };
export const PRIMARY = [
  { id: 'home', label: 'Home', path: '/am/home', icon: 'home' },
  { id: 'new', label: 'New', path: '/am/browse', icon: 'grid' },
  { id: 'radio', label: 'Radio', path: '/am/radio', icon: 'radio' },
];
export const LIBRARY = [
  { id: 'recent', label: 'Recently Added', path: '/am/library/recently-added', icon: 'clock' },
  { id: 'artists', label: 'Artists', path: '/am/library/artists', icon: 'mic' },
  { id: 'albums', label: 'Albums', path: '/am/library/albums', icon: 'stack' },
  { id: 'songs', label: 'Songs', path: '/am/library/songs', icon: 'note' },
  { id: 'videos', label: 'Music Videos', path: '/am/library/music-videos', icon: 'video' },
  { id: 'madeforyou', label: 'Made for You', path: '/am/home/made-for-you', icon: 'person' },
];
export const PLAYLISTS_ROOT = { id: 'allplaylists', label: 'All Playlists', path: '/am/library/playlist-folder/p.playlistsroot', icon: 'grid9' };

export const playlistPath = (id) => `/am/container/library-playlist/${encodeURIComponent(id)}`;
export const searchPath = (q) => `/am/search/?term=${encodeURIComponent(String(q).trim())}`;

// Which sidebar row corresponds to the current route (most specific first: made-for-you lives under /am/home).
export const activeNav = (path = '') => {
  const p = String(path).split('?')[0];
  const m = p.match(/^\/am\/container\/library-playlist\/([^/]+)/);
  if (m) return `pl:${decodeURIComponent(m[1])}`;
  if (p.startsWith('/am/library/playlist-folder')) return PLAYLISTS_ROOT.id;
  if (p === '/am/listen-now' || p.startsWith('/am/listen-now/')) return 'home';   // Cider's own Home button opens /am/listen-now
  const all = [SEARCH, ...PRIMARY, ...LIBRARY].sort((x, y) => y.path.length - x.path.length);
  for (const n of all) if (p === n.path || p.startsWith(n.path + '/')) return n.id;
  return '';
};

// Library playlists from the Apple Music API: [{id, name, art}] (art url has {w}x{h} placeholders).
export const playlistsFromApi = (rows = []) => rows
  .filter((r) => r?.id && r.attributes?.name)
  .map((r) => ({ id: r.id, name: r.attributes.name, art: r.attributes.artwork?.url ?? null }));

export const artSized = (url, px = 44) => (url ? url.replace(/\{w\}/g, px).replace(/\{h\}/g, px).replace(/\{f\}/g, 'jpg').replace(/\{c\}/g, 'bb') : '');

export const initials = (name = '') => (String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '♪');

// ---- Up Next ----
export const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

// "41 songs · 2 hr 8 min"
export const queueSummary = (tracks = []) => {
  const n = tracks.length;
  if (!n) return '';
  const totalMin = Math.round(tracks.reduce((a, t) => a + (Number(t?.attributes?.durationInMillis) || 0), 0) / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const dur = h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
  return `${n} song${n === 1 ? '' : 's'} · ${dur}`;
};

// Split Cider's queue slice into {history, current, next}. `position` is the absolute index of the playing track;
// `start` is the absolute index of the slice's first item (0 when the whole queue was read).
export const splitQueue = (slice, start = 0) => {
  const items = (slice?.items ?? []).map((i) => i?.track ?? i).filter(Boolean);
  const abs = Number.isInteger(slice?.position) ? slice.position : 0;
  const rel = Math.max(0, abs - start);
  return { history: items.slice(0, rel), current: items[rel] ?? null, next: items.slice(rel + 1), position: abs };
};

// Absolute queue index of the i-th "next" row.
export const absoluteIndex = (position, i) => position + 1 + i;

// Cheap change detection so the full queue is only re-read when it can have changed.
export const queueSignature = (s) => `${s?.position}|${s?.total}`;

// Moving a row: drag from `from` (index within next) onto `to` (index within next) -> absolute indexes for queueMoveToPosition.
export const moveArgs = (position, from, to) => [absoluteIndex(position, from), absoluteIndex(position, to)];

export const trackTitle = (t) => t?.attributes?.name ?? '';
export const trackArtist = (t) => t?.attributes?.artistName ?? '';
export const isExplicit = (t) => t?.attributes?.contentRating === 'explicit';

// ---- placement that survives zoom/scale (pure) ----
// After setting style px values, the element may render scaled (CSS zoom etc). k = rendered / requested.
export const fitScale = (requestedPx, renderedPx) => (requestedPx > 0 && renderedPx > 0 && Number.isFinite(renderedPx / requestedPx) ? renderedPx / requestedPx : 1);
// Style values that render at the wanted visual rect given scale k.
export const compensate = (target, k) => ({ left: target.left / k, top: target.top / k, width: target.width / k, height: target.height / k });
export const needsCorrection = (target, actual, tol = 1.5) => Math.abs(target.left - actual.left) > tol || Math.abs(target.top - actual.top) > tol || Math.abs(target.width - actual.width) > tol || Math.abs(target.height - actual.height) > tol;

// ---- Up Next copy of Apple Music's "Continue Playing" ----
// "Artist \u2014 Album" (either part may be missing).
export const subtitleOf = (t) => [t?.attributes?.artistName, t?.attributes?.albumName].filter(Boolean).join(' \u2014 ');
// Name of the album/playlist the queue came from, for the "From ..." line (best effort: Cider does not document the shape).
export const containerName = (item) => {
  const c = item?.containerContext ?? item?.track?.containerContext;
  return c?.name ?? c?.attributes?.name ?? c?.title ?? '';
};
export const fromLine = (name) => (name ? `From ${name}` : '');
// First non-empty container name in a slice.
export const sourceName = (slice) => (slice?.items ?? []).map(containerName).find(Boolean) ?? '';

// ---- scraping Cider's own (hidden) sidebar so pins/playlists/favourites match it exactly ----
export const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const isFavouritesLabel = (s) => /favou?rite\s+songs?|morceaux\s+pr[ée]f[ée]r[ée]s/i.test(cleanName(s));
export const isActiveClass = (cls) => /(^|[\s-])(active|selected|router-link-active|current)([\s-]|$)/i.test(String(cls ?? ''));
export const rowKey = (kind, index, name) => `${kind}:${index}:${cleanName(name)}`;

// ---- round 5 helpers ----
// Pick an artwork URL from whatever the (lazy-loaded) element exposes.
export const pickArt = ({ src, currentSrc, dataSrc, bg } = {}) => {
  const ok = (u) => (u && !/^data:image\/gif;base64,R0lGOD/.test(u) ? u : null);
  const fromBg = typeof bg === 'string' ? (bg.match(/url\((['"]?)(.*?)\1\)/)?.[2] ?? null) : null;
  return ok(currentSrc) || ok(src) || ok(dataSrc) || ok(fromBg) || null;
};
// name -> artwork from the API playlists, as a fallback when a pinned row has no artwork element.
export const artByName = (playlists = []) => { const m = new Map(); for (const p of playlists) if (p?.name && p.art && !m.has(cleanName(p.name))) m.set(cleanName(p.name), p.art); return m; };
// A "track-like" object for the currently playing song, from RPC.playbackSnapshot().nowPlaying.
export const nowPlayingTrack = (snap) => {
  const np = snap?.nowPlaying; if (!np?.name) return null;
  return { id: 'now', attributes: { name: np.name, artistName: np.artistName ?? '', albumName: np.albumName ?? '', artwork: np.artwork ?? null, contentRating: np.contentRating, durationInMillis: np.durationInMillis } };
};
// Which of Cider's own top buttons (Home/New/Radio) to forward a click to, by label (localized-safe: falls back to position).
export const topIndex = (id) => ({ home: 0, new: 1, radio: 2 }[id] ?? -1);
