// Discover engine (tested in test/discover.test.mjs): listening signals + Apple's similar-artist graph -> mixes.
// Pure: no DOM, no Cider, no network. discover-data.js turns Apple Music payloads into the shapes used here.
//
//  1. Taste profile: every signal (recent plays, the local play log, heavy rotation, Favourite Songs, your own playlists,
//     the library) adds weight to an artist, its genres and its years. Songs you own or have played are "known".
//  2. Taste clusters: your top artists are grouped by how much their similar-artist lists overlap, so two separate habits
//     (say phonk and musical theatre) become two mixes instead of averaging into neither.
//  3. Graph relevance: personalised PageRank over the similar-artist graph, restarting at your artists. An artist reached
//     from several of yours by short paths scores high; hubs that everything links to are damped.
//  4. Song scoring: graph relevance, agreement between your artists, genre and era fit, popularity (an entry point for a
//     new artist, a deep cut for one you know), editorial and Apple evidence, and your earlier reactions.
//  5. Learning: Love, Add and Not for me (and skips in Cider) are labelled examples; a regularised logistic regression
//     moves the feature weights toward what you keep.
//  6. Selection: diversified greedy picking (MMR) with per-cluster quotas, artist and album caps, an exploration share and
//     a little noise so every new mix differs; then the songs are ordered in short blocks that move between your tastes.

const GENERIC_GENRES = new Set(['music', 'pop/rock', 'worldwide', 'all genres']);

export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// "A & B", "A, B", "A feat. B" -> every credited artist, plus the full string.
export function artistTokens(name) {
  const full = norm(name);
  if (!full) return [];
  const parts = full.replace(/[()[\]]/g, ',').split(/\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\/)\s*/).map((p) => p.trim()).filter(Boolean);
  return [...new Set([full, ...parts])];
}

