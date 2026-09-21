'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lab/analysis');
const Mo = require('../lab/models');
const { mulberry32, monthKey } = require('./helpers');

const I = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// A market with persistent moods and a BTC price that ignores them
// (unless an edge is injected). breadth and activity are AR(1), so
// states last hours, like the real thing.
function synthetic({ days, seed, start = Date.UTC(2025, 0, 1), edge = null }) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };

  const n = days * 96;
  const series = [];
  const ret = new Float64Array(n);
  let b = 0;
  let a = 0;

  for (let i = 0; i < n; i++) {
    b = 0.97 * b + 0.25 * gauss();
    a = 0.95 * a + 0.3 * gauss();
    const ts = start + (i + 1) * I;
    series.push({
      ts,
      month: monthKey(ts - 1),
      breadth: Math.round(20 / (1 + Math.exp(-b))) / 20,
      actRaw: Math.exp(0.5 * a) * (1 + 0.3 * Math.sin((2 * Math.PI * (i % 96)) / 96)),
      coverage: 20,
      universeN: 20
    });
    ret[i] = 0.0015 * gauss();
  }

  if (edge) {
    // States depend only on breadth and activity, so they can be read
    // before the price is built and the edge written into the price.
    const states = Mo.computeStates(series, 'hex');
    const { transitions } = Mo.buildTransitions(Mo.buildEpisodes(states), states);
    for (const tr of transitions) {
      const push = edge[tr.to];
      if (!push) continue;
      for (let k = 1; k <= 16 && tr.eventIdx + k < n; k++) ret[tr.eventIdx + k] += push / 16;
    }
  }

  let price = 50000;
  for (let i = 0; i < n; i++) {
    price *= 1 + ret[i];
    series[i].btcClose = price;
  }
  return series;
}

const run = (series, freezeTs, modelName = 'hex') =>
  A.analyze({ series, modelName, freezeTs, reps: 200, now: 0 });

test('the freeze: history nominates, live confirms, straddlers belong to neither', () => {
  const freeze = 1_000_000;
  const sample = A.makeSampler(freeze);
  const h4 = A.HORIZONS[1];
  assert.equal(sample(freeze - h4.ms, h4), 'history');
  assert.equal(sample(freeze - h4.ms + 1, h4), null);
  assert.equal(sample(freeze, h4), 'live');
});

test('pure noise does not survive Holm', () => {
  let screenFalse = 0;
  let hypothesisFalse = 0;
  let tested = 0;

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const series = synthetic({ days: 75, seed });
    const r = run(series, series[series.length - 1].ts + DAY); // everything is history
    tested += r.screen.family;

    const flagged = r.screen.rows.filter(row =>
      A.HORIZONS.some(h => ['pending', 'confirmed', 'failed'].includes(row[h.key].verdict)));
    if (flagged.length) screenFalse++;

    const hyp = r.hypotheses.list.filter(hh =>
      A.HORIZONS.some(h => ['pending', 'confirmed', 'failed'].includes(hh[h.key].verdict)));
    if (hyp.length) hypothesisFalse++;

    for (const row of r.screen.rows) {
      for (const h of A.HORIZONS) assert.ok(row[h.key].reason, 'every verdict has a reason');
    }
  }

  assert.ok(tested > 50, `the screen actually ran tests (${tested})`);
  // Holm keeps the family-wise error near 5%: across 12 families, at most one slip
  assert.ok(screenFalse + hypothesisFalse <= 1, `false families: ${screenFalse} screen, ${hypothesisFalse} hypotheses`);
});

test('an injected edge is found in history and confirmed after the freeze', () => {
  const series = synthetic({ days: 150, seed: 42, edge: { euphoria: -0.005, frustration: 0.005 } });
  const freeze = series[Math.floor(series.length * 0.6)].ts;
  const r = run(series, freeze);

  const intoEuphoria = r.screen.rows.filter(row => row.to === 'euphoria' && row.h4.history.nEff >= A.MIN_N);
  assert.ok(intoEuphoria.length, 'some transition into euphoria is testable');
  for (const row of intoEuphoria) {
    assert.ok(row.h4.history.mean < 0, `${row.transition} history mean ${row.h4.history.mean}`);
  }
  assert.ok(intoEuphoria.some(row => row.h4.verdict === 'confirmed'), 'at least one is confirmed live');

  const h2 = r.hypotheses.list.find(h => h.id === 'H2');
  assert.equal(h2.h4.verdict, 'confirmed', h2.h4.reason);
  assert.equal(h2.h4.history.detail.alike, true);
  assert.match(h2.h4.reason, /history \+0\.\d+%.*live \+0\.\d+%/);
});

