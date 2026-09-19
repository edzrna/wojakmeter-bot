'use strict';

// ===============================
// LAB ANALYSIS — the report the desk shows
//
// Read this before trusting any number in the report:
//
//   Outcome  BTC return from the confirming snapshot to +1 h, +4 h
//            and +24 h, minus the mean return of every snapshot in
//            the same month. Without that subtraction a bull month
//            makes every transition look like an edge.
//   Overlap  Inside each group, events closer together than the
//            horizon are thinned to one. Twenty flickers in one
//            afternoon share one future: one observation, not twenty.
//   Family   Every test at every horizon is corrected together
//            (Holm). Run 126 tests at |t| > 2 and about six pass by
//            luck alone.
//   Split    History (before the freeze) can only NOMINATE. Only
//            data after the freeze can CONFIRM. The freeze is the
//            moment this model version first ran, so the hypotheses
//            were fixed before the confirming data existed.
//
// Verdicts always carry their reason. Nothing here answers with a
// bare true/false.
// ===============================

const { ALL, VALENCE, hexDistance, linearDistance, transitionKind } = require('./hex-topology');
const { INTERVAL_MS } = require('./metrics');
const { MODELS, computeStates, buildEpisodes, buildTransitions, rimArrivals } = require('./models');
const S = require('./stats');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const HORIZONS = [
  { key: 'h1', label: '1h', ms: HOUR_MS },
  { key: 'h4', label: '4h', ms: 4 * HOUR_MS },
  { key: 'h24', label: '24h', ms: DAY_MS }
];

const ALPHA = 0.05;
const MIN_N = 30;       // independent events in history before a test is run
const MIN_CONFIRM = 20; // independent events after the freeze before a candidate is judged

const DIVERGENCE = { lookbackMs: 4 * HOUR_MS, minBtcMove: 0.5, minBreadthMove: 0.15 };

const HYPOTHESES = [
  {
    id: 'H1',
    title: 'Route: through the centre vs straight across',
    statement:
      'Arrivals into a rim state that came through neutral are followed by different returns ' +
      'than arrivals that came straight from another rim state.',
    method:
      'Excess return after each confirmed arrival, compared inside each destination state ' +
      '(through-centre minus straight), pooled by inverse variance. Two-sided z.',
    unit: 'pct'
  },
  {
    id: 'H2',
    title: 'The extremes behave alike',
    statement:
      'After the market enters euphoria or frustration, price tends to reverse — and both ' +
      'extremes do it, each against its own side.',
    method:
      'Reversal score = −side × excess return (side +1 euphoria, −1 frustration). Pooled t-test; ' +
      'also requires both extremes to agree in sign.',
    unit: 'pct'
  },
  {
    id: 'H3',
    title: 'Lattice distance beats linear distance',
    statement:
      'The size of an emotional jump measured on the lattice predicts the size of the next move ' +
      'better than the same jump measured on the linear scale.',
    method:
      'Spearman correlation of |excess return| with each distance over the same transitions; ' +
      'difference tested with a day-block bootstrap.',
    unit: 'rho'
  },
  {
    id: 'H4',
    title: 'Divergence: price and breadth disagree',
    statement:
      'When BTC and breadth move in opposite directions over 4 h, BTC tends to follow breadth ' +
      'more than it does after an aligned move.',
    method:
      'Signed return −sign(BTC 4 h) × excess, diverging vs aligned snapshots ' +
      '(|BTC 4 h| ≥ 0.5 %, |Δ breadth| ≥ 15 points), Welch t.',
    unit: 'pct'
  }
];

