// Discover: the page behind the sidebar's "Discover New Music" row (Cider hosts it at /ugc/plugins/ce/native-discover).
// The generation job, its result and the feedback live here at module level; the page element is recreated by Cider on
// every visit and only renders that state. See discover-engine.js for how songs are chosen.
import { buildProfile, creditOf, shortName, pickSeeds, clusterSeeds, rankArtists, candidateSongs, scoreSongs, weightsFor, learnWeights, selectMix, quotasFor, sequence, reasonFor, tasteSummary, mixTitles, prettyGenre, norm, artistTokens, parseDiscoverSettings, DISCOVER_DEFAULTS, describeLearning } from './discover-engine.js';
import * as data from './discover-data.js';
import { DISCOVER as G, sfCss, sfTag } from './sf.js';
import { app, rpc, ls, esc, go, warn, every, reducedMotion } from './core.js';

export const PAGE = 'native-discover', PATH = `/ugc/plugins/ce/${PAGE}`;
const LS_SETTINGS = 'native/discover', LS_SAVED = 'native/discover-playlist';
const HOUR = 36e5, DAY = 864e5, REFRESH = { daily: DAY, weekly: 7 * DAY, manual: Infinity };
const icon = (k) => sfTag(G, k);
const art = (u, px) => esc(data.art(u, px) || '');

// ---------------------------------------------------------------------------------------------------- state
const S = { status: 'idle', step: '', progress: 0, error: null, result: null, settings: parseDiscoverSettings(ls.get(LS_SETTINGS)), fb: null, note: '', nowPlaying: null, playing: false };
const subs = new Set();
const emit = () => { for (const f of subs) { try { f(); } catch (e) { warn(e); } } };
let memo = null, job = null, loaded = null, noteTimer = 0;
const note = (t) => { S.note = t; clearTimeout(noteTimer); noteTimer = setTimeout(() => { S.note = ''; emit(); }, 3800); emit(); };

function load() {
  if (!loaded) loaded = (async () => {
    S.fb = { examples: [], artists: {}, genres: {}, blocked: [], dismissed: [], labeled: {}, ...((await data.kv.get('feedback')) || {}) };
    S.result = S.result || (await data.kv.get('result')) || null;
  })();
  return loaded;
}
const saveFb = () => data.kv.set('feedback', S.fb);
function setSettings(patch) { S.settings = parseDiscoverSettings({ ...S.settings, ...patch }); ls.set(LS_SETTINGS, JSON.stringify(S.settings)); }

// ---- feedback: every reaction is a labelled example for the learner and nudges the artist and genre ----
const LABEL = { love: [1, 1.5], add: [1, 1], kept: [1, 0.8], played: [1, 0.5], dismiss: [0, 1.5], block: [0, 2], skip: [0, 0.5] };
const mainArtist = (name) => artistTokens(name)[1] || norm(name);
function label(song, kind) {
  const fb = S.fb, [y, w] = LABEL[kind], key = `${song.id}:${kind}`;
  if (!fb || fb.labeled[key]) return false;
  if (kind === 'played' && fb.labeled[`${song.id}:skip`]) return false;
  fb.labeled[key] = 1;
  if (song.f) fb.examples = [...fb.examples, { f: song.f, y, w, t: Date.now(), k: kind }].slice(-400);
  const a = mainArtist(song.artistName), sign = y ? 1 : -1;
  fb.artists[a] = (fb.artists[a] || 0) + sign * w;
  if (song.genre) fb.genres[song.genre] = (fb.genres[song.genre] || 0) + sign * w * 0.5;
  return true;
}
// What happened to the last mix since it was made: favourited, added to the library, played (from any device).
function implicitFeedback(prev, tracks) {
  if (!prev?.mix?.length) return;
  const ids = (src) => new Set(tracks.filter((t) => t.source === src).map((t) => t.id));
  const fav = ids('favourite'), lib = ids('library'), rec = ids('recent'), saved = new Set(prev.savedIds || []);
  for (const s of [...prev.mix, ...(prev.mixes || []).flatMap((m) => m.songs)]) {
    if (fav.has(s.id)) label(s, 'love');
    else if (lib.has(s.id) && !saved.has(s.id)) label(s, 'kept');
    if (rec.has(s.id)) label(s, 'played');
  }
  saveFb();
}

// ---------------------------------------------------------------------------------------------------- generation
const step = (text, progress) => { S.step = text; S.progress = progress; emit(); };

async function gather(prev) {
  const saved = ls.get(LS_SAVED);
  const { tracks, libraryArtists, recent } = await data.collectSignals({ savedPlaylistId: saved, onStep: step });
  implicitFeedback(prev, tracks);
  const blocked = S.fb.blocked.map((b) => b.name);
  let profile = buildProfile({ tracks, libraryArtists, blocked });
  if (!profile.artists.length) throw new Error('Play some music first: Discover learns from what you listen to.');
  // catalog ids for the artists that matter, then rebuild so their songs share one artist key
  step('Matching your artists', 0.28);
  const sample = new Map();
  for (const t of tracks) {
    if (!t.artistName || t.source === 'discover') continue;
    const k = norm(creditOf(t).name), cur = sample.get(k) || {};
    sample.set(k, { song: cur.song || t.id, album: cur.album || t.albumId });
  }
  const top = profile.artists.slice(0, 70).map((a) => ({ name: a.name, id: a.id, viaAlbum: a.viaAlbum, sampleSongId: sample.get(norm(a.name))?.song, sampleAlbumId: sample.get(norm(a.name))?.album }));
  await data.resolveArtistIds(top);
  const idOf = new Map(top.filter((a) => a.id).map((a) => [norm(a.name), a.id]));
  for (const t of tracks) {
    if (!t.artistName) continue;
    const c = creditOf(t), id = c.id ? null : idOf.get(norm(c.name));
    if (id) { if (c.viaAlbum) t.albumArtistId = id; else t.artistId = id; }
  }
  profile = buildProfile({ tracks, libraryArtists, blocked });
  const seeds = pickSeeds(profile, 30).filter((s) => s.id);
  if (!seeds.length) throw new Error('Your artists could not be found in the Apple Music catalogue.');
  const adventure = S.settings.adventure;
  const nodes = await data.crawl(seeds, { adventure, onStep: step, rank: (n) => rankArtists(n, seeds, clusterSeeds(seeds, n), { adventure }) });
  const clusters = clusterSeeds(seeds, nodes);
  step('Reading editors’ picks', 0.8);
  const [ed, apple] = await Promise.all([data.editorial(seeds, nodes), data.appleEvidence()]);
  return { at: Date.now(), profile, seeds, nodes, clusters, ed, apple, recent };
}

const slim = (c) => ({ id: c.id, name: c.name, artistName: c.artistName, artistId: c.artistId || null, albumName: c.albumName, albumId: c.albumId || null, art: c.art, bg: c.bg, durationMs: c.durationMs, explicit: c.explicit, year: c.year, genre: c.genre, reason: reasonFor(c), knownArtist: c.knownArtist, hop: c.hop, cluster: c.cluster, f: c.f, score: +(c.score || 0).toFixed(3) });
const eraOk = (c, era, year) => era === 'any' || !c.year || (era === 'recent' ? c.year >= year - 4 : era === 'classic' ? c.year <= year - 20 : true);

