'use strict';

// Test doubles shared by the suites: a deterministic synthetic market,
// a fake Binance that honours the real klines semantics (startTime,
// endTime, limit, open candle included, 1M aggregation, Invalid
// symbol), and a real Postgres in memory (PGlite) behind the same
// tagged-template interface as the Neon driver.

const INTERVAL = 15 * 60 * 1000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// specs: [{ symbol, price, volume, beta, vol, listedAt? }]
function createMarket({ specs, from, to, seed = 7 }) {
  const n = Math.round((to - from) / INTERVAL) + 1;
  const common = mulberry32(seed);
  const factor = new Float64Array(n);
  for (let i = 0; i < n; i++) factor[i] = (common() - 0.5) * 0.006;

  const data = new Map();
  for (const spec of specs) {
    const own = mulberry32(hash(spec.symbol) ^ seed);
    let price = spec.price;
    const candles = [];
    for (let i = 0; i < n; i++) {
      const t = from + i * INTERVAL;
      const r = (spec.beta ?? 1) * factor[i] + (own() - 0.5) * 0.004 * (spec.vol ?? 1);
      const u1 = own();
      const u2 = own();
      const u3 = own();
      if (spec.listedAt && t < spec.listedAt) continue;
      const o = price;
      const c = price * (1 + r);
      candles.push({
        t,
        o,
        h: Math.max(o, c) * (1 + u1 * 0.002),
        l: Math.min(o, c) * (1 - u2 * 0.002),
        c,
        ct: t + INTERVAL - 1,
        qv: spec.volume * (0.5 + u3)
      });
      price = c;
    }
    data.set(spec.symbol, candles);
  }
  return { data, from, to };
}

function toRow(k) {
  return [k.t, String(k.o), String(k.h), String(k.l), String(k.c), '1', k.ct, String(k.qv), 10, '0', '0', '0'];
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthly(candles) {
  const out = new Map();
  for (const k of candles) {
    const key = monthKey(k.t);
    const [y, m] = key.split('-').map(Number);
    const open = Date.UTC(y, m - 1, 1);
    const cur = out.get(key);
    if (!cur) out.set(key, { t: open, o: k.o, h: k.h, l: k.l, c: k.c, ct: Date.UTC(y, m, 1) - 1, qv: k.qv });
    else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.qv += k.qv;
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

function response(body, status = 200, headers = {}) {
  const h = { 'x-mbx-used-weight-1m': '10', ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => h[key.toLowerCase()] ?? null },
    json: async () => body
  };
}

// failSymbols: requests for these throw (network failure)
// lag: Map symbol → ms; that contract publishes its candles late
// ban: { until } — while now() < until, every request is a 418 IP ban
function createFakeBinance(market, { exchangeSymbols, now, failSymbols = new Set(), lag = new Map(), ban = { until: null } }) {
  const calls = [];
  const monthlyCache = new Map();

  async function fetcher(url) {
    const u = new URL(url);
    calls.push(u.pathname + u.search);

    if (ban.until && now() < ban.until) {
      const seconds = Math.ceil((ban.until - now()) / 1000);
      return response({ code: -1003, msg: `Way too many requests; IP banned until ${ban.until}.` }, 418, { 'retry-after': String(seconds) });
    }

    if (u.pathname === '/fapi/v1/exchangeInfo') return response({ symbols: exchangeSymbols });

    if (u.pathname === '/fapi/v1/klines') {
      const symbol = u.searchParams.get('symbol');
      const interval = u.searchParams.get('interval');
      const limit = Number(u.searchParams.get('limit') || 500);
      const startTime = u.searchParams.has('startTime') ? Number(u.searchParams.get('startTime')) : null;
      const endTime = u.searchParams.has('endTime') ? Number(u.searchParams.get('endTime')) : null;

      if (failSymbols.has(symbol)) throw new Error('socket hang up');

      const candles = market.data.get(symbol);
      if (!candles) return response({ code: -1121, msg: 'Invalid symbol.' }, 400);

      const t = now();
      let rows;
      if (interval === '15m') {
        const visible = t - (lag.get(symbol) || 0);
        rows = candles.filter(k => k.t <= visible); // the open candle is included, like Binance
      } else if (interval === '1M') {
        if (!monthlyCache.has(symbol)) monthlyCache.set(symbol, monthly(candles));
        rows = monthlyCache.get(symbol).filter(k => k.t <= t);
      } else {
        return response({ code: -1120, msg: 'Invalid interval.' }, 400);
      }

      if (startTime !== null) rows = rows.filter(k => k.t >= startTime);
      if (endTime !== null) rows = rows.filter(k => k.t <= endTime);
      rows = startTime !== null ? rows.slice(0, limit) : rows.slice(-limit);
      return response(rows.map(toRow));
    }

    return response({ code: -1, msg: 'Not found' }, 404);
  }

  return { fetcher, calls };
}

async function createTestSql() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  const sql = async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    const res = await db.query(text, values);
    return res.rows;
  };
  sql.db = db;
  return sql;
}

const quietLog = { log() {}, warn() {}, error() {} };

module.exports = {
  INTERVAL,
  mulberry32,
  hash,
  createMarket,
  createFakeBinance,
  createTestSql,
  response,
  monthKey,
  quietLog
};
