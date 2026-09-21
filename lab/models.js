'use strict';

// ===============================
// LAB MODELS — snapshots → states → episodes → transitions
//
// Two models read the same snapshots:
//
//   linear-v1  breadth score → the seven original bands. Kept so the
//              lattice has something to beat.
//   hex-v1     direction (breadth) × intensity (activation) → the
//              nearest cell of the lattice.
//   hex-v2     the same axes with a steadier intensity. hex-v1 crossed
//              cells about fourteen times a day, most of them the
//              intensity of a single hour wobbling across a boundary.
//              v2 reads the intensity over four hours, keeps a cell
//              until the point is clearly out of it, and asks a state
//              to last an hour before it counts.
//
// Nothing is stored per model. States, transitions and routes are
// recomputed from raw snapshots every time, so a model can change
// without throwing away a single day of collected data.
//
// A state only counts once it has lasted minDwell snapshots, and it
// is only KNOWN at the snapshot that confirms it. Outcomes are
// measured from that confirming snapshot, never from the earlier one
// where the state began: measuring from the start would let the
// future decide which starts get counted.
//
// hex-v1 parameters were fixed before any outcome was looked at. If
// they change, the version must change, and so does the freeze.
// ===============================

const {
  CENTRE, LINEAR, hexDistance, linearDistance, rimDistance, classifyPoint, classifyPointSticky, transitionKind
} = require('./hex-topology');
const { INTERVAL_MS } = require('./metrics');

const DAY_MS = 24 * 60 * 60 * 1000;
const STEPS_PER_DAY = DAY_MS / INTERVAL_MS;

const MODELS = {
  linear: {
    name: 'linear',
    version: 'linear-v1',
    params: { thresholds: [20, 35, 45, 60, 70, 85], minDwell: 2 },
    description: 'Breadth score (share of the universe up over 24 h, 0–100) cut into the seven original bands.'
  },
  hex: {
    name: 'hex',
    version: 'hex-v1',
    params: {
      D: 0.6,
      windowDays: 30,
      slotHalfWidth: 4,
      minHistory: 63,
      minDwell: 2
    },
    description:
      'Direction = 2·breadth − 1. Intensity = 2·p − 1, where p is the percentile of the median 1 h high–low range ' +
      'against the same hour (±1 h) over the previous 30 days. The point (direction, intensity) / D belongs to the ' +
      'nearest lattice centre.'
  },
  hex2: {
    name: 'hex2',
    version: 'hex-v2',
    params: {
      D: 0.6,
      windowDays: 30,
      slotHalfWidth: 4,
      minHistory: 63,
      minDwell: 4,      // a state counts after an hour, not half an hour
      smoothSteps: 16,  // intensity from the median of the last 4 h
      margin: 0.15      // a cell is kept until the point is clearly out
    },
    description:
      'Same axes as hex-v1 with a steadier intensity: the percentile is taken on the median of the last 4 h of ' +
      '1 h ranges, a cell is only left once the point is 0.15 past the boundary, and a state counts after an hour.'
  }
};

// Trailing median of the last `steps` readings. A hole leaves the
// window short and the value unknown: nothing is invented across
// missing snapshots. Only ts and actRaw are needed downstream.
function smoothedSeries(series, steps) {
  const out = new Array(series.length);
  const win = [];

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (i > 0 && s.ts - series[i - 1].ts !== INTERVAL_MS) win.length = 0;
    win.push(Number.isFinite(s.actRaw) ? s.actRaw : NaN);
    if (win.length > steps) win.shift();

    let value = NaN;
    if (win.length === steps && win.every(Number.isFinite)) {
      const sorted = win.slice().sort((a, b) => a - b);
      const half = steps >> 1;
      value = steps % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    }
    out[i] = { ts: s.ts, actRaw: value };
  }

  return out;
}

function linearMood(breadth, thresholds = MODELS.linear.params.thresholds) {
  const score = Math.round(breadth * 100);
  return LINEAR[thresholds.filter(x => score >= x).length];
}

// Percentile of each snapshot's activation against the same time of
// day (± slotHalfWidth steps) over the previous windowDays days.
// Comparing 14:00 with past 14:00s removes the daily rhythm of the
// market, so "intense" means unusual, not "the US session opened".
// series must be sorted by ts on the 15 m grid.
function activationPercentiles(series, {
  windowDays = MODELS.hex.params.windowDays,
  slotHalfWidth = MODELS.hex.params.slotHalfWidth,
  minHistory = MODELS.hex.params.minHistory,
  indices = null
} = {}) {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  if (!n) return out;

  const t0 = series[0].ts;
  const span = Math.round((series[n - 1].ts - t0) / INTERVAL_MS) + 1;
  const grid = new Float64Array(span).fill(NaN);

  for (const s of series) {
    if (Number.isFinite(s.actRaw)) grid[Math.round((s.ts - t0) / INTERVAL_MS)] = s.actRaw;
  }

  const targets = indices || series.map((_, i) => i);

  for (const i of targets) {
    const g = Math.round((series[i].ts - t0) / INTERVAL_MS);
    const v = grid[g];
    if (!Number.isFinite(v)) continue;

    let less = 0;
    let equal = 0;
    let total = 0;

    for (let d = 1; d <= windowDays; d++) {
      const base = g - d * STEPS_PER_DAY;
      for (let o = -slotHalfWidth; o <= slotHalfWidth; o++) {
        const j = base + o;
        if (j < 0 || j >= g) continue;
        const w = grid[j];
        if (!Number.isFinite(w)) continue;
        total++;
        if (w < v) less++;
        else if (w === v) equal++;
      }
    }

    if (total >= minHistory) out[i] = (less + 0.5 * equal) / total;
  }

  return out;
}

