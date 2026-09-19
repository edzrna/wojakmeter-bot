'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lab/hex-topology');
const Mo = require('../lab/models');
const { mulberry32 } = require('./helpers');

const I = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

test('lattice: neighbours at 1, opposites at 2, both seams closed', () => {
  for (let i = 0; i < H.RIM.length; i++) {
    const a = H.RIM[i];
    const b = H.RIM[(i + 1) % H.RIM.length];
    assert.equal(H.hexDistance(a, b), 1, `${a}–${b}`);
    assert.equal(H.hexDistance(a, H.CENTRE), 1);
    assert.equal(H.hexDistance(a, H.RIM[(i + 3) % 6]), 2);
  }
  assert.equal(H.hexDistance('euphoria', 'frustration'), 1);
  assert.equal(H.hexDistance('optimism', 'doubt'), 1);
  assert.equal(H.linearDistance('euphoria', 'frustration'), 6);
  assert.equal(H.rimDistance('content', 'concern'), 3);
  assert.equal(H.hexDistance('euphoria', 'nope'), null);
});

test('classifier: the drawing and the classifier are the same object', () => {
  // Nearest centre by brute force must agree everywhere except exact ties
  const centres = H.ALL.map(m => ({ m, ...H.centre(m) }));
  const rnd = mulberry32(3);
  for (let k = 0; k < 20000; k++) {
    const x = (rnd() - 0.5) * 4;
    const y = (rnd() - 0.5) * 4;
    const d = centres.map(c => ({ m: c.m, d: Math.hypot(x - c.x, y - c.y) })).sort((a, b) => a.d - b.d);
    if (d[1].d - d[0].d < 1e-9) continue;
    assert.equal(H.classifyPoint(x, y), d[0].m, `(${x}, ${y})`);
  }

  for (const m of H.ALL) {
    const c = H.centre(m);
    assert.equal(H.classifyPoint(c.x, c.y), m);
  }

  // Neutral is the central hexagon: inradius 0.5
  assert.equal(H.classifyPoint(0.49, 0), 'neutral');
  assert.equal(H.classifyPoint(0.51, 0), 'content');
  assert.equal(H.classifyPoint(0, 0.5 / Math.sin(Math.PI / 3) - 0.01), 'neutral');

  // The seams sit on the intensity axis; ties break by side of the market
  assert.equal(H.classifyPoint(0, 1.2), 'euphoria');
  assert.equal(H.classifyPoint(-1e-9, 1.2), 'frustration');
  assert.equal(H.classifyPoint(0, -1.2), 'optimism');
  assert.equal(H.classifyPoint(-1e-9, -1.2), 'doubt');
  assert.equal(H.classifyPoint(NaN, 0), null);
});

test('transition kinds', () => {
  assert.equal(H.transitionKind('neutral', 'euphoria'), 'expansion');
  assert.equal(H.transitionKind('doubt', 'neutral'), 'decompression');
  assert.equal(H.transitionKind('euphoria', 'frustration'), 'drift');
  assert.equal(H.transitionKind('content', 'frustration'), 'rotation');
  assert.equal(H.transitionKind('content', 'concern'), 'inversion');
  assert.equal(H.transitionKind('content', 'content'), 'none');
  assert.equal(H.transitionKind('content', undefined), 'unknown');
  assert.deepEqual(H.geometry().cells.euphoria, H.centre('euphoria'));
});

test('linear model keeps the original bands', () => {
  const cases = [[0.19, 'frustration'], [0.2, 'concern'], [0.35, 'doubt'], [0.45, 'neutral'],
    [0.6, 'optimism'], [0.7, 'content'], [0.85, 'euphoria'], [1, 'euphoria']];
  for (const [b, mood] of cases) assert.equal(Mo.linearMood(b), mood, String(b));
});

function days(n, fn) {
  const out = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n * 96; i++) out.push({ ts: t0 + (i + 1) * I, ...fn(i) });
  return out;
}

