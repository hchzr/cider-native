import assert from 'node:assert/strict';
import { norm, artistTokens, songKey, usefulGenres, creditOf, shortName, mixTitles, buildProfile, genreFit, pickSeeds, clusterSeeds, buildGraph, pagerank, rankArtists, candidateSongs, scoreSongs, weightsFor, learnWeights, selectMix, quotasFor, sequence, reasonFor, popularity, recallAtK, tasteSummary, FEATURES, parseDiscoverSettings, DISCOVER_DEFAULTS, describeLearning, newPlays } from '../discover-engine.js';

// Synthetic fixtures only (the repository is public): two separate tastes, "rock" and "jazz", plus a hub artist.
const song = (id, name, artistName, artistId, genres, extra = {}) => ({ id: String(id), name, artistName, artistId: String(artistId), albumName: `${name} LP`, genres, year: 2015, ...extra });
const tracks = [
  ...Array.from({ length: 6 }, (_, i) => ({ ...song(100 + i, `Rock Song ${i}`, 'Rocker A', 1, ['Rock', 'Music']), source: 'recent', w: 1 })),
  ...Array.from({ length: 4 }, (_, i) => ({ ...song(110 + i, `Rock B ${i}`, 'Rocker B', 2, ['Rock']), source: 'recent', w: 1 })),
  ...Array.from({ length: 5 }, (_, i) => ({ ...song(120 + i, `Jazz Song ${i}`, 'Jazz C', 3, ['Jazz'], { year: 1962 }), source: 'favourite', w: 1 })),
  ...Array.from({ length: 2 }, (_, i) => ({ ...song(130 + i, `Jazz D ${i}`, 'Jazz D', 4, ['Jazz'], { year: 1965 }), source: 'own-playlist', w: 1 })),
  { ...song(140, 'Shown Song', 'Shown Artist', 99, ['Pop']), source: 'shown' },
];

// ---- helpers
assert.equal(norm('  The  Beatles '), 'the beatles');
assert.deepEqual(artistTokens('A & B feat. C'), ['a & b feat. c', 'a', 'b', 'c']);
assert.equal(songKey('Song (Remastered 2011)', 'A & B'), songKey('Song', 'A'), 'remaster tags and featured artists do not make a new song');
assert.equal(songKey('Song - Live at X', 'A'), songKey('Song', 'A'));
assert.equal(songKey('Song (from "Show', 'A'), songKey('Song', 'A'), 'an unclosed bracket is stripped too');
assert.deepEqual(usefulGenres(['Pop', 'Music', 'Pop/Rock', 'Pop']), ['pop'], 'generic genres dropped, duplicates removed');
assert.ok(popularity(0, false) > popularity(4, false), 'new artist: their best-known song first');
assert.ok(popularity(5, true) > popularity(0, true), 'known artist: a deeper cut beats the hit');
assert.ok(popularity(3, false, 1) > popularity(0, false, 1), 'famous new artist: their biggest hit is probably heard already');
assert.ok(popularity(8, true, 1) > popularity(5, true, 1), 'famous known artist: dig deeper');

// ---- credit: album artists keep a cast recording or a collaboration together
assert.equal(creditOf({ artistName: 'Leslie Odom, Jr., Lin-Manuel Miranda & Phillipa Soo', albumArtist: 'Original Broadway Cast of Hamilton' }).name, 'Original Broadway Cast of Hamilton');
assert.equal(creditOf({ artistName: 'Rema & Selena Gomez', albumArtist: 'Rema', artistId: 9 }).name, 'Rema');
assert.equal(creditOf({ artistName: 'Rema & Selena Gomez', albumArtist: 'Rema' }).viaAlbum, true);
assert.equal(creditOf({ artistName: 'Some Band', albumArtist: 'Various Artists', artistId: 5 }).name, 'Some Band', 'compilations keep the track artist');
assert.equal(creditOf({ artistName: 'A', albumArtist: 'A', artistId: 5 }).id, '5');
const cast = buildProfile({ tracks: ['Singer 1 & Singer 2', 'Singer 3, Singer 4 & Singer 5', 'Singer 1'].map((a, i) => ({ id: `h${i}`, name: `Number ${i}`, artistName: a, albumArtist: 'Original Cast of Show', source: 'recent' })) });
assert.equal(cast.artists.length, 1, 'every number on a cast album, solos included, counts for the show'); assert.equal(cast.artists[0].name, 'Original Cast of Show');
assert.deepEqual([...mixTitles([{ id: 'a', genre: 'pop', names: ['X'] }, { id: 'b', genre: 'pop', names: ['Y'] }, { id: 'c', genre: 'jazz', names: ['Z'] }]).values()], ['More Like X', 'More Like Y', 'Jazz Discoveries'], 'titles never repeat');