function compose(m, st, fb, shown) {
  const a = st.adventure, year = new Date().getFullYear();
  const ranked = rankArtists(m.nodes, m.seeds, m.clusters, { adventure: a }), titles = mixTitles(m.clusters);
  const feedback = { artists: new Map(Object.entries(fb.artists)), genres: new Map(Object.entries(fb.genres)) };
  // your own top artists are candidates too, for their deeper cuts (they are not in the ranking: it starts from them)
  const sources = new Map(ranked);
  for (const c of m.clusters) for (const s of c.seeds) if (s.id && !sources.has(s.id)) sources.set(s.id, { id: s.id, name: s.name, relN: 0.5, viaN: 0, via: [], hop: 1, cluster: c.id, fame: ranked.fame?.(s.id) || 0 });
  let cands = candidateSongs(m.nodes, sources, m.profile, { ...m.ed, apple: m.apple, feedback, shown: shown.penalty }, { adventure: a });
  const genreCount = new Map(); for (const c of cands) if (c.genre) genreCount.set(c.genre, (genreCount.get(c.genre) || 0) + 1);
  const dismissed = new Set(fb.dismissed), blocked = new Set(fb.blocked.map((b) => norm(b.name)));
  const skip = new Set(st.skipClusters), avoid = new Set(st.avoidGenres);
  cands = cands.filter((c) => !dismissed.has(c.id) && !shown.exclude.has(c.id) && !artistTokens(c.artistName).some((t) => blocked.has(t))
    && !(c.cluster && skip.has(c.cluster)) && !(c.genre && avoid.has(c.genre)) && (st.deepCuts || !c.knownArtist) && eraOk(c, st.era, year));
  const learned = learnWeights(fb.examples);
  scoreSongs(cands, weightsFor(a, learned));
  const clusters = m.clusters.filter((c) => !skip.has(c.id));
  const picks = selectMix(cands, { count: st.length, quotas: quotasFor(clusters, st.length), maxPerArtist: 2, temperature: 0.04 + 0.1 * a, exploreShare: 0.1 + 0.25 * a });
  const mix = sequence(picks).map(slim), used = new Set(mix.map((s) => s.id));
  const mixes = clusters.map((c) => {
    const songs = sequence(selectMix(cands.filter((x) => x.cluster === c.id && !used.has(x.id)), { count: 25, maxPerArtist: 2, temperature: 0.05, exploreShare: 0.15 })).map(slim);
    songs.forEach((s) => used.add(s.id));
    return { id: c.id, title: titles.get(c.id), names: [...new Set(c.names.map(shortName))], genre: c.genre ? prettyGenre(c.genre) : null, songs };
  }).filter((x) => x.songs.length >= 8);
  const best = new Map();
  for (const c of cands) if (!c.knownArtist && c.artistId && (!best.has(c.artistId) || c.score > best.get(c.artistId).score)) best.set(c.artistId, c);
  const artists = [...best.entries()].sort((p, q) => q[1].score - p[1].score).slice(0, 18).map(([id, c]) => {
    const r = ranked.get(id);
    const via = [...new Set((r?.via || []).map(shortName))];
    return { id, name: r?.name || c.artistName, art: m.nodes.get(id)?.art || null, reason: via.length ? `Like ${via.slice(0, 2).join(' and ')}` : r?.bridge ? `Through ${shortName(r.bridge)}` : '', song: slim(c) };
  });
  const deep = [], seenA = new Set();
  for (const c of cands.filter((x) => x.knownArtist && !used.has(x.id)).sort((p, q) => q.score - p.score)) {
    if (seenA.has(c.artistKey)) continue; seenA.add(c.artistKey); deep.push(slim(c)); if (deep.length >= 15) break;
  }
  const rel = new Map();
  for (const s of m.seeds) { const l = m.nodes.get(s.id)?.latest; if (l?.releaseDate && Date.now() - Date.parse(l.releaseDate) < 120 * DAY && !rel.has(l.id) && !m.profile.known.albums.has(String(l.id))) rel.set(l.id, l); }
  const releases = [...rel.values()].sort((p, q) => Date.parse(q.releaseDate) - Date.parse(p.releaseDate)).slice(0, 12);
  const reserve = cands.filter((c) => !used.has(c.id)).sort((p, q) => q.score - p.score).slice(0, 120).map(slim);
  return {
    t: Date.now(), gatheredAt: m.at, settings: { ...st }, mix, mixes, artists, deep, releases, reserve, learned, learning: describeLearning(learned),
    taste: tasteSummary(m.profile, m.clusters), clusters: m.clusters.map((c) => ({ id: c.id, title: titles.get(c.id), names: [...new Set(c.names.map(shortName))] })),
    genres: [...genreCount.entries()].sort((p, q) => q[1] - p[1]).slice(0, 14).map(([g]) => ({ id: g, name: prettyGenre(g) })),
    counts: { candidates: cands.length, artists: ranked.size, seeds: m.seeds.length, examples: fb.examples.length, liked: fb.examples.filter((e) => e.y === 1).length, passed: fb.examples.filter((e) => e.y === 0).length },
  };
}

// Songs shown in the last three main mixes are left out of the next ones; anything shown in the last six is marked.
async function shownSets() {
  const hist = (await data.kv.get('shown')) || [];
  return { exclude: new Set(hist.slice(0, 3).flatMap((h) => h.mix)), penalty: new Set(hist.flatMap((h) => [...h.mix, ...h.more])), hist };
}
async function remember(result, hist) {
  await data.kv.set('result', result);
  await data.kv.set('shown', [{ t: result.t, mix: result.mix.map((s) => s.id), more: result.mixes.flatMap((x) => x.songs.map((s) => s.id)) }, ...hist].slice(0, 6));
}

export function generate({ full = false } = {}) {
  if (job) return job;
  job = (async () => {
    await load();
    S.status = 'running'; S.error = null; step('Getting ready', 0.02);
    const t0 = performance.now(); data.stats.calls = 0; data.stats.cached = 0;
    try {
      const prev = S.result;
      if (full || !memo || Date.now() - memo.at > 6 * HOUR) memo = await gather(prev);
      step('Choosing songs', 0.92);
      const shown = await shownSets();
      const result = compose(memo, S.settings, S.fb, shown);
      result.stats = { ms: Math.round(performance.now() - t0), calls: data.stats.calls, cached: data.stats.cached };
      result.savedIds = prev?.savedIds || [];
      await remember(result, shown.hist);
      S.result = result; S.status = 'ready';
    } catch (e) { warn('discover failed', e); S.error = e?.message || String(e); S.status = 'error'; }
    S.step = ''; job = null; emit();
  })();
  return job;
}
// Settings changed: re-choose from what was already gathered (instant), or gather if nothing is.
async function recompose() {
  if (!memo || job) return generate();
  const shown = await shownSets();
  shown.exclude = new Set(shown.hist.slice(1, 3).flatMap((h) => h.mix));   // the mix being replaced may keep its songs
  const result = compose(memo, S.settings, S.fb, shown);
  result.stats = S.result?.stats; result.savedIds = S.result?.savedIds || [];
  S.result = result; await data.kv.set('result', result); emit();
}
function dueForRefresh() {
  const r = S.result; if (!r) return true;
  return Date.now() - r.t > (REFRESH[S.settings.refresh] ?? REFRESH.weekly);
}

