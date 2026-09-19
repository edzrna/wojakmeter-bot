'use strict';

// ===============================
// LAB STATS — small, dependency-free, deterministic
//
// Exact Student t tail via the regularised incomplete beta, Holm's
// step-down correction, declustering for overlapping windows,
// Welch and stratified mean differences, Spearman correlation and a
// seeded day-block bootstrap. Same data in, same numbers out.
// ===============================

function logGamma(x) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta (Numerical Recipes)
function betacf(a, b, x) {
  const MAXIT = 400;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// P(|T| ≥ |t|) for Student's t with df degrees of freedom
function tTwoSided(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return NaN;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

// One-sided p in the given direction (+1: mean > 0, −1: mean < 0)
function tOneSided(t, df, direction) {
  const two = tTwoSided(t, df);
  if (!Number.isFinite(two)) return NaN;
  return Math.sign(t) === Math.sign(direction) ? two / 2 : 1 - two / 2;
}

// Complementary error function, |relative error| < 1.2e-7
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
  );
  return x >= 0 ? r : 2 - r;
}

function zTwoSided(z) {
  return Number.isFinite(z) ? erfc(Math.abs(z) / Math.SQRT2) : NaN;
}

function zOneSided(z, direction) {
  if (!Number.isFinite(z)) return NaN;
  const upper = 0.5 * erfc(z / Math.SQRT2); // P(Z ≥ z)
  return direction > 0 ? upper : 1 - upper;
}

function describe(values) {
  const v = values.filter(Number.isFinite);
  const n = v.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, se: NaN, t: NaN, df: 0, p: NaN, up: NaN };

  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : NaN;
  const se = n > 1 ? sd / Math.sqrt(n) : NaN;
  const t = se > 0 ? mean / se : NaN;

  return { n, mean, sd, se, t, df: n - 1, p: tTwoSided(t, n - 1), up: v.filter(x => x > 0).length / n };
}

// Holm step-down: controls the family-wise error rate over all tests
function holm(pvalues) {
  const m = pvalues.length;
  const order = pvalues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adjusted = new Array(m);
  let running = 0;
  order.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

// Keep one event per horizon window, earliest first. Overlapping
// windows share most of their future, so counting each would
// multiply one price move into many "observations".
function decluster(events, horizonMs) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const out = [];
  let lastTs = -Infinity;
  for (const e of sorted) {
    if (e.ts >= lastTs + horizonMs) {
      out.push(e);
      lastTs = e.ts;
    }
  }
  return out;
}

function welch(a, b) {
  const A = describe(a);
  const B = describe(b);
  if (A.n < 2 || B.n < 2) return { diff: NaN, se: NaN, t: NaN, df: NaN, p: NaN, nA: A.n, nB: B.n };

  const va = A.sd ** 2 / A.n;
  const vb = B.sd ** 2 / B.n;
  const se = Math.sqrt(va + vb);
  const diff = A.mean - B.mean;
  const t = se > 0 ? diff / se : NaN;
  const df = (va + vb) ** 2 / ((va ** 2) / (A.n - 1) + (vb ** 2) / (B.n - 1));

  return { diff, se, t, df, p: tTwoSided(t, df), nA: A.n, nB: B.n, meanA: A.mean, meanB: B.mean };
}

// Difference of means (a − b) inside each stratum, pooled with
// inverse-variance weights. Compares like with like: arrivals into
// the same state, one route against the other.
function stratified(strata) {
  let W = 0;
  let WD = 0;
  let nA = 0;
  let nB = 0;
  let used = 0;

  for (const { a, b } of strata) {
    const A = describe(a);
    const B = describe(b);
    if (A.n < 2 || B.n < 2) continue;
    const v = A.sd ** 2 / A.n + B.sd ** 2 / B.n;
    if (!(v > 0)) continue;
    const w = 1 / v;
    W += w;
    WD += w * (A.mean - B.mean);
    nA += A.n;
    nB += B.n;
    used++;
  }

  if (!W) return { diff: NaN, se: NaN, z: NaN, p: NaN, nA, nB, strata: 0 };

  const diff = WD / W;
  const se = Math.sqrt(1 / W);
  const z = diff / se;
  return { diff, se, z, p: zTwoSided(z), nA, nB, strata: used };
}

// Average ranks, ties shared
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Float64Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function corrFromSums(n, sx, sy, sxx, syy, sxy) {
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (!(vx > 0) || !(vy > 0)) return NaN;
  return cov / Math.sqrt(vx * vy);
}

function pearson(x, y) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i];
  }
  return corrFromSums(n, sx, sy, sxx, syy, sxy);
}

function spearman(x, y) {
  return pearson(ranks(x), ranks(y));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// corr(x1, y) − corr(x2, y) on precomputed ranks, resampling whole
// blocks (days) so dependent events travel together.
function blockBootstrapCorrDiff({ x1, x2, y, block, reps = 1000, seed = 1 }) {
  const groups = new Map();
  block.forEach((b, i) => {
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(i);
  });
  const keys = [...groups.keys()];
  const next = mulberry32(seed);
  const diffs = [];

  for (let r = 0; r < reps; r++) {
    let n = 0, s1 = 0, s2 = 0, sy = 0, s11 = 0, s22 = 0, syy = 0, s1y = 0, s2y = 0;
    for (let k = 0; k < keys.length; k++) {
      for (const i of groups.get(keys[Math.floor(next() * keys.length)])) {
        const a = x1[i], b = x2[i], c = y[i];
        n++; s1 += a; s2 += b; sy += c;
        s11 += a * a; s22 += b * b; syy += c * c; s1y += a * c; s2y += b * c;
      }
    }
    const r1 = corrFromSums(n, s1, sy, s11, syy, s1y);
    const r2 = corrFromSums(n, s2, sy, s22, syy, s2y);
    if (Number.isFinite(r1) && Number.isFinite(r2)) diffs.push(r1 - r2);
  }

  if (!diffs.length) return { lo: NaN, hi: NaN, p: NaN, pUp: NaN, pDown: NaN, reps: 0 };

  diffs.sort((a, b) => a - b);
  const R = diffs.length;
  const le = diffs.filter(d => d <= 0).length / R;
  const ge = diffs.filter(d => d >= 0).length / R;
  const floor = 1 / R;

  return {
    lo: quantile(diffs, 0.025),
    hi: quantile(diffs, 0.975),
    p: Math.min(1, Math.max(floor, 2 * Math.min(le, ge))),
    pUp: Math.max(floor, le),   // evidence that the difference is > 0
    pDown: Math.max(floor, ge), // evidence that the difference is < 0
    reps: R
  };
}

module.exports = {
  logGamma,
  incompleteBeta,
  tTwoSided,
  tOneSided,
  erfc,
  zTwoSided,
  zOneSided,
  describe,
  holm,
  decluster,
  welch,
  stratified,
  ranks,
  pearson,
  spearman,
  mulberry32,
  quantile,
  blockBootstrapCorrDiff
};