// ---- profile
const profile = buildProfile({ tracks, libraryArtists: ['Library Only'], blocked: ['Blocked Band'] });
assert.equal(profile.artists[0].name, 'Jazz C', 'favourites weigh three times a play');
assert.ok(!profile.artists.some((a) => a.name === 'Shown Artist'), 'songs Discover showed carry no taste');
assert.ok(profile.knowsSong({ id: '140' }), '... but they still count as known');
assert.ok(profile.knowsSong({ name: 'Rock Song 1 (Remastered)', artistName: 'Rocker A' }), 'known by title across releases');
assert.ok(profile.isKnownArtist('Library Only') && profile.isKnownArtist('Rocker A feat. Someone'));
assert.ok(!profile.isKnownArtist('Shown Artist'));
assert.ok(profile.isBlocked('Blocked Band & Friend'));
assert.ok(profile.eraFit(1963) > profile.eraFit(1990), 'era fit peaks where the listening is');
assert.ok(genreFit(profile, ['Jazz']) > genreFit(profile, ['Metal']));
const held = buildProfile({ tracks, hidden: ['Jazz D'] });
assert.ok(!held.artists.some((a) => a.name === 'Jazz D') && !held.isKnownArtist('Jazz D') && !held.knowsSong({ id: '130' }), 'holdout hides an artist completely');

// ---- graph: rock seeds 1,2 -> 10,11,12; jazz seeds 3,4 -> 20,21; hub 50 linked from everything; 13 is two hops out
const top = (aid, name, genre, n = 10) => Array.from({ length: n }, (_, r) => song(`s${aid}-${r}`, `${name} hit ${r}`, name, aid, [genre]));
const node = (id, name, similar, genre) => [String(id), { id: String(id), name, genres: [genre], similar: similar.map(String), top: top(id, name, genre) }];
const nodes = new Map([
  node(1, 'Rocker A', [10, 11, 2, 50], 'Rock'), node(2, 'Rocker B', [10, 12, 1, 50], 'Rock'),
  node(3, 'Jazz C', [20, 21, 4, 50], 'Jazz'), node(4, 'Jazz D', [20, 3, 50], 'Jazz'),
  node(10, 'New Rock X', [1, 2, 13], 'Rock'), node(11, 'New Rock Y', [1, 50], 'Rock'), node(12, 'New Rock Z', [2, 50], 'Rock'),
  node(13, 'Far Rock', [10, 14], 'Rock'), node(14, 'Very Far', [13], 'Rock'),
  node(20, 'New Jazz X', [3, 4, 50], 'Jazz'), node(21, 'New Jazz Y', [3, 50], 'Jazz'),
  node(50, 'Hub', [1, 3, 10, 20], 'Pop'),
]);
const seeds = pickSeeds(profile, 10).map((s) => ({ ...s, id: s.id }));
assert.equal(seeds[0].w, 1, 'best seed normalised to 1');
const clusters = clusterSeeds(seeds, nodes);
assert.equal(clusters.length, 2, 'rock and jazz listening become two clusters');
const byName = (n) => clusters.find((c) => c.names.includes(n));
assert.ok(byName('Rocker A') === byName('Rocker B') && byName('Jazz C') === byName('Jazz D') && byName('Rocker A') !== byName('Jazz C'));
assert.equal(byName('Jazz C').genre, 'jazz');

const g = buildGraph(nodes);
assert.ok(g.adj.get('1').has('10') && !g.adj.get('11')?.has('2'), 'directed edges only by default');
assert.ok(buildGraph(nodes, { reverse: 0.5 }).adj.get('10').has('50'), 'reverse edges on request');
assert.deepEqual(g.inn.get('13'), ['10', '14'], 'who lists an artist as similar');
const pr = pagerank(g, new Map([['1', 1]]), { alpha: 0.3 });
assert.ok(Math.abs([...pr.values()].reduce((s, v) => s + v, 0) - 1) < 1e-6, 'pagerank is a distribution');
assert.ok(pr.get('10') > pr.get('14'), 'closer artists rank higher');

const ranked = rankArtists(nodes, seeds, clusters, { adventure: 0.5 });
const r = (id) => ranked.get(id);
assert.ok(!ranked.has('1') && !ranked.has('3'), 'seeds are not candidates');
assert.ok(r('10').rel > r('11').rel, 'reached from two of your artists beats one');
assert.equal(r('10').viaN, 2); assert.deepEqual(r('10').via.sort(), ['Rocker A', 'Rocker B']);
assert.equal(r('13').hop, 2); assert.equal(r('13').bridge, 'New Rock X');
assert.equal(r('20').cluster, byName('Jazz C').id, 'artists are assigned to the cluster that reaches them');
assert.equal(r('10').cluster, byName('Rocker A').id);
const undamped = rankArtists(nodes, seeds, clusters, { hubDamping: 0 });
assert.ok(r('50').rel / r('10').rel < undamped.get('50').rel / undamped.get('10').rel, 'hub damping lowers the hub against a specific match');
assert.ok(rankArtists(nodes, seeds, clusters, { adventure: 1 }).get('14').relN > rankArtists(nodes, seeds, clusters, { adventure: 0 }).get('14').relN, 'adventure reaches further');

