'use strict';

// ===============================
// LAB v2 — orchestration
//
// One worker loop, one task at a time, in this order every minute:
//   1. record the boundary that just closed          (source: live)
//   2. rebuild boundaries missed in the last 48 h    (source: backfill)
//   3. rebuild one month of history, newest first    (source: backfill)
//   4. once an hour, rebuild a few live snapshots    (source: backfill)
//      from the same candles: the two must match, or history and live
//      are not the same measurement and history cannot nominate
//   5. recompute the reports if the data changed     (at most every 10 min)
//
// Every task writes what it decided, and why, into `status`, so the
// desk can say why something is not happening instead of showing an
// empty panel.
//
// The series lives in memory (aggregates only, ~150 bytes a row), so
// the reports never re-read the database.
// ===============================

const { INTERVAL_MS, snapshotMonth } = require('./metrics');
const { computeUniverses, addMonths, monthStart, monthsBetween } = require('./universe');
const { createStore } = require('./store');
const { createReconstructor, boundariesBetween, lastClosedBoundary } = require('./reconstruct');
const { analyze, clean } = require('./analysis');
const { MODELS, computeStates, buildEpisodes } = require('./models');
const topology = require('./hex-topology');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULTS = {
  tickMs: MINUTE,
  settleMs: 20_000,             // wait this long after a boundary before reading its candle
  livePatienceMs: 5 * MINUTE,   // before this, a partial live snapshot waits for the missing contracts
  gapWindowMs: 48 * HOUR,
  gapRetryMs: HOUR,
  auditEveryMs: HOUR,
  auditLagMs: HOUR,             // audit only snapshots whose candles are long final
  auditBatch: 4,                // four a run keeps pace with four live snapshots an hour
  reportMinIntervalMs: 10 * MINUTE,
  staleAfterMs: 45 * MINUTE,
  backfillFrom: '2024-01'
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const iso = ts => new Date(ts).toISOString().replace('.000Z', 'Z');
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

function lowerBound(series, ts) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createLab({ sql, rest, now = Date.now, backfillFrom, log = console, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const requested = backfillFrom ? String(backfillFrom).trim() : '';
  const fromMonth = MONTH_RE.test(requested) ? requested : cfg.backfillFrom;
  const store = sql ? createStore(sql) : null;

  const status = {
    startedAt: null,
    ready: false,
    fatal: sql ? null : 'DATABASE_URL is not set: the lab cannot store anything',
    config: {
      database: Boolean(sql),
      backfillFrom: fromMonth,
      warning: requested && !MONTH_RE.test(requested)
        ? `LAB_BACKFILL_FROM "${requested}" is not YYYY-MM; using ${fromMonth}`
        : null
    },
    recorder: { lastLiveTs: null, lastRunAt: null, lastResult: null, lastError: null },
    gaps: { lastRunAt: null, filled: 0, failing: 0, lastError: null },
    audit: { lastRunAt: null, checked: 0, lastError: null, lastErrorAt: null },
    backfill: { state: 'waiting', from: fromMonth, total: 0, done: 0, current: null, lastError: null, skipped: {} },
    universe: { month: null, basis: null, symbols: [], survivorship: null, lastError: null },
    reports: { computing: false, computedAt: null, lastError: null }
  };

  const freeze = {};
  const byTs = new Map();          // ts → { live?, backfill? }
  let unifiedCache = [];
  let dirty = false;
  let dataVersion = 0;
  const comparison = { compared: 0, mismatches: 0, coverageDiffs: 0, maxBreadthDiff: 0, maxCloseDiff: 0 };

  const universes = new Map();     // month → stored universe
  const universeFailures = new Map(); // month → permanent failure
  const failedAt = new Map();      // boundary → last failed gap-fill attempt
  const doneMonths = new Set();
  let backfillMonths = null;
  let universesReady = false;

  const reports = {};
  let reportVersion = -1;
  let lastReportAt = 0;
  let lastAuditAt = 0;
  let savedBlockUntil = null;

  let timer = null;
  let running = false;

  // ===============================
  // SERIES
  // ===============================

  function toRow(source, s) {
    return {
      source,
      ts: s.ts,
      month: s.month,
      universeN: s.universeN,
      coverage: s.coverage,
      breadth: s.breadth,
      btcClose: s.btcClose,
      btcC24: s.btcC24 ?? null,
      btcC1: s.btcC1 ?? null,
      actRaw: s.actRaw ?? null,
      rvMed: s.rvMed ?? null
    };
  }

  function put(row) {
    const slot = byTs.get(row.ts) || {};
    slot[row.source] = row;
    byTs.set(row.ts, slot);
  }

  function merge(source, snapshots) {
    for (const s of snapshots) put(toRow(source, s));
    if (snapshots.length) {
      dirty = true;
      dataVersion++;
    }
  }

  // One row per boundary, preferring what was recorded live. Where
  // both exist (the hourly audit makes them), the two must be
  // identical: same closed candles, same numbers. A live snapshot that
  // went without a contract that published late is counted apart —
  // an expected difference, not a broken measurement.
  function unified() {
    if (!dirty) return unifiedCache;

    const out = [];
    let compared = 0;
    let mismatches = 0;
    let coverageDiffs = 0;
    let maxBreadthDiff = 0;
    let maxCloseDiff = 0;

    for (const slot of byTs.values()) {
      if (slot.live && slot.backfill) {
        compared++;
        if (slot.live.coverage !== slot.backfill.coverage) {
          coverageDiffs++;
        } else {
          const db = Math.abs(slot.live.breadth - slot.backfill.breadth);
          const dc = Math.abs(slot.live.btcClose / slot.backfill.btcClose - 1);
          maxBreadthDiff = Math.max(maxBreadthDiff, db);
          maxCloseDiff = Math.max(maxCloseDiff, dc);
          if (db > 1e-12 || dc > 1e-12) mismatches++;
        }
      }
      out.push(slot.live || slot.backfill);
    }

    out.sort((a, b) => a.ts - b.ts);
    Object.assign(comparison, { compared, mismatches, coverageDiffs, maxBreadthDiff, maxCloseDiff });
    unifiedCache = out;
    dirty = false;
    return out;
  }

  const hasTs = ts => byTs.has(ts);

  // ===============================
  // UNIVERSES
  // ===============================

  function remember(stored) {
    const u = { ok: true, ...stored };
    universes.set(u.month, u);
    return u;
  }

  async function getUniverse(month) {
    if (universes.has(month)) return universes.get(month);
    if (universeFailures.has(month)) return universeFailures.get(month);

    const stored = await store.getUniverse(month);
    if (stored) return remember(stored);

    const { results } = await computeUniverses({ rest, months: [month], now: now() });
    return settleUniverse(results.get(month));
  }

  async function settleUniverse(result) {
    if (!result.ok) {
      if (result.permanent) universeFailures.set(result.month, result);
      return result;
    }
    return remember(await store.saveUniverse(result, now()));
  }

  async function ensureUniverses(months) {
    const missing = [];
    for (const m of months) {
      if (universes.has(m) || universeFailures.has(m)) continue;
      const stored = await store.getUniverse(m);
      if (stored) remember(stored);
      else missing.push(m);
    }
    if (!missing.length) return;

    const { results } = await computeUniverses({ rest, months: missing, now: now() });
    for (const m of missing) {
      const u = await settleUniverse(results.get(m));
      if (!u.ok) status.backfill.skipped[m] = u.reason;
    }
  }

  const reconstructor = createReconstructor({ rest, getUniverse });

  // ===============================
  // READY
  // ===============================

  async function ensureReady() {
    if (status.ready) return true;
    if (!store) return false;

    try {
      await store.ensure();
      const t = now();

      for (const m of Object.values(MODELS)) {
        const stored = await store.ensureMeta(`freeze:${m.version}`, { ts: t }, t);
        freeze[m.name] = Number(stored?.ts);
      }

      const done = await store.getMeta('backfill:done');
      if (Array.isArray(done)) for (const m of done) doneMonths.add(m);

      // A ban Binance sent before a restart still stands
      const block = await store.getMeta('binance:block');
      const until = Number(block?.until);
      if (until > t && typeof rest?.blockUntil === 'function') {
        rest.blockUntil(until, `${block.reason || 'Binance block'} (from before the restart)`);
        savedBlockUntil = until;
      }

      const rows = await store.loadSeries();
      for (const r of rows) put(r);
      dirty = true;
      dataVersion++;

      let lastLive = null;
      for (const r of rows) if (r.source === 'live' && (lastLive === null || r.ts > lastLive)) lastLive = r.ts;
      status.recorder.lastLiveTs = lastLive;

      status.ready = true;
      status.fatal = null;
      log.log(`[Lab] ready — ${rows.length} stored snapshot rows, history from ${fromMonth}`);
      return true;
    } catch (err) {
      status.fatal = `database: ${err.message}`;
      log.error('[Lab] not ready:', err.message);
      return false;
    }
  }

  // ===============================
  // TASKS
  // ===============================

  async function recordLive() {
    const t = now();
    const T = lastClosedBoundary(t, cfg.settleMs);
    status.recorder.lastRunAt = t;
    if (hasTs(T)) return;

    const { snapshots, invalid } = await reconstructor.build([T]);

    if (snapshots.length) {
      const s = snapshots[0];
      if (s.missing && t - T < cfg.livePatienceMs) {
        status.recorder.lastResult = `waiting for ${s.missing.length} contract(s) to publish the ${iso(T)} candle`;
        return;
      }
      await store.upsertSnapshots('live', [s], t);
      merge('live', [s]);
      status.recorder.lastLiveTs = T;
      status.recorder.lastResult = `recorded ${iso(T)} — ${s.coverage}/${s.universeN} contracts`;
      status.recorder.lastError = null;
      return;
    }

    status.recorder.lastError = `${iso(T)}: ${invalid[0] ? invalid[0].reason : 'no snapshot built'}`;
  }

  async function fillGaps() {
    const t = now();
    const newest = lastClosedBoundary(t, cfg.settleMs) - INTERVAL_MS; // the newest belongs to the live recorder
    const oldest = Math.max(newest - cfg.gapWindowMs + INTERVAL_MS, monthStart(fromMonth) + INTERVAL_MS);
    const missing = boundariesBetween(oldest, newest)
      .filter(T => !hasTs(T) && !(failedAt.get(T) > t - cfg.gapRetryMs));

    status.gaps.lastRunAt = t;
    if (!missing.length) return;

    const { snapshots, invalid } = await reconstructor.build(missing);
    if (snapshots.length) {
      await store.upsertSnapshots('backfill', snapshots, t);
      merge('backfill', snapshots);
    }
    for (const x of invalid) failedAt.set(x.ts, t);

    status.gaps.filled += snapshots.length;
    status.gaps.failing = invalid.length;
    status.gaps.lastError = invalid.length ? `${iso(invalid[0].ts)}: ${invalid[0].reason}` : null;
  }

  // The newest live snapshots without a rebuilt twin, rebuilt the way
  // history is. Stored as backfill rows, so the check survives restarts.
  async function auditLive() {
    const t = now();
    if (t - lastAuditAt < cfg.auditEveryMs) return;
    lastAuditAt = t;
    status.audit.lastRunAt = t;

    const due = [];
    for (const [ts, slot] of byTs) {
      if (slot.live && !slot.backfill && ts <= t - cfg.auditLagMs) due.push(ts);
    }
    if (!due.length) return;

    const pick = due.sort((a, b) => b - a).slice(0, cfg.auditBatch).sort((a, b) => a - b);

    let snapshots;
    let invalid;
    try {
      ({ snapshots, invalid } = await reconstructor.build(pick));
      if (snapshots.length) {
        await store.upsertSnapshots('backfill', snapshots, t);
        merge('backfill', snapshots);
      }
    } catch (err) {
      // Binance or the database had a bad minute: try again in five,
      // not in an hour
      lastAuditAt = t - cfg.auditEveryMs + 5 * MINUTE;
      throw err;
    }

    status.audit.checked += snapshots.length;
    status.audit.lastError = invalid.length ? `${iso(invalid[0].ts)}: ${invalid[0].reason}` : null;
    status.audit.lastErrorAt = invalid.length ? t : null;
  }

  async function backfillStep() {
    const b = status.backfill;
    if (b.state === 'done') return;

    const t = now();
    const currentMonth = snapshotMonth(lastClosedBoundary(t, cfg.settleMs));

    if (!backfillMonths) {
      backfillMonths = fromMonth <= currentMonth ? monthsBetween(fromMonth, currentMonth).reverse() : [];
      b.total = backfillMonths.length;
      b.done = backfillMonths.filter(m => doneMonths.has(m)).length; // months finished before a restart
    }

    if (!universesReady) {
      b.state = 'universes';
      await ensureUniverses(backfillMonths);
      universesReady = true;
    }

    const next = backfillMonths.find(m => !doneMonths.has(m));
    if (!next) {
      b.state = 'done';
      b.current = null;
      b.done = b.total;
      return;
    }

    b.state = 'running';
    b.current = next;

    const first = monthStart(next) + INTERVAL_MS;
    const last = Math.min(monthStart(addMonths(next, 1)), lastClosedBoundary(t, cfg.settleMs));
    const Ts = boundariesBetween(first, last).filter(T => !hasTs(T));

    if (Ts.length) {
      const { snapshots, invalid } = await reconstructor.build(Ts);
      if (snapshots.length) {
        await store.upsertSnapshots('backfill', snapshots, now());
        merge('backfill', snapshots);
      }

      const retryable = invalid.filter(x => x.retryable);
      if (retryable.length) {
        b.lastError = `${next}: ${retryable.length} boundaries will be retried — ${retryable[0].reason}`;
        return; // the month stays open
      }
      if (invalid.length) b.skipped[next] = `${invalid.length} boundaries skipped — e.g. ${invalid[0].reason}`;
    }

    doneMonths.add(next);
    await store.setMeta('backfill:done', [...doneMonths].sort(), now());
    b.done = backfillMonths.filter(m => doneMonths.has(m)).length;
    b.current = backfillMonths.find(m => !doneMonths.has(m)) || null; // the month up next, not the one just finished
    b.lastError = null;

    if (b.done === b.total) {
      b.state = 'done';
      b.current = null;
    }
  }

  // Keep Binance's block across restarts (read back in ensureReady)
  async function persistBlock() {
    const s = typeof rest?.stats === 'function' ? rest.stats() : null;
    const until = s && Number.isFinite(s.blockedUntil) ? s.blockedUntil : null;
    if (!until || until === savedBlockUntil) return;
    savedBlockUntil = until;
    await store.setMeta('binance:block', { until, reason: s.blockReason }, now());
  }

  function contextForReport() {
    return {
      backfill: {
        from: fromMonth,
        done: status.backfill.done,
        total: status.backfill.total,
        complete: status.backfill.state === 'done'
      },
      liveVsBackfill: { ...comparison },
      survivorship:
        'Months ranked after they ended choose among contracts that still trade today; months ranked live are point-in-time.'
    };
  }

  async function refreshReports({ force = false } = {}) {
    if (!status.ready) return;
    if (!force && reportVersion === dataVersion) return;

    const t = now();
    if (!force && lastReportAt && t - lastReportAt < cfg.reportMinIntervalMs) return;

    const series = unified();
    if (!series.length) return;

    status.reports.computing = true;
    const version = dataVersion;

    try {
      const context = contextForReport();
      for (const name of Object.keys(MODELS)) {
        await yieldToLoop();
        reports[name] = analyze({ series, modelName: name, freezeTs: freeze[name], context, now: t });
      }
      reportVersion = version;
      lastReportAt = t;
      status.reports.computedAt = t;
      status.reports.lastError = null;
    } catch (err) {
      status.reports.lastError = err.message;
      log.error('[Lab] report failed:', err);
    } finally {
      status.reports.computing = false;
    }
  }

  function updateUniverseStatus() {
    const month = snapshotMonth(lastClosedBoundary(now(), cfg.settleMs));
    const u = universes.get(month);
    if (u) {
      Object.assign(status.universe, {
        month,
        basis: u.basis,
        symbols: u.symbols,
        survivorship: u.survivorship,
        lastError: null
      });
    } else {
      status.universe.month = month;
      status.universe.lastError = universeFailures.get(month)?.reason || null;
    }
  }

  // Errors carry the time they happened: a task that runs once an hour
  // would otherwise show an old failure as if it were current
  async function step(name, fn) {
    try {
      await fn();
    } catch (err) {
      status[name].lastError = err.message;
      status[name].lastErrorAt = now();
      log.error(`[Lab] ${name}: ${err.message}`);
    }
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      if (!(await ensureReady())) return { ready: false };
      await step('recorder', recordLive);
      await step('gaps', fillGaps);
      await step('audit', auditLive);
      await step('backfill', backfillStep);
      try {
        await persistBlock();
      } catch (err) {
        log.error(`[Lab] could not save the Binance block: ${err.message}`);
      }
      await refreshReports();
      updateUniverseStatus();
      return { ready: true };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    status.startedAt = now();
    const run = () => tick().catch(err => log.error('[Lab] tick crashed:', err));
    run();
    timer = setInterval(run, cfg.tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ===============================
  // READ API (for the desk routes)
  // ===============================

  function publicStatus() {
    const series = unified();
    let live = 0;
    let backfill = 0;
    for (const slot of byTs.values()) {
      if (slot.live) live++;
      if (slot.backfill) backfill++;
    }

    return clean({
      ok: true,
      service: { startedAt: status.startedAt, ready: status.ready, fatal: status.fatal },
      config: { ...status.config },
      freeze: Object.fromEntries(Object.values(MODELS).map(m => [m.version, freeze[m.name] ?? null])),
      data: {
        snapshots: series.length,
        live,
        backfill,
        first: series.length ? series[0].ts : null,
        last: series.length ? series[series.length - 1].ts : null,
        liveVsBackfill: { ...comparison }
      },
      recorder: { ...status.recorder },
      gaps: { ...status.gaps },
      audit: { ...status.audit },
      backfill: { ...status.backfill, skipped: { ...status.backfill.skipped } },
      universe: { ...status.universe, symbols: [...status.universe.symbols] },
      reports: { ...status.reports },
      binance: typeof rest?.stats === 'function' ? rest.stats() : null
    });
  }

  function report(modelName) {
    if (!MODELS[modelName]) return { ok: false, error: `Unknown model: ${modelName}` };
    if (reports[modelName]) return reports[modelName];
    return {
      ok: true,
      pending: true,
      reason: status.fatal || (status.ready ? 'The first report is computed once snapshots exist.' : 'The lab is starting.')
    };
  }

  // The lattice: where the market is now, where it has been today,
  // and how the last 30 days split across the cells.
  function state(modelName = 'hex') {
    const model = MODELS[modelName];
    if (!model || modelName === 'linear') return { ok: false, error: `No lattice for model: ${modelName}` };
    const geometry = topology.geometry();
    const series = unified();

    if (!series.length) {
      return clean({
        ok: true,
        model: model.version,
        cell: null,
        reason: status.fatal || 'No snapshots yet — the first one is recorded within 15 minutes of startup.',
        point: null,
        trail: [],
        occupancy: null,
        geometry
      });
    }

    const lastTs = series[series.length - 1].ts;
    const slice = series.slice(lowerBound(series, lastTs - (model.params.windowDays + 31) * DAY));
    const windowFrom = lastTs - 30 * DAY;
    const indices = [];
    for (let i = 0; i < slice.length; i++) if (slice[i].ts > windowFrom) indices.push(i);

    const states = computeStates(slice, modelName, { indices });
    const recent = indices.map(i => states[i]);
    const latest = states[slice.length - 1];
    const snap = slice[slice.length - 1];

    const episodes = buildEpisodes(recent, { minDwell: model.params.minDwell });
    const lastEpisode = episodes[episodes.length - 1];

    const counts = {};
    let known = 0;
    for (const s of recent) {
      if (!s.mood) continue;
      counts[s.mood] = (counts[s.mood] || 0) + 1;
      known++;
    }
    const share = {};
    for (const mood of topology.ALL) share[mood] = known ? (counts[mood] || 0) / known : 0;

    const age = now() - lastTs;

    return clean({
      ok: true,
      model: model.version,
      ts: lastTs,
      cell: latest.mood,
      reason: latest.mood ? null : latest.reason,
      point: latest.mood ? { x: latest.x, y: latest.y } : null,
      confirmed: lastEpisode ? { cell: lastEpisode.mood, since: recent[lastEpisode.confirmIdx].ts } : null,
      inputs: {
        breadth: snap.breadth,
        up: Math.round(snap.breadth * snap.coverage),
        coverage: snap.coverage,
        universeN: snap.universeN,
        activationPct: Number.isFinite(latest.activationPct) ? latest.activationPct : null
      },
      stale: age > cfg.staleAfterMs ? `The latest snapshot is ${Math.round(age / MINUTE)} minutes old` : null,
      trail: recent
        .filter(s => s.mood && s.ts > lastTs - DAY)
        .map(s => ({ ts: s.ts, x: s.x, y: s.y, cell: s.mood })),
      occupancy: { windowDays: 30, samples: known, share },
      geometry
    });
  }

  function health() {
    if (status.fatal) return { ok: false, reason: status.fatal };
    return { ok: true, ready: status.ready };
  }

  return {
    start,
    stop,
    tick,
    refreshReports,
    status: publicStatus,
    report,
    state,
    health,
    _internal: { unified, freeze, store, universes }
  };
}

module.exports = { createLab, DEFAULTS };