// ---------------------------------------------------------------------------------------------------- actions
const lists = () => { const r = S.result || {}; return { mix: r.mix || [], deep: r.deep || [], reserve: r.reserve || [], artists: (r.artists || []).map((a) => a.song), ...Object.fromEntries((r.mixes || []).map((m) => [`mix:${m.id}`, m.songs])) }; };
const songAt = (list, i) => lists()[list]?.[+i];

async function playList(songs, index = 0, { shuffle = false, name = 'Discover' } = {}) {
  try { await data.play(songs, index, { shuffle, name }); watchPlayback(songs); }
  catch (e) { warn(e); note('Couldn’t play these songs'); }
}
async function react(song, kind) {
  await load();
  if (kind === 'love') { try { await data.love(song); if (app()?.config?.getValue?.('appleMusic.addToLibraryOnFavorite')) await data.addToLibrary(song); } catch (e) { warn(e); return note('Couldn’t favourite this song'); } }
  if (kind === 'add') { try { await data.addToLibrary(song); } catch (e) { warn(e); return note('Couldn’t add this song'); } }
  label(song, kind);
  if (kind === 'love') note(`Favourited “${song.name}”`);
  if (kind === 'add') note(`Added “${song.name}” to your library`);
  if (kind === 'dismiss') { S.fb.dismissed = [...S.fb.dismissed, song.id].slice(-2000); replace(song); note('Got it. Discover will suggest less like this.'); }
  if (kind === 'block') {
    const name = mainArtist(song.artistName);
    if (!S.fb.blocked.some((b) => norm(b.name) === name)) S.fb.blocked = [...S.fb.blocked, { name: song.artistName.split(/\s*(?:,|&| feat\.? )\s*/i)[0], id: song.artistId || null }];
    removeArtist(name); note(`Discover won’t suggest ${song.artistName} again.`);
  }
  if (S.result) { (S.result.reacted ||= {})[song.id] = kind; await data.kv.set('result', S.result); }
  await saveFb(); emit();
}
// A dismissed song is replaced by the best reserve song that keeps the mix's artist limit.
function replace(song) {
  const r = S.result; if (!r) return;
  const per = new Map(); r.mix.forEach((s) => per.set(mainArtist(s.artistName), (per.get(mainArtist(s.artistName)) || 0) + 1));
  for (const key of ['mix', 'deep', ...(r.mixes || []).map((m) => `mix:${m.id}`)]) {
    const arr = key === 'mix' ? r.mix : key === 'deep' ? r.deep : r.mixes.find((m) => `mix:${m.id}` === key).songs;
    const i = arr.findIndex((s) => s.id === song.id); if (i < 0) continue;
    const j = key === 'mix' ? r.reserve.findIndex((s) => (per.get(mainArtist(s.artistName)) || 0) < 2 && s.cluster === song.cluster) : -1;
    const k = j >= 0 ? j : key === 'mix' ? r.reserve.findIndex((s) => (per.get(mainArtist(s.artistName)) || 0) < 2) : -1;
    if (k >= 0) { const [n] = r.reserve.splice(k, 1); arr.splice(i, 1, { ...n, fresh: true }); } else arr.splice(i, 1);
  }
}
function removeArtist(key) {
  const r = S.result; if (!r) return;
  const keep = (s) => !artistTokens(s.artistName).includes(key);
  r.reserve = r.reserve.filter(keep);
  r.mix.filter((s) => !keep(s)).forEach(replace);
  r.mix = r.mix.filter(keep); r.deep = r.deep.filter(keep);
  r.mixes.forEach((m) => { m.songs = m.songs.filter(keep); });
  r.artists = r.artists.filter((a) => keep({ artistName: a.name }));
}
async function save() {
  const r = S.result; if (!r?.mix?.length) return;
  note('Saving…');
  try {
    const desc = `Made by Discover on ${new Date(r.t).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })} from your listening.`;
    const out = await data.savePlaylist(r.mix, { description: desc, savedId: ls.get(LS_SAVED) });
    ls.set(LS_SAVED, out.id); r.savedIds = [...new Set([...(r.savedIds || []), ...r.mix.map((s) => s.id)])]; r.savedAt = Date.now();
    await data.kv.set('result', r);
    note(out.replaced ? 'Updated your “Discover Mix” playlist' : 'Saved as “Discover Mix” in your playlists');
  } catch (e) { warn(e); note('Couldn’t save the playlist'); }
}
async function resetLearning() {
  S.fb = { ...S.fb, examples: [], artists: {}, genres: {}, labeled: {} }; await saveFb(); await recompose(); note('Discover forgot what it learned from your reactions.');
}
async function unblock(name) { S.fb.blocked = S.fb.blocked.filter((b) => b.name !== name); await saveFb(); await recompose(); }

// ---- listening in Cider: a skip in the first 30 seconds is a mild "no", playing most of the song a mild "yes" ----
let watchStop = null, watching = null;
function watchPlayback(songs) {
  watching = { songs: new Map(songs.map((s) => [s.id, s])), cur: null, idle: 0 };
  if (!watchStop) watchStop = every(tick, { focused: 2000, background: 4000 });
}
function tick() {
  let s; try { s = rpc().playbackSnapshot; } catch { return; }
  const id = s?.nowPlaying?.playParams?.catalogId || s?.nowPlaying?.playParams?.id || null;
  S.nowPlaying = id ? String(id) : null; S.playing = s?.state === 'playing';
  for (const f of nowSubs) f();
  if (!watching) return;
  const cur = watching.cur;
  if (cur && cur.id !== S.nowPlaying) {
    const song = watching.songs.get(cur.id);
    if (song && cur.dur > 0) { if (cur.max < 30 && cur.max / cur.dur < 0.5) label(song, 'skip'); else if (cur.max / cur.dur > 0.7) label(song, 'played'); saveFb(); }
    watching.cur = null;
  }
  if (S.nowPlaying && watching.songs.has(S.nowPlaying)) {
    watching.idle = 0;
    if (!watching.cur) watching.cur = { id: S.nowPlaying, max: 0, dur: 0 };
    watching.cur.max = Math.max(watching.cur.max, s?.time?.currentTime || 0); watching.cur.dur = s?.time?.duration || watching.cur.dur;
  } else if (++watching.idle > 45 && !pageOpen) { watchStop(); watchStop = null; watching = null; }
}
const nowSubs = new Set();
let pageOpen = 0;

