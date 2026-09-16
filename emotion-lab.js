'use strict';

// ===============================
// WOJAKMETER — EMOTION LAB
//
// The point of this module is not to trade. It is to find out
// whether the emotion spectrum predicts anything at all.
//
// Right now TRANSITION_RULES assigns leverage 3 to neutral→optimism
// and leverage 4 to optimism→content. Those numbers came from
// reasoning, not measurement. This module replaces the guess with
// a number you can defend.
//
// What it does:
//   1. Persists every emotion snapshot and transition
//   2. Comes back later and records what price actually did
//      at +1h, +4h and +24h
//   3. Computes expectancy per transition with sample size
//   4. Refuses to call anything an edge below a minimum sample
//
// Storage: Neon/Postgres if DATABASE_URL is set, otherwise a local
// JSONL file. On Railway the file does not survive a redeploy, so
// use Postgres for anything you intend to trust.
// ===============================

const fs = require('fs');
const path = require('path');

const HORIZONS = [
  { key: 'h1',  ms: 60 * 60 * 1000 },
  { key: 'h4',  ms: 4 * 60 * 60 * 1000 },
  { key: 'h24', ms: 24 * 60 * 60 * 1000 }
];

// Below this, any win rate is noise. 30 is already generous —
// at n=30 a 60% win rate still has a confidence interval wide
// enough to include 40%.
const MIN_SAMPLE = 30;

const FILE_PATH = process.env.LAB_FILE || path.join(process.cwd(), 'emotion-lab.jsonl');

// ===============================
// STORAGE
// ===============================