test('one extreme alone is not "the extremes behave alike"', () => {
  const series = synthetic({ days: 150, seed: 42, edge: { euphoria: -0.008 } });
  const r = run(series, series[series.length - 1].ts + DAY);
  const h2 = r.hypotheses.list.find(h => h.id === 'H2');
  assert.notEqual(h2.h4.verdict, 'pending');
  assert.notEqual(h2.h4.verdict, 'confirmed');
});

test('the report is deterministic and clean JSON', () => {
  const series = synthetic({ days: 40, seed: 9 });
  const freeze = series[Math.floor(series.length * 0.7)].ts;
  const a = run(series, freeze);
  const b = run(series, freeze);
  assert.deepEqual(a, b);

  const text = JSON.stringify(a);
  assert.ok(!/NaN|Infinity/.test(text));
  assert.equal(a.freezeTs, freeze, 'timestamps survive rounding');
  assert.equal(a.samples.live.from, freeze);
  assert.equal(a.transitions.possible, 42);

  const lin = run(series, freeze, 'linear');
  assert.equal(lin.model.version, 'linear-v1');
});

test('insufficient data says how much is missing', () => {
  const series = synthetic({ days: 9, seed: 3 });
  const r = run(series, series[series.length - 1].ts + DAY);
  const h1 = r.hypotheses.list.find(h => h.id === 'H1');
  assert.equal(h1.h4.verdict, 'insufficient');
  assert.match(h1.h4.reason, /needs 30 independent arrivals per route; has \d+ through the centre, \d+ straight/);
  const row = r.screen.rows[0];
  assert.match(row.h24.reason, /history has \d+ independent events; 30 needed/);
});

test('history is frozen: data arriving after the freeze never moves a history number', () => {
  const short = synthetic({ days: 100, seed: 17 });
  const long = synthetic({ days: 120, seed: 17 }); // the same 100 days, then 20 more
  const freezeTs = short[95 * 96 - 1].ts;          // five days before it ends, inside its last month

  const a = A.analyze({ series: short, modelName: 'hex', freezeTs, reps: 200 });
  const b = A.analyze({ series: long, modelName: 'hex', freezeTs, reps: 200 });

  const keys = ['h1', 'h4', 'h24'];
  assert.deepEqual(
    b.hypotheses.list.map(hy => keys.map(k => [hy[k].history.estimate, hy[k].history.p])),
    a.hypotheses.list.map(hy => keys.map(k => [hy[k].history.estimate, hy[k].history.p]))
  );

  // rows are sorted by total count, live included: match them by name
  const rowsOf = r => new Map(r.screen.rows.map(row => [row.transition, row]));
  const ra = rowsOf(a);
  for (const [name, row] of rowsOf(b)) {
    const before = ra.get(name);
    for (const k of keys) {
      if (!before) {
        assert.equal(row[k].history.n, 0, `${name} only exists after the freeze`);
        continue;
      }
      const x = before[k].history;
      const y = row[k].history;
      assert.deepEqual([y.mean, y.p, y.nEff, y.pHolm], [x.mean, x.p, x.nEff, x.pHolm], `${name} ${k}`);
    }
  }
  assert.ok(b.samples.live.snapshots > a.samples.live.snapshots, 'B really has more after the freeze');
});

test('a clear result against the statement is a candidate that says which way it runs', () => {
  const def = A.HYPOTHESES.find(h => h.id === 'H3');
  const history = { testable: true, estimate: -0.026, pHolm: 0.01, detail: {} };
  const live = { testable: false, reason: 'needs 20 days with transitions; has 0' };
  const v = A.judgeHypothesis(def, { history, live });
  assert.equal(v.verdict, 'pending');
  assert.equal(v.opposite, true);
  assert.match(v.reason, /the opposite of the statement/);

  const same = A.judgeHypothesis(def, { history: { ...history, estimate: 0.026 }, live });
  assert.equal(same.opposite, false);

  const nan = A.judgeHypothesis(def, { history: { ...history, pHolm: NaN }, live });
  assert.equal(nan.verdict, 'noise', 'a p that could not be computed is never a candidate');
});
