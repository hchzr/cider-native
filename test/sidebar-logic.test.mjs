import assert from 'node:assert/strict';
import { SEARCH, subtitleOf, containerName, fromLine, sourceName, cleanName, isFavouritesLabel, isActiveClass, rowKey, PRIMARY, LIBRARY, PLAYLISTS_ROOT, playlistPath, searchPath, activeNav, playlistsFromApi, artSized, initials, fmtDuration, queueSummary, splitQueue, absoluteIndex, queueSignature, moveArgs, trackTitle, trackArtist, isExplicit } from '../sidebar-logic.js';

assert.equal(playlistPath('p.abc'), '/am/container/library-playlist/p.abc'); assert.equal(searchPath(' daft punk '), '/am/search/?term=daft%20punk');
assert.equal(activeNav('/am/home'), 'home'); assert.equal(activeNav('/am/home/made-for-you'), 'madeforyou'); assert.equal(activeNav('/am/search/?term=daft%20punk'), 'search'); assert.equal(activeNav('/am/browse'), 'new');
assert.equal(activeNav('/am/listen-now'), 'home', "Cider's Home route highlights Home");
assert.equal(activeNav('/am/library/songs'), 'songs'); assert.equal(activeNav('/am/library/recently-added?x=1'), 'recent');
assert.equal(activeNav('/am/container/library-playlist/p.xyz'), 'pl:p.xyz'); assert.equal(activeNav('/am/library/playlist-folder/p.playlistsroot'), 'allplaylists');
assert.equal(activeNav('/settings'), ''); assert.equal(activeNav(''), ''); assert.equal(activeNav('/am/library'), '', 'bare /am/library is not a row');
assert.ok([SEARCH, ...PRIMARY, ...LIBRARY, PLAYLISTS_ROOT].every((n) => n.path.startsWith('/am/')), 'all rows are real Cider routes');
assert.equal(new Set([SEARCH, ...PRIMARY, ...LIBRARY].map((n) => n.id)).size, 1 + PRIMARY.length + LIBRARY.length, 'unique ids');
assert.deepEqual(LIBRARY.map((n) => n.label), ['Recently Added', 'Artists', 'Albums', 'Songs', 'Music Videos', 'Made for You'], "matches Apple Music's Library rows");

const pls = playlistsFromApi([{ id: 'p.1', attributes: { name: 'Chill', artwork: { url: 'https://x/{w}x{h}bb.jpg' } } }, { id: 'p.2', attributes: { name: 'No art' } }, { id: 'p.3', attributes: {} }, null]);
assert.deepEqual(pls, [{ id: 'p.1', name: 'Chill', art: 'https://x/{w}x{h}bb.jpg' }, { id: 'p.2', name: 'No art', art: null }]);
assert.equal(artSized('https://x/{w}x{h}{c}.{f}', 40), 'https://x/40x40bb.jpg'); assert.equal(artSized(null), '');
assert.equal(initials('Ada Lovelace'), 'AL'); assert.equal(initials('  '), '♪'); assert.equal(initials('cher'), 'C');

assert.equal(fmtDuration(65_000), '1:05'); assert.equal(fmtDuration(3_725_000), '1:02:05'); assert.equal(fmtDuration(undefined), '0:00');
const tr = (ms) => ({ attributes: { durationInMillis: ms, name: 'n', artistName: 'a', contentRating: 'explicit' } });
assert.equal(queueSummary([]), ''); assert.equal(queueSummary([tr(180000)]), '1 song · 3 min'); assert.equal(queueSummary([tr(3600000), tr(1800000)]), '2 songs · 1 hr 30 min'); assert.equal(queueSummary([tr(7200000)]), '1 song · 2 hr');

