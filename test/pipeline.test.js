'use strict';

// The whole service against a fake Binance and a real Postgres in
// memory, with a clock the test controls. Nothing here is mocked
// below the network: the lab builds, stores, reloads and reports
// exactly as it would on Railway.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { createLab } = require('../lab');
const { createBinanceRest } = require('../lib/binance-rest');
const { createDeskAuth, signV2, sha256Hex } = require('../lib/desk-auth');
const { createApp } = require('../server');
const { createReconstructor } = require('../lab/reconstruct');
const { rankMonth } = require('../lab/universe');
const { createMarket, createFakeBinance, createTestSql, quietLog } = require('./helpers');

const MIN = 60 * 1000;
const LISTED = Date.UTC(2024, 0, 1);

function world() {
  const specs = [];
  const info = [];
  const add = (symbol, o) => {
    specs.push({ symbol, price: o.price ?? 10, volume: o.volume, beta: o.beta ?? 1, vol: o.vol ?? 1.5, listedAt: o.listedAt });
    info.push({
      symbol,
      pair: symbol,
      contractType: o.contractType || 'PERPETUAL',
      status: 'TRADING',
      quoteAsset: 'USDT',
      baseAsset: o.base || symbol.replace(/USDT.*$/, ''),
      underlyingType: o.underlyingType || 'COIN',
      onboardDate: o.onboardDate ?? LISTED
    });
  };

  add('BTCUSDT', { volume: 5e8, price: 60000, vol: 0.5 });
  for (let i = 1; i <= 21; i++) add(`C${String(i).padStart(2, '0')}USDT`, { volume: 4e8 - i * 1e7, price: 5 + i });
  add('USDCUSDT', { volume: 9e9, price: 1, beta: 0, vol: 0.001 });                     // stablecoin
  add('BTCDOMUSDT', { volume: 8e9, underlyingType: 'INDEX' });                          // index
  add('BTCUSDT_260327', { volume: 7e9, contractType: 'CURRENT_QUARTER', base: 'BTC' }); // dated future
  const young = Date.UTC(2026, 1, 10);
  add('NEWUSDT', { volume: 6e9, onboardDate: young, listedAt: young });                 // no full basis month

  const market = createMarket({ specs, from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 2, 12), seed: 5 });
  return { market, info };
}

test('rankMonth: previous month, eligible only, BTC always in', () => {
  const contracts = Array.from({ length: 30 }, (_, i) => ({ symbol: `S${i}USDT`, onboardDate: 0 }));
  contracts.push({ symbol: 'BTCUSDT', onboardDate: 0 });
  const volumes = new Map(contracts.map((c, i) => [c.symbol, new Map([['2026-01', 1000 - i]])]));
  const r = rankMonth('2026-02', contracts, volumes, { computedAt: Date.UTC(2026, 1, 1) });
  assert.equal(r.ok, true);
  assert.equal(r.symbols.length, 20);
  assert.equal(r.symbols[19], 'BTCUSDT', 'forced in, in place of #20');
  assert.equal(r.basis, '2026-01');
  assert.equal(r.survivorship, 'point-in-time');

  const late = rankMonth('2026-02', contracts, volumes, { computedAt: Date.UTC(2026, 5, 1) });
  assert.equal(late.survivorship, 'current-listings');

  const noBtc = rankMonth('2026-03', contracts, volumes, { computedAt: 0 });
  assert.equal(noBtc.ok, false);
  assert.equal(noBtc.permanent, true);
  assert.match(noBtc.reason, /BTCUSDT has no full-month volume for 2026-02/);
});