// "A, B & C" -> "A": the name to show when a whole credit list would be too long.
export const leadArtist = (name) => String(name || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0] || String(name || '');
// For sentences: "Andrew Lloyd Webber & The Phantom of the Opera (Original London Cast)" -> "Andrew Lloyd Webber".
export const shortName = (name) => leadArtist(String(name || '').replace(/\s*[([].*?[)\]]/g, '').trim()) || String(name || '');
export const usefulGenres = (genres) => [...new Set((genres || []).map(norm).filter((g) => g && !GENERIC_GENRES.has(g)))];
// Title without "(Remastered 2011)" / "[Live]" etc. plus the main credited artist: the same song across releases.
export const songKey = (name, artist) => `${norm(name).replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, '').trim()}|${artistTokens(artist)[1] || artistTokens(artist)[0] || ''}`;
const yearOf = (d) => { const y = parseInt(String(d || '').slice(0, 4), 10); return Number.isFinite(y) && y > 1900 ? y : null; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------------------------------- 1. taste profile
// How much one occurrence of a song in each signal says about taste. `shown` (songs Discover itself showed or saved) and
// `discover` count as known songs but say nothing about taste: otherwise the mixes would feed on themselves.
export const SOURCE_WEIGHT = { recent: 1, log: 1, heavy: 0.6, favourite: 3, 'own-playlist': 1, playlist: 0.35, library: 0.2, shown: 0, discover: 0 };

// Who a play counts for. Cast recordings and collaborations credit each track to its performers ("A, B & C"), which
// splits one taste across dozens of names; the album artist ("Original Broadway Cast of X", or "A" for "A & B") is the
// stable identity, so it is used when it is one of the track's artists or the track's artists are a list of people.
const VARIOUS = new Set(['various artists', 'verschiedene interpreten', 'artistes divers', 'varios artistas']);
export function creditOf(t) {
  const al = norm(t.albumArtist), toks = artistTokens(t.artistName);
  if (!al || VARIOUS.has(al) || al === toks[0]) return { name: t.artistName, id: t.artistId ? String(t.artistId) : null, viaAlbum: false };
  if (toks.includes(al) || toks.length > 2 || /\bcast\b|original|soundtrack|ensemble|company/i.test(t.albumArtist)) return { name: t.albumArtist, id: t.albumArtistId ? String(t.albumArtistId) : null, viaAlbum: true };
  return { name: t.artistName, id: t.artistId ? String(t.artistId) : null, viaAlbum: false };
}

// tracks: [{ id?, isrc?, name, artistName, artistId?, albumArtist?, albumArtistId?, albumName?, albumId?, genres?, year?, source, w? }]
export function buildProfile({ tracks = [], libraryArtists = [], blocked = [], hidden = [] } = {}) {
  const idByName = new Map();
  for (const t of tracks) { const c = creditOf(t); if (c.id && !idByName.has(norm(c.name))) idByName.set(norm(c.name), c.id); }
  const hiddenSet = new Set(hidden.map(norm)), blockedSet = new Set(blocked.map(norm));
  const artists = new Map(), genres = new Map(), years = new Map();
  const known = { ids: new Set(), isrcs: new Set(), songs: new Set(), artists: new Set(), albums: new Set() };
  for (const t of tracks) {
    if (!t.artistName) continue;
    const c = creditOf(t);
    const isHidden = [...artistTokens(t.artistName), norm(c.name)].some((x) => hiddenSet.has(x));
    if (!isHidden) {
      if (t.id) known.ids.add(String(t.id));
      if (t.isrc) known.isrcs.add(t.isrc);
      if (t.name) known.songs.add(songKey(t.name, t.artistName));
      if (t.albumId && t.source !== 'discover' && t.source !== 'shown') known.albums.add(String(t.albumId));
    }
    const w = (t.w ?? 1) * (SOURCE_WEIGHT[t.source] ?? 0);
    if (w <= 0 || isHidden) continue;
    artistTokens(t.artistName).forEach((x) => known.artists.add(x)); known.artists.add(norm(c.name));
    const id = c.id || idByName.get(norm(c.name)) || null;
    const key = id ? `id:${id}` : `n:${norm(c.name)}`;
    const a = artists.get(key) || { key, id, name: c.name, w: 0, n: 0, genres: new Map(), viaAlbum: c.viaAlbum };
    a.w += w; a.n++;
    usefulGenres(t.genres).forEach((g, i) => { const gw = w * (i === 0 ? 1 : 0.35); a.genres.set(g, (a.genres.get(g) || 0) + gw); genres.set(g, (genres.get(g) || 0) + gw); });
    artists.set(key, a);
    const y = t.year ?? yearOf(t.releaseDate);
    if (y) years.set(y, (years.get(y) || 0) + w);
  }
  for (const name of libraryArtists) if (!artistTokens(name).some((x) => hiddenSet.has(x))) artistTokens(name).forEach((x) => known.artists.add(x));
  const gTotal = [...genres.values()].reduce((s, v) => s + v, 0) || 1;
  for (const [g, v] of genres) genres.set(g, v / gTotal);
  const ranked = [...artists.values()].sort((a, b) => b.w - a.w);
  const eraPeak = Math.max(1e-9, ...Array.from({ length: 90 }, (_, i) => kde(years, 1946 + i)));
  return {
    artists: ranked, genres, years, known, blocked: blockedSet,
    isBlocked: (name) => artistTokens(name).some((x) => blockedSet.has(x)),
    isKnownArtist: (name) => artistTokens(name).some((x) => known.artists.has(x)),
    knowsSong: (s) => (s.id && known.ids.has(String(s.id))) || (s.isrc && known.isrcs.has(s.isrc)) || (s.name && known.songs.has(songKey(s.name, s.artistName))),
    eraFit: (y) => (y && years.size ? clamp(kde(years, y) / eraPeak, 0, 1) : 0.5),
  };
}
function kde(years, y, h = 4) { let s = 0; for (const [yy, w] of years) s += w * Math.exp(-((y - yy) ** 2) / (2 * h * h)); return s; }

// Cosine between a song's genres (primary first) and the profile's genre shares.
export function genreFit(profile, genres) {
  const g = usefulGenres(genres); if (!g.length || !profile.genres.size) return 0;
  let dot = 0, nn = 0;
  g.forEach((x, i) => { const v = i === 0 ? 1 : 0.35; nn += v * v; dot += v * (profile.genres.get(x) || 0); });
  let pp = 0; for (const v of profile.genres.values()) pp += v * v;
  return clamp(dot / (Math.sqrt(nn) * Math.sqrt(pp) || 1), 0, 1);
}

export function pickSeeds(profile, n = 30) {
  const top = profile.artists.filter((a) => !profile.isBlocked(a.name)).slice(0, n);
  const max = top[0]?.w || 1;
  return top.map((a) => ({ key: a.key, id: a.id, name: a.name, w: a.w / max, genres: a.genres }));
}

// ---------------------------------------------------------------------------------------------------- 2. taste clusters
// nodes: Map(artistId -> { id, name, genres[], similar: [artistId] | null, top: [song] | null, art? })
const simSet = (nodes, id) => new Set(nodes.get(id)?.similar || []);
function mapCos(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; dot += v * (b.get(k) || 0); }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
export function seedAffinity(a, b, nodes) {
  const A = simSet(nodes, a.id), B = simSet(nodes, b.id);
  const direct = (a.id && B.has(a.id)) || (b.id && A.has(b.id)) ? 1 : 0;
  let shared = 0; if (A.size && B.size) { let n = 0; for (const x of A) if (B.has(x)) n++; shared = n / Math.min(A.size, B.size); }
  return 0.45 * direct + 0.35 * shared + 0.2 * mapCos(a.genres || new Map(), b.genres || new Map());
}

// Average-linkage agglomerative clustering of the seeds; the strongest clusters (by listening weight) become mixes.
export function clusterSeeds(seeds, nodes, { maxClusters = 6, minAffinity = 0.2, sameGenre = 0.08 } = {}) {
  const aff = seeds.map((a) => seeds.map((b) => (a === b ? 1 : seedAffinity(a, b, nodes))));
  let groups = seeds.map((_, i) => [i]);
  const link = (g, h) => { let s = 0; for (const i of g) for (const j of h) s += aff[i][j]; return s / (g.length * h.length); };
  for (;;) {
    let best = null;
    for (let x = 0; x < groups.length; x++) for (let y = x + 1; y < groups.length; y++) { const l = link(groups[x], groups[y]); if (!best || l > best.l) best = { x, y, l }; }
    if (!best || best.l < minAffinity) break;
    groups[best.x] = groups[best.x].concat(groups[best.y]); groups.splice(best.y, 1);
  }
  // clusters that would carry the same genre name and still share something are one taste split in two
  const topGenre = (g) => { const v = new Map(); for (const i of g) for (const [k, x] of seeds[i].genres || []) v.set(k, (v.get(k) || 0) + x * seeds[i].w); return [...v.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let x = 0; x < groups.length; x++) for (let y = x + 1; y < groups.length; y++) {
      const gx = topGenre(groups[x]);
      if (gx && gx === topGenre(groups[y]) && link(groups[x], groups[y]) >= sameGenre) { groups[x] = groups[x].concat(groups[y]); groups.splice(y, 1); merged = true; break outer; }
    }
  }
  const weight = (g) => g.reduce((s, i) => s + seeds[i].w, 0);
  groups.sort((g, h) => weight(h) - weight(g));
  const kept = groups.slice(0, maxClusters), rest = groups.slice(maxClusters);
  for (const g of rest) {   // a small leftover joins the cluster it is closest to, if any is close at all
    let best = null; kept.forEach((k, i) => { const l = link(g, k); if (!best || l > best.l) best = { i, l }; });
    if (best && best.l > 0.08) kept[best.i] = kept[best.i].concat(g);
  }
  return kept.map((g) => {
    const members = g.map((i) => seeds[i]).sort((a, b) => b.w - a.w);
    const votes = new Map();
    for (const m of members) for (const [k, v] of m.genres || []) votes.set(k, (votes.get(k) || 0) + v * m.w);
    const genre = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { id: `c:${norm(members[0].name)}`, seeds: members, w: weight(g), genre, names: members.slice(0, 3).map((m) => m.name) };   // named after its top artist: stable across rebuilds
  });
}

// ---------------------------------------------------------------------------------------------------- 3. graph relevance
// Similar-artist lists are directed and ranked. Measured on a holdout of the listener's own favourites, plain directed
// edges beat adding reverse edges, and only light hub damping pays off (see README, "How Discover works").
export function buildGraph(nodes, { reverse = 0 } = {}) {
  const adj = new Map(), indeg = new Map(), inn = new Map();
  const add = (u, v, w) => { if (u === v) return; let m = adj.get(u); if (!m) adj.set(u, (m = new Map())); m.set(v, Math.max(m.get(v) || 0, w)); };
  for (const n of nodes.values()) {
    (n.similar || []).forEach((v, r) => {
      const w = 1 / (1 + 0.15 * r); add(n.id, v, w); if (reverse) add(v, n.id, reverse * w);
      indeg.set(v, (indeg.get(v) || 0) + 1); if (!inn.has(v)) inn.set(v, []); inn.get(v).push(n.id);
    });
  }
  return { adj, indeg, inn };
}
export function pagerank({ adj }, restart, { alpha = 0.25, iters = 30 } = {}) {
  const total = [...restart.values()].reduce((s, v) => s + v, 0) || 1;
  const r = new Map([...restart].map(([k, v]) => [k, v / total]));
  const sums = new Map(); for (const [u, m] of adj) { let s = 0; for (const w of m.values()) s += w; sums.set(u, s); }
  let p = new Map(r);
  for (let it = 0; it < iters; it++) {
    const next = new Map(); let dangling = 0;
    for (const [k, v] of r) next.set(k, alpha * v);
    for (const [u, pu] of p) {
      const m = adj.get(u), mass = (1 - alpha) * pu;
      if (!m || !sums.get(u)) { dangling += mass; continue; }
      const s = sums.get(u); for (const [v, w] of m) next.set(v, (next.get(v) || 0) + mass * w / s);
    }
    if (dangling) for (const [k, v] of r) next.set(k, next.get(k) + dangling * v);
    p = next;
  }
  return p;
}

// Relevance of every artist in the graph, overall and per cluster, with the seeds that lead to it (for the reasons).
export function rankArtists(nodes, seeds, clusters, { adventure = 0.5, hubDamping = 0.1 } = {}) {
  const graph = buildGraph(nodes), alpha = 0.3 - 0.15 * clamp(adventure, 0, 1);
  const withId = seeds.filter((s) => s.id);
  const restartOf = (list) => new Map(list.filter((s) => s.id).map((s) => [s.id, s.w]));
  const global = pagerank(graph, restartOf(withId), { alpha });
  const per = clusters.map((c) => ({ id: c.id, p: pagerank(graph, restartOf(c.seeds), { alpha }) }));
  const seedIds = new Set(withId.map((s) => s.id)), seedSims = withId.map((s) => [s, simSet(nodes, s.id)]);
  const damp = (id, v) => v / (1 + (graph.indeg.get(id) || 0)) ** hubDamping;
  const out = new Map();
  for (const [id, v] of global) {
    if (seedIds.has(id)) continue;
    const own = nodes.get(id)?.similar || [], via = [];
    for (const [s, sims] of seedSims) if (sims.has(id) || own.includes(s.id)) via.push(s);
    via.sort((a, b) => b.w - a.w);
    let cluster = null, cbest = -1;
    for (const c of per) { const x = c.p.get(id) || 0; if (x > cbest) { cbest = x; cluster = c.id; } }
    out.set(id, { id, name: nodes.get(id)?.name || null, rel: damp(id, v), via: via.map((s) => s.name), viaN: via.length, hop: via.length ? 1 : 2, cluster, clusterRel: Object.fromEntries(per.map((c) => [c.id, damp(id, c.p.get(id) || 0)])) });
  }
  // a hop-2 artist's bridge: the most relevant artist one of yours leads to that lists it (or that it lists) as similar
  for (const a of out.values()) {
    if (a.hop !== 2) continue;
    let best = null;
    for (const v of [...(graph.inn.get(a.id) || []), ...(graph.adj.get(a.id)?.keys() || [])]) { const b = out.get(v); if (b && b.hop === 1 && (!best || b.rel > best.rel)) best = b; }
    a.bridge = best?.name || null;
  }
  const max = Math.max(1e-12, ...[...out.values()].map((a) => a.rel));
  const degs = [...graph.indeg.values()].sort((a, b) => a - b), p90 = Math.max(2, degs[Math.floor(degs.length * 0.9)] || 2);
  for (const a of out.values()) { a.relN = Math.sqrt(a.rel / max); a.fame = Math.min(1, (graph.indeg.get(a.id) || 0) / p90); }
  out.fame = (id) => Math.min(1, (graph.indeg.get(id) || 0) / p90);
  return out;
}

// ---------------------------------------------------------------------------------------------------- 4. song scoring
export const FEATURES = ['graph', 'consensus', 'genre', 'era', 'pop', 'novelty', 'editorial', 'apple', 'fresh', 'fbArtist', 'fbGenre', 'shown'];
export const PRIOR = { graph: 1.2, consensus: 0.5, genre: 0.6, era: 0.25, pop: 0.35, novelty: 0.35, editorial: 0.4, apple: 0.25, fresh: 0.1, fbArtist: 1, fbGenre: 0.4, shown: -0.9 };

// The Adventure setting (0 familiar ... 1 adventurous) reshapes the prior; learned deltas are added on top.
export function weightsFor(adventure = 0.5, learned = null) {
  const a = clamp(adventure, 0, 1), w = { ...PRIOR };
  w.novelty += 0.5 * a - 0.15; w.pop += 0.25 - 0.45 * a; w.genre += 0.2 - 0.35 * a; w.era += 0.1 - 0.15 * a;
  if (learned) for (const k of FEATURES) w[k] += learned[k] || 0;
  return w;
}
export const scoreOf = (f, w) => FEATURES.reduce((s, k) => s + (w[k] || 0) * (f[k] || 0), 0);

// How likely a song is to be a good first listen: a new artist's best-known songs, or a known artist's deeper cuts. For a
// famous artist (`fame` near 1: many artists in the graph point at them) the biggest hits are probably heard already, so
// the peak moves down their list.
export const popularity = (rank, knownArtist, fame = 0) => (knownArtist
  ? Math.exp(-((rank - 5 - 3 * fame) ** 2) / 18)
  : (1 - fame) * Math.exp(-rank / 2.5) + fame * Math.exp(-((rank - 3) ** 2) / 5));

// artists: rankArtists() output; nodes carry each artist's top songs.
// evidence: { editorial: Map(songId -> { seed, playlist }), editorialArtists: Map(artistName -> { seed, playlist }),
//             apple: Set(artist names), feedback: { artists: Map(norm name -> net), genres: Map(genre -> net) },
//             shown: Set(song ids recently shown), extra: [song] (editorial songs whose artists are not in the graph) }
export function candidateSongs(nodes, artists, profile, evidence = {}, { adventure = 0.5, knownSkip = 3, newDepth = 4, now = Date.now() } = {}) {
  const ed = evidence.editorial || new Map(), edA = evidence.editorialArtists || new Map(), apple = evidence.apple || new Set();
  const fbA = evidence.feedback?.artists || new Map(), fbG = evidence.feedback?.genres || new Map(), shown = evidence.shown || new Set();
  const seen = new Set(), out = [];
  const consider = (song, rank, art) => {
    if (!song?.id || !song.name || !song.artistName) return;
    const key = songKey(song.name, song.artistName);
    if (seen.has(song.id) || seen.has(key) || (song.isrc && seen.has(song.isrc))) return;
    if (profile.isBlocked(song.artistName) || profile.knowsSong(song)) return;
    const knownArtist = profile.isKnownArtist(song.artistName), e = ed.get(song.id);
    const fame = art?.fame || 0;
    if (!e && rank != null) { if (knownArtist && rank < knownSkip + Math.round(4 * fame)) return; if (!knownArtist && rank > newDepth + Math.round(3 * fame)) return; }
    seen.add(song.id); seen.add(key); if (song.isrc) seen.add(song.isrc);
    const genre = usefulGenres(song.genres)[0] || null, year = song.year ?? yearOf(song.releaseDate);
    const ageDays = song.releaseDate ? (now - Date.parse(song.releaseDate)) / 864e5 : 9999;
    const f = {
      graph: art?.relN ?? (e ? 0.35 : 0),
      consensus: art ? 1 - 1 / (1 + art.viaN) : 0,
      genre: genreFit(profile, song.genres),
      era: profile.eraFit(year),
      pop: rank == null ? 0.4 : popularity(rank, knownArtist, fame),
      novelty: knownArtist ? 0 : 1,
      editorial: e ? 1 : edA.has(norm(song.artistName)) ? 0.5 : 0,
      apple: artistTokens(song.artistName).some((x) => apple.has(x)) ? 1 : 0,
      fresh: ageDays < 730 ? 1 - ageDays / 730 : 0,
      fbArtist: Math.tanh(artistTokens(song.artistName).reduce((s, x) => s + (fbA.get(x) || 0), 0)),
      fbGenre: genre ? Math.tanh((fbG.get(genre) || 0) / 2) : 0,
      shown: shown.has(song.id) ? 1 : 0,
    };
    out.push({ ...song, year, genre, rank, knownArtist, artistKey: norm(artistTokens(song.artistName)[1] || song.artistName),
      cluster: art?.cluster ?? null, hop: art?.hop ?? (e ? 1 : 2), via: art?.via || (e ? [e.seed] : []), bridge: art?.bridge || null, editorialFrom: e || null, f });
  };
  for (const a of artists.values()) (nodes.get(a.id)?.top || []).forEach((s, i) => consider(s, i, a));
  for (const s of evidence.extra || []) consider(s, null, s.artistId ? artists.get(String(s.artistId)) : null);
  return out;
}

export function scoreSongs(cands, weights) { for (const c of cands) c.score = scoreOf(c.f, weights); return cands; }

// ---------------------------------------------------------------------------------------------------- 5. learning
// examples: [{ f, y: 1 kept | 0 rejected, w? }] -> per-feature weight deltas (null until there is enough to learn from).
export function learnWeights(examples, { l2 = 2, steps = 400, lr = 0.15, shrink = 0.6, min = 6 } = {}) {
  const ex = (examples || []).filter((e) => e?.f && (e.y === 0 || e.y === 1));
  if (ex.length < min || !ex.some((e) => e.y === 1) || !ex.some((e) => e.y === 0)) return null;
  const d = Object.fromEntries(FEATURES.map((k) => [k, 0])); let b = 0;
  const W = ex.reduce((s, e) => s + (e.w ?? 1), 0);
  for (let it = 0; it < steps; it++) {
    const g = Object.fromEntries(FEATURES.map((k) => [k, l2 * d[k] / W])); let gb = 0;
    for (const e of ex) {
      const z = b + FEATURES.reduce((s, k) => s + d[k] * (e.f[k] || 0), 0), p = 1 / (1 + Math.exp(-z)), err = (p - e.y) * (e.w ?? 1) / W;
      for (const k of FEATURES) g[k] += err * (e.f[k] || 0);
      gb += err;
    }
    for (const k of FEATURES) d[k] -= lr * g[k] * 10;
    b -= lr * gb * 10;
  }
  return Object.fromEntries(FEATURES.map((k) => [k, clamp(d[k] * shrink, -1, 1)]));
}

// ---------------------------------------------------------------------------------------------------- 6. selection
const gumbel = (rng) => -Math.log(-Math.log(Math.min(1 - 1e-9, Math.max(1e-9, rng()))));
// An album is the same by id or by title (editions of one album have different ids): either counts toward the cap.
const albumKeys = (c) => [c.albumId ? `id:${c.albumId}` : null, c.albumName ? `${norm(c.albumName).replace(/\s*[([].*?[)\]]/g, '').trim()}|${c.artistKey}` : null].filter(Boolean);
const sameAlbum = (a, b) => { const k = albumKeys(b); return albumKeys(a).some((x) => k.includes(x)); };
export const similarity = (a, b) => (a.artistKey === b.artistKey ? 1 : 0) || ((a.genre && a.genre === b.genre ? 0.35 : 0) + (a.cluster && a.cluster === b.cluster ? 0.15 : 0) + (sameAlbum(a, b) ? 0.5 : 0));

// quotas: { clusterId: n } (missing clusters are unconstrained). Returns the picks in selection order.
export function selectMix(cands, { count = 30, quotas = null, maxPerArtist = 2, maxPerAlbum = 1, lambda = 0.78, temperature = 0.05, exploreShare = 0.2, rng = Math.random } = {}) {
  const pool = cands.map((c) => ({ c, s: c.score + temperature * gumbel(rng), maxSim: 0 }));
  const chosen = [], perArtist = new Map(), perAlbum = new Map(), perCluster = new Map();
  const exploreTarget = Math.round(count * exploreShare); let explored = 0;
  const quotaLeft = (cl) => (quotas && cl in quotas ? quotas[cl] - (perCluster.get(cl) || 0) : Infinity);
  const anyQuotaLeft = () => quotas && Object.keys(quotas).some((k) => quotaLeft(k) > 0);
  while (chosen.length < count) {
    const slotsLeft = count - chosen.length, needExplore = explored < exploreTarget && slotsLeft <= exploreTarget - explored, wantQuota = anyQuotaLeft();
    let best = null;
    for (const p of pool) {
      if (p.taken) continue;
      const c = p.c;
      if ((perArtist.get(c.artistKey) || 0) >= maxPerArtist || albumKeys(c).some((k) => (perAlbum.get(k) || 0) >= maxPerAlbum)) continue;
      if (needExplore && c.hop !== 2) continue;
      if (wantQuota && !(quotaLeft(c.cluster) > 0 && quotaLeft(c.cluster) !== Infinity)) continue;
      const v = lambda * p.s - (1 - lambda) * p.maxSim;
      if (!best || v > best.v) best = { p, v };
    }
    if (!best) {
      if (needExplore) { explored = exploreTarget; continue; }      // no far candidates left: fill normally
      if (wantQuota) { quotas = null; continue; }                   // quotas unreachable: drop them
      break;
    }
    const { c } = best.p; best.p.taken = true; chosen.push(c);
    perArtist.set(c.artistKey, (perArtist.get(c.artistKey) || 0) + 1);
    for (const k of albumKeys(c)) perAlbum.set(k, (perAlbum.get(k) || 0) + 1);
    if (c.cluster) perCluster.set(c.cluster, (perCluster.get(c.cluster) || 0) + 1);
    if (c.hop === 2) explored++;
    for (const p of pool) if (!p.taken) p.maxSim = Math.max(p.maxSim, similarity(p.c, c));
  }
  return chosen;
}

// Cluster quotas for a mix: shares follow listening weight, flattened so a small habit still gets a couple of songs.
export function quotasFor(clusters, count, { min = 2, flatten = 0.6 } = {}) {
  if (!clusters.length) return null;
  const w = clusters.map((c) => c.w ** flatten), total = w.reduce((s, x) => s + x, 0) || 1;
  const q = {}; clusters.forEach((c, i) => { q[c.id] = Math.max(min, Math.round(count * w[i] / total)); });
  return q;
}

// Order a mix so it moves between your tastes: short blocks of two or three songs, one taste after another, each block
// preferring a different genre from the last. The strongest song opens; each taste plays its best songs first.
export function sequence(picks) {
  if (picks.length < 3) return picks.slice();
  const groups = new Map();
  for (const c of picks.slice().sort((a, b) => b.score - a.score)) { const k = c.cluster ?? `g:${c.genre}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const genreOf = (list) => { const n = new Map(); for (const c of list) n.set(c.genre, (n.get(c.genre) || 0) + 1); return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
  const out = [];
  let prevKey = null, prevGenre = null;
  while (out.length < picks.length) {
    const live = [...groups.entries()].filter(([, l]) => l.length);
    const rank = ([k, l]) => l[0].score + 0.04 * l.length - (k === prevKey && live.length > 1 ? 100 : 0) - (genreOf(l) === prevGenre ? 0.6 : 0);
    const [key, list] = live.sort((a, b) => rank(b) - rank(a))[0];
    const block = list.splice(0, Math.min(list.length, list.length > 8 ? 3 : 2));
    out.push(...block); prevKey = key; prevGenre = genreOf(block);
  }
  // two songs by one artist can still meet at a block boundary: move the second to a gap between two other artists
  for (let i = 1; i < out.length; i++) {
    if (out[i].artistKey !== out[i - 1].artistKey) continue;
    const [c] = out.splice(i, 1);
    const at = out.findIndex((x, j) => j > 0 && x.artistKey !== c.artistKey && out[j - 1].artistKey !== c.artistKey);
    out.splice(at > 0 ? at : i, 0, c);
  }
  return out;
}

// One short line under each song saying why it is there.
export function reasonFor(c) {
  if (c.editorialFrom) return `From “${c.editorialFrom.playlist}”`;
  if (c.knownArtist) return `A deeper cut from ${shortName(c.artistName)}`;
  const via = [...new Set((c.via || []).map(shortName))];
  if (via.length >= 2) return `Because you like ${via[0]} and ${via[1]}`;
  if (via.length === 1) return `Because you like ${via[0]}`;
  if (c.bridge) return `Further out, through ${shortName(c.bridge)}`;
  if (c.f?.apple) return 'Suggested by Apple Music';
  return 'Something new for you';
}

// ---------------------------------------------------------------------------------------------------- summaries
const pretty = (g) => String(g || '').replace(/(^|[\s/-])([a-z])/g, (m, p, ch) => p + ch.toUpperCase()).replace(/\bR&b\b/, 'R&B').replace(/\bK-pop\b/i, 'K-Pop');
export const prettyGenre = pretty;

export function tasteSummary(profile, clusters) {
  const genres = [...profile.genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, share]) => ({ name: pretty(name), share }));
  const dec = new Map(); let tot = 0;
  for (const [y, w] of profile.years) { const d = Math.floor(y / 10) * 10; dec.set(d, (dec.get(d) || 0) + w); tot += w; }
  const decades = [...dec.entries()].sort((a, b) => a[0] - b[0]).map(([decade, w]) => ({ decade, share: w / (tot || 1) }));
  return { genres, decades, artists: profile.artists.slice(0, 12).map((a) => a.name), clusters: clusters.map((c) => ({ id: c.id, genre: pretty(c.genre), names: c.names })) };
}

// Mix names: the cluster's genre when no other cluster has it, otherwise its leading artist.
export function mixTitles(clusters) {
  const count = new Map(); for (const c of clusters) if (c.genre) count.set(c.genre, (count.get(c.genre) || 0) + 1);
  return new Map(clusters.map((c) => [c.id, c.genre && count.get(c.genre) === 1 ? `${pretty(c.genre)} Discoveries` : `More Like ${shortName(c.names[0])}`]));
}
export const mixTitle = (cluster) => (cluster ? mixTitles([cluster]).get(cluster.id) : 'Discover Mix');

// ---------------------------------------------------------------------------------------------------- settings
export const DISCOVER_DEFAULTS = { adventure: 0.5, length: 30, era: 'any', deepCuts: true, skipClusters: [], avoidGenres: [], refresh: 'weekly' };
export function parseDiscoverSettings(raw) {
  let o; try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  const d = DISCOVER_DEFAULTS, strs = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string').slice(0, 40) : []);
  if (!o || typeof o !== 'object') return { ...d, skipClusters: [], avoidGenres: [] };
  const adv = Number(o.adventure);
  return {
    adventure: o.adventure != null && Number.isFinite(adv) ? clamp(adv, 0, 1) : d.adventure,
    length: [20, 30, 50, 100].includes(o.length) ? o.length : d.length,
    era: ['any', 'recent', 'classic'].includes(o.era) ? o.era : d.era,
    deepCuts: typeof o.deepCuts === 'boolean' ? o.deepCuts : d.deepCuts,
    skipClusters: strs(o.skipClusters), avoidGenres: strs(o.avoidGenres),
    refresh: ['daily', 'weekly', 'manual'].includes(o.refresh) ? o.refresh : d.refresh,
  };
}

// The learned weight changes in words, strongest first ("More artists new to you").
const LEARN_WORDS = {
  novelty: ['artists new to you', 'artists you already know'], pop: ['artists’ best-known songs', 'lesser-known songs'],
  graph: ['close matches to your artists', 'looser matches'], consensus: ['artists several of yours have in common', 'one-off connections'],
  genre: ['your usual genres', 'genres you play less'], era: ['your usual eras', 'other eras'], editorial: ['editors’ picks', 'songs beyond editors’ picks'],
  apple: ['Apple’s suggestions', 'songs Apple doesn’t suggest'], fresh: ['new releases', 'older songs'],
};
export function describeLearning(learned, threshold = 0.06) {
  if (!learned) return [];
  return Object.entries(LEARN_WORDS).map(([k, words]) => [learned[k] || 0, words]).filter(([v]) => Math.abs(v) >= threshold)
    .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, 4).map(([v, [up, down]]) => `More ${v > 0 ? up : down}`);
}

// Holdout check used by the tests (and the evaluation script): how many hidden artists the ranking finds in its top k.
export function recallAtK(ranked, hidden, k) {
  const top = new Set(ranked.slice(0, k)); let hit = 0;
  for (const h of hidden) if (top.has(h)) hit++;
  return hidden.size ? hit / hidden.size : 0;
}