test('activation percentile: same hour only, and only after 7 days of it', () => {
  // actRaw = day number: every past value is smaller than today's
  const series = days(40, i => ({ actRaw: Math.floor(i / 96), breadth: 0.5 }));
  const p = Mo.activationPercentiles(series);
  assert.equal(p[35 * 96 + 40], 1);
  assert.ok(Number.isNaN(p[6 * 96 + 40]), 'six days are not enough');
  assert.ok(Number.isFinite(p[7 * 96 + 40]), 'seven days are');

  // A constant series sits exactly in the middle
  const flat = Mo.activationPercentiles(days(10, () => ({ actRaw: 2, breadth: 0.5 })));
  assert.equal(flat[9 * 96 + 40], 0.5);
});

test('hex states: the four corners and the middle', () => {
  const base = days(40, () => ({ actRaw: 1, breadth: 0.5 }));
  const probe = (act, breadth) => {
    const s = base.map(x => ({ ...x }));
    const last = s[s.length - 1];
    last.actRaw = act;
    last.breadth = breadth;
    const st = Mo.computeStates(s, 'hex');
    return st[st.length - 1].mood;
  };
  assert.equal(probe(5, 0.9), 'euphoria');     // violent, rising
  assert.equal(probe(5, 0.1), 'frustration');  // violent, falling
  assert.equal(probe(0, 0.9), 'optimism');     // calm, rising
  assert.equal(probe(0, 0.1), 'doubt');        // calm, falling
  assert.equal(probe(1, 0.5), 'neutral');
  assert.equal(probe(1, 0.95), 'content');     // ordinary intensity, rising
});

function statesOf(moods, { gapAfter = null } = {}) {
  const t0 = Date.UTC(2026, 0, 1);
  let offset = 0;
  return moods.map((mood, i) => {
    if (gapAfter !== null && i === gapAfter + 1) offset += I;
    return { ts: t0 + i * I + offset, mood };
  });
}

test('episodes: blips never count, outcomes start at the confirming snapshot', () => {
  const s = statesOf(['content', 'content', 'euphoria', 'content', 'content', 'doubt', 'doubt']);
  const ep = Mo.buildEpisodes(s);
  assert.deepEqual(ep.map(e => [e.mood, e.startIdx, e.endIdx, e.confirmIdx]), [
    ['content', 0, 4, 1],
    ['doubt', 5, 6, 6]
  ]);
  const { transitions } = Mo.buildTransitions(ep, s);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, 'content→doubt');
  assert.equal(transitions[0].eventIdx, 6);      // confirmed at the 2nd doubt, not the 1st
  assert.equal(transitions[0].entryTs, s[5].ts);
  assert.equal(transitions[0].blips, 0);

  const skip = statesOf(['content', 'content', 'neutral', 'doubt', 'doubt']);
  const t2 = Mo.buildTransitions(Mo.buildEpisodes(skip), skip).transitions;
  assert.equal(t2[0].transition, 'content→doubt');
  assert.equal(t2[0].blips, 1); // the neutral blip is recorded, not counted as a state
});

test('episodes: a hole or an unknown state breaks the path', () => {
  const gap = statesOf(['content', 'content', 'doubt', 'doubt'], { gapAfter: 1 });
  const r = Mo.buildTransitions(Mo.buildEpisodes(gap), gap);
  assert.equal(r.transitions.length, 0);
  assert.equal(r.gapped, 1);

  const unknown = statesOf(['content', 'content', null, 'doubt', 'doubt']);
  const r2 = Mo.buildTransitions(Mo.buildEpisodes(unknown), unknown);
  assert.equal(r2.transitions.length, 0);
  assert.equal(r2.gapped, 1);
});

test('rim arrivals: through the centre, straight across, or back to the same side', () => {
  const s = statesOf([
    'concern', 'concern', 'neutral', 'neutral', 'content', 'content', // through-centre
    'euphoria', 'euphoria',                                           // straight, 1 step
    'neutral', 'neutral', 'euphoria', 'euphoria',                     // return
    'frustration', 'frustration'                                      // straight across the seam
  ]);
  const arrivals = Mo.rimArrivals(Mo.buildEpisodes(s), s);
  assert.deepEqual(arrivals.map(a => [a.from, a.to, a.route, a.rimSteps]), [
    ['concern', 'content', 'through-centre', 3],
    ['content', 'euphoria', 'rim', 1],
    ['euphoria', 'euphoria', 'return', 0],
    ['euphoria', 'frustration', 'rim', 1]
  ]);
});