test('pipeline: live, gaps, history, reports and the signed desk API', async t => {
  const { market, info } = world();
  let clock = Date.UTC(2026, 2, 10, 12, 5, 30);
  const failSymbols = new Set();
  const lag = new Map();

  const sql = await createTestSql();
  const fake = createFakeBinance(market, { exchangeSymbols: info, now: () => clock, failSymbols, lag });
  const rest = createBinanceRest({ fetcher: fake.fetcher, now: () => clock, sleep: async ms => { clock += ms; }, minGapMs: 0 });
  const lab = createLab({ sql, rest, now: () => clock, backfillFrom: '2026-02', log: quietLog });

  // --- first minute: live boundary, 48 h of gaps, the current month
  await lab.tick();
  let st = lab.status();
  assert.equal(st.service.ready, true);
  assert.equal(st.recorder.lastLiveTs, Date.UTC(2026, 2, 10, 12, 0));
  assert.equal(st.backfill.done, 1);
  assert.equal(st.backfill.total, 2);
  assert.equal(st.backfill.current, '2026-02', 'the month up next, not the one just finished');
  const freeze = st.freeze['hex-v1'];
  assert.equal(freeze, Date.UTC(2026, 2, 10, 12, 5, 30), 'frozen at first start');

  // --- eleven minutes later: next live boundary and the rest of history
  clock += 11 * MIN;
  await lab.tick();
  st = lab.status();
  assert.equal(st.backfill.state, 'done');
  assert.equal(st.data.snapshots, 3601, 'Feb 1 00:15 → Mar 10 12:15, no holes');
  assert.equal(st.data.live, 2);
  assert.equal(st.data.backfill, 3599);
  assert.equal(st.recorder.lastError, null);

  await t.test('universes: last month\'s volume, no stablecoins, indices, dated or young contracts', () => {
    const march = lab._internal.universes.get('2026-03');
    const feb = lab._internal.universes.get('2026-02');
    assert.equal(march.symbols.length, 20);
    assert.ok(march.symbols.includes('BTCUSDT'));
    for (const s of ['USDCUSDT', 'BTCDOMUSDT', 'BTCUSDT_260327', 'NEWUSDT', 'C20USDT', 'C21USDT']) {
      assert.ok(!march.symbols.includes(s), `${s} must not be in`);
    }
    assert.equal(march.basis, '2026-02');
    assert.equal(march.survivorship, 'point-in-time');
    assert.equal(feb.survivorship, 'current-listings', 'ranked after it ended');
  });

  await t.test('rebuilding a live boundary gives the same numbers', async () => {
    const rebuilt = await createReconstructor({ rest, getUniverse: async m => lab._internal.universes.get(m) })
      .build([Date.UTC(2026, 2, 10, 12, 0)]);
    const live = lab._internal.unified().find(s => s.ts === Date.UTC(2026, 2, 10, 12, 0));
    assert.equal(live.source, 'live');
    const s = rebuilt.snapshots[0];
    assert.equal(s.breadth, live.breadth);
    assert.equal(s.btcClose, live.btcClose);
    assert.equal(s.actRaw, live.actRaw);
  });

  await t.test('a failed request is retried, never stored as a thin snapshot', async () => {
    clock += 15 * MIN; // 12:31:30 → boundary 12:30
    failSymbols.add('C05USDT');
    await lab.tick();
    let s = lab.status();
    assert.match(s.recorder.lastError, /12:30:00Z: 1 request\(s\) failed, e\.g\. C05USDT/);
    assert.equal(s.data.snapshots, 3601);

    failSymbols.clear();
    clock += MIN;
    await lab.tick();
    s = lab.status();
    assert.equal(s.recorder.lastLiveTs, Date.UTC(2026, 2, 10, 12, 30));
    assert.equal(s.data.snapshots, 3602);
  });

  await t.test('a contract that publishes late: wait, then record without it and say so', async () => {
    // The fake shows a lagging contract's candle only once its open
    // time is `lag` in the past: with 30 min, the 12:30 candle (the one
    // closing at 12:45) appears at 13:00 — after the 5 min patience.
    clock = Date.UTC(2026, 2, 10, 12, 46, 30); // boundary 12:45
    lag.set('C07USDT', 30 * MIN);
    await lab.tick();
    assert.match(lab.status().recorder.lastResult, /waiting for 1 contract\(s\)/);
    assert.equal(lab.status().data.snapshots, 3602);

    clock = Date.UTC(2026, 2, 10, 12, 51, 30);
    await lab.tick();
    const s = lab.status();
    assert.equal(s.recorder.lastLiveTs, Date.UTC(2026, 2, 10, 12, 45));
    assert.match(s.recorder.lastResult, /19\/20 contracts/);
    lag.clear();
  });

  await t.test('a restart reloads everything and keeps the freeze', async () => {
    const again = createLab({ sql, rest, now: () => clock, backfillFrom: '2026-02', log: quietLog });
    await again.tick();
    const s = again.status();
    assert.equal(s.data.snapshots, 3603);
    assert.equal(s.freeze['hex-v1'], freeze);
    assert.equal(s.backfill.state, 'done');
  });

  await t.test('reports and lattice state', async () => {
    await lab.refreshReports({ force: true });
    const r = lab.report('hex');
    assert.equal(r.ok, true);
    assert.equal(r.model.version, 'hex-v1');
    assert.equal(r.freezeTs, freeze);
    assert.equal(r.samples.live.snapshots, 3, '12:15, 12:30 and 12:45 are after the freeze');
    assert.equal(r.hypotheses.list.length, 4);

    const lattice = lab.state();
    assert.equal(lattice.ok, true);
    assert.ok(lattice.cell, lattice.reason);
    assert.ok(lattice.trail.length > 0 && lattice.trail.length <= 96);
    assert.equal(lattice.inputs.coverage, 19);
    assert.ok(Math.abs(Object.values(lattice.occupancy.share).reduce((a, b) => a + b, 0) - 1) < 1e-6);
    assert.equal(lattice.stale, null);

    assert.equal(lab.report('bogus').ok, false);
  });

  await t.test('signed HTTP routes', async () => {
    const SECRET = 'pipe-secret';
    const auth = createDeskAuth({ secret: SECRET, now: () => clock, log: quietLog });
    const server = http.createServer(createApp({ lab, auth }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const headersFor = pathWithQuery => {
      const ts = String(clock);
      const nonce = crypto.randomBytes(16).toString('hex');
      return {
        'x-wm-sig-version': '2',
        'x-wm-timestamp': ts,
        'x-wm-nonce': nonce,
        'x-wm-signature': signV2({ ts, nonce, method: 'GET', pathWithQuery, bodyHash: sha256Hex('') }, SECRET)
      };
    };
    const get = async (path, headers = headersFor(path)) => {
      const res = await fetch(base + path, { headers });
      return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
    };

    try {
      const status = await get('/desk/lab/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.data.snapshots, 3603);
      assert.equal(status.cache, 'private, no-store');

      const state = await get('/desk/lab/state?model=hex');
      assert.equal(state.status, 200);
      assert.ok(state.body.geometry.cells.neutral);

      const linear = await get('/desk/lab/report?model=linear');
      assert.equal(linear.status, 200);
      assert.equal(linear.body.model.version, 'linear-v1');

      const bogus = await get('/desk/lab/report?model=bogus');
      assert.equal(bogus.status, 400);
      assert.match(bogus.body.error, /model: Expected one of hex, hex2, linear/);

      const twice = await get('/desk/lab/report?model=hex&model=linear');
      assert.equal(twice.status, 400);

      const tampered = await get('/desk/lab/report?model=linear', headersFor('/desk/lab/report?model=hex'));
      assert.equal(tampered.status, 401);
      assert.equal(tampered.body.error, 'Invalid signature');

      const h = headersFor('/desk/lab/status');
      assert.equal((await get('/desk/lab/status', h)).status, 200);
      const replay = await get('/desk/lab/status', h);
      assert.equal(replay.status, 401);
      assert.equal(replay.body.error, 'Replayed request');

      assert.equal((await get('/desk/lab/status', {})).status, 401);
      const health=(await get('/health', {})).body;
      assert.equal(health.ok,true);assert.equal(health.ready,true);assert.equal(health.fresh,true);
      assert.equal((await get('/live', {})).body.ok,true);
      const previousClock=clock;clock+=46*MIN;
      assert.equal((await get('/health', {})).status,503);
      assert.equal((await get('/live', {})).status,200);clock=previousClock;
      assert.equal((await get('/nope', {})).status, 404);

      const v2 = await get('/desk/lab/report?model=hex2');
      assert.equal(v2.status, 200);
      assert.equal(v2.body.model.version, 'hex-v2');
      const lattice2 = await get('/desk/lab/state?model=hex2');
      assert.equal(lattice2.status, 200);
      assert.equal(lattice2.body.model, 'hex-v2');
      assert.equal((await get('/desk/lab/state?model=linear')).status, 400, 'there is no lattice for the linear scale');

      const freeze = (await get('/desk/lab/status')).body.freeze;
      assert.ok(Number.isFinite(freeze['hex-v2']), 'hex-v2 has its own freeze');
      assert.ok(Number.isFinite(freeze['hex-v1']));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('an hour on, live snapshots are rebuilt as history and must match', async () => {
    clock = Date.UTC(2026, 2, 10, 14, 1, 30);
    await lab.tick();
    const s = lab.status();
    assert.equal(s.audit.checked, 4, '12:00, 12:15, 12:30 and 12:45');
    assert.equal(s.audit.lastError, null);
    const c = s.data.liveVsBackfill;
    assert.equal(c.compared, 4);
    assert.equal(c.mismatches, 0, 'same candles, same numbers');
    assert.equal(c.coverageDiffs, 1, '12:45 went live without the contract that published late');
    assert.equal(lab._internal.unified().find(x => x.ts === Date.UTC(2026, 2, 10, 12, 45)).coverage, 19, 'what was known live is kept');

    await lab.tick();
    assert.equal(lab.status().audit.checked, 4, 'not again within the hour');
  });
  await t.test('activation-only audit mismatch survives restart and blocks validation',async()=>{
    const ts=Date.UTC(2026,2,10,12,0);
    await sql`UPDATE lab_snapshots SET act_raw=act_raw+1 WHERE ts=${ts} AND source='backfill'`;
    const restarted=createLab({sql,rest,now:()=>clock,backfillFrom:'2026-02',log:quietLog});
    await restarted.tick();
    assert(restarted.status().data.liveVsBackfill.mismatches>=1);
    assert.equal(restarted.report('hex').validation.status,'blocked');
  });
});

test('without a database the lab says so everywhere', async () => {
  const lab = createLab({ sql: null, rest: { stats: () => null }, log: quietLog, backfillFrom: '1999-13' });
  assert.deepEqual(await lab.tick(), { ready: false });
  assert.equal(lab.health().ok, false);
  assert.match(lab.health().reason, /DATABASE_URL is not set/);
  assert.match(lab.report('hex').reason, /DATABASE_URL is not set/);
  assert.match(lab.state().reason, /DATABASE_URL is not set/);
  const st = lab.status();
  assert.match(st.config.warning, /"1999-13" is not YYYY-MM; using 2024-01/);
});

test('a Binance ban survives a restart: the new process does not knock, then resumes on its own', async () => {
  const { market, info } = world();
  let clock = Date.UTC(2026, 2, 10, 12, 5, 30);
  const ban = { until: null };
  const sql = await createTestSql();
  const fake = createFakeBinance(market, { exchangeSymbols: info, now: () => clock, ban });
  const make = () => createLab({
    sql,
    rest: createBinanceRest({ fetcher: fake.fetcher, now: () => clock, sleep: async ms => { clock += ms; }, minGapMs: 0 }),
    now: () => clock,
    backfillFrom: '2026-02',
    log: quietLog
  });

  const first = make();
  await first.tick();
  assert.equal(first.status().backfill.done, 1, 'March first');

  ban.until = clock + 90 * MIN;
  clock += MIN;
  await first.tick();
  let s = first.status();
  assert.match(s.backfill.lastError, /HTTP 418/);
  assert.equal(s.binance.blockedUntil, ban.until, 'Retry-After honoured');

  // a redeploy: new process, new client, same database
  const knocks = fake.calls.length;
  const second = make();
  await second.tick();
  s = second.status();
  assert.equal(fake.calls.length, knocks, 'not one request during the ban');
  assert.equal(s.binance.blockedUntil, ban.until);
  assert.match(s.binance.blockReason, /HTTP 418 \(from before the restart\)/);
  assert.equal(s.backfill.done, 1, 'months finished before the restart still count');
  assert.equal(s.backfill.total, 2);

  clock = ban.until + MIN;
  await second.tick();
  s = second.status();
  assert.equal(s.binance.blockedUntil, null);
  assert.equal(s.backfill.state, 'done');
  assert.equal(s.backfill.done, 2);
  assert.equal(s.recorder.lastLiveTs, Date.UTC(2026, 2, 10, 13, 30));
  assert.equal(s.data.snapshots, 3606, 'the hour lost to the ban is rebuilt: no holes');
  await sql.db.close();
});

test('a bad minute at the database delays the audit by five minutes, not by an hour, and says when it failed', async () => {
  const { market, info } = world();
  let clock = Date.UTC(2026, 2, 10, 12, 5, 30);
  const real = await createTestSql();
  const broken = { on: false };
  const sql = (...args) => {
    if (broken.on) throw new Error('Error connecting to database: TypeError: fetch failed');
    return real(...args);
  };
  sql.db = real.db;

  const fake = createFakeBinance(market, { exchangeSymbols: info, now: () => clock });
  const lab = createLab({
    sql,
    rest: createBinanceRest({ fetcher: fake.fetcher, now: () => clock, sleep: async ms => { clock += ms; }, minGapMs: 0 }),
    now: () => clock,
    backfillFrom: '2026-03',
    log: quietLog
  });

  await lab.tick();                       // first tick: nothing to audit yet
  clock = Date.UTC(2026, 2, 10, 13, 20, 30);
  broken.on = true;
  await lab.tick();
  let s = lab.status();
  assert.match(s.audit.lastError, /Error connecting to database/);
  assert.equal(s.audit.lastErrorAt, clock, 'the error carries its time');
  assert.equal(s.audit.checked, 0);

  broken.on = false;
  clock += 6 * MIN;
  await lab.tick();
  s = lab.status();
  assert.ok(s.audit.checked > 0, 'it tried again within the hour');
  assert.equal(s.audit.lastError, null);
  assert.equal(s.audit.lastErrorAt, null);
  assert.equal(s.data.liveVsBackfill.mismatches, 0);
  await real.db.close();
});
