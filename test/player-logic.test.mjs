import assert from 'node:assert/strict';
import { fmtTime, artworkUrl, clamp01, ratioFromPointer, progressAt, subtitle } from '../player-logic.js';
assert.equal(fmtTime(0), '0:00'); assert.equal(fmtTime(65.9), '1:05'); assert.equal(fmtTime(3725), '1:02:05');
assert.equal(fmtTime(NaN), '0:00'); assert.equal(fmtTime(-4), '0:00');
assert.equal(artworkUrl({ url: 'https://x/{w}x{h}{c}.{f}' }, 80), 'https://x/80x80bb.jpg');
assert.equal(artworkUrl(undefined), '');
assert.equal(clamp01(2), 1); assert.equal(clamp01(-1), 0); assert.equal(clamp01(NaN), 0);
assert.equal(ratioFromPointer(150, 100, 200), 0.25); assert.equal(ratioFromPointer(10, 100, 200), 0); assert.equal(ratioFromPointer(5, 0, 0), 0);
assert.equal(progressAt(30, 120), 0.25); assert.equal(progressAt(130, 120), 1, 'capped at the end'); assert.equal(progressAt(5, 0), 0, 'unknown duration');
assert.equal(subtitle({ artistName: 'A', albumName: 'B' }), 'A — B'); assert.equal(subtitle({ artistName: 'A' }), 'A'); assert.equal(subtitle(null), '');
console.log('player helper tests passed');
import { contentInsets, pillWidth } from '../player-logic.js';
assert.deepEqual(contentInsets(1000, { left: 0, right: 137, width: 137 }, null), { left: 137, right: 0 });
assert.deepEqual(contentInsets(1000, { left: 0, right: 137, width: 137 }, { left: 830, right: 1000, width: 170 }), { left: 137, right: 170 });
assert.deepEqual(contentInsets(1000, { left: 0, right: 40, width: 40 }, null), { left: 0, right: 0 }, 'collapsed sidebar ignored');
assert.deepEqual(contentInsets(1000, null, { left: 100, right: 300, width: 200 }), { left: 0, right: 0 }, 'left-side panel is not the right drawer');
assert.equal(pillWidth(1280), 592); assert.equal(pillWidth(400), 440); assert.equal(pillWidth(2000), 720);
console.log('layout tests passed');

