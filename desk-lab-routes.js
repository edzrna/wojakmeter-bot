'use strict';

// ===============================
// WOJAKMETER — DESK RESEARCH ENDPOINTS
// desk-lab-routes.js
//
// Mounts /desk/edge and /desk/divergence on the bot's express app,
// behind the same HMAC guard the rest of the desk API uses.
//
// In index.js, after desk-api is mounted and `lab` exists:
//
//   const deskLab = require("./desk-lab-routes");
//   deskLab.mount(app, { lab, guard: deskApi.guard });
//
// If desk-api.js does not export its guard, pass the secret and
// this file builds an identical one:
//
//   deskLab.mount(app, { lab });
// ===============================

const crypto = require('crypto');

const MAX_SKEW_MS = 5 * 60 * 1000;

function sign(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Same verification the rest of the desk API performs. Duplicated
// rather than imported so this file works whether or not desk-api
// exports its internals.
function defaultGuard(handler) {
  return async (req, res) => {
    const secret = process.env.BOT_API_SECRET;

    if (!secret) {
      return res.status(401).json({ ok: false, error: 'BOT_API_SECRET not set' });
    }

    const ts = req.headers['x-wm-timestamp'];
    const signature = req.headers['x-wm-signature'];

    if (!ts || !signature) {
      return res.status(401).json({ ok: false, error: 'Missing signature headers' });
    }

    const age = Math.abs(Date.now() - Number(ts));

    if (!Number.isFinite(age) || age > MAX_SKEW_MS) {
      return res.status(401).json({ ok: false, error: 'Signature expired' });
    }

    // The proxy signs the path without the query string
    const body = req.method === 'POST' ? JSON.stringify(req.body || {}) : '';
    const payload = `${ts}.${req.path}.${body}`;

    if (!safeEqual(signature, sign(payload, secret))) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[DeskLab] ${req.path}:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

const VALID_HORIZONS = new Set(['h1', 'h4', 'h24']);

function mount(app, { lab, guard } = {}) {
  if (!lab) {
    console.warn('[DeskLab] no lab passed — research endpoints not mounted');
    return;
  }

  const protect = guard || defaultGuard;

  app.get('/desk/edge', protect(async (req, res) => {
    const requested = String(req.query.horizon || 'h4');
    const horizon = VALID_HORIZONS.has(requested) ? requested : 'h4';

    const results = await lab.analyze({ horizon });

    res.json({
      ok: true,
      horizon,
      results,
      // Surfaced so the UI never has to hardcode the threshold
      minSample: 30,
      generatedAt: Date.now()
    });
  }));

  app.get('/desk/divergence', protect(async (req, res) => {
    const requested = String(req.query.horizon || 'h4');
    const horizon = VALID_HORIZONS.has(requested) ? requested : 'h4';

    const result = await lab.analyzeDivergence({ horizon });

    res.json({ ok: true, horizon, ...result, generatedAt: Date.now() });
  }));

  console.log('[DeskLab] mounted — /desk/edge and /desk/divergence are live');
}

module.exports = { mount, defaultGuard };