// ---------------------------------------------------------------------------------------------------- page
const STYLE = `
:host { display: block; color: inherit; font: inherit; -webkit-font-smoothing: antialiased; padding-bottom: 120px; container-type: inline-size;
  --sec: color-mix(in srgb, currentColor 55%, transparent); --ter: color-mix(in srgb, currentColor 32%, transparent); --line: color-mix(in srgb, currentColor 11%, transparent);
  --fill: color-mix(in srgb, currentColor 8%, transparent); --fill2: color-mix(in srgb, currentColor 13%, transparent); --hover: color-mix(in srgb, currentColor 6%, transparent);
  --accent: var(--keyColor, #fa2d48); --ease: cubic-bezier(.32,.72,0,1); }
* { box-sizing: border-box; }
button { all: unset; box-sizing: border-box; cursor: default; }
button:focus-visible, [tabindex]:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 1px; border-radius: 6px; }
a { color: inherit; text-decoration: none; cursor: default; } a:hover { text-decoration: underline; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes fade { from { opacity: 0; } }
@keyframes shimmer { from { background-position: -400px 0; } to { background-position: 400px 0; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition-duration: .01ms !important; } }

/* header: Music's playlist header (270pt artwork, 22pt title, accent curator line, capsule buttons) */
.hero { display: flex; gap: 30px; align-items: flex-end; margin: 0 0 30px; }
.cover { position: relative; flex: none; width: 270px; height: 270px; border-radius: 8px; overflow: hidden; background: linear-gradient(150deg, var(--c1, #e0466e), var(--c2, #6a3df0)); box-shadow: 0 6px 20px rgba(0,0,0,.16), 0 0 0 .5px rgba(0,0,0,.08); }
.cover .mosaic { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; filter: saturate(1.1); }
.cover .mosaic i { background: center/cover; }
.cover::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, color-mix(in srgb, var(--c1, #e0466e) 88%, black) 6%, color-mix(in srgb, var(--c1, #e0466e) 55%, transparent) 42%, transparent 72%); }
.cover .label { position: absolute; left: 18px; right: 18px; bottom: 16px; z-index: 1; color: #fff; text-shadow: 0 1px 10px rgba(0,0,0,.2); }
.cover .label b { display: block; font-size: 30px; line-height: 33px; font-weight: 800; letter-spacing: -.5px; margin-top: 8px; }
.cover .label span { display: block; font-size: 13px; font-weight: 600; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.info { flex: 1; min-width: 0; padding-bottom: 2px; }
h1 { all: unset; display: block; font-size: 22px; line-height: 27px; font-weight: 700; letter-spacing: -.2px; }
.curator { font-size: 22px; line-height: 27px; color: var(--accent); }
.meta { font-size: 11px; font-weight: 600; color: var(--sec); margin-top: 4px; }
.desc { font-size: 12px; line-height: 16px; color: var(--sec); margin-top: 10px; max-width: 580px; }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 30px; min-width: 112px; padding: 0 16px; border-radius: 15px; background: var(--fill); color: var(--accent); font-size: 15px; font-weight: 600; transition: background-color .2s var(--ease), transform .35s var(--ease); }
.pill:hover, .round:hover { background: var(--fill2); }
.pill:active, .round:active { transform: scale(.95); transition-duration: .1s; }
.pill[disabled], .round[disabled] { opacity: .45; pointer-events: none; }
.round { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--accent); background: var(--fill); transition: background-color .2s var(--ease), transform .35s var(--ease); }
.round.on { background: var(--accent); color: #fff; }
.round.spin .sf { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.progress { margin-top: 16px; max-width: 420px; animation: fade .3s ease both; }
.bar { height: 4px; border-radius: 2px; background: var(--fill2); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 2px; background: var(--accent); transform: scaleX(var(--p)); transform-origin: left; transition: transform .6s var(--ease); }
.step, .toast { font-size: 12px; color: var(--sec); margin-top: 7px; }
.toast { animation: rise .35s var(--ease) both; }
.err { font-size: 13px; margin-top: 12px; color: var(--sec); }

/* Tune: a grouped settings card */
.tune { margin: -10px 0 30px; padding: 4px 16px; border-radius: 12px; background: var(--fill); animation: rise .4s var(--ease) both; }
.trow2 { display: flex; align-items: center; gap: 18px; min-height: 46px; padding: 8px 0; }
.trow2 + .trow2 { box-shadow: inset 0 .5px 0 var(--line); }
.tl { width: 170px; flex: none; font-size: 13px; } .tl small { display: block; font-size: 11px; color: var(--sec); margin-top: 1px; }
.slider { flex: 1; max-width: 460px; display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--sec); }
input[type=range] { -webkit-appearance: none; appearance: none; flex: 1; height: 4px; border-radius: 2px; margin: 0; background: linear-gradient(to right, var(--accent) calc(var(--v) * 100%), var(--fill2) 0); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 .5px 2.5px rgba(0,0,0,.4), 0 0 0 .5px rgba(0,0,0,.06); }
.seg { display: inline-flex; padding: 2px; border-radius: 7px; background: var(--fill2); flex: none; }
.seg button { padding: 2px 12px; border-radius: 5px; font-size: 12px; }
.seg button[aria-pressed=true] { background: #fff; color: #000; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.sw { position: relative; width: 38px; height: 22px; border-radius: 11px; background: var(--fill2); flex: none; transition: background-color .2s ease; }
.sw::after { content: ""; position: absolute; top: 1px; left: 1px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .22s var(--ease); }
.sw[aria-checked=true] { background: var(--accent); } .sw[aria-checked=true]::after { transform: translateX(16px); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.chip { padding: 3px 10px; border-radius: 12px; font-size: 12px; background: var(--fill2); transition: background-color .2s var(--ease), color .2s; }
.chip:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
.chip.off { color: var(--sec); text-decoration: line-through; background: transparent; box-shadow: inset 0 0 0 .5px var(--line); }
.chip.avoid { background: transparent; box-shadow: inset 0 0 0 .5px var(--line); color: var(--sec); }
.chip.avoid.on { background: var(--accent); color: #fff; box-shadow: none; text-decoration: line-through; }

/* track list: Music's playlist rows (artwork, title over a grey "why" line, artist, album, time) */
.list { margin: 0 -10px; }
.row { position: relative; display: grid; grid-template-columns: 44px minmax(0, 2.3fr) minmax(0, 1.2fr) minmax(0, 1.2fr) 96px 44px; align-items: center; column-gap: 14px; height: 58px; padding: 0 10px; border-radius: 8px; transition: background-color .15s var(--ease); }
.row::after { content: ""; position: absolute; left: 68px; right: 10px; bottom: 0; height: .5px; background: var(--line); }
.row:hover { background: var(--hover); } .row:hover::after, .row:has(+ .row:hover)::after { opacity: 0; }
.row.fresh { animation: rise .5s var(--ease) both; }
.row.gone { animation: out .32s var(--ease) forwards; } @keyframes out { to { opacity: 0; transform: translateX(-12px); } }
.art { position: relative; width: 44px; height: 44px; border-radius: 5px; background: var(--fill) center/cover; box-shadow: 0 0 0 .5px var(--line); overflow: hidden; }
.art .ov { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.42); color: #fff; opacity: 0; transition: opacity .15s; }
.row:hover .art .ov, .row.now .art .ov { opacity: 1; }
.tt { min-width: 0; line-height: 1.3; }
.n { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.now .n { color: var(--accent); }
.why { font-size: 11px; color: var(--sec); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.e { display: inline-block; font-size: 9px; font-weight: 700; width: 12px; line-height: 12px; text-align: center; border-radius: 2px; background: var(--fill2); color: var(--sec); margin-left: 5px; vertical-align: 1px; }
.col { font-size: 13px; color: var(--sec); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acts { display: flex; justify-content: flex-end; gap: 1px; opacity: 0; transition: opacity .15s; }
.row:hover .acts, .acts:focus-within { opacity: 1; }
.ib { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--sec); transition: color .15s, background-color .15s; }
.ib:hover { color: var(--accent); background: var(--hover); }
.ib.on { color: var(--accent); }
.acts .ib.on { opacity: 1; }
.time { font-size: 13px; color: var(--sec); text-align: right; font-variant-numeric: tabular-nums; }
.row.skel .art, .row.skel .bone { background: linear-gradient(90deg, var(--fill) 0, var(--fill2) 200px, var(--fill) 400px) 0 0/800px 100%; animation: shimmer 1.4s linear infinite; box-shadow: none; }
.bone { height: 10px; border-radius: 5px; } .bone + .bone { margin-top: 7px; width: 60%; }
@container (max-width: 860px) { .row { grid-template-columns: 44px minmax(0, 2fr) minmax(0, 1fr) 96px 44px; } .col.album { display: none; } }
@container (max-width: 560px) { .row { grid-template-columns: 44px minmax(0, 1fr) 96px; } .col, .time { display: none; } }

/* shelves */
section { margin-top: 36px; }
.sh { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; min-height: 22px; }
.sh h2 { all: unset; font-size: 15px; line-height: 19px; font-weight: 600; }
.sh .sub { font-size: 12px; color: var(--sec); margin-left: 4px; }
.sh .nav { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity .2s; }
section:hover .sh .nav { opacity: 1; }
.sh .nav .ib { width: 24px; height: 24px; }
.shelf { display: grid; grid-auto-flow: column; grid-auto-columns: var(--cw, 178px); gap: 20px; overflow-x: auto; scrollbar-width: none; margin-right: -34px; padding: 0 34px 4px 0; scroll-snap-type: x mandatory; scroll-behavior: smooth; }
.shelf > * { scroll-snap-align: start; }
.card { min-width: 0; }
.pic { position: relative; display: block; width: 100%; aspect-ratio: 1; border-radius: 8px; background: var(--fill) center/cover; box-shadow: 0 0 0 .5px var(--line); overflow: hidden; transition: transform .35s var(--ease); }
.card:active .pic { transform: scale(.97); }
.pt { font-size: 13px; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps { font-size: 12px; line-height: 15px; color: var(--sec); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 1px; }
.play { position: absolute; left: 10px; bottom: 10px; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: #fff; background: rgba(0,0,0,.42); -webkit-backdrop-filter: blur(12px) saturate(1.6); backdrop-filter: blur(12px) saturate(1.6); opacity: 0; transform: scale(.85); transition: opacity .2s var(--ease), transform .3s var(--ease); z-index: 2; }
.card:hover .play, .play:focus-visible { opacity: 1; transform: none; }
.play:hover { background: var(--accent); }
.artist { text-align: center; } .artist .pic { border-radius: 50%; } .artist .play { left: 50%; margin-left: -16px; }
.mixpic { background: linear-gradient(150deg, var(--c1), var(--c2)); }
.mixpic .mosaic { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; }
.mixpic .mosaic i { background: center/cover; }
.mixpic::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, color-mix(in srgb, var(--c1) 92%, black) 10%, color-mix(in srgb, var(--c1) 50%, transparent) 48%, transparent 75%); }
.mixpic .label { position: absolute; left: 12px; right: 12px; bottom: 11px; z-index: 1; color: #fff; font-size: 17px; line-height: 20px; font-weight: 800; letter-spacing: -.2px; text-shadow: 0 1px 8px rgba(0,0,0,.2); }
.mixpic .label small { display: block; font-size: 11px; font-weight: 600; opacity: .85; letter-spacing: 0; }
.cuts { display: grid; grid-auto-flow: column; grid-template-rows: repeat(3, 60px); grid-auto-columns: calc((100% - 40px) / 3); column-gap: 20px; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x mandatory; scroll-behavior: smooth; }
@container (max-width: 860px) { .cuts { grid-auto-columns: calc((100% - 20px) / 2); } }
.cut { position: relative; display: grid; grid-template-columns: 48px minmax(0, 1fr) 30px; align-items: center; column-gap: 12px; scroll-snap-align: start; }
.cut::after { content: ""; position: absolute; left: 60px; right: 0; bottom: 0; height: .5px; background: var(--line); }
.cut .art { width: 48px; height: 48px; }
.cut:hover .art .ov { opacity: 1; }

/* your taste */
.taste { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; }
.panel { background: var(--fill); border-radius: 12px; padding: 14px 16px 16px; min-width: 0; }
.panel h3 { all: unset; display: block; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.gb { display: grid; grid-template-columns: minmax(0, 120px) 1fr 34px; align-items: center; gap: 10px; height: 22px; font-size: 12px; }
.gb span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .gb small { color: var(--sec); text-align: right; font-variant-numeric: tabular-nums; }
.gb .track { height: 6px; border-radius: 3px; background: var(--fill2); overflow: hidden; } .gb .track i { display: block; height: 100%; width: calc(var(--v) * 100%); background: var(--accent); border-radius: 3px; }
.dec { display: flex; align-items: flex-end; gap: 6px; height: 104px; }
.dec div { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 5px; height: 100%; font-size: 10px; color: var(--sec); }
.dec i { width: 100%; max-width: 28px; height: calc(var(--v) * 76px); min-height: 2px; border-radius: 3px 3px 1px 1px; background: var(--accent); }
.learn { font-size: 12px; line-height: 17px; } .learn p { margin: 0 0 6px; } .learn .sec { color: var(--sec); }
.learn ul { margin: 0 0 10px; padding-left: 16px; }
.link { color: var(--accent); font-size: 12px; } .link:hover { text-decoration: underline; }
.blocked { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.blocked .chip { display: inline-flex; align-items: center; gap: 6px; }
.foot { margin-top: 40px; font-size: 11px; line-height: 16px; color: var(--ter); max-width: 640px; }
.empty { padding: 60px 0; text-align: center; color: var(--sec); font-size: 13px; }
.back { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: 13px; margin-bottom: 16px; }
` + sfCss(G);
let sheetCache = null;
const sheet = () => { if (!sheetCache) { sheetCache = new CSSStyleSheet(); sheetCache.replaceSync(STYLE); } return sheetCache; };

