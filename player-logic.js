// Pure helpers for the floating player (tested in test/player-logic.test.mjs).
export const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export const artworkUrl = (art, size = 120) => {
  const u = art?.url;
  if (!u) return '';
  return u.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg').replace('{c}', 'bb');
};

export const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// Position (0..1) of a pointer inside a horizontal track.
export const ratioFromPointer = (clientX, left, width) => (width > 0 ? clamp01((clientX - left) / width) : 0);


export const subtitle = (a) => [a?.artistName, a?.albumName].filter(Boolean).join(' — ');

export const nextRepeatLabel = (mode) => ({ none: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[mode] || 'Repeat');

// Horizontal insets so the pill is centred on the content area (between left sidebar and right drawer),
// like Music.app. Rects are {left,right,width} or null. Panels narrower than minW (collapsed) are ignored.
export const contentInsets = (winW, leftRect, rightRect, minW = 80) => {
  const left = leftRect && leftRect.width >= minW && leftRect.right < winW * 0.6 ? Math.round(leftRect.right) : 0;
  const right = rightRect && rightRect.width >= minW && rightRect.left > winW * 0.4 ? Math.round(winW - rightRect.left) : 0;
  return { left, right };
};

// Pill width: proportional to the content area, clamped (Music.app's pill is ~46% of the window).
export const pillWidth = (windowW) => Math.round(Math.min(720, Math.max(440, windowW * 0.4625)));



// Progress (0..1) at a given playback time; 0 when the duration is unknown.
export const progressAt = (time, duration) => (duration > 0 ? clamp01(time / duration) : 0);