// ---- candidates and scoring
const cands = candidateSongs(nodes, ranked, profile, { apple: new Set(['new jazz y']), shown: new Set(['s20-0']) }, { now: Date.parse('2026-01-01') });
const ids = new Set(cands.map((c) => c.id));
const depth = 4 + Math.round(3 * r('10').fame), depthQuiet = 4 + Math.round(3 * r('11').fame);
assert.ok(ids.has('s10-0') && ids.has(`s10-${depth}`) && !ids.has(`s10-${depth + 1}`), 'new artist: their first few songs, more for a famous one');
assert.ok(r('10').fame > r('11').fame && !ids.has(`s11-${depthQuiet + 1}`), 'fame comes from how many artists point at you');
assert.ok(!cands.some((c) => c.artistName === 'Rocker A'), 'seeds are not candidates themselves');
assert.ok(cands.every((c) => FEATURES.every((k) => typeof c.f[k] === 'number')), 'every candidate has every feature');
assert.equal(cands.find((c) => c.id === 's21-0').f.apple, 1, 'Apple evidence by artist');
assert.equal(cands.find((c) => c.id === 's20-0').f.shown, 1, 'recently shown songs are marked');
const dupes = candidateSongs(new Map([node(10, 'New Rock X', [], 'Rock')].map(([k, v]) => [k, { ...v, top: [song(1, 'Same', 'New Rock X', 10, ['Rock']), song(2, 'Same (Remastered)', 'New Rock X', 10, ['Rock'])] }])), new Map([['10', { id: '10', relN: 1, viaN: 1, via: [] }]]), profile);
assert.equal(dupes.length, 1, 'the same song on two releases is one candidate');
const knownOnly = candidateSongs(new Map([['1', { id: '1', top: top(1, 'Rocker A', 'Rock', 8) }]]), new Map([['1', { id: '1', relN: 0.5, viaN: 0, via: [] }]]), profile);
assert.deepEqual(knownOnly.map((c) => c.rank), [3, 4, 5, 6, 7], 'known artist: their first three hits are skipped');

const w = weightsFor(0.5);
scoreSongs(cands, w);
assert.ok(cands.find((c) => c.id === 's20-0').score < cands.find((c) => c.id === 's20-1').score, 'shown penalty applies');
assert.ok(weightsFor(1).novelty > weightsFor(0).novelty && weightsFor(1).pop < weightsFor(0).pop, 'adventure favours new artists and deeper songs');

// ---- learning: the user keeps new-artist picks and rejects known-artist ones -> novelty weight rises
const mk = (novelty, y) => ({ f: Object.fromEntries(FEATURES.map((k) => [k, k === 'novelty' ? novelty : 0.5])), y });
assert.equal(learnWeights([mk(1, 1), mk(0, 0)]), null, 'not enough examples yet');
assert.equal(learnWeights(Array.from({ length: 10 }, () => mk(1, 1))), null, 'one class only');
const learned = learnWeights([...Array.from({ length: 8 }, () => mk(1, 1)), ...Array.from({ length: 8 }, () => mk(0, 0))]);
assert.ok(learned.novelty > 0.2, `novelty learned (${learned.novelty})`);
assert.ok(Math.abs(learned.genre) < 0.05, 'an uninformative feature stays put');
assert.ok(weightsFor(0.5, learned).novelty > weightsFor(0.5).novelty);