// One state per snapshot. `indices` limits the work to some snapshots
// (the desk only needs the last 30 days); the rest come back unknown.
function computeStates(series, modelName, { indices = null } = {}) {
  const model = MODELS[modelName];
  if (!model) throw new Error(`Unknown model: ${modelName}`);

  if (modelName === 'linear') {
    return series.map(s => {
      const ok = Number.isFinite(s.breadth);
      return {
        ts: s.ts,
        mood: ok ? linearMood(s.breadth, model.params.thresholds) : null,
        score: ok ? Math.round(s.breadth * 100) : null,
        reason: ok ? null : 'no breadth'
      };
    });
  }

  const p = model.params;
  const source = p.smoothSteps > 1 ? smoothedSeries(series, p.smoothSteps) : series;

  // A dead band needs an unbroken chain of states, so a model that has
  // one computes every snapshot: `indices` would leave holes in it
  const targets = p.margin > 0 ? null : indices;
  const pct = activationPercentiles(source, { ...p, indices: targets });
  const wanted = targets ? new Set(targets) : null;
  const D = p.D;

  let prevMood = null;
  let prevTs = null;

  return series.map((s, i) => {
    if (wanted && !wanted.has(i)) return { ts: s.ts, mood: null, reason: 'not computed' };

    const a = pct[i];
    if (!Number.isFinite(a) || !Number.isFinite(s.breadth)) {
      prevMood = null;
      prevTs = null;
      return { ts: s.ts, mood: null, reason: 'intensity needs 7 days of comparable history' };
    }

    const x = (2 * s.breadth - 1) / D;
    const y = (2 * a - 1) / D;
    const chained = prevTs !== null && s.ts - prevTs === INTERVAL_MS;
    const mood = p.margin > 0 ? classifyPointSticky(x, y, chained ? prevMood : null, p.margin) : classifyPoint(x, y);

    prevMood = mood;
    prevTs = s.ts;
    return { ts: s.ts, mood, x, y, activationPct: a };
  });
}

// Runs of identical states inside contiguous stretches, then the runs
// that lasted long enough. A missing snapshot or an unknown state
// breaks the stretch: whatever happened in the hole was not observed.
function buildEpisodes(states, { minDwell = 2 } = {}) {
  const runs = [];
  let segment = 0;

  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const prev = states[i - 1];
    const contiguous = i > 0 && s.ts - prev.ts === INTERVAL_MS && prev.mood && s.mood;
    if (i > 0 && !contiguous) segment++;
    if (!s.mood) continue;

    const last = runs[runs.length - 1];
    if (last && last.segment === segment && last.mood === s.mood && last.endIdx === i - 1) {
      last.endIdx = i;
      last.len++;
    } else {
      runs.push({ mood: s.mood, segment, startIdx: i, endIdx: i, len: 1 });
    }
  }

  const episodes = [];
  for (const r of runs) {
    if (r.len < minDwell) continue; // a blip: seen, never confirmed

    const last = episodes[episodes.length - 1];
    if (last && last.segment === r.segment && last.mood === r.mood) {
      last.endIdx = r.endIdx; // the same state resumed after a blip
      continue;
    }

    episodes.push({
      mood: r.mood,
      segment: r.segment,
      startIdx: r.startIdx,
      endIdx: r.endIdx,
      confirmIdx: r.startIdx + minDwell - 1
    });
  }

  return episodes;
}

function buildTransitions(episodes, states) {
  const out = [];
  let gapped = 0;

  for (let i = 1; i < episodes.length; i++) {
    const a = episodes[i - 1];
    const b = episodes[i];

    if (a.segment !== b.segment) {
      gapped++;
      continue;
    }

    out.push({
      from: a.mood,
      to: b.mood,
      transition: `${a.mood}→${b.mood}`,
      entryTs: states[b.startIdx].ts,
      eventTs: states[b.confirmIdx].ts,
      eventIdx: b.confirmIdx,
      dwellMs: states[b.startIdx].ts - states[a.startIdx].ts,
      hex: hexDistance(a.mood, b.mood),
      linear: linearDistance(a.mood, b.mood),
      rim: rimDistance(a.mood, b.mood),
      kind: transitionKind(a.mood, b.mood),
      blips: b.startIdx - a.endIdx - 1
    });
  }

  return { transitions: out, gapped };
}

// Every confirmed arrival into a rim state, with the rim state the
// market came from and whether it passed through neutral on the way.
//   through-centre  A → neutral → B   (tension released first)
//   rim             A → B             (never let go)
//   return          A → neutral → A   (went quiet, came back to the same side)
function rimArrivals(episodes, states) {
  const out = [];

  for (let i = 1; i < episodes.length; i++) {
    const b = episodes[i];
    if (b.mood === CENTRE) continue;

    let viaCentre = false;
    let a = null;

    for (let j = i - 1; j >= 0; j--) {
      const e = episodes[j];
      if (e.segment !== b.segment) break;
      if (e.mood === CENTRE) {
        viaCentre = true;
        continue;
      }
      a = e;
      break;
    }

    if (!a) continue;

    out.push({
      from: a.mood,
      to: b.mood,
      route: a.mood === b.mood ? 'return' : viaCentre ? 'through-centre' : 'rim',
      rimSteps: rimDistance(a.mood, b.mood),
      eventTs: states[b.confirmIdx].ts,
      eventIdx: b.confirmIdx
    });
  }

  return out;
}

module.exports = {
  MODELS,
  STEPS_PER_DAY,
  linearMood,
  activationPercentiles,
  computeStates,
  buildEpisodes,
  buildTransitions,
  rimArrivals
};
