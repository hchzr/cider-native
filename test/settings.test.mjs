import assert from 'node:assert/strict';
import { PARTS, PART, GROUPS, defaultSettings, parseSettings, migrateLegacy, isOn, configOn, activeStyles, recommendedPlan, PLAYER_SCALE } from '../settings.js';

// schema sanity
assert.equal(new Set(PARTS.map((p) => p.id)).size, PARTS.length, 'unique part ids');
assert.ok(PARTS.every((p) => GROUPS.some((g) => g.id === p.group)), 'every part is in a known group');
assert.ok(PARTS.every((p) => !p.parent || PART[p.parent]), 'parents exist');
assert.ok(PARTS.every((p) => p.title), 'every part has a title');
assert.ok(PARTS.filter((p) => p.config).every((p) => p.config.path && p.config.on !== p.config.off), 'config parts have distinct on/off values');

// defaults: everything plugin-owned on
const d = defaultSettings();
assert.equal(d.enabled, true);
assert.ok(Object.values(d.parts).every((v) => v === true));
assert.ok(!('macSizing' in d.parts) && !('playerSize' in d.parts), 'Cider settings and choices are not stored as parts');

// parsing is defensive
assert.deepEqual(parseSettings('not json'), d);
assert.deepEqual(parseSettings(null), d);
const p = parseSettings(JSON.stringify({ enabled: false, parts: { sidebar: false, bogus: true, player: 'yes' }, playerSize: 'huge' }));
assert.equal(p.enabled, false); assert.equal(p.parts.sidebar, false); assert.equal(p.parts.player, true, 'wrong type falls back to default');
assert.ok(!('bogus' in p.parts)); assert.equal(p.playerSize, 'default');

// on/off resolution: master switch, own flag, parent chain; config/choice parts are never "plugin-on"
const s = defaultSettings();
assert.equal(isOn(s, 'sidebar'), true);
s.parts.sidebar = false; assert.equal(isOn(s, 'discoverRow'), false, 'child follows its parent');
s.parts.sidebar = true; s.enabled = false; assert.equal(isOn(s, 'sidebar'), false, 'master switch');
assert.equal(isOn(defaultSettings(), 'macSizing'), false); assert.equal(isOn(defaultSettings(), 'nope'), false);

// styles follow the parts
const all = activeStyles(defaultSettings());
assert.ok(['toolbar', 'icons', 'layout', 'content', 'pages', 'library', 'motion', 'scrollbars', 'cursor', 'font', 'accent'].every((x) => all.includes(x)));
const noIcons = defaultSettings(); noIcons.parts.icons = false;
assert.ok(!activeStyles(noIcons).includes('icons'));
const off = defaultSettings(); off.enabled = false; assert.deepEqual(activeStyles(off), []);

// Cider-setting parts read Cider's config
const cfg = { 'visual.pauseAnimatedOnBlur': true, 'appleMusic.animatedArtwork': true, 'visual.sizing': 'desktop', 'visual.artworkBlurMap.fpsLimit': 60 };
assert.equal(configOn(PART.coversInBackground, (k) => cfg[k]), false, 'covers pause on blur -> part off');
assert.equal(configOn(PART.animatedCovers, (k) => cfg[k]), true);
assert.deepEqual(recommendedPlan((k) => cfg[k]), [['visual.pauseAnimatedOnBlur', false], ['visual.artworkBlurMap.fpsLimit', 30]]);
assert.deepEqual(recommendedPlan(() => undefined), [], 'never creates unknown keys');

// legacy migration
const legacy = { 'native-sidebars/enabled': '0', 'native-player/scale': '1.1', 'native-extras/notify': '0' };
const m = migrateLegacy((k) => legacy[k] ?? null);
assert.equal(m.parts.sidebar, false); assert.equal(m.parts.notifications, false); assert.equal(m.playerSize, 'large'); assert.equal(m.parts.player, true);
assert.equal(PLAYER_SCALE[m.playerSize], 1.1);
console.log('settings tests passed');
