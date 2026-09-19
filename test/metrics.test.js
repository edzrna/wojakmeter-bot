'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lab/metrics');

const I = M.INTERVAL_MS;
const T0 = Date.UTC(2026, 2, 10, 0, 0); // 2026-03-10 00:00Z

// 97 closed candles ending at T0 − 1: close_i = 100 + i, open_i = close_{i−1}
function ladder({ n = 97, end = T0 } = {}) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - i) * I;
    const c = 100 + i;
    const o = i ? 100 + i - 1 : 100;
    candles.push({ t, o, h: c + 1, l: o - 1, c, ct: t + I - 1, qv: i + 1 });
  }
  return candles;
}

test('coinMetrics: every number checked by hand', () => {
  const m = M.coinMetrics(ladder(), T0);
  assert.equal(m.ok, true);
  assert.equal(m.close, 196);
  assert.equal(m.c24, 96);                                     // 196 / 100 − 1
  const r4 = x => Math.round(x * 1e4) / 1e4;
  assert.equal(m.c1, r4((196 / 192 - 1) * 100));    // open 1 h ago = close_92 = 192
  assert.equal(m.rv, r4(382 / 366));                // (94+95+96+97) / (90+91+92+93)
  assert.equal(m.hl1, r4(((197 - 191) / 196) * 100)); // high 197, low = open_93 − 1 = 191
});

test('coinMetrics: refuses what it cannot measure, and says why', () => {
  assert.match(M.coinMetrics(ladder(), T0 + I).reason, /no candle closing/);
  assert.match(M.coinMetrics(ladder({ n: 50 }), T0).reason, /needs 97 closed candles, has 50/);

  const gapped = ladder({ n: 98 });
  gapped.splice(50, 1);
  assert.match(M.coinMetrics(gapped, T0).reason, /gap in the last 24 h/);

  const open = ladder();
  open[96] = { ...open[96], ct: open[96].t + 5 * 60 * 1000 };
  assert.match(M.coinMetrics(open, T0).reason, /not a closed 15 m candle/);

  const broken = ladder();
  broken[10] = { ...broken[10], c: 0 };
  assert.match(M.coinMetrics(broken, T0).reason, /invalid candle values/);

  assert.match(M.coinMetrics({ error: 'timeout' }, T0).reason, /fetch failed: timeout/);
  assert.match(M.coinMetrics({ unavailable: 'delisted' }, T0).reason, /delisted/);
  assert.match(M.coinMetrics([], T0).reason, /no candles/);
});

function scaled(factor) {
  return ladder().map(k => ({ ...k, o: k.o * factor, h: k.h * factor, l: k.l * factor, c: k.c * factor }));
}

function falling() {
  // mirror image: close falls from 196 to 100
  return ladder().map((k, i, all) => {
    const c = 196 - i;
    const o = i ? 196 - i + 1 : 196;
    return { ...all[i], o, h: o + 1, l: c - 1, c };
  });
}

test('buildSnapshot: breadth, coverage and the month of the newest candle', () => {
  const universe = ['BTCUSDT', ...Array.from({ length: 11 }, (_, i) => `C${i}USDT`)];
  const series = new Map();
  series.set('BTCUSDT', scaled(1000));
  universe.slice(1).forEach((s, i) => series.set(s, i < 6 ? ladder() : falling()));

  const r = M.buildSnapshot({ T: T0, universe, series });
  assert.equal(r.ok, true);
  const s = r.snapshot;
  assert.equal(s.coverage, 12);
  assert.equal(s.universeN, 12);
  assert.equal(s.breadth, 7 / 12); // BTC + 6 rising
  assert.equal(s.btcClose, 196000);
  assert.equal(s.month, '2026-03');
  assert.equal(s.missing, null);

  // The aggregates come from the stored (rounded) coins
  const up = s.coins.filter(c => c[1] > 0).length;
  assert.equal(up / s.coins.length, s.breadth);
  assert.equal(s.actRaw, M.median(s.coins.map(c => c[4])));

  assert.equal(M.snapshotMonth(Date.UTC(2026, 2, 1)), '2026-02'); // 00:00 on the 1st closes February
  assert.equal(M.isBoundary(T0), true);
  assert.equal(M.isBoundary(T0 + 1), false);
});

test('buildSnapshot: BTC missing, thin coverage and failed requests are not snapshots', () => {
  const universe = ['BTCUSDT', ...Array.from({ length: 11 }, (_, i) => `C${i}USDT`)];
  const full = new Map(universe.map(s => [s, ladder()]));

  const noBtc = new Map(full);
  noBtc.set('BTCUSDT', ladder({ n: 20 }));
  const a = M.buildSnapshot({ T: T0, universe, series: noBtc });
  assert.equal(a.ok, false);
  assert.match(a.reason, /BTCUSDT unavailable: needs 97/);

  const thin = new Map(full);
  for (const s of universe.slice(1, 4)) thin.set(s, []);
  const b = M.buildSnapshot({ T: T0, universe, series: thin });
  assert.equal(b.ok, false);
  assert.match(b.reason, /coverage 9\/12 is below 10/);

  const failed = new Map(full);
  failed.set('C3USDT', { error: 'ECONNRESET' });
  const c = M.buildSnapshot({ T: T0, universe, series: failed });
  assert.equal(c.ok, false);
  assert.equal(c.retryable, true);
  assert.match(c.reason, /C3USDT: fetch failed: ECONNRESET/);

  const delisted = new Map(full);
  delisted.set('C3USDT', { unavailable: 'not served by Binance' });
  const d = M.buildSnapshot({ T: T0, universe, series: delisted });
  assert.equal(d.ok, true);
  assert.deepEqual(d.snapshot.missing, [['C3USDT', 'not served by Binance']]);
  assert.equal(d.snapshot.coverage, 11);
});