// ---- selection
let seed = 7; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const mix = selectMix(cands, { count: 10, quotas: quotasFor(clusters, 10), maxPerArtist: 2, temperature: 0, rng });
assert.equal(mix.length, 10);
const per = new Map(); mix.forEach((c) => per.set(c.artistKey, (per.get(c.artistKey) || 0) + 1));
assert.ok([...per.values()].every((n) => n <= 2), 'at most two songs per artist');
assert.ok(mix.some((c) => c.cluster === byName('Jazz C').id) && mix.some((c) => c.cluster === byName('Rocker A').id), 'both tastes are represented');
const editions = [{ ...cands[0], id: 'e1', albumId: 'A1', albumName: 'Record', artistKey: 'x', score: 9 }, { ...cands[0], id: 'e2', albumId: 'A2', albumName: 'Record (Deluxe)', artistKey: 'x', score: 8 }];
assert.equal(selectMix(editions, { count: 2, temperature: 0, rng }).length, 1, 'two editions of one album count as one album');
const explore = selectMix(cands, { count: 10, exploreShare: 0.3, temperature: 0, rng });
assert.ok(explore.filter((c) => c.hop === 2).length >= 3, 'exploration share reserves far songs');
const a1 = selectMix(cands, { count: 8, temperature: 0.4, rng }).map((c) => c.id).join(), a2 = selectMix(cands, { count: 8, temperature: 0.4, rng }).map((c) => c.id).join();
assert.notEqual(a1, a2, 'noise makes each new mix differ');
const q = quotasFor(clusters, 30);
assert.ok(Object.values(q).every((n) => n >= 2) && q[byName('Jazz C').id] > q[byName('Rocker A').id], 'quotas follow weight with a floor');

const seq = sequence(mix);
assert.equal(seq.length, mix.length);
assert.ok(seq.every((c, i) => i === 0 || c.artistKey !== seq[i - 1].artistKey), 'never the same artist twice in a row');
assert.equal(seq[0], mix.slice().sort((a, b) => b.score - a.score)[0], 'the strongest song opens');
const blocky = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, artistKey: `a${i}`, genre: i < 8 ? 'phonk' : 'pop', cluster: i < 8 ? 'p' : 'q', year: 2024, score: 10 - i * 0.1 }));
const runs = (list) => { let m = 1, r = 1; for (let i = 1; i < list.length; i++) { r = list[i].genre === list[i - 1].genre ? r + 1 : 1; m = Math.max(m, r); } return m; };
assert.ok(runs(sequence(blocky).slice(0, 8)) <= 3, 'a dominant genre is broken up while there is something else to play');

// ---- reasons, summary, evaluation
assert.equal(reasonFor({ via: ['A', 'B'] }), 'Because you like A and B');
assert.equal(reasonFor({ via: ['A & The B (Original Cast)', 'A'] }), 'Because you like A', 'short names, no repeats');
assert.equal(shortName('Andrew Lloyd Webber & The Phantom of the Opera (Original London Cast)'), 'Andrew Lloyd Webber');
assert.equal(reasonFor({ via: [], bridge: 'X' }), 'Further out, through X');
assert.equal(reasonFor({ knownArtist: true, artistName: 'A' }), 'A deeper cut from A');
assert.equal(reasonFor({ editorialFrom: { playlist: 'Inspired by A' } }), 'From “Inspired by A”');
const sum = tasteSummary(profile, clusters);
assert.equal(sum.genres[0].name, 'Jazz'); assert.ok(sum.decades.some((d) => d.decade === 1960));
assert.equal(recallAtK(['a', 'b', 'c'], new Set(['b', 'z']), 2), 0.5);

// ---- settings and learning text
assert.deepEqual(parseDiscoverSettings('nope'), DISCOVER_DEFAULTS);
const ps = parseDiscoverSettings({ adventure: 3, length: 7, era: 'recent', deepCuts: false, skipClusters: ['c:a', 4], refresh: 'daily' });
assert.equal(ps.adventure, 1); assert.equal(ps.length, 30); assert.equal(ps.era, 'recent'); assert.equal(ps.deepCuts, false); assert.deepEqual(ps.skipClusters, ['c:a']); assert.equal(ps.refresh, 'daily');
assert.equal(parseDiscoverSettings({ adventure: 0 }).adventure, 0, 'zero is a valid adventure');
assert.deepEqual(describeLearning(null), []);
assert.deepEqual(describeLearning({ novelty: 0.3, pop: -0.2, genre: 0.01 }), ['More artists new to you', 'More lesser-known songs']);
assert.ok(clusters.every((c) => c.id.startsWith('c:')) && byName('Rocker A').id === 'c:rocker a', 'clusters are named after their top artist');

// ---- play log alignment
assert.equal(newPlays(['a', 'b', 'c'], []), 0, 'first look: nothing is new');
assert.equal(newPlays(['a', 'b', 'c'], ['a', 'b', 'c']), 0, 'no change');
assert.equal(newPlays(['x', 'y', 'a', 'b'], ['a', 'b', 'c']), 2, 'two new plays on top');
assert.equal(newPlays(['b', 'a', 'c'], ['a', 'b', 'c']), 0, 'a replay of a recent song does not re-log the history');
assert.equal(newPlays(['x', 'b', 'a', 'c'], ['a', 'b', 'c']), 1, 'a new play then a replay');
assert.equal(newPlays(['p', 'q', 'r'], ['a', 'b', 'c']), 3, 'more plays than the list holds: all of it is new');

console.log('discover tests passed');