const fmtTime = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtTotal = (songs) => { const m = Math.round(songs.reduce((t, s) => t + (s.durationMs || 0), 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const ago = (t) => { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? new Date(t).toLocaleDateString(undefined, { weekday: 'long' }) : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }); };
const hex = (c, f) => (c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : f);
// Four songs with four different covers, for a mosaic.
const distinctArt = (songs) => { const seen = new Set(), out = []; for (const s of songs) { const k = s.albumId || s.art; if (!s.art || seen.has(k)) continue; seen.add(k); out.push(s); if (out.length === 4) break; } return out.length >= 4 ? out : songs.slice(0, 4); };
const viewFromPath = () => { try { const q = (app().PodRouter().currentPath || '').split('?')[1] || ''; return new URLSearchParams(q).get('mix') || null; } catch { return null; } };

class NativeDiscover extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' }); this.root.adoptedStyleSheets = [sheet()];
    this.tuneOpen = false; this.shelfX = {};
    this.onState = () => this.render(); this.onNow = () => this.markNow();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('dblclick', (e) => { const r = e.target.closest('.row[data-list]'); if (r && !e.target.closest('button,a')) this.playFrom(r.dataset.list, +r.dataset.i); });
    this.root.addEventListener('change', (e) => { if (e.target.dataset.set === 'adventure') { setSettings({ adventure: +e.target.value }); recompose(); } });
    this.root.addEventListener('input', (e) => { if (e.target.dataset.set === 'adventure') e.target.style.setProperty('--v', e.target.value); });
    this.root.addEventListener('contextmenu', (e) => { const r = e.target.closest('[data-list][data-i]'); if (r) { e.preventDefault(); this.menu(e, r.dataset.list, +r.dataset.i); } });
  }
  connectedCallback() {
    pageOpen++; subs.add(this.onState); nowSubs.add(this.onNow);
    this.mixId = viewFromPath();
    if (!watchStop) watchStop = every(tick, { focused: 2000, background: 6000 });
    this.render();
    load().then(() => { if (!job && dueForRefresh()) generate(); this.render(); });
  }
  disconnectedCallback() { pageOpen--; subs.delete(this.onState); nowSubs.delete(this.onNow); if (!pageOpen && !watching && watchStop) { watchStop(); watchStop = null; } }

  playFrom(list, i, shuffle = false) {
    const songs = lists()[list] || [];
    if (!songs.length) return;
    const m = list.startsWith('mix:') ? S.result.mixes.find((x) => `mix:${x.id}` === list) : null;
    if (list === 'artists') return playList([songs[i]], 0, { name: 'Discover' });
    playList(songs, shuffle ? Math.floor(Math.random() * songs.length) : i, { shuffle, name: m ? m.title : list === 'deep' ? 'Deep Cuts' : 'Discover Mix' });
  }
  menu(e, list, i) {
    const s = songAt(list, i), CM = window.__PLUGINSYS__?.ContextMenu; if (!s || !CM) return;
    const r = S.result?.reacted?.[s.id], item = (label, fn) => CM.actionItem(label, fn);
    const items = [
      item('Play', () => this.playFrom(list, i)), item('Play Next', () => data.playNext(s)), item('Play Last', () => data.playLater(s)), CM.menuSeperator(),
      item(r === 'love' ? 'Favourited' : 'Favourite', () => react(s, 'love')), item('Add to Library', () => react(s, 'add')), CM.menuSeperator(),
      ...(s.artistId ? [item('Go to Artist', () => go(`/am/artist/${s.artistId}`))] : []), ...(s.albumId ? [item('Go to Album', () => go(`/am/container/album/${s.albumId}`))] : []),
      CM.menuSeperator(), item('Not for Me', () => this.dismiss(list, i)), item(`Never Suggest ${s.artistName.split(/\s*(?:,|&| feat\.? )\s*/i)[0]}`, () => react(s, 'block')),
    ];
    new CM.Menu(items).show(e);
  }
  dismiss(list, i) {
    const s = songAt(list, i); if (!s) return;
    const row = this.root.querySelector(`.row[data-list="${list}"][data-i="${i}"], .cut[data-list="${list}"][data-i="${i}"]`);
    const go2 = () => react(s, 'dismiss');
    if (row && !reducedMotion()) { row.classList.add('gone'); setTimeout(go2, 300); } else go2();
  }
  async onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const { act, list, i, v } = t.dataset;
    switch (act) {
      case 'play': return this.playFrom(list || (this.mixId ? `mix:${this.mixId}` : 'mix'), +(i || 0));
      case 'shuffle': return this.playFrom(list || (this.mixId ? `mix:${this.mixId}` : 'mix'), 0, true);
      case 'new': return generate();
      case 'rebuild': return generate({ full: true });
      case 'save': return save();
      case 'tune': this.tuneOpen = !this.tuneOpen; return this.render();
      case 'more': {
        const CM = window.__PLUGINSYS__?.ContextMenu; if (!CM) return;
        new CM.Menu([CM.actionItem('Save as Playlist', () => save()), CM.actionItem('New Mix', () => generate()), CM.actionItem('Rebuild from Your Listening', () => generate({ full: true })), CM.menuSeperator(),
          CM.actionItem(`Refresh: ${S.settings.refresh === 'daily' ? 'Daily ✓' : 'Daily'}`, () => { setSettings({ refresh: 'daily' }); this.render(); }),
          CM.actionItem(`Refresh: ${S.settings.refresh === 'weekly' ? 'Weekly ✓' : 'Weekly'}`, () => { setSettings({ refresh: 'weekly' }); this.render(); }),
          CM.actionItem(`Refresh: ${S.settings.refresh === 'manual' ? 'Only When I Ask ✓' : 'Only When I Ask'}`, () => { setSettings({ refresh: 'manual' }); this.render(); })]).show(e);
        return;
      }
      case 'row-menu': return this.menu(e, list, +i);
      case 'love': case 'add': { const s = songAt(list, +i); if (s) react(s, act); return; }
      case 'dismiss': return this.dismiss(list, +i);
      case 'artist': return go(`/am/artist/${v}`);
      case 'album': return go(`/am/container/album/${v}`);
      case 'open-mix': return go(`${PATH}?mix=${encodeURIComponent(v)}`);
      case 'back': return go(PATH);
      case 'seg': setSettings({ [t.dataset.k]: t.dataset.k === 'length' ? +v : v }); return recompose();
      case 'deep': setSettings({ deepCuts: !S.settings.deepCuts }); return recompose();
      case 'cluster': { const s = new Set(S.settings.skipClusters); s.has(v) ? s.delete(v) : s.add(v); setSettings({ skipClusters: [...s] }); return recompose(); }
      case 'genre': { const s = new Set(S.settings.avoidGenres); s.has(v) ? s.delete(v) : s.add(v); setSettings({ avoidGenres: [...s] }); return recompose(); }
      case 'reset-learning': return resetLearning();
      case 'unblock': return unblock(v);
      case 'page': { const sh = t.closest('section')?.querySelector('.shelf, .cuts'); if (sh) sh.scrollBy({ left: (v === 'next' ? 1 : -1) * sh.clientWidth * 0.9 }); return; }
    }
  }
  markNow() {
    for (const r of this.root.querySelectorAll('.row.now, .cut.now')) if (r.dataset.id !== S.nowPlaying) r.classList.remove('now');
    if (S.nowPlaying) for (const r of this.root.querySelectorAll(`[data-id="${CSS.escape(S.nowPlaying)}"]`)) r.classList.add('now');
  }

  // ---- render ----
  cover(songs, label, sub, cls = 'cover') {
    const s = distinctArt(songs || []), c1 = hex(s[0]?.bg, '#d8475f'), c2 = hex(s[1]?.bg || s[2]?.bg, '#5b3cc4');
    return `<div class="${cls}" style="--c1:${c1};--c2:${c2}"><div class="mosaic">${s.slice(0, 4).map((x) => `<i style="background-image:url('${art(x.art, 300)}')"></i>`).join('')}</div>
      <div class="label">${cls === 'cover' ? icon('spark') : ''}<b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div></div>`;
  }
  row(s, list, i) {
    const r = S.result?.reacted?.[s.id];
    return `<div class="row${s.fresh ? ' fresh' : ''}${S.nowPlaying === s.id ? ' now' : ''}" data-list="${list}" data-i="${i}" data-id="${esc(s.id)}">
      <div class="art" style="background-image:url('${art(s.art, 100)}')"><button class="ov" data-act="play" data-list="${list}" data-i="${i}" title="Play" aria-label="Play ${esc(s.name)}">${icon('play')}</button></div>
      <div class="tt"><div class="n">${esc(s.name)}${s.explicit ? '<span class="e">E</span>' : ''}</div><div class="why">${esc(s.reason)}</div></div>
      <div class="col">${s.artistId ? `<a data-act="artist" data-v="${esc(s.artistId)}">${esc(s.artistName)}</a>` : esc(s.artistName)}</div>
      <div class="col album">${s.albumId ? `<a data-act="album" data-v="${esc(s.albumId)}">${esc(s.albumName || '')}</a>` : esc(s.albumName || '')}</div>
      <div class="acts">
        <button class="ib${r === 'love' ? ' on' : ''}" data-act="love" data-list="${list}" data-i="${i}" title="Favourite" aria-label="Favourite">${icon(r === 'love' ? 'starFill' : 'star')}</button>
        <button class="ib${r === 'add' ? ' on' : ''}" data-act="add" data-list="${list}" data-i="${i}" title="Add to Library" aria-label="Add to Library">${icon(r === 'add' ? 'check' : 'plus')}</button>
        <button class="ib" data-act="dismiss" data-list="${list}" data-i="${i}" title="Not for Me" aria-label="Not for Me">${icon('down')}</button>
      </div>
      <div class="time">${fmtTime(s.durationMs)}</div>
    </div>`;
  }
  skeleton(n = 8) { return Array.from({ length: n }, () => '<div class="row skel"><div class="art"></div><div class="tt"><div class="bone"></div><div class="bone"></div></div><div class="col"><div class="bone"></div></div><div class="col album"><div class="bone"></div></div><div></div><div></div></div>').join(''); }
  shelf(title, sub, inner, { key, cls = 'shelf', cw = null } = {}) {
    return `<section><div class="sh"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}<div class="nav"><button class="ib" data-act="page" data-v="prev" aria-label="Previous">${icon('chevL')}</button><button class="ib" data-act="page" data-v="next" aria-label="Next">${icon('chevR')}</button></div></div><div class="${cls}" data-shelf="${key}" ${cw ? `style="--cw:${cw}px"` : ''}>${inner}</div></section>`;
  }
  tune(r) {
    const st = S.settings, seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="seg" data-k="${k}" data-v="${v}" aria-pressed="${String(st[k]) === String(v)}">${l}</button>`).join('')}</div>`;
    const clusters = r?.clusters || [], genres = r?.genres || [];
    return `<div class="tune">
      <div class="trow2"><div class="tl">Adventure<small>How far from what you know</small></div><div class="slider">Familiar<input type="range" min="0" max="1" step="0.05" value="${st.adventure}" data-set="adventure" style="--v:${st.adventure}" aria-label="Adventure">Adventurous</div></div>
      <div class="trow2"><div class="tl">Era</div>${seg('era', [['any', 'Any'], ['recent', 'Recent'], ['classic', 'Classic']])}</div>
      <div class="trow2"><div class="tl">Length</div>${seg('length', [[20, '20'], [30, '30'], [50, '50'], [100, '100']])}</div>
      <div class="trow2"><div class="tl">Deeper cuts<small>Lesser-known songs by artists you play</small></div><button class="sw" role="switch" aria-checked="${st.deepCuts}" data-act="deep" aria-label="Deeper cuts"></button></div>
      ${clusters.length ? `<div class="trow2"><div class="tl">Your tastes<small>Turn one off to leave it out</small></div><div class="chips">${clusters.map((c) => `<button class="chip${st.skipClusters.includes(c.id) ? ' off' : ''}" data-act="cluster" data-v="${c.id}" title="${esc(c.names.join(', '))}">${esc(c.title.replace(/ Discoveries$/, ''))}</button>`).join('')}</div></div>` : ''}
      ${genres.length ? `<div class="trow2"><div class="tl">Avoid<small>Genres to leave out</small></div><div class="chips">${genres.map((g) => `<button class="chip avoid${st.avoidGenres.includes(g.id) ? ' on' : ''}" data-act="genre" data-v="${esc(g.id)}">${esc(g.name)}</button>`).join('')}</div></div>` : ''}
    </div>`;
  }
  hero(r, songs, { title, curator, label, sub, desc, mixView }) {
    const running = S.status === 'running', has = songs.length > 0;
    const newArtists = songs.filter((s) => !s.knownArtist).length;
    const meta = has ? `Updated ${ago(r.t)} · ${songs.length} songs, ${fmtTotal(songs)}${newArtists ? ` · ${newArtists} by artists new to you` : ''}` : running ? 'Making your mix…' : '';
    return `<div class="hero">${this.cover(songs, label, sub)}<div class="info">
      ${mixView ? `<button class="back" data-act="back">${icon('chevL')} Discover</button>` : ''}
      <h1>${esc(title)}</h1><div class="curator">${esc(curator)}</div><div class="meta">${esc(meta)}</div>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
      <div class="actions">
        <button class="pill" data-act="play" ${has ? '' : 'disabled'}>${icon('play')}Play</button><button class="pill" data-act="shuffle" ${has ? '' : 'disabled'}>${icon('shuffle')}Shuffle</button>
        ${mixView ? '' : `<button class="round${running ? ' spin' : ''}" data-act="new" title="New Mix" aria-label="New Mix" ${running ? 'disabled' : ''}>${icon('refresh')}</button>
        <button class="round" data-act="save" title="Save as Playlist" aria-label="Save as Playlist" ${has && !running ? '' : 'disabled'}>${icon('save')}</button>
        <button class="round${this.tuneOpen ? ' on' : ''}" data-act="tune" title="Tune" aria-label="Tune" aria-expanded="${this.tuneOpen}">${icon('tune')}</button>
        <button class="round" data-act="more" title="More" aria-label="More">${icon('more')}</button>`}
      </div>
      ${running ? `<div class="progress"><div class="bar" style="--p:${S.progress}"><i></i></div><div class="step">${esc(S.step || 'Working…')}</div></div>` : S.note ? `<div class="toast">${esc(S.note)}</div>` : ''}
      ${S.status === 'error' && S.error ? `<div class="err">${esc(S.error)} <button class="link" data-act="rebuild">Try Again</button></div>` : ''}
    </div></div>`;
  }
  render() {
    const r = S.result, name = app()?.config?.getValue?.('general.displayName') || '';
    const keepX = {}; for (const el of this.root.querySelectorAll('[data-shelf]')) keepX[el.dataset.shelf] = el.scrollLeft;
    let html = '';
    const mixView = this.mixId && r?.mixes?.find((m) => m.id === this.mixId);
    if (mixView) {
      html = this.hero(r, mixView.songs, { title: mixView.title, curator: `Made for ${name || 'You'}`, label: mixView.genre || 'Discover', sub: mixView.names.slice(0, 2).join(' · '), desc: `New music for your love of ${mixView.names.join(', ')}.`, mixView: true })
        + `<div class="list">${mixView.songs.map((s, i) => this.row(s, `mix:${mixView.id}`, i)).join('')}</div>`;
    } else {
      const songs = r?.mix || [];
      html = this.hero(r, songs, { title: 'Discover Mix', curator: name ? `Made for ${name}` : 'Made for You', label: 'Discover', sub: 'New music for you',
        desc: songs.length ? 'Songs you haven’t heard, picked from your listening: artists close to the ones you play, deeper cuts from the ones you love, and a few steps further out.' : 'Discover reads what you play, love and keep, then looks for music you haven’t heard yet.' });
      if (this.tuneOpen) html += this.tune(r);
      if (!r && S.status !== 'error') html += `<div class="list">${this.skeleton()}</div>`;
      else if (r && !songs.length) html += '<div class="empty">Nothing new turned up with these settings. Try a more adventurous mix or turn a taste back on.</div>';
      else if (r) html += `<div class="list">${songs.map((s, i) => this.row(s, 'mix', i)).join('')}</div>`;
      if (r) html += this.shelves(r);
    }
    this.root.innerHTML = html;
    for (const el of this.root.querySelectorAll('[data-shelf]')) if (keepX[el.dataset.shelf]) { el.style.scrollBehavior = 'auto'; el.scrollLeft = keepX[el.dataset.shelf]; el.style.scrollBehavior = ''; }
    if (r?.mix) for (const s of r.mix) delete s.fresh;
  }
  shelves(r) {
    let h = '';
    if (r.mixes?.length) h += this.shelf('Mixes for You', '', r.mixes.map((m) => `<div class="card"><button class="pic mixpic" data-act="open-mix" data-v="${esc(m.id)}" aria-label="${esc(m.title)}" style="--c1:${hex(m.songs[0]?.bg, '#d8475f')};--c2:${hex(m.songs[1]?.bg, '#5b3cc4')}"><div class="mosaic">${distinctArt(m.songs).map((x) => `<i style="background-image:url('${art(x.art, 200)}')"></i>`).join('')}</div><div class="label">${esc(m.genre || m.names[0])}<small>Discoveries</small></div></button><button class="play" data-act="play" data-list="mix:${esc(m.id)}" data-i="0" aria-label="Play ${esc(m.title)}">${icon('play')}</button><div class="pt">${esc(m.title)}</div><div class="ps">${esc(m.names.join(', '))}</div></div>`).join(''), { key: 'mixes' });
    if (r.artists?.length) h += this.shelf('Artists to Try', '', r.artists.map((a, i) => `<div class="card artist"><button class="pic" data-act="artist" data-v="${esc(a.id)}" aria-label="${esc(a.name)}" style="background-image:url('${art(a.art, 300)}')"></button><button class="play" data-act="play" data-list="artists" data-i="${i}" aria-label="Play ${esc(a.song.name)}">${icon('play')}</button><div class="pt">${esc(a.name)}</div><div class="ps">${esc(a.reason)}</div></div>`).join(''), { key: 'artists', cw: 150 });
    if (r.deep?.length) h += this.shelf('Deeper Cuts', 'from artists you play', r.deep.map((s, i) => `<div class="cut${S.nowPlaying === s.id ? ' now' : ''}" data-list="deep" data-i="${i}" data-id="${esc(s.id)}"><div class="art" style="background-image:url('${art(s.art, 100)}')"><button class="ov" data-act="play" data-list="deep" data-i="${i}" aria-label="Play ${esc(s.name)}">${icon('play')}</button></div><div class="tt"><div class="n">${esc(s.name)}</div><div class="why">${esc(s.artistName)}${s.year ? ` · ${s.year}` : ''}</div></div><button class="ib" data-act="row-menu" data-list="deep" data-i="${i}" aria-label="More">${icon('more')}</button></div>`).join(''), { key: 'deep', cls: 'cuts' });
    if (r.releases?.length) h += this.shelf('New from Your Artists', '', r.releases.map((a) => `<div class="card"><button class="pic" data-act="album" data-v="${esc(a.id)}" aria-label="${esc(a.name)}" style="background-image:url('${art(a.art, 300)}')"></button><div class="pt">${esc(a.name)}</div><div class="ps">${esc(a.artistName)} · ${esc(new Date(a.releaseDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</div></div>`).join(''), { key: 'releases' });
    h += this.tasteSection(r);
    const st = r.stats;
    h += `<div class="foot">Discover reads your Apple Music history, library, playlists and favourites, follows Apple’s similar-artist graph from the artists you play most, and learns from what you favourite, add, skip or pass on. Everything it learns stays on this Mac.${st ? ` Last built in ${(st.ms / 1000).toFixed(1)} s from ${r.counts.candidates} candidate songs across ${r.counts.artists} artists (${st.calls} requests, ${st.cached} from cache).` : ''}</div>`;
    return h;
  }
  tasteSection(r) {
    const t = r.taste, maxG = Math.max(0.0001, ...(t?.genres || []).map((g) => g.share)), maxD = Math.max(0.0001, ...(t?.decades || []).map((d) => d.share));
    const learn = r.learning || [], c = r.counts || {};
    const blocked = S.fb?.blocked || [];
    return `<section><div class="sh"><h2>Your Taste</h2><span class="sub">what Discover works from</span></div><div class="taste">
      <div class="panel"><h3>Genres</h3>${(t?.genres || []).slice(0, 7).map((g) => `<div class="gb"><span>${esc(g.name)}</span><div class="track" style="--v:${(g.share / maxG).toFixed(3)}"><i></i></div><small>${Math.round(g.share * 100)}%</small></div>`).join('')}</div>
      <div class="panel"><h3>Eras</h3><div class="dec">${(t?.decades || []).filter((d) => d.share > 0.005).map((d) => `<div><i style="--v:${(d.share / maxD).toFixed(3)}"></i>${String(d.decade).slice(2)}s</div>`).join('')}</div></div>
      <div class="panel learn"><h3>What Discover Has Learned</h3>
        ${c.examples ? `<p class="sec">From ${c.liked} song${c.liked === 1 ? '' : 's'} you kept or played through and ${c.passed} you passed on.</p>` : '<p class="sec">Nothing yet. Favourite, add or pass on songs and Discover adjusts what it picks.</p>'}
        ${learn.length ? `<ul>${learn.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : c.examples ? '<p class="sec">Not enough reactions yet to change how it picks.</p>' : ''}
        ${c.examples ? '<button class="link" data-act="reset-learning">Reset What It Learned</button>' : ''}
        ${blocked.length ? `<p style="margin-top:12px">Never suggested:</p><div class="blocked">${blocked.map((b) => `<button class="chip" data-act="unblock" data-v="${esc(b.name)}" title="Allow again">${esc(b.name)} ${icon('x')}</button>`).join('')}</div>` : ''}
      </div></div></section>`;
  }
}
customElements.get(PAGE) || customElements.define(PAGE, NativeDiscover);

// ---------------------------------------------------------------------------------------------------- module
let logTimer = 0, logFirst = 0;
export function startDiscover() {
  load();
  // keep the play log growing while Cider runs: Apple only remembers the last ~100 plays
  const grow = () => data.refreshPlayLog().catch(() => {});
  if (!logTimer) { logFirst = setTimeout(() => { grow(); data.kv.prune(30 * DAY, ['a:', 'c:', 'c2:']).catch(() => {}); }, 30e3); logTimer = setInterval(grow, 3 * HOUR); }
}
export function stopDiscover() { clearTimeout(logFirst); clearInterval(logTimer); logTimer = 0; }
export const openDiscover = () => go(PATH);
export const discoverDebug = () => ({ memo, state: S });
export const discoverDiagnostics = ({ detail = false } = {}) => ({ status: S.status, step: S.step, error: S.error, hasResult: !!S.result, at: S.result?.t ?? null, counts: S.result?.counts ?? null, stats: S.result?.stats ?? null, settings: S.settings,
  ...(detail && memo ? { seeds: memo.seeds.map((x) => `${x.name} ${x.w.toFixed(2)}`), clusters: memo.clusters.map((c) => `${c.id} [${c.genre}] ${c.seeds.map((x) => x.name).join(', ')}`), profileTop: memo.profile.artists.slice(0, 60).map((a) => `${a.name}${a.id ? '' : ' (no id)'} ${a.w.toFixed(1)}`) } : {}) });
