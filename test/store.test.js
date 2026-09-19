'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lab/store');
const { createTestSql } = require('./helpers');

const I = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function snap(i, extra = {}) {
  return {
    ts: T0 + i * I,
    month: '2026-01',
    universeN: 20,
    coverage: 19,
    breadth: (i % 20) / 19,
    btcClose: 50000 + i,
    btcC24: 1.5,
    btcC1: -0.25,
    actRaw: 0.8,
    rvMed: 1.1,
    coins: [['BTCUSDT', 1.5, -0.25, 1.1, 0.8]],
    missing: [['XYZUSDT', 'no candles']],
    ...extra
  };
}

test('store: batches, paging, both sources, idempotent schema', async () => {
  const sql = await createTestSql();

  // The old table must come out untouched
  await sql`CREATE TABLE emotion_lab (id serial PRIMARY KEY, note text)`;
  await sql`INSERT INTO emotion_lab (note) VALUES ('old bot row')`;

  const store = createStore(sql);
  await store.ensure();
  await store.ensure();

  const many = Array.from({ length: 1200 }, (_, i) => snap(i + 1));
  await store.upsertSnapshots('backfill', many, 1);
  await store.upsertSnapshots('live', [snap(5, { breadth: 0.5 })], 2);

  const rows = await store.loadSeries({ pageSize: 500 });
  assert.equal(rows.length, 1201);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    assert.ok(a.ts < b.ts || (a.ts === b.ts && a.source < b.source), 'ordered by (ts, source)');
  }
  const at5 = rows.filter(r => r.ts === T0 + 5 * I);
  assert.deepEqual(at5.map(r => r.source), ['backfill', 'live']);
  assert.equal(typeof at5[0].ts, 'number');
  assert.equal(at5[1].breadth, 0.5);

  // Upsert replaces the values of the same (source, ts)
  await store.upsertSnapshots('backfill', [snap(7, { breadth: 0.25, actRaw: null })], 3);
  const again = await store.loadSeries();
  const at7 = again.find(r => r.ts === T0 + 7 * I && r.source === 'backfill');
  assert.equal(at7.breadth, 0.25);
  assert.equal(at7.actRaw, null);
  assert.equal(again.length, 1201);

  const detail = await store.snapshotDetail(T0 + 5 * I);
  assert.equal(detail.source, 'live', 'live wins');
  assert.deepEqual(detail.coins, [['BTCUSDT', 1.5, -0.25, 1.1, 0.8]]);
  assert.deepEqual(detail.missing, [['XYZUSDT', 'no candles']]);

  const old = await sql`SELECT note FROM emotion_lab`;
  assert.deepEqual(old, [{ note: 'old bot row' }]);
});

test('store: a month universe and the freeze are written once', async () => {
  const sql = await createTestSql();
  const store = createStore(sql);

  const first = { month: '2026-02', basis: '2026-01', method: 'm', symbols: ['BTCUSDT', 'ETHUSDT'], candidates: 300, survivorship: 'point-in-time' };
  const saved = await store.saveUniverse(first, 10);
  assert.deepEqual(saved.symbols, ['BTCUSDT', 'ETHUSDT']);

  const second = await store.saveUniverse({ ...first, symbols: ['BTCUSDT', 'SOLUSDT'] }, 20);
  assert.deepEqual(second.symbols, ['BTCUSDT', 'ETHUSDT'], 'first write wins');
  assert.deepEqual(await store.listUniverseMonths(), ['2026-02']);
  assert.equal(await store.getUniverse('2026-03'), null);

  assert.deepEqual(await store.ensureMeta('freeze:hex-v1', { ts: 111 }, 1), { ts: 111 });
  assert.deepEqual(await store.ensureMeta('freeze:hex-v1', { ts: 222 }, 2), { ts: 111 }, 'the freeze never moves');

  await store.setMeta('backfill:done', ['2026-01'], 3);
  await store.setMeta('backfill:done', ['2026-01', '2026-02'], 4);
  assert.deepEqual(await store.getMeta('backfill:done'), ['2026-01', '2026-02']);
  assert.equal(await store.getMeta('missing'), null);
});
