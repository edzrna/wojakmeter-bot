'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lab/stats');

// Reference values computed with SciPy (scipy.stats.t / ttest_ind / spearmanr / beta)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Student t tail matches SciPy', () => {
  near(S.tTwoSided(2.0, 10), 0.07338803477074037, 1e-10, 't=2 df=10');
  near(S.tTwoSided(2.228139, 10), 0.04999998745288254, 1e-10, 'critical value');
  near(S.tTwoSided(30, 3), 8.135280427163958e-5, 1e-12, 'far tail');
  near(S.tTwoSided(0.3, 250), 0.7644264490160496, 1e-10, 'large df');
  assert.equal(S.tTwoSided(0, 5), 1);
  assert.ok(Number.isNaN(S.tTwoSided(NaN, 5)));

  near(S.tOneSided(2.0, 10, 1), 0.07338803477074037 / 2, 1e-10, 'one-sided, right way');
  near(S.tOneSided(2.0, 10, -1), 1 - 0.07338803477074037 / 2, 1e-10, 'one-sided, wrong way');
  near(S.incompleteBeta(0.5, 2, 3), 0.6875, 1e-12, 'I_0.5(2,3)');
});

test('normal tail', () => {
  near(S.zTwoSided(1.959964), 0.05, 1e-6, 'two-sided');
  near(S.zOneSided(1.644854, 1), 0.05, 1e-6, 'one-sided');
  near(S.zOneSided(-1.644854, -1), 0.05, 1e-6, 'one-sided, negative');
});

test('describe, Welch and Spearman', () => {
  const d = S.describe([1, 2, 3, 4]);
  assert.equal(d.mean, 2.5);
  near(d.t, 2.5 / (Math.sqrt(5 / 3) / 2), 1e-12, 't');
  assert.equal(d.df, 3);
  assert.equal(d.up, 1);

  const w = S.welch([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  near(w.t, -1.8973665961010275, 1e-12, 'Welch t');
  near(w.p, 0.10753119493062728, 1e-9, 'Welch p');

  near(S.spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]), 0.8207826816681233, 1e-12, 'Spearman with ties');

  // One stratum: the same difference as Welch, judged on the normal
  const st = S.stratified([{ a: [1, 2, 3, 4, 5], b: [2, 4, 6, 8, 10] }]);
  near(st.diff, -3, 1e-12, 'stratified diff');
  near(st.z, -1.8973665961010275, 1e-12, 'stratified z');
});

test('Holm step-down', () => {
  assert.deepEqual(S.holm([0.01, 0.04, 0.03, 0.005]), [0.03, 0.06, 0.06, 0.02]);
  assert.deepEqual(S.holm([0.9, 0.8]), [1, 1]);
  assert.deepEqual(S.holm([]), []);
});

test('decluster keeps one event per window', () => {
  const kept = S.decluster([0, 130, 10, 60, 20, 65].map(ts => ({ ts })), 60).map(e => e.ts);
  assert.deepEqual(kept, [0, 60, 130]);
});

test('day-block bootstrap: seeded, and honest when there is nothing to compare', () => {
  const rnd = S.mulberry32(11);
  const n = 400;
  const x1 = [];
  const x2 = [];
  const y = [];
  const block = [];
  for (let i = 0; i < n; i++) {
    const a = rnd();
    x1.push(a);
    x2.push(rnd());
    y.push(a + 0.3 * rnd());
    block.push(Math.floor(i / 8));
  }
  const args = { x1: S.ranks(x1), x2: S.ranks(x2), y: S.ranks(y), block, reps: 400, seed: 5 };
  const a = S.blockBootstrapCorrDiff(args);
  const b = S.blockBootstrapCorrDiff(args);
  assert.deepEqual(a, b, 'same seed, same answer');
  assert.ok(a.lo > 0, 'x1 predicts y, x2 does not');
  assert.ok(a.p <= 1 / a.reps + 1e-12);

  const same = S.blockBootstrapCorrDiff({ ...args, x2: args.x1 });
  assert.equal(same.p, 1);
});

test('bootstrap p comes from the standard error: below 1/reps, and not at the mercy of the seed', () => {
  const rnd = S.mulberry32(3);
  const x1 = [], x2 = [], y = [], block = [];
  for (let i = 0; i < 2000; i++) {
    const g = rnd() - 0.5;
    y.push(g);
    x1.push(0.3 * g + 0.5 * (rnd() - 0.5));
    x2.push(0.2 * g + 0.5 * (rnd() - 0.5));
    block.push(Math.floor(i / 5));
  }
  const args = { x1: S.ranks(x1), x2: S.ranks(x2), y: S.ranks(y), block };
  const a = S.blockBootstrapCorrDiff({ ...args, reps: 1000, seed: 1 });
  const b = S.blockBootstrapCorrDiff({ ...args, reps: 4000, seed: 2 });

  assert.ok(a.estimate > 0);
  assert.ok(a.p < 1 / a.reps, `resolved below 1/reps: ${a.p}`);
  assert.ok(Math.abs(Math.log10(a.p) - Math.log10(b.p)) < 0.3, `seed and reps barely matter: ${a.p} vs ${b.p}`);
  assert.ok(a.pUp < a.pDown);
  assert.equal(a.p, S.erfc(Math.abs(a.estimate / a.se) / Math.SQRT2));
});