function createFileStore() {
  function readAll() {
    if (!fs.existsSync(FILE_PATH)) return [];

    return fs.readFileSync(FILE_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  return {
    kind: 'file',

    async append(record) {
      fs.appendFileSync(FILE_PATH, JSON.stringify(record) + '\n');
    },

    async pendingOutcomes(now) {
      return readAll().filter(r =>
        r.type === 'transition' &&
        HORIZONS.some(h => !r.outcomes?.[h.key] && now - r.ts >= h.ms)
      );
    },

    // Rewrites the whole file. Fine at research volume (a few
    // thousand rows); swap to Postgres before it matters.
    async update(id, outcomes) {
      const rows = readAll().map(r =>
        r.id === id ? { ...r, outcomes: { ...r.outcomes, ...outcomes } } : r
      );

      fs.writeFileSync(FILE_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    },

    async transitions() {
      return readAll().filter(r => r.type === 'transition');
    }
  };
}

function createPostgresStore(sql) {
  let ready = false;

  async function ensure() {
    if (ready) return;

    await sql`
      CREATE TABLE IF NOT EXISTS emotion_lab (
        id           TEXT PRIMARY KEY,
        ts           BIGINT NOT NULL,
        type         TEXT NOT NULL,
        symbol       TEXT,
        from_mood    TEXT,
        to_mood      TEXT,
        transition   TEXT,
        price        DOUBLE PRECISION,
        breadth      DOUBLE PRECISION,
        btc_change1h DOUBLE PRECISION,
        dwell_ms     BIGINT,
        velocity     DOUBLE PRECISION,
        divergence   DOUBLE PRECISION,
        context      JSONB,
        outcomes     JSONB DEFAULT '{}'::jsonb
      )
    `;

    await sql`CREATE INDEX IF NOT EXISTS emotion_lab_ts ON emotion_lab (ts)`;
    await sql`CREATE INDEX IF NOT EXISTS emotion_lab_tr ON emotion_lab (transition)`;

    ready = true;
  }

  return {
    kind: 'postgres',

    async append(r) {
      await ensure();

      await sql`
        INSERT INTO emotion_lab
          (id, ts, type, symbol, from_mood, to_mood, transition,
           price, breadth, btc_change1h, dwell_ms, velocity, divergence, context)
        VALUES
          (${r.id}, ${r.ts}, ${r.type}, ${r.symbol || null},
           ${r.fromMood || null}, ${r.toMood || null}, ${r.transition || null},
           ${r.price ?? null}, ${r.breadth ?? null}, ${r.btcChange1h ?? null},
           ${r.dwellMs ?? null}, ${r.velocity ?? null}, ${r.divergence ?? null},
           ${JSON.stringify(r.context || {})})
        ON CONFLICT (id) DO NOTHING
      `;
    },

    async pendingOutcomes(now) {
      const oldest = HORIZONS[0].ms;

      const rows = await sql`
        SELECT * FROM emotion_lab
        WHERE type = 'transition' AND ts <= ${now - oldest}
        ORDER BY ts ASC
        LIMIT 500
      `;

      return rows.filter(r =>
        HORIZONS.some(h => !r.outcomes?.[h.key] && now - Number(r.ts) >= h.ms)
      ).map(r => ({ ...r, ts: Number(r.ts) }));
    },

    async update(id, outcomes) {
      await sql`
        UPDATE emotion_lab
        SET outcomes = outcomes || ${JSON.stringify(outcomes)}::jsonb
        WHERE id = ${id}
      `;
    },

    async transitions() {
      const rows = await sql`
        SELECT * FROM emotion_lab WHERE type = 'transition' ORDER BY ts ASC
      `;
      return rows.map(r => ({ ...r, ts: Number(r.ts) }));
    }
  };
}

// ===============================
// DERIVED SIGNALS
// The parts that are NOT just breadth relabelled
// ===============================

// Price rising while breadth falls is distribution: the index is
// carried by fewer and fewer names. The reverse is accumulation.
// This is the one number here that price alone cannot give you.
function computeDivergence(btcChange1h, breadthDelta) {
  if (!Number.isFinite(btcChange1h) || !Number.isFinite(breadthDelta)) return null;

  const priceDir   = Math.sign(btcChange1h);
  const breadthDir = Math.sign(breadthDelta);

  if (priceDir === 0 || breadthDir === 0) return 0;
  if (priceDir === breadthDir) return 0;

  // Magnitude of the disagreement
  return priceDir * Math.min(1, Math.abs(breadthDelta) * 5) * -1;
}

// How violently the market changed emotional state.
// Fast moves into extremes tend to be fragile.
function computeVelocity(dwellMs, moodDistance) {
  if (!dwellMs || dwellMs <= 0) return null;

  const minutes = dwellMs / 60000;
  return Number((moodDistance / Math.max(1, minutes) * 60).toFixed(4));
}

const MOOD_ORDER = [
  'frustration', 'concern', 'doubt', 'neutral', 'optimism', 'content', 'euphoria'
];

function moodDistance(from, to) {
  const a = MOOD_ORDER.indexOf(from);
  const b = MOOD_ORDER.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return b - a;
}

// ===============================
// LAB
// ===============================

function createLab({ store, getPrice, now = Date.now } = {}) {
  let lastState = null;

  async function recordSnapshot(summary) {
    const ts = now();
    const mood = summary.marketMood;

    const breadthDelta = lastState
      ? summary.breadth - lastState.breadth
      : 0;

    const divergence = computeDivergence(summary.btcChange1h, breadthDelta);

    // No change in mood — just track it and move on
    if (lastState && lastState.mood === mood) {
      lastState.breadth = summary.breadth;
      return null;
    }

    const dwellMs = lastState ? ts - lastState.since : null;
    const distance = lastState ? moodDistance(lastState.mood, mood) : 0;

    const record = {
      id: `${ts}-${mood}`,
      ts,
      type: lastState ? 'transition' : 'init',
      symbol: 'BTCUSDT',
      fromMood: lastState?.mood || null,
      toMood: mood,
      transition: lastState ? `${lastState.mood}→${mood}` : null,
      price: summary.coins?.find(c => c.symbol === 'BTCUSDT')?.price ?? null,
      breadth: summary.breadth,
      btcChange1h: summary.btcChange1h,
      dwellMs,
      velocity: computeVelocity(dwellMs, Math.abs(distance)),
      divergence,
      context: {
        strategyScore: summary.strategyScore,
        coverage: summary.coverage,
        alignedCount: summary.alignedCount,
        conflict: summary.conflict,
        direction: summary.direction
      },
      outcomes: {}
    };

    await store.append(record);

    lastState = { mood, since: ts, breadth: summary.breadth };

    return record;
  }

  // Comes back later and writes down what actually happened.
  // This is the half that turns a log into evidence.
  async function resolveOutcomes() {
    const ts = now();
    const pending = await store.pendingOutcomes(ts);
    let resolved = 0;

    for (const row of pending) {
      const entryPrice = Number(row.price);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      const due = HORIZONS.filter(h =>
        !row.outcomes?.[h.key] && ts - row.ts >= h.ms
      );

      if (!due.length) continue;

      let current;
      try {
        current = await getPrice(row.symbol || 'BTCUSDT');
      } catch {
        continue;
      }

      if (!Number.isFinite(current) || current <= 0) continue;

      const patch = {};
      for (const h of due) {
        patch[h.key] = Number(((current / entryPrice - 1) * 100).toFixed(4));
      }

      await store.update(row.id, patch);
      resolved++;
    }

    return { checked: pending.length, resolved };
  }

  // ===============================
  // ANALYSIS
  // ===============================

  async function analyze({ horizon = 'h4', minSample = MIN_SAMPLE } = {}) {
    const rows = (await store.transitions())
      .filter(r => Number.isFinite(Number(r.outcomes?.[horizon])));

    const groups = new Map();

    for (const r of rows) {
      const key = r.transition;
      if (!key) continue;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Number(r.outcomes[horizon]));
    }

    const results = [];

    for (const [transition, returns] of groups) {
      const n = returns.length;
      const wins = returns.filter(x => x > 0).length;
      const mean = returns.reduce((s, x) => s + x, 0) / n;

      const variance = n > 1
        ? returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
        : 0;

      const sd = Math.sqrt(variance);
      const stdErr = n > 0 ? sd / Math.sqrt(n) : 0;

      // t-statistic against the null hypothesis "mean return is zero"
      const t = stdErr > 0 ? mean / stdErr : 0;

      const avgWin = wins
        ? returns.filter(x => x > 0).reduce((s, x) => s + x, 0) / wins
        : 0;

      const losses = n - wins;
      const avgLoss = losses
        ? Math.abs(returns.filter(x => x <= 0).reduce((s, x) => s + x, 0) / losses)
        : 0;

      const winRate = n ? wins / n : 0;
      const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

      results.push({
        transition,
        n,
        winRate: Number((winRate * 100).toFixed(1)),
        meanReturn: Number(mean.toFixed(4)),
        sd: Number(sd.toFixed(4)),
        tStat: Number(t.toFixed(2)),
        expectancy: Number(expectancy.toFixed(4)),
        // |t| > 2 is the rough two-sigma bar. It is a screen,
        // not proof — testing many transitions inflates false positives.
        significant: n >= minSample && Math.abs(t) > 2,
        verdict:
          n < minSample
            ? `insufficient sample (${n}/${minSample})`
            : Math.abs(t) <= 2
              ? 'indistinguishable from noise'
              : mean > 0 ? 'positive edge candidate' : 'negative edge candidate'
      });
    }

    return results.sort((a, b) => Math.abs(b.tStat) - Math.abs(a.tStat));
  }

  // Divergence is the hypothesis most worth isolating, because it
  // is the only input here that price action alone cannot produce.
  async function analyzeDivergence({ horizon = 'h4' } = {}) {
    const rows = (await store.transitions())
      .filter(r =>
        Number.isFinite(Number(r.outcomes?.[horizon])) &&
        Number.isFinite(Number(r.divergence))
      );

    const buckets = { diverging: [], aligned: [] };

    for (const r of rows) {
      const d = Number(r.divergence);
      const ret = Number(r.outcomes[horizon]);
      (Math.abs(d) > 0.2 ? buckets.diverging : buckets.aligned).push(ret);
    }

    const describe = (arr) => {
      if (!arr.length) return { n: 0 };
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      const wins = arr.filter(x => x > 0).length;
      return {
        n: arr.length,
        meanReturn: Number(mean.toFixed(4)),
        winRate: Number(((wins / arr.length) * 100).toFixed(1))
      };
    };

    return {
      diverging: describe(buckets.diverging),
      aligned: describe(buckets.aligned),
      note: 'If diverging and aligned look the same, divergence adds nothing.'
    };
  }

  return { recordSnapshot, resolveOutcomes, analyze, analyzeDivergence };
}

// ===============================
// FACTORY
// ===============================

function createEmotionLab({ sql = null, getPrice, now = Date.now } = {}) {
  const store = sql ? createPostgresStore(sql) : createFileStore();

  console.log(`[EmotionLab] storage: ${store.kind}`);

  if (store.kind === 'file') {
    console.warn('[EmotionLab] file storage does not survive a Railway redeploy — set DATABASE_URL for real research');
  }

  return createLab({ store, getPrice, now });
}

module.exports = {
  createEmotionLab,
  createLab,
  createFileStore,
  createPostgresStore,
  computeDivergence,
  computeVelocity,
  moodDistance,
  HORIZONS,
  MIN_SAMPLE
};
