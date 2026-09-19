'use strict';

// ===============================
// LAB UNIVERSE — which 20 contracts count, month by month
//
// Month M uses the 20 USDT-M perpetuals with the most quote volume
// in month M−1. It stays fixed for the whole month, so breadth never
// jumps because contract #20 swapped places with #21, and it is
// chosen only from the past, so there is no look-ahead.
//
//   - BTCUSDT is always in: it prices the outcomes.
//   - Stablecoins are out: a coin pinned to $1 counts as up or down
//     by coin flip.
//   - Index contracts (BTCDOM, DEFI…), dated futures and commodity
//     tokens are out: they are not crypto sentiment.
//   - A contract needs the whole basis month on the exchange, so a
//     listing with one hysterical first week cannot jump the queue.
//
// Known bias, stated instead of hidden: months ranked after they
// ended (the history rebuild) can only choose among contracts that
// still trade today. A contract delisted since cannot appear. Months
// ranked while live are point-in-time. Each stored universe says
// which kind it is.
// ===============================

const { monthKey, REF_SYMBOL } = require('./metrics');

const UNIVERSE_SIZE = 20;
const MIN_UNIVERSE = 10;
const METHOD = 'prev-month-quote-volume-v1';

const EXCLUDED_BASES = new Set([
  // stablecoins and fiat
  'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDP', 'USDE', 'PYUSD', 'USD1', 'RLUSD',
  'BFUSD', 'USDS', 'EUR', 'EURI', 'AEUR', 'GBP',
  // commodities
  'PAXG', 'XAUT', 'XAU', 'XAG'
]);

function monthStart(key) {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(Date.UTC(y, m - 1 + n, 1));
}

function monthsBetween(fromKey, toKey) {
  const out = [];
  for (let k = fromKey; k <= toKey; k = addMonths(k, 1)) out.push(k);
  return out;
}

function eligibleContracts(info) {
  const symbols = Array.isArray(info?.symbols) ? info.symbols : [];
  return symbols
    .filter(s =>
      s.contractType === 'PERPETUAL' &&
      s.quoteAsset === 'USDT' &&
      s.status === 'TRADING' &&
      (s.underlyingType === undefined || s.underlyingType === 'COIN') &&
      !String(s.symbol).includes('_') &&
      !EXCLUDED_BASES.has(String(s.baseAsset || '').toUpperCase())
    )
    .map(s => ({ symbol: s.symbol, onboardDate: Number(s.onboardDate) || 0 }));
}

// volumes: Map symbol → Map(monthKey → quote volume)
function rankMonth(month, contracts, volumes, { computedAt, size = UNIVERSE_SIZE } = {}) {
  const basis = addMonths(month, -1);
  const basisStart = monthStart(basis);

  const ranked = contracts
    .filter(c => c.onboardDate <= basisStart)
    .map(c => ({ symbol: c.symbol, qv: volumes.get(c.symbol)?.get(basis) }))
    .filter(r => Number.isFinite(r.qv) && r.qv > 0)
    .sort((a, b) => b.qv - a.qv || (a.symbol < b.symbol ? -1 : 1));

  if (!ranked.some(r => r.symbol === REF_SYMBOL)) {
    return { ok: false, permanent: true, month, reason: `${REF_SYMBOL} has no full-month volume for ${basis}` };
  }

  const symbols = ranked.slice(0, size).map(r => r.symbol);
  if (!symbols.includes(REF_SYMBOL)) symbols[symbols.length - 1] = REF_SYMBOL;

  if (symbols.length < MIN_UNIVERSE) {
    return { ok: false, permanent: true, month, reason: `only ${symbols.length} eligible contracts for ${basis}` };
  }

  const pointInTime = Number.isFinite(computedAt) && computedAt < monthStart(addMonths(month, 1));

  return {
    ok: true,
    month,
    basis,
    method: METHOD,
    symbols,
    candidates: ranked.length,
    survivorship: pointInTime ? 'point-in-time' : 'current-listings'
  };
}

// One pass over every eligible contract gives the volumes for all the
// requested months at once.
async function computeUniverses({ rest, months, now = Date.now() }) {
  const info = await rest.exchangeInfo();
  const contracts = eligibleContracts(info);

  // Only contracts that could qualify for at least one requested month
  const latestBasisStart = Math.max(...months.map(m => monthStart(addMonths(m, -1))));
  const relevant = contracts.filter(c => c.onboardDate <= latestBasisStart);

  const volumes = new Map();
  const failures = [];

  for (const c of relevant) {
    try {
      const rows = await rest.klines(c.symbol, '1M', { limit: 99 });
      const byMonth = new Map();
      for (const k of rows) byMonth.set(monthKey(k.t), k.qv);
      volumes.set(c.symbol, byMonth);
    } catch (err) {
      failures.push([c.symbol, err.message]);
    }
  }

  // A missing volume would silently reshuffle the ranking. Refuse
  // instead, and let the caller retry later.
  if (failures.length) {
    const err = new Error(`monthly volume unavailable for ${failures.length} contract(s), e.g. ${failures[0][0]}: ${failures[0][1]}`);
    err.retryable = true;
    throw err;
  }

  const results = new Map();
  for (const month of months) results.set(month, rankMonth(month, contracts, volumes, { computedAt: now }));

  return { results, contracts: contracts.length, fetched: relevant.length };
}

module.exports = {
  UNIVERSE_SIZE,
  METHOD,
  EXCLUDED_BASES,
  monthStart,
  addMonths,
  monthsBetween,
  eligibleContracts,
  rankMonth,
  computeUniverses
};