const fmtPct = x => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(3)}%` : 'n/a');
const fmtP = p => (!Number.isFinite(p) ? 'n/a' : p < 0.001 ? '<0.001' : p.toFixed(3));
const fmtNum = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const verdict = (v, reason) => ({ verdict: v, reason });

// ===============================
// RETURNS
// ===============================

function forwardAndExcess(series) {
  const n = series.length;
  const index = new Map();
  series.forEach((s, i) => index.set(s.ts, i));

  const returns = {};
  for (const h of HORIZONS) {
    const fwd = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const j = index.get(series[i].ts + h.ms);
      if (j !== undefined) fwd[i] = (series[j].btcClose / series[i].btcClose - 1) * 100;
    }

    const byMonth = new Map();
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(fwd[i])) continue;
      const acc = byMonth.get(series[i].month) || { sum: 0, count: 0 };
      acc.sum += fwd[i];
      acc.count++;
      byMonth.set(series[i].month, acc);
    }

    const excess = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(fwd[i])) continue;
      const acc = byMonth.get(series[i].month);
      excess[i] = fwd[i] - acc.sum / acc.count;
    }

    returns[h.key] = { fwd, excess };
  }

  return { index, returns };
}

function makeSampler(freezeTs) {
  return (ts, h) => {
    if (!Number.isFinite(freezeTs)) return 'history';
    if (ts + h.ms <= freezeTs) return 'history';
    if (ts >= freezeTs) return 'live';
    return null; // its window straddles the freeze: it belongs to neither sample
  };
}

function eventsOf(list, excess, h, sampleOf, sample) {
  const out = [];
  for (const e of list) {
    const v = excess[e.eventIdx];
    if (Number.isFinite(v) && sampleOf(e.eventTs, h) === sample) out.push({ ts: e.eventTs, v });
  }
  return out;
}

// ===============================
// TRANSITION SCREEN — every observed transition, every horizon
// ===============================

function judgeMean({ history, live }) {
  if (!(history.nEff >= MIN_N)) {
    return verdict('insufficient', `history has ${history.nEff} independent events; ${MIN_N} needed`);
  }
  if (!Number.isFinite(history.pHolm)) return verdict('insufficient', 'no variation in history');

  const base = `history ${fmtPct(history.mean)} (t ${fmtNum(history.t, 2)}, p_holm ${fmtP(history.pHolm)}, n ${history.nEff})`;
  if (history.pHolm >= ALPHA) return verdict('noise', `${base} — indistinguishable from noise`);

  if (!(live.nEff >= MIN_CONFIRM)) {
    return verdict('pending', `${base}; live has ${live.nEff}/${MIN_CONFIRM} independent events`);
  }

  const pOne = S.tOneSided(live.t, live.df, Math.sign(history.mean));
  live.pOne = pOne;
  const liveText = `live ${fmtPct(live.mean)} (one-sided p ${fmtP(pOne)}, n ${live.nEff})`;

  return pOne < ALPHA
    ? verdict('confirmed', `${base}; ${liveText}`)
    : verdict('failed', `${base}; ${liveText} — did not hold after the freeze`);
}

function screen(transitions, R, sampleOf) {
  const groups = new Map();
  for (const tr of transitions) {
    if (!groups.has(tr.transition)) groups.set(tr.transition, []);
    groups.get(tr.transition).push(tr);
  }

  const rows = [];
  const tested = [];

  for (const [key, list] of groups) {
    const { from, to } = list[0];
    const row = {
      transition: key,
      from,
      to,
      hex: hexDistance(from, to),
      linear: linearDistance(from, to),
      kind: transitionKind(from, to),
      count: list.length
    };

    for (const h of HORIZONS) {
      const cell = {};
      for (const sample of ['history', 'live']) {
        const events = eventsOf(list, R[h.key].excess, h, sampleOf, sample);
        const kept = S.decluster(events, h.ms);
        const d = S.describe(kept.map(e => e.v));
        cell[sample] = { n: events.length, nEff: kept.length, mean: d.mean, sd: d.sd, t: d.t, df: d.df, p: d.p, up: d.up };
      }
      row[h.key] = cell;
      if (cell.history.nEff >= MIN_N && Number.isFinite(cell.history.p)) tested.push(cell.history);
    }

    rows.push(row);
  }

  const adjusted = S.holm(tested.map(c => c.p));
  tested.forEach((c, k) => { c.pHolm = adjusted[k]; });

  for (const row of rows) {
    for (const h of HORIZONS) Object.assign(row[h.key], judgeMean(row[h.key]));
  }

  rows.sort((a, b) => b.count - a.count || (a.transition < b.transition ? -1 : 1));
  return { rows, family: tested.length };
}

// ===============================
// HYPOTHESES
// ===============================

function notTestable(reason, n, detail = {}) {
  return { testable: false, reason, n, detail };
}

function testH1({ arrivals, excess, h, sampleOf, sample, minN }) {
  const byState = new Map();
  for (const a of arrivals) {
    if (a.route === 'return') continue;
    const v = excess[a.eventIdx];
    if (!Number.isFinite(v) || sampleOf(a.eventTs, h) !== sample) continue;
    if (!byState.has(a.to)) byState.set(a.to, { centre: [], rim: [] });
    byState.get(a.to)[a.route === 'through-centre' ? 'centre' : 'rim'].push({ ts: a.eventTs, v });
  }

  const strata = [];
  const perState = {};
  let centre = 0;
  let rim = 0;

  for (const [to, g] of byState) {
    const c = S.decluster(g.centre, h.ms).map(e => e.v);
    const r = S.decluster(g.rim, h.ms).map(e => e.v);
    centre += c.length;
    rim += r.length;
    strata.push({ a: c, b: r });
    perState[to] = { centre: c.length, rim: r.length, centreMean: S.describe(c).mean, rimMean: S.describe(r).mean };
  }

  const n = { centre, rim };
  if (centre < minN || rim < minN) {
    return notTestable(`needs ${minN} independent arrivals per route; has ${centre} through the centre, ${rim} straight`, n, { perState });
  }

  const st = S.stratified(strata);
  if (!Number.isFinite(st.z)) return notTestable('no destination state has both routes with variation', n, { perState });

  return {
    testable: true,
    estimate: st.diff,
    stat: st.z,
    statName: 'z',
    p: st.p,
    pUp: S.zOneSided(st.z, 1),
    pDown: S.zOneSided(st.z, -1),
    n,
    detail: { strata: st.strata, perState }
  };
}

function testH2({ transitions, excess, h, sampleOf, sample, minN }) {
  const entries = { euphoria: [], frustration: [] };
  let directJumps = 0;

  for (const tr of transitions) {
    const inSample = sampleOf(tr.eventTs, h) === sample;
    const extremes = (tr.from === 'euphoria' && tr.to === 'frustration') || (tr.from === 'frustration' && tr.to === 'euphoria');
    if (extremes && inSample) directJumps++;
    if (tr.to !== 'euphoria' && tr.to !== 'frustration') continue;
    const v = excess[tr.eventIdx];
    if (!Number.isFinite(v) || !inSample) continue;
    entries[tr.to].push({ ts: tr.eventTs, v: -VALENCE[tr.to] * v });
  }

  const e = S.decluster(entries.euphoria, h.ms).map(x => x.v);
  const f = S.decluster(entries.frustration, h.ms).map(x => x.v);
  const de = S.describe(e);
  const df = S.describe(f);
  const pooled = S.describe([...e, ...f]);
  const each = Math.ceil(minN / 2);

  const n = { euphoria: e.length, frustration: f.length };
  const detail = { euphoriaMean: de.mean, frustrationMean: df.mean, directJumps };

  if (e.length < each || f.length < each) {
    return notTestable(`needs ${each} independent entries into each extreme; has ${e.length} euphoria, ${f.length} frustration`, n, detail);
  }

  const alike = Math.sign(de.mean) === Math.sign(df.mean) && Math.sign(de.mean) === Math.sign(pooled.mean);

  return {
    testable: true,
    estimate: pooled.mean,
    stat: pooled.t,
    statName: 't',
    p: pooled.p,
    pUp: S.tOneSided(pooled.t, pooled.df, 1),
    pDown: S.tOneSided(pooled.t, pooled.df, -1),
    n,
    detail: { ...detail, alike }
  };
}

function testH3({ transitions, excess, h, sampleOf, sample, minN, reps, seed }) {
  const x1 = [];
  const x2 = [];
  const y = [];
  const block = [];

  for (const tr of transitions) {
    const v = excess[tr.eventIdx];
    if (!Number.isFinite(v) || sampleOf(tr.eventTs, h) !== sample) continue;
    x1.push(tr.hex);
    x2.push(tr.linear);
    y.push(Math.abs(v));
    block.push(Math.floor(tr.eventTs / DAY_MS));
  }

  const days = new Set(block).size;
  const n = { transitions: y.length, days };
  if (days < minN) return notTestable(`needs ${minN} days with transitions; has ${days}`, n);

  const r1 = S.ranks(x1);
  const r2 = S.ranks(x2);
  const ry = S.ranks(y);
  const rhoHex = S.pearson(r1, ry);
  const rhoLinear = S.pearson(r2, ry);

  if (!Number.isFinite(rhoHex) || !Number.isFinite(rhoLinear)) {
    return notTestable('one of the distances does not vary across these transitions', n, { rhoHex, rhoLinear });
  }

  const boot = S.blockBootstrapCorrDiff({ x1: r1, x2: r2, y: ry, block, reps, seed });

  return {
    testable: true,
    estimate: rhoHex - rhoLinear,
    stat: null,
    statName: 'bootstrap',
    p: boot.p,
    pUp: boot.pUp,
    pDown: boot.pDown,
    n,
    detail: { rhoHex, rhoLinear, ci95: [boot.lo, boot.hi], reps: boot.reps }
  };
}

function testH4({ series, index, excess, h, sampleOf, sample, minN }) {
  const diverging = [];
  const aligned = [];

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const j = index.get(s.ts - DIVERGENCE.lookbackMs);
    if (j === undefined) continue;
    const v = excess[i];
    if (!Number.isFinite(v) || sampleOf(s.ts, h) !== sample) continue;

    const btc = (s.btcClose / series[j].btcClose - 1) * 100;
    const dB = s.breadth - series[j].breadth;
    if (Math.abs(btc) < DIVERGENCE.minBtcMove || Math.abs(dB) < DIVERGENCE.minBreadthMove) continue;

    const event = { ts: s.ts, v: -Math.sign(btc) * v };
    (Math.sign(btc) !== Math.sign(dB) ? diverging : aligned).push(event);
  }

  const a = S.decluster(diverging, h.ms).map(e => e.v);
  const b = S.decluster(aligned, h.ms).map(e => e.v);
  const n = { diverging: a.length, aligned: b.length };

  if (a.length < minN || b.length < minN) {
    return notTestable(`needs ${minN} independent events per group; has ${a.length} diverging, ${b.length} aligned`, n);
  }

  const w = S.welch(a, b);
  if (!Number.isFinite(w.t)) return notTestable('no variation in one of the groups', n);

  return {
    testable: true,
    estimate: w.diff,
    stat: w.t,
    statName: 't',
    p: w.p,
    pUp: S.tOneSided(w.t, w.df, 1),
    pDown: S.tOneSided(w.t, w.df, -1),
    n,
    detail: { divergingMean: w.meanA, alignedMean: w.meanB }
  };
}

const TESTS = { H1: testH1, H2: testH2, H3: testH3, H4: testH4 };

function estimateText(result, unit) {
  return unit === 'rho' ? `Δρ ${fmtNum(result.estimate, 3)}` : fmtPct(result.estimate);
}

function judgeHypothesis(def, { history, live }) {
  if (!history.testable) return verdict('insufficient', `history: ${history.reason}`);

  const base = `history ${estimateText(history, def.unit)} (p_holm ${fmtP(history.pHolm)})`;
  if (history.pHolm >= ALPHA) return verdict('noise', `${base} — not supported`);

  if (def.id === 'H2' && !history.detail.alike) {
    return verdict('noise', `${base}, but the two extremes move in opposite directions — not alike`);
  }

  if (!live.testable) return verdict('pending', `${base}; live: ${live.reason}`);

  const pOne = history.estimate > 0 ? live.pUp : live.pDown;
  live.pOne = pOne;
  const liveText = `live ${estimateText(live, def.unit)} (one-sided p ${fmtP(pOne)})`;
  const holds = pOne < ALPHA && (def.id !== 'H2' || live.detail.alike);

  return holds
    ? verdict('confirmed', `${base}; ${liveText}`)
    : verdict('failed', `${base}; ${liveText} — did not hold after the freeze`);
}

// ===============================
// DESCRIPTIVE
// ===============================

function occupancy(states) {
  const counts = {};
  let known = 0;
  for (const s of states) {
    if (!s.mood) continue;
    counts[s.mood] = (counts[s.mood] || 0) + 1;
    known++;
  }
  const share = {};
  for (const mood of ALL) share[mood] = known ? (counts[mood] || 0) / known : 0;
  return { known, unknown: states.length - known, share };
}

function sampleSummary(series, freezeTs) {
  const history = { snapshots: 0, from: null, to: null };
  const live = { snapshots: 0, from: null, to: null };
  for (const s of series) {
    const bucket = Number.isFinite(freezeTs) && s.ts >= freezeTs ? live : history;
    bucket.snapshots++;
    if (bucket.from === null) bucket.from = s.ts;
    bucket.to = s.ts;
  }
  return { history, live };
}

function dataHealth(series) {
  let missing = 0;
  let minCoverage = Infinity;
  for (let i = 0; i < series.length; i++) {
    if (i > 0) {
      const steps = (series[i].ts - series[i - 1].ts) / INTERVAL_MS;
      if (steps > 1) missing += steps - 1;
    }
    if (series[i].coverage < minCoverage) minCoverage = series[i].coverage;
  }
  return {
    snapshots: series.length,
    missingBoundaries: missing,
    minCoverage: Number.isFinite(minCoverage) ? minCoverage : null
  };
}

// Round for the wire; integers (timestamps) pass untouched
function clean(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value : Math.round(value * 1e6) / 1e6;
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v);
    return out;
  }
  return value;
}

// ===============================
// REPORT
// ===============================

function analyze({ series, modelName, freezeTs, context = {}, now = Date.now(), reps = 1000, seed = 20260918 }) {
  const model = MODELS[modelName];
  if (!model) throw new Error(`Unknown model: ${modelName}`);

  const sampleOf = makeSampler(freezeTs);
  const { index, returns } = forwardAndExcess(series);
  const states = computeStates(series, modelName);
  const episodes = buildEpisodes(states, { minDwell: model.params.minDwell });
  const { transitions, gapped } = buildTransitions(episodes, states);
  const arrivals = rimArrivals(episodes, states);

  const { rows, family } = screen(transitions, returns, sampleOf);

  const hypotheses = HYPOTHESES.map(def => ({ ...def }));
  const tested = [];

  for (const def of hypotheses) {
    for (const h of HORIZONS) {
      const cell = {};
      for (const sample of ['history', 'live']) {
        cell[sample] = TESTS[def.id]({
          series,
          index,
          transitions,
          arrivals,
          excess: returns[h.key].excess,
          h,
          sampleOf,
          sample,
          minN: sample === 'history' ? MIN_N : MIN_CONFIRM,
          reps,
          seed
        });
      }
      def[h.key] = cell;
      if (cell.history.testable && Number.isFinite(cell.history.p)) tested.push(cell.history);
    }
  }

  const adjusted = S.holm(tested.map(c => c.p));
  tested.forEach((c, k) => { c.pHolm = adjusted[k]; });

  for (const def of hypotheses) {
    for (const h of HORIZONS) Object.assign(def[h.key], judgeHypothesis(def, def[h.key]));
  }

  const liveTransitions = transitions.filter(t => Number.isFinite(freezeTs) && t.eventTs >= freezeTs).length;

  return clean({
    ok: true,
    model: { name: model.name, version: model.version, params: model.params, description: model.description },
    computedAt: now,
    freezeTs: Number.isFinite(freezeTs) ? freezeTs : null,
    horizons: HORIZONS.map(h => ({ key: h.key, label: h.label })),
    samples: sampleSummary(series, freezeTs),
    health: dataHealth(series),
    occupancy: occupancy(states),
    transitions: {
      history: transitions.length - liveTransitions,
      live: liveTransitions,
      acrossGaps: gapped,
      types: rows.length,
      possible: ALL.length * (ALL.length - 1)
    },
    screen: { family, alpha: ALPHA, minN: MIN_N, minConfirm: MIN_CONFIRM, rows },
    hypotheses: { family: tested.length, list: hypotheses },
    context,
    notes: [
      'Outcome: BTC return from the confirming snapshot to +1 h, +4 h and +24 h, minus the mean return of every snapshot in the same month.',
      `A state counts after ${model.params.minDwell} consecutive snapshots (${model.params.minDwell * 15} min); outcomes start at the snapshot that confirms it, never earlier.`,
      'Inside each group, events closer together than the horizon are thinned to one.',
      `Holm correction across the ${family} transition tests of this model and, separately, across the ${tested.length} hypothesis tests.`,
      'History (before the freeze) can only nominate a candidate. Only data after the freeze can confirm it.',
      'Transitions across a gap in the data are dropped: the path in between was not observed.'
    ]
  });
}

module.exports = {
  HORIZONS,
  HYPOTHESES,
  ALPHA,
  MIN_N,
  MIN_CONFIRM,
  DIVERGENCE,
  forwardAndExcess,
  makeSampler,
  analyze,
  clean
};
