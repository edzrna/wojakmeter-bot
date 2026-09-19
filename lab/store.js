'use strict';

// ===============================
// LAB STORE — Neon / Postgres
//
// Tables (created on first start, never dropped):
//   lab_snapshots  one row per (source, 15 m boundary)
//   lab_universe   the contracts of each month, frozen once chosen
//   lab_meta       freeze timestamps and history-rebuild progress
//
// The old emotion_lab table is not touched: it stays as the record of
// what the old bot saw.
//
// Only tagged-template queries, so it works with any version of the
// Neon driver. Bulk writes pass one JSON document and let Postgres
// unpack it (jsonb_to_recordset): one round trip per 500 rows.
// ===============================

const BATCH = 500;
const PAGE = 20_000;

function num(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function rowToSnapshot(r) {
  return {
    source: r.source,
    ts: Number(r.ts),
    month: r.month,
    universeN: Number(r.universe_n),
    coverage: Number(r.coverage),
    breadth: Number(r.breadth),
    btcClose: Number(r.btc_close),
    btcC24: num(r.btc_c24),
    btcC1: num(r.btc_c1),
    actRaw: num(r.act_raw),
    rvMed: num(r.rv_med)
  };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function createStore(sql) {
  let ready = null;

  function ensure() {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS lab_snapshots (
            source      TEXT NOT NULL CHECK (source IN ('live', 'backfill')),
            ts          BIGINT NOT NULL,
            month       TEXT NOT NULL,
            universe_n  SMALLINT NOT NULL,
            coverage    SMALLINT NOT NULL,
            breadth     DOUBLE PRECISION NOT NULL,
            btc_close   DOUBLE PRECISION NOT NULL,
            btc_c24     DOUBLE PRECISION,
            btc_c1      DOUBLE PRECISION,
            act_raw     DOUBLE PRECISION,
            rv_med      DOUBLE PRECISION,
            coins       TEXT,
            missing     TEXT,
            created_at  BIGINT NOT NULL,
            PRIMARY KEY (source, ts)
          )
        `;
        await sql`CREATE INDEX IF NOT EXISTS lab_snapshots_ts ON lab_snapshots (ts)`;
        await sql`
          CREATE TABLE IF NOT EXISTS lab_universe (
            month         TEXT PRIMARY KEY,
            basis         TEXT NOT NULL,
            method        TEXT NOT NULL,
            symbols       JSONB NOT NULL,
            candidates    INTEGER,
            survivorship  TEXT NOT NULL,
            created_at    BIGINT NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS lab_meta (
            key         TEXT PRIMARY KEY,
            value       JSONB NOT NULL,
            updated_at  BIGINT NOT NULL
          )
        `;
      })().catch(err => {
        ready = null; // let the next call try again
        throw err;
      });
    }
    return ready;
  }

  async function upsertSnapshots(source, snapshots, createdAt) {
    await ensure();
    for (let i = 0; i < snapshots.length; i += BATCH) {
      const chunk = snapshots.slice(i, i + BATCH).map(s => ({
        source,
        ts: s.ts,
        month: s.month,
        universe_n: s.universeN,
        coverage: s.coverage,
        breadth: s.breadth,
        btc_close: s.btcClose,
        btc_c24: s.btcC24,
        btc_c1: s.btcC1,
        act_raw: s.actRaw,
        rv_med: s.rvMed,
        coins: JSON.stringify(s.coins),
        missing: s.missing ? JSON.stringify(s.missing) : null,
        created_at: createdAt
      }));

      await sql`
        INSERT INTO lab_snapshots
          (source, ts, month, universe_n, coverage, breadth, btc_close, btc_c24, btc_c1,
           act_raw, rv_med, coins, missing, created_at)
        SELECT source, ts, month, universe_n, coverage, breadth, btc_close, btc_c24, btc_c1,
               act_raw, rv_med, coins, missing, created_at
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(
          source text, ts bigint, month text, universe_n smallint, coverage smallint,
          breadth double precision, btc_close double precision, btc_c24 double precision,
          btc_c1 double precision, act_raw double precision, rv_med double precision,
          coins text, missing text, created_at bigint)
        ON CONFLICT (source, ts) DO UPDATE SET
          month = EXCLUDED.month,
          universe_n = EXCLUDED.universe_n,
          coverage = EXCLUDED.coverage,
          breadth = EXCLUDED.breadth,
          btc_close = EXCLUDED.btc_close,
          btc_c24 = EXCLUDED.btc_c24,
          btc_c1 = EXCLUDED.btc_c1,
          act_raw = EXCLUDED.act_raw,
          rv_med = EXCLUDED.rv_med,
          coins = EXCLUDED.coins,
          missing = EXCLUDED.missing
      `;
    }
  }

  // Aggregates only (no per-coin payload), paged by (ts, source)
  async function loadSeries({ fromTs = 0, pageSize = PAGE } = {}) {
    await ensure();
    const out = [];
    let cursorTs = fromTs - 1;
    let cursorSource = '';

    for (;;) {
      const rows = await sql`
        SELECT source, ts, month, universe_n, coverage, breadth, btc_close,
               btc_c24, btc_c1, act_raw, rv_med
        FROM lab_snapshots
        WHERE (ts, source) > (${cursorTs}, ${cursorSource})
        ORDER BY ts, source
        LIMIT ${pageSize}
      `;
      for (const r of rows) out.push(rowToSnapshot(r));
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      cursorTs = Number(last.ts);
      cursorSource = last.source;
    }

    return out;
  }

  async function snapshotDetail(ts) {
    await ensure();
    const rows = await sql`
      SELECT source, ts, coins, missing FROM lab_snapshots
      WHERE ts = ${ts}
      ORDER BY source DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    return {
      source: rows[0].source,
      ts: Number(rows[0].ts),
      coins: parseJson(rows[0].coins, []),
      missing: parseJson(rows[0].missing, null)
    };
  }

  async function getUniverse(month) {
    await ensure();
    const rows = await sql`SELECT * FROM lab_universe WHERE month = ${month}`;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      month: r.month,
      basis: r.basis,
      method: r.method,
      symbols: parseJson(r.symbols, []),
      candidates: num(r.candidates),
      survivorship: r.survivorship,
      createdAt: Number(r.created_at)
    };
  }

  async function listUniverseMonths() {
    await ensure();
    const rows = await sql`SELECT month FROM lab_universe ORDER BY month`;
    return rows.map(r => r.month);
  }

  // First write wins: a month's universe never changes once chosen
  async function saveUniverse(u, createdAt) {
    await ensure();
    await sql`
      INSERT INTO lab_universe (month, basis, method, symbols, candidates, survivorship, created_at)
      VALUES (${u.month}, ${u.basis}, ${u.method}, ${JSON.stringify(u.symbols)}::jsonb,
              ${u.candidates}, ${u.survivorship}, ${createdAt})
      ON CONFLICT (month) DO NOTHING
    `;
    return getUniverse(u.month);
  }

  async function getMeta(key) {
    await ensure();
    const rows = await sql`SELECT value FROM lab_meta WHERE key = ${key}`;
    return rows.length ? parseJson(rows[0].value, null) : null;
  }

  async function setMeta(key, value, updatedAt) {
    await ensure();
    await sql`
      INSERT INTO lab_meta (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${updatedAt})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }

  // Insert if absent, then return whatever is stored (the first value wins)
  async function ensureMeta(key, value, updatedAt) {
    await ensure();
    await sql`
      INSERT INTO lab_meta (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${updatedAt})
      ON CONFLICT (key) DO NOTHING
    `;
    return getMeta(key);
  }

  return {
    ensure,
    upsertSnapshots,
    loadSeries,
    snapshotDetail,
    getUniverse,
    listUniverseMonths,
    saveUniverse,
    getMeta,
    setMeta,
    ensureMeta
  };
}

module.exports = { createStore, rowToSnapshot, BATCH, PAGE };
