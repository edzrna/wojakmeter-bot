'use strict';

// ===============================
// LAB RECONSTRUCT — any set of boundaries, live or history
//
// One function builds every snapshot the lab ever stores. The live
// recorder calls it for the boundary that just closed, the gap filler
// for boundaries missed while the service was down, and the history
// rebuild month by month. Same candles in, same numbers out.
//
// Candles are fetched once per contract per month group, asking for
// exactly the range needed (the oldest candle is the one 24 h before
// the first boundary).
// ===============================

const { INTERVAL_MS, NEED, buildSnapshot, snapshotMonth } = require('./metrics');

function boundariesBetween(fromTs, toTs) {
  const out = [];
  for (let T = Math.ceil(fromTs / INTERVAL_MS) * INTERVAL_MS; T <= toTs; T += INTERVAL_MS) out.push(T);
  return out;
}

function lastClosedBoundary(now, settleMs = 0) {
  return Math.floor((now - settleMs) / INTERVAL_MS) * INTERVAL_MS;
}

function createReconstructor({ rest, getUniverse }) {
  // boundaries: ascending list of T. Returns { snapshots, invalid }.
  async function build(boundaries) {
    const byMonth = new Map();
    for (const T of boundaries) {
      const month = snapshotMonth(T);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(T);
    }

    const snapshots = [];
    const invalid = [];

    for (const [month, Ts] of byMonth) {
      Ts.sort((a, b) => a - b);

      let universe;
      try {
        universe = await getUniverse(month);
      } catch (err) {
        for (const T of Ts) invalid.push({ ts: T, retryable: true, reason: `universe ${month}: ${err.message}` });
        continue;
      }

      if (!universe || !universe.ok) {
        const reason = `universe ${month}: ${universe ? universe.reason : 'unavailable'}`;
        const retryable = !universe || !universe.permanent;
        for (const T of Ts) invalid.push({ ts: T, retryable, reason });
        continue;
      }

      const start = Ts[0] - NEED * INTERVAL_MS;        // open time of the oldest candle needed
      const end = Ts[Ts.length - 1] - INTERVAL_MS;     // open time of the newest closed candle
      const series = new Map();

      for (const symbol of universe.symbols) {
        try {
          series.set(symbol, await rest.klinesRange(symbol, '15m', start, end, INTERVAL_MS));
        } catch (err) {
          // HTTP 400 is Binance refusing the symbol (e.g. delisted since):
          // a fact about the contract, not a failed request to retry.
          series.set(symbol, err.status === 400 ? { unavailable: `not served by Binance (${err.message})` } : { error: err.message });
        }
      }

      for (const T of Ts) {
        const r = buildSnapshot({ T, universe: universe.symbols, series });
        if (r.ok) snapshots.push(r.snapshot);
        else invalid.push({ ts: T, retryable: Boolean(r.retryable), reason: r.reason });
      }
    }

    return { snapshots, invalid };
  }

  return { build };
}

module.exports = { createReconstructor, boundariesBetween, lastClosedBoundary };
