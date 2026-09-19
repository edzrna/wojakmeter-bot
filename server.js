'use strict';

// ===============================
// WOJAKMETER BOT v2 — service entry
//
// Phase 1 of the rebuild: the lab alone. No Telegram, no trading, no
// exchange keys. Every 15 minutes it records a snapshot of the
// market, it rebuilds the history from Binance, and it serves the
// desk through signed, read-only routes.
//
// Environment (Railway):
//   DATABASE_URL       Neon — required
//   BOT_API_SECRET     same value as on Vercel — required for the desk
//   LAB_BACKFILL_FROM  optional, YYYY-MM, first month of history (default 2024-01)
//   PORT               injected by Railway — never set it by hand
//
// Railway: the public domain's Target Port must equal the port printed
// at startup. If they differ you get a bare 502.
// ===============================

const express = require('express');
const { createBinanceRest } = require('./lib/binance-rest');
const { createDeskAuth } = require('./lib/desk-auth');
const { createLab } = require('./lab');
const { mountLabRoutes } = require('./lab/routes');

function createApp({ lab, auth }) {
  const app = express();
  app.disable('x-powered-by');

  // Keep the exact bytes: the v2 signature covers the raw body
  app.use(express.json({
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
  }));

  app.get('/health', (req, res) => {
    const h = lab.health();
    res.status(h.ok ? 200 : 503).json(h);
  });

  mountLabRoutes(app, { guard: auth.guard, lab });

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // Malformed JSON and other body errors: say so, as JSON
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ ok: false, error: status === 500 ? 'Internal error' : err.message });
  });

  return app;
}

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  let sql = null;

  if (databaseUrl) {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(databaseUrl);
  } else {
    console.error('[bot-v2] DATABASE_URL is not set — the lab will report it and store nothing');
  }

  if (!process.env.BOT_API_SECRET) {
    console.error('[bot-v2] BOT_API_SECRET is not set — every desk route will answer 503');
  }

  const rest = createBinanceRest();
  const lab = createLab({ sql, rest, backfillFrom: process.env.LAB_BACKFILL_FROM });
  const auth = createDeskAuth();
  const app = createApp({ lab, auth });

  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => {
    console.log(`[bot-v2] listening on ${port} — Railway's Target Port must be ${port}`);
    lab.start();
  });
}

if (require.main === module) main();

module.exports = { createApp };