const slice = { position: 2, total: 5, items: [0, 1, 2, 3, 4].map((i) => ({ track: { id: String(i) } })) };
const sq = splitQueue(slice); assert.deepEqual(sq.history.map((t) => t.id), ['0', '1']); assert.equal(sq.current.id, '2'); assert.deepEqual(sq.next.map((t) => t.id), ['3', '4']);
assert.deepEqual(splitQueue(null), { history: [], current: null, next: [], position: 0 });
const tail = splitQueue({ position: 40, total: 60, items: [{ track: { id: 'a' } }, { track: { id: 'b' } }] }, 40);
assert.equal(tail.current.id, 'a'); assert.deepEqual(tail.next.map((t) => t.id), ['b']); assert.equal(tail.position, 40, 'position stays absolute for slices that start later'); assert.equal(splitQueue({ items: [], position: 3 }).current, null);
assert.equal(absoluteIndex(2, 0), 3); assert.equal(absoluteIndex(2, 1), 4); assert.deepEqual(moveArgs(2, 0, 3), [3, 6]);
assert.equal(queueSignature({ position: 1, total: 9 }), '1|9'); assert.notEqual(queueSignature({ position: 1, total: 9 }), queueSignature({ position: 2, total: 9 }));
assert.equal(trackTitle(tr(1)), 'n'); assert.equal(trackArtist(tr(1)), 'a'); assert.equal(isExplicit(tr(1)), true); assert.equal(isExplicit({}), false);
console.log('sidebar logic tests passed');
import { fitScale, compensate, needsCorrection } from '../sidebar-logic.js';
assert.equal(fitScale(100, 92), 0.92); assert.equal(fitScale(0, 50), 1); assert.equal(fitScale(100, 0), 1); assert.equal(fitScale(100, NaN), 1);
const want = { left: 1061, top: 0, width: 221, height: 715 }; const k = 0.92; const c = compensate(want, k);
assert.ok(Math.abs(c.left * k - want.left) < 1e-9 && Math.abs(c.width * k - want.width) < 1e-9, 'compensated values render at the wanted rect');
assert.equal(needsCorrection(want, { ...want, left: 1062 }), false); assert.equal(needsCorrection(want, { ...want, left: 1100 }), true); assert.equal(needsCorrection(want, { ...want, width: 200 }), true);
console.log('placement tests passed');

// ---- redesign helpers ----
const trk = { attributes: { name: 'N', artistName: 'Ar', albumName: 'Al' } };
assert.equal(subtitleOf(trk), 'Ar \u2014 Al'); assert.equal(subtitleOf({ attributes: { artistName: 'Ar' } }), 'Ar'); assert.equal(subtitleOf({}), '');
assert.equal(containerName({ containerContext: { name: 'Mood' } }), 'Mood'); assert.equal(containerName({ containerContext: { attributes: { name: 'Hamilton' } } }), 'Hamilton'); assert.equal(containerName({}), '');
assert.equal(fromLine('Mood'), 'From Mood'); assert.equal(fromLine(''), '');
assert.equal(sourceName({ items: [{ track: {} }, { containerContext: { name: 'Chill' } }] }), 'Chill'); assert.equal(sourceName(null), '');
assert.equal(cleanName('  a\n  b  '), 'a b'); assert.equal(isFavouritesLabel('Favourite Songs'), true); assert.equal(isFavouritesLabel('Favorite songs'), true); assert.equal(isFavouritesLabel('Morceaux préférés'), true); assert.equal(isFavouritesLabel('Chill'), false);
assert.equal(isActiveClass('nav-button-content active'), true); assert.equal(isActiveClass('router-link-active'), true); assert.equal(isActiveClass('inactive'), false); assert.equal(isActiveClass('nav-button-content'), false); assert.equal(isActiveClass(undefined), false);
assert.equal(rowKey('pl', 2, ' Chill '), 'pl:2:Chill');
console.log('redesign helper tests passed');
import { pickArt, artByName, nowPlayingTrack, topIndex } from '../sidebar-logic.js';
assert.equal(pickArt({ src: 'a.jpg' }), 'a.jpg'); assert.equal(pickArt({ currentSrc: 'c.jpg', src: 'a.jpg' }), 'c.jpg'); assert.equal(pickArt({ dataSrc: 'd.jpg' }), 'd.jpg');
assert.equal(pickArt({ bg: 'url("https://x/y.png")' }), 'https://x/y.png'); assert.equal(pickArt({ bg: 'none' }), null); assert.equal(pickArt({}), null); assert.equal(pickArt(), null);
assert.equal(pickArt({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }), null, 'tracking-pixel placeholders are ignored');
const m = artByName([{ name: ' Chill ', art: 'u1' }, { name: 'Chill', art: 'u2' }, { name: 'NoArt', art: null }]); assert.equal(m.get('Chill'), 'u1'); assert.equal(m.has('NoArt'), false);
assert.equal(nowPlayingTrack(null), null); assert.equal(nowPlayingTrack({ nowPlaying: {} }), null);
const np = nowPlayingTrack({ nowPlaying: { name: 'T', artistName: 'A', albumName: 'B', artwork: { url: 'x' } } }); assert.equal(np.attributes.name, 'T'); assert.equal(np.attributes.artwork.url, 'x');
assert.equal(topIndex('home'), 0); assert.equal(topIndex('radio'), 2); assert.equal(topIndex('songs'), -1);
console.log('round-5 helper tests passed');
