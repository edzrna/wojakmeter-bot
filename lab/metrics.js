'use strict';

// ===============================
// LAB METRICS — closed 15 m candles → one snapshot
//
// The single definition of what the lab measures. The live recorder,
// the gap filler and the history rebuild all call buildSnapshot(), so
// a snapshot recorded tonight and the same instant rebuilt next year
// are the same numbers.
//
// A snapshot at boundary T describes the market up to T: its newest
// candle is the one that closed at T − 1 ms. Nothing here reads a
// ticker or "the current price" — only closed candles, which Binance
// never revises, so every snapshot can be rebuilt exactly.
//
// Per coin, from the last 97 closed candles (24 h + 1):
//   c24   close now vs close 24 h ago, %
//   c1    close now vs open 1 h ago, %
//   rv    quote volume of the last hour / the hour before
//   hl1   high–low range of the last hour, % of the close
//
// Aggregates are computed from the ROUNDED per-coin values that get
// stored, so anyone recomputing them from the stored coins gets the
// same numbers.
// ===============================

const INTERVAL_MS = 15 * 60 * 1000;
const DAY_CANDLES = 96;
const HOUR_CANDLES = 4;
const NEED = DAY_CANDLES + 1;
const MIN_COVERAGE = 10;
const REF_SYMBOL = 'BTCUSDT';

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The snapshot at T belongs to the month of its newest candle
function snapshotMonth(T) {
  return monthKey(T - 1);
}

function isBoundary(T) {
  return Number.isSafeInteger(T) && T % INTERVAL_MS === 0;
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// candles: ascending by open time. Returns metrics or { ok: false, reason }.
function coinMetrics(candles, T) {
  if (candles && candles.error) return { ok: false, reason: `fetch failed: ${candles.error}` };
  if (candles && candles.unavailable) return { ok: false, reason: candles.unavailable };
  if (!Array.isArray(candles) || !candles.length) return { ok: false, reason: 'no candles' };

  const lastOpen = T - INTERVAL_MS;
  let k = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].t === lastOpen) { k = i; break; }
    if (candles[i].t < lastOpen) break;
  }

  if (k < 0) return { ok: false, reason: 'no candle closing at this boundary' };
  if (k < NEED - 1) return { ok: false, reason: `needs ${NEED} closed candles, has ${k + 1}` };

  for (let i = k - NEED + 1; i <= k; i++) {
    const c = candles[i];
    if (!(c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 && c.qv >= 0 && c.h >= c.l)) {
      return { ok: false, reason: 'invalid candle values' };
    }
    if (c.ct !== c.t + INTERVAL_MS - 1) return { ok: false, reason: 'not a closed 15 m candle' };
    if (i > k - NEED + 1 && c.t - candles[i - 1].t !== INTERVAL_MS) {
      return { ok: false, reason: 'gap in the last 24 h of candles' };
    }
  }

  const last = candles[k];
  const dayAgo = candles[k - DAY_CANDLES];
  const hourStart = candles[k - HOUR_CANDLES + 1];

  let qvHour = 0;
  let qvPrevHour = 0;
  let hi = -Infinity;
  let lo = Infinity;

  for (let i = k - HOUR_CANDLES + 1; i <= k; i++) {
    qvHour += candles[i].qv;
    hi = Math.max(hi, candles[i].h);
    lo = Math.min(lo, candles[i].l);
  }
  for (let i = k - 2 * HOUR_CANDLES + 1; i <= k - HOUR_CANDLES; i++) qvPrevHour += candles[i].qv;

  return {
    ok: true,
    close: last.c,
    c24: round((last.c / dayAgo.c - 1) * 100, 4),
    c1: round((last.c / hourStart.o - 1) * 100, 4),
    rv: qvPrevHour > 0 ? round(qvHour / qvPrevHour, 4) : null,
    hl1: round(((hi - lo) / last.c) * 100, 4)
  };
}

// universe: symbols in rank order. series: Map symbol → candles (or { error }).
function buildSnapshot({ T, universe, series }) {
  if (!isBoundary(T)) return { ok: false, T, reason: 'not a 15 m boundary' };
  if (!Array.isArray(universe) || !universe.length) return { ok: false, T, reason: 'empty universe' };

  const coins = [];
  const missing = [];
  let btc = null;

  for (const symbol of universe) {
    const m = coinMetrics(series.get(symbol), T);
    if (!m.ok) {
      missing.push([symbol, m.reason]);
      continue;
    }
    coins.push([symbol, m.c24, m.c1, m.rv, m.hl1]);
    if (symbol === REF_SYMBOL) btc = m;
  }

  // A network failure is not a fact about the market: never store a
  // snapshot that is partial because a request failed.
  const failed = missing.filter(([, reason]) => reason.startsWith('fetch failed'));
  if (failed.length) {
    return { ok: false, T, retryable: true, reason: `${failed.length} request(s) failed, e.g. ${failed[0][0]}: ${failed[0][1]}` };
  }

  if (!btc) {
    const why = missing.find(([s]) => s === REF_SYMBOL);
    return { ok: false, T, reason: `${REF_SYMBOL} unavailable: ${why ? why[1] : 'not in universe'}` };
  }

  if (coins.length < MIN_COVERAGE) {
    return { ok: false, T, reason: `coverage ${coins.length}/${universe.length} is below ${MIN_COVERAGE}` };
  }

  const up = coins.filter(c => c[1] > 0).length;

  return {
    ok: true,
    snapshot: {
      ts: T,
      month: snapshotMonth(T),
      universeN: universe.length,
      coverage: coins.length,
      breadth: up / coins.length,
      btcClose: btc.close,
      btcC24: btc.c24,
      btcC1: btc.c1,
      actRaw: median(coins.map(c => c[4])),
      rvMed: median(coins.map(c => c[3]).filter(v => v !== null)),
      coins,
      missing: missing.length ? missing : null
    }
  };
}

module.exports = {
  INTERVAL_MS,
  DAY_CANDLES,
  HOUR_CANDLES,
  NEED,
  MIN_COVERAGE,
  REF_SYMBOL,
  monthKey,
  snapshotMonth,
  isBoundary,
  median,
  coinMetrics,
  buildSnapshot
};
