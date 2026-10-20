// Discover data layer: reads listening signals and Apple's artist graph through Cider's authenticated Apple Music client
// (CiderApp.v3), with an IndexedDB cache, a small concurrency limit and batched artist requests (40 artists with all
// their views in one call), and performs the page's actions (play, love, add, save as a playlist).
import { norm, artistTokens, newPlays } from './discover-engine.js';
import { warn } from './core.js';

const DAY = 864e5, HOUR = 36e5;
const sf = '$STOREFRONT';

// ---- IndexedDB key/value store (cache entries, the play log, results, feedback) ----
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('native-discover', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode), s = t.objectStore('kv'), out = fn(s); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); };
export const kv = {
  get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch((e) => warn('discover: store failed', k, e)),
  del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {}),
  getMany: async (keys) => { const d = await db(); return new Promise((res) => { const t = d.transaction('kv', 'readonly'), s = t.objectStore('kv'), out = new Array(keys.length); keys.forEach((k, i) => { const r = s.get(k); r.onsuccess = () => { out[i] = r.result; }; }); t.oncomplete = () => res(out); t.onerror = () => res(out); }); },
  setMany: async (entries) => { const d = await db(); return new Promise((res) => { const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv'); for (const [k, v] of entries) s.put(v, k); t.oncomplete = res; t.onerror = res; }); },
  // Drop cache entries ({ t, v }) older than maxAge whose key starts with one of the prefixes.
  prune: async (maxAge, prefixes) => {
    const d = await db(), now = Date.now();
    return new Promise((res) => {
      const t = d.transaction('kv', 'readwrite'), c = t.objectStore('kv').openCursor(); let n = 0;
      c.onsuccess = () => { const cur = c.result; if (!cur) return; const k = String(cur.key); if (prefixes.some((p) => k.startsWith(p)) && cur.value?.t && now - cur.value.t > maxAge) { cur.delete(); n++; } cur.continue(); };
      t.oncomplete = () => res(n); t.onerror = () => res(n);
    });
  },
};

// ---- Apple Music requests: limited concurrency, one retry, optional cache ----
export const stats = { calls: 0, cached: 0 };
function limiter(max) {
  let active = 0; const q = [];
  const next = () => { if (active >= max || !q.length) return; active++; const { fn, res, rej } = q.shift(); fn().then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const limit = limiter(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, params, opts) {
  return limit(async () => {
    stats.calls++;
    try { return (await window.CiderApp.v3(path, params, opts))?.data ?? null; }
    catch (e) {
      await sleep(e?.status === 429 ? 2500 : 700);
      try { return (await window.CiderApp.v3(path, params, opts))?.data ?? null; } catch (e2) { warn('discover: request failed', path, e2?.status || e2?.message || e2); return null; }
    }
  });
}
async function cached(key, ttl, fn) {
  const hit = await kv.get(key);
  if (hit && Date.now() - hit.t < ttl) { stats.cached++; return hit.v; }
  const v = await fn();
  if (v != null) kv.set(key, { t: Date.now(), v });
  return v ?? hit?.v ?? null;
}
const rows = (d) => d?.data ?? [];
// Every page of a paginated endpoint (Apple caps page sizes at 100, or 30 for history). When the first page reports a
// total, the rest are requested together.
async function pages(path, params = {}, { size = 100, max = 30 } = {}) {
  const first = await call(path, { ...params, limit: size, offset: 0 }), out = [...rows(first)];
  if (rows(first).length < size || !first?.next) return out;
  const total = first.meta?.total;
  if (total) {
    const n = Math.min(max, Math.ceil(total / size));
    const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => call(path, { ...params, limit: size, offset: (i + 1) * size })));
    rest.forEach((d) => out.push(...rows(d)));
    return out;
  }
  for (let p = 1; p < max; p++) {
    const d = await call(path, { ...params, limit: size, offset: p * size });
    const r = rows(d); out.push(...r);
    if (r.length < size || !d?.next) break;
  }
  return out;
}

// ---- normalising Apple Music song resources ----
const yearOf = (d) => { const y = parseInt(String(d || '').slice(0, 4), 10); return Number.isFinite(y) && y > 1900 ? y : null; };
export const albumIdOf = (url) => (String(url || '').match(/\/album\/[^/]+\/(\d+)/) || [])[1] || null;
export function songFrom(r) {
  const a = r?.attributes; if (!a?.name) return null;
  const catalog = r.relationships?.catalog?.data?.[0];
  const id = r.type === 'songs' ? r.id : a.playParams?.catalogId || catalog?.id || null;
  const artist = (r.relationships?.artists?.data || []).find((x) => x.type === 'artists') || (catalog?.relationships?.artists?.data || [])[0];
  return {
    id: id ? String(id) : null, libraryId: r.type === 'library-songs' ? r.id : null,
    isrc: a.isrc || catalog?.attributes?.isrc || null, name: a.name, artistName: a.artistName, artistId: artist?.id ? String(artist.id) : null,
    albumArtist: a.albumArtistName || catalog?.attributes?.albumArtistName || null,
    albumName: a.albumName || null, albumId: albumIdOf(a.url || catalog?.attributes?.url), genres: a.genreNames || [], releaseDate: a.releaseDate || null, year: yearOf(a.releaseDate),
    durationMs: a.durationInMillis || 0, art: a.artwork?.url || null, bg: a.artwork?.bgColor || null, explicit: a.contentRating === 'explicit', url: a.url || null,
  };
}
const artSize = (u, px) => (u ? u.replace('{w}', px).replace('{h}', px).replace('{f}', 'webp').replace('{c}', 'cc') : null);
export const art = artSize;

// ---------------------------------------------------------------------------------------------------- listening signals
// Library playlists: your own (editable) ones are a strong signal, subscribed Apple ones a weak one, Discover's own output
// none; Favourite Songs is the one non-editable playlist with no catalog version.
const isDiscoverOutput = (p, savedId) => p.id === savedId || /^discover( mix| -)/i.test(p.attributes?.name || '');
const isFavourites = (p) => p.attributes && !p.attributes.canEdit && !p.attributes.canDelete && !p.attributes.hasCatalog;

export async function collectSignals({ savedPlaylistId = null, onStep = () => {} } = {}) {
  const tracks = [], push = (list, source, wOf) => list.forEach((s, i) => { if (s?.artistName) tracks.push({ ...s, source, w: wOf(i, list.length) }); });

  onStep('Reading what you played', 0.04);
  const recentRaw = await pages('/v1/me/recent/played/tracks', { types: 'songs' }, { size: 30, max: 4 });
  const recent = recentRaw.map(songFrom).filter(Boolean);
  push(recent, 'recent', (i) => Math.exp(-i / 45));
  const logged = await updatePlayLog(recent);
  const recentIds = new Set(recent.map((s) => s.id)), older = logged.filter((p) => !recentIds.has(p.id));
  push(older, 'log', (i) => Math.max(0.05, 0.5 ** ((Date.now() - older[i].t) / (60 * DAY))));

  onStep('Reading your favourites and playlists', 0.1);
  const playlists = await cached('c:library-playlists', 6 * HOUR, () => pages('/v1/me/library/playlists', {}, { max: 5 }));
  const discoverIds = new Set();
  const plTracks = (p) => cached(`c2:pl:${p.id}`, 12 * HOUR, async () => (await pages(`/v1/me/library/playlists/${p.id}/tracks`, { include: 'catalog' }, { max: 4 })).map(songFrom).filter(Boolean));
  const fav = playlists.find(isFavourites);
  if (fav) push(await plTracks(fav), 'favourite', () => 1);
  await Promise.all(playlists.filter((p) => p !== fav).map(async (p) => {
    const list = await plTracks(p);
    if (isDiscoverOutput(p, savedPlaylistId)) { list.forEach((s) => s.id && discoverIds.add(s.id)); push(list, 'discover', () => 1); return; }
    const per = Math.min(1, 8 / Math.max(1, list.length));
    push(list, p.attributes?.canEdit ? 'own-playlist' : 'playlist', () => per);
  }));

  onStep('Reading your heavy rotation', 0.18);
  const heavy = rows(await call('/v1/me/history/heavy-rotation', { limit: 10 }));
  await Promise.all(heavy.map(async (h) => {
    const path = h.type === 'albums' ? `/v1/catalog/${sf}/albums/${h.id}/tracks` : h.type === 'playlists' ? `/v1/catalog/${sf}/playlists/${h.id}/tracks`
      : h.type === 'library-playlists' ? `/v1/me/library/playlists/${h.id}/tracks` : h.type === 'library-albums' ? `/v1/me/library/albums/${h.id}/tracks` : null;
    if (!path) return;
    const list = (await cached(`c2:heavy:${h.id}`, DAY, async () => rows(await call(path, { limit: 100, ...(h.type.startsWith('library') ? { include: 'catalog' } : {}) })).map(songFrom).filter(Boolean))) || [];
    push(list, 'heavy', () => 4 / Math.max(1, list.length));
  }));

  onStep('Reading your library', 0.24);
  const library = await cached('c2:library-songs', 12 * HOUR, async () => (await pages('/v1/me/library/songs', { sort: '-dateAdded', include: 'catalog' }, { max: 30 })).map(songFrom).filter(Boolean));
  push(library.filter((s) => !discoverIds.has(s.id)), 'library', (i) => Math.max(0.25, Math.exp(-i / 400)));
  library.filter((s) => discoverIds.has(s.id)).forEach((s) => tracks.push({ ...s, source: 'discover' }));
  const libraryArtists = await cached('c:library-artists', 12 * HOUR, async () => (await pages('/v1/me/library/artists', {}, { max: 15 })).map((a) => a.attributes?.name).filter(Boolean));
  return { tracks, libraryArtists, recent };
}

// Apple only shows the last ~100 plays, so Discover keeps its own log: each time it reads the history, the songs above the
// previously seen head are new plays. Over weeks this gives a much longer memory than the API.
async function updatePlayLog(recent) {
  const log = (await kv.get('playlog')) || [], head = (await kv.get('playlog-head')) || [];
  const ids = recent.map((s) => s.id), cut = newPlays(ids, head);
  const now = Date.now(), fresh = recent.slice(0, cut).map((s, i) => ({ id: s.id, isrc: s.isrc, name: s.name, artistName: s.artistName, artistId: s.artistId, albumName: s.albumName, genres: s.genres, year: s.year, t: now - i * 4 * 60e3 }));
  const next = [...fresh, ...log].slice(0, 5000);
  if (fresh.length) await kv.set('playlog', next);
  if (ids.length && ids.slice(0, 30).join() !== head.join()) await kv.set('playlog-head', ids.slice(0, 30));
  return next;
}
export const refreshPlayLog = async () => { const r = (await pages('/v1/me/recent/played/tracks', { types: 'songs' }, { size: 30, max: 1 })).map(songFrom).filter(Boolean); if (r.length) await updatePlayLog(r); };

// Catalog artist ids for the artists you play most: one representative song (or, for an album artist, album) each, looked
// up in batches and cached for good. artists: [{ name, id?, sampleSongId?, sampleAlbumId?, viaAlbum? }] - ids are written back.
export async function resolveArtistIds(artists) {
  const byAlbum = artists.filter((a) => !a.id && a.viaAlbum && a.sampleAlbumId);
  if (byAlbum.length) {
    const known = new Map(((await kv.get('album-artist')) || []));
    const missing = [...new Set(byAlbum.map((a) => a.sampleAlbumId))].filter((id) => !known.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const d = await call(`/v1/catalog/${sf}/albums`, { ids: missing.slice(i, i + 100).join(','), include: 'artists' });
      for (const r of rows(d)) { const ar = (r.relationships?.artists?.data || []).find((x) => norm(x.attributes?.name) === norm(r.attributes?.artistName)) || r.relationships?.artists?.data?.[0]; if (ar) known.set(r.id, ar.id); }
    }
    if (missing.length) kv.set('album-artist', [...known]);
    for (const a of byAlbum) if (known.has(a.sampleAlbumId)) a.id = String(known.get(a.sampleAlbumId));
  }
  const need = artists.filter((a) => !a.id && !a.viaAlbum);
  if (!need.length) return;
  const songIds = new Map();
  for (const a of need) { const s = a.sampleSongId; if (s) { if (!songIds.has(s)) songIds.set(s, []); songIds.get(s).push(a); } }
  const known = new Map(((await kv.get('song-artist')) || []));
  const missing = [...songIds.keys()].filter((id) => !known.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const d = await call(`/v1/catalog/${sf}/songs`, { ids: missing.slice(i, i + 100).join(','), include: 'artists' });
    for (const r of rows(d)) { const ar = r.relationships?.artists?.data?.[0]; if (ar) known.set(r.id, ar.id); }
  }
  if (missing.length) kv.set('song-artist', [...known]);
  for (const [sid, list] of songIds) if (known.has(sid)) for (const a of list) a.id = String(known.get(sid));
  // whatever is still unresolved (library-only songs with no catalog match): a name search, accepted only on an exact match
  await Promise.all(artists.filter((a) => !a.id).slice(0, 12).map(async (a) => {
    const hit = await cached(`c:search:${norm(a.name)}`, 30 * DAY, async () => { const r = rows((await call(`/v1/catalog/${sf}/search`, { term: a.name, types: 'artists', limit: 3 }))?.results?.artists); return r.map((x) => ({ id: x.id, name: x.attributes?.name })); });
    const m = (hit || []).find((x) => norm(x.name) === norm(a.name)); if (m) a.id = String(m.id);
  }));
}

// ---------------------------------------------------------------------------------------------------- artist graph
const VIEWS_FULL = 'similar-artists,top-songs,latest-release,featured-playlists', VIEWS = 'similar-artists,top-songs';
function nodeFrom(r) {
  const v = r.views || {}, a = r.attributes || {};
  return {
    id: String(r.id), name: a.name, genres: a.genreNames || [], art: a.artwork?.url || null, bg: a.artwork?.bgColor || null,
    similar: (v['similar-artists']?.data || []).map((x) => String(x.id)),
    simInfo: (v['similar-artists']?.data || []).map((x) => ({ id: String(x.id), name: x.attributes?.name, art: x.attributes?.artwork?.url, genres: x.attributes?.genreNames })),
    top: (v['top-songs']?.data || []).map(songFrom).filter(Boolean).map((s) => ({ ...s, artistId: s.artistId || String(r.id) })),
    latest: v['latest-release']?.data?.[0] ? { id: v['latest-release'].data[0].id, name: v['latest-release'].data[0].attributes?.name, artistName: v['latest-release'].data[0].attributes?.artistName, art: v['latest-release'].data[0].attributes?.artwork?.url, releaseDate: v['latest-release'].data[0].attributes?.releaseDate, trackCount: v['latest-release'].data[0].attributes?.trackCount } : null,
    featured: (v['featured-playlists']?.data || []).map((p) => ({ id: p.id, name: p.attributes?.name })),
  };
}
// Artists with their views, 40 per request, each cached for a week.
async function fetchArtists(ids, views) {
  const keys = ids.map((id) => `a:${views === VIEWS_FULL ? 'f' : 's'}:${id}`), hits = await kv.getMany(keys), out = new Map(), missing = [];
  ids.forEach((id, i) => { const h = hits[i]; if (h && Date.now() - h.t < 7 * DAY) { out.set(id, h.v); stats.cached++; } else missing.push(id); });
  const batches = []; for (let i = 0; i < missing.length; i += 40) batches.push(missing.slice(i, i + 40));
  await Promise.all(batches.map(async (b) => {
    const d = await call(`/v1/catalog/${sf}/artists`, { ids: b.join(','), views });
    const got = rows(d).map(nodeFrom); got.forEach((n) => out.set(n.id, n));
    await kv.setMany(got.map((n) => [`a:${views === VIEWS_FULL ? 'f' : 's'}:${n.id}`, { t: Date.now(), v: n }]));
  }));
  return out;
}

// Seeds (with full views) -> their similar artists -> the most promising second-hop artists, scored as it goes.
export async function crawl(seeds, { adventure = 0.5, onStep = () => {}, rank } = {}) {
  const nodes = new Map(), names = new Map();
  const absorb = (m) => { for (const n of m.values()) { nodes.set(n.id, n); n.simInfo.forEach((s) => { if (!nodes.has(s.id) && !names.has(s.id)) names.set(s.id, s); }); } };
  onStep('Finding artists like yours', 0.32);
  absorb(await fetchArtists(seeds.filter((s) => s.id).map((s) => s.id), VIEWS_FULL));
  const prelim = new Map();
  for (const s of seeds) (nodes.get(s.id)?.similar || []).forEach((v, r) => { if (!nodes.has(v)) prelim.set(v, (prelim.get(v) || 0) + s.w / (1 + 0.15 * r)); });
  const hop1 = [...prelim.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.round(120 + 80 * adventure)).map(([id]) => id);
  onStep('Listening around them', 0.48);
  absorb(await fetchArtists(hop1, VIEWS));
  // placeholders for the frontier so ranking can name them; then fetch the best of them
  for (const [id, s] of names) if (!nodes.has(id)) nodes.set(id, { id, name: s.name, genres: s.genres || [], art: s.art || null, similar: null, top: null });
  const ranked = rank(nodes);
  const hop2 = [...ranked.values()].filter((a) => !nodes.get(a.id)?.top).sort((a, b) => b.rel - a.rel).slice(0, Math.round(30 + 50 * adventure)).map((a) => a.id);
  onStep('Exploring further out', 0.66);
  absorb(await fetchArtists(hop2, VIEWS));
  return nodes;
}

// Editorial playlists of your top artists ("Inspired by X", "X: Deep Cuts", "Next Steps"...): songs people chose to sit
// next to an artist you love.
const EDITORIAL = /inspired by|deep cuts|next steps|influences|the roots|in the studio|similar artists/i;
export async function editorial(seeds, nodes, { max = 8 } = {}) {
  const songs = new Map(), artistsMap = new Map(), extra = [];
  const picks = [];
  for (const s of seeds.slice(0, max)) for (const p of nodes.get(s.id)?.featured || []) if (EDITORIAL.test(p.name || '')) picks.push({ seed: s, p });
  await Promise.all(picks.slice(0, 14).map(async ({ seed, p }) => {
    const list = await cached(`c:edpl:${p.id}`, 7 * DAY, async () => rows(await call(`/v1/catalog/${sf}/playlists/${p.id}/tracks`, { limit: 50, include: 'artists' })).map(songFrom).filter(Boolean));
    for (const s of list || []) {
      if (!s.id || songs.has(s.id)) continue;
      songs.set(s.id, { seed: seed.name, playlist: p.name });
      artistTokens(s.artistName).forEach((x) => artistsMap.set(x, { seed: seed.name, playlist: p.name }));
      extra.push(s);
    }
  }));
  return { editorial: songs, editorialArtists: artistsMap, extra };
}

// Artists Apple's own recommendations point at ("X Fans Like", "More Like Y"...): weak, independent evidence.
export async function appleEvidence() {
  const d = await cached('c:recs', 12 * HOUR, async () => rows(await call('/v1/me/recommendations', { limit: 10 })).map((r) => ({ title: r.attributes?.title?.stringForDisplay || '', kind: r.attributes?.kind, items: (r.relationships?.contents?.data || []).map((c) => ({ type: c.type, name: c.attributes?.name, artistName: c.attributes?.artistName })) })));
  const set = new Set();
  for (const r of d || []) if (r.kind === 'music-recommendations') for (const c of r.items) if (c.type === 'albums' && c.artistName) artistTokens(c.artistName).forEach((x) => set.add(x));
  return set;
}

// ---------------------------------------------------------------------------------------------------- actions
const store = () => window.__PLUGINSYS__?.Stores?.appleMusicStore;
async function catalogResources(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...rows(await call(`/v1/catalog/${sf}/songs`, { ids: ids.slice(i, i + 100).join(',') })));
  const by = new Map(out.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
export const QUEUE_ID = 'native-discover';
export async function play(songs, index = 0, { shuffle = false, name = 'Discover' } = {}) {
  const items = await catalogResources(songs.map((s) => s.id));
  if (!items.length) throw new Error('These songs are not available');
  const start = Math.max(0, items.findIndex((r) => r.id === songs[index]?.id));
  await store().setQueueFromItems(items, start, { play: true, shuffle, containerContext: { type: 'playlist', id: QUEUE_ID, name, isManuallyQueued: false } });
}
export const playNext = (s) => window.CiderApp.RPC.mkPlayNext('songs', s.id);
export const playLater = (s) => window.CiderApp.RPC.mkPlayLater('songs', s.id);
export async function addToLibrary(s) {
  await window.CiderApp.v3('/v1/me/library', { 'ids[songs]': [s.id] }, { paramsInURL: true, fetchOptions: { method: 'POST' } });
}
// Favourite (Music's star): rating 1. Apple adds favourites to the library when the account is set up to.
export async function love(s, on = true) {
  await window.CiderApp.v3(`/v1/me/ratings/songs/${s.id}`, {}, { fetchOptions: on ? { method: 'PUT', body: JSON.stringify({ type: 'rating', attributes: { value: 1 } }) } : { method: 'DELETE' } });
}
// One "Discover Mix" playlist, replaced in place on later saves. Catalog songs in a library playlist join the library,
// which is why saving is always a separate, explicit action.
export async function savePlaylist(songs, { name = 'Discover Mix', description = '', savedId = null } = {}) {
  const tracks = songs.map((s) => ({ id: s.id, type: 'songs' })), rpc = window.CiderApp.RPC;
  if (savedId) {
    const cur = await call(`/v1/me/library/playlists/${savedId}/tracks`, { limit: 1 });
    if (cur) {
      const total = cur.meta?.total ?? rows(cur).length;
      const r = await rpc.replacePlaylistTracks(savedId, tracks, { allowLibraryImport: true, expectedTrackCount: total });
      if (r?.ok) { try { await rpc.updatePlaylistMetadata?.(savedId, { description }); } catch {} return { id: savedId, replaced: true }; }
    }
  }
  const r = await rpc.createPlaylist({ name, description, tracks, allowLibraryImport: true });
  if (!r?.ok) throw new Error(r?.error?.message || r?.message || 'Could not create the playlist');
  return { id: r.id, replaced: false };
}
