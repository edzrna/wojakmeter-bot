'use strict';

// ===============================
// BINANCE USD-M — PUBLIC REST CLIENT
//
// Public market data only: no keys, no account endpoints, no orders.
//
// Every request goes through one queue, so the whole service shares
// one weight budget:
//   - at least minGapMs between requests
//   - reads X-MBX-USED-WEIGHT-1M and waits for the next clock minute
//     before crossing weightBudget: 600, a quarter of Binance's 2400.
//     Railway's outbound IPs are shared and the header counts everyone
//     on the IP, so the lab stays small and patient
//   - 429 / 418 block the queue until Retry-After (floor: 60 s / 15 min)
//   - 451 is Binance refusing this server's location. It will not fix
//     itself, so the queue is blocked for 30 min and every request in
//     between fails at once with that reason, instead of hammering the
//     API and reporting it as a flaky network
//   - a block longer than maxWaitMs fails the request with its reason
//     instead of leaving the caller hanging
//   - blockUntil() restores a block learned before a restart: knocking
//     during a ban is how a short ban becomes a long one
//
// Kline weight depends on the `limit` you ASK for, not on how many
// candles come back, so callers pass the smallest limit that covers
// the range.
// ===============================

const ORIGIN = 'https://fapi.binance.com';
const MINUTE = 60_000;
const GEO_BLOCK_MS = 30 * MINUTE;

function klineWeight(limit) {
  const n = Number(limit) || 500;
  if (n < 100) return 1;
  if (n < 500) return 2;
  if (n <= 1000) return 5;
  return 10;
}

// Binance kline row → { t, o, h, l, c, ct, qv }  (open time, OHLC, close time, quote volume)
function parseKline(row) {
  if (!Array.isArray(row) || row.length < 8) return null;
  const k = {
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    ct: Number(row[6]),
    qv: Number(row[7])
  };
  return Object.values(k).every(Number.isFinite) ? k : null;
}

function createBinanceRest({
  fetcher = globalThis.fetch,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  origin = ORIGIN,
  minGapMs = 150,
  weightBudget = 600,
  maxWaitMs = 5 * MINUTE,
  timeoutMs = 15_000
} = {}) {
  let tail = Promise.resolve();
  let lastAt = 0;
  let blockedUntil = 0;
  let blockReason = null;
  let usedWeight = 0;
  let usedMinute = -1;

  const stats = { requests: 0, errors: 0, waitedMs: 0, lastError: null };

  async function waitTurn(weight) {
    const t = now();

    if (blockedUntil > t) {
      const wait = blockedUntil - t;
      if (wait > maxWaitMs) {
        const err = new Error(`Binance blocked until ${new Date(blockedUntil).toISOString()} (${blockReason})`);
        err.code = 'BLOCKED';
        throw err;
      }
      stats.waitedMs += wait;
      await sleep(wait);
    }

    const minute = Math.floor(now() / MINUTE);
    if (minute === usedMinute && usedWeight + weight > weightBudget) {
      const wait = (minute + 1) * MINUTE - now() + 1000;
      stats.waitedMs += wait;
      await sleep(wait);
    }

    const gap = now() - lastAt;
    if (gap < minGapMs) await sleep(minGapMs - gap);
  }

  function noteWeight(res, weight) {
    const header = res.headers?.get?.('x-mbx-used-weight-1m');
    const minute = Math.floor(now() / MINUTE);

    if (header !== null && header !== undefined && Number.isFinite(Number(header))) {
      usedWeight = Number(header);
      usedMinute = minute;
      return;
    }

    // No header (proxy, test double): count locally
    if (minute !== usedMinute) {
      usedMinute = minute;
      usedWeight = 0;
    }
    usedWeight += weight;
  }

  function request(path, params = {}, { weight = 1 } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    const url = origin + path + (qs ? `?${qs}` : '');

    const job = tail.then(async () => {
      await waitTurn(weight);
      lastAt = now();
      stats.requests++;

      let res;
      try {
        res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        stats.errors++;
        stats.lastError = `${path}: ${err.message}`;
        throw err;
      }

      noteWeight(res, weight);

      if (res.status === 429 || res.status === 418) {
        const raw = res.headers?.get?.('retry-after');
        const seconds = Number(raw);
        const advised = raw && Number.isFinite(seconds) ? now() + seconds * 1000 : NaN;
        const floor = now() + (res.status === 418 ? 15 * MINUTE : MINUTE);
        blockedUntil = Math.max(floor, Number.isFinite(advised) ? advised : 0);
        blockReason = `HTTP ${res.status}`;
      }

      if (res.status === 451) {
        blockedUntil = now() + GEO_BLOCK_MS;
        blockReason = 'HTTP 451: Binance refuses requests from this server\'s location — ' +
          'the service must run in a region Binance serves (not the US)';
      }

      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          if (body && (body.code !== undefined || body.msg)) {
            detail = ` ${body.code ?? ''} ${body.msg ?? ''}`.trimEnd();
          }
        } catch {
          // body was not JSON; the status says enough
        }
        const err = new Error(`Binance ${path}: HTTP ${res.status}${detail}`);
        err.status = res.status;
        stats.errors++;
        stats.lastError = err.message;
        throw err;
      }

      return res.json();
    });

    tail = job.catch(() => {});
    return job;
  }

  function exchangeInfo() {
    return request('/fapi/v1/exchangeInfo', {}, { weight: 1 });
  }

  async function klines(symbol, interval, { startTime, endTime, limit = 500 } = {}) {
    const rows = await request(
      '/fapi/v1/klines',
      { symbol, interval, startTime, endTime, limit },
      { weight: klineWeight(limit) }
    );

    if (!Array.isArray(rows)) throw new Error(`Binance klines ${symbol}: unexpected response`);

    return rows.map((row, i) => {
      const k = parseKline(row);
      if (!k) throw new Error(`Binance klines ${symbol}: unparseable row ${i}`);
      return k;
    });
  }

  // Every candle whose open time falls in [startTime, endTime], paging
  // by 1500 and asking for no more than the range needs.
  async function klinesRange(symbol, interval, startTime, endTime, intervalMs) {
    const out = [];
    let cursor = startTime;

    while (cursor <= endTime) {
      const remaining = Math.floor((endTime - cursor) / intervalMs) + 1;
      const limit = Math.max(1, Math.min(1500, remaining));
      const page = await klines(symbol, interval, { startTime: cursor, endTime, limit });

      for (const k of page) {
        const inside = k.t >= startTime && k.t <= endTime;
        const ascending = !out.length || k.t > out[out.length - 1].t;
        if (inside && ascending) out.push(k);
      }

      if (page.length < limit) break;
      const next = page[page.length - 1].t + intervalMs;
      if (next <= cursor) break; // no progress: stop rather than loop forever
      cursor = next;
    }

    return out;
  }

  // Never shortens a block that is already longer
  function blockUntil(until, reason) {
    if (Number.isFinite(until) && until > blockedUntil) {
      blockedUntil = until;
      blockReason = reason || 'restored block';
    }
  }

  function snapshotStats() {
    return {
      ...stats,
      usedWeight: usedMinute === Math.floor(now() / MINUTE) ? usedWeight : 0,
      weightBudget,
      blockedUntil: blockedUntil > now() ? blockedUntil : null,
      blockReason: blockedUntil > now() ? blockReason : null
    };
  }

  return { request, exchangeInfo, klines, klinesRange, blockUntil, stats: snapshotStats };
}

module.exports = { createBinanceRest, parseKline, klineWeight, ORIGIN };
