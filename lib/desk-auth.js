'use strict';

// ===============================
// DESK AUTH — bot side, signature v2
//
// The Vercel proxy signs every request; this verifies it.
//
//   payload = "v2" \n ts \n nonce \n METHOD \n path-with-query \n sha256(raw body)
//
// v1 signed only "ts.path.body": the method and the query string
// were outside the signature, and the body was re-serialised before
// checking. v2 covers the method, the exact path WITH its query and
// the exact body bytes. The nonce is remembered for the whole skew
// window, so a captured request cannot be replayed at all — not
// even inside the 5 minutes.
//
// The secret never leaves the server: BOT_API_SECRET lives on
// Railway and on Vercel (Production only), never in the browser.
// ===============================

const crypto = require('crypto');

const VERSION = '2';
const MAX_SKEW_MS = 5 * 60 * 1000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TS_RE = /^\d{1,16}$/;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}

function canonical({ ts, nonce, method, pathWithQuery, bodyHash }) {
  return ['v2', String(ts), String(nonce), String(method).toUpperCase(), String(pathWithQuery), String(bodyHash)].join('\n');
}

function signV2(parts, secret) {
  return crypto.createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createDeskAuth({
  secret = () => process.env.BOT_API_SECRET,
  now = Date.now,
  maxSkewMs = MAX_SKEW_MS,
  log = console
} = {}) {
  const seen = new Map(); // nonce → forget after

  function sweep(t) {
    for (const [nonce, forgetAt] of seen) if (forgetAt <= t) seen.delete(nonce);
  }

  function verify(req) {
    const key = typeof secret === 'function' ? secret() : secret;
    if (!key) return { ok: false, status: 503, error: 'BOT_API_SECRET is not set on this service' };

    const headers = req.headers || {};
    if (headers['x-wm-sig-version'] !== VERSION) {
      return { ok: false, status: 401, error: 'Signature version 2 required' };
    }

    const ts = String(headers['x-wm-timestamp'] || '');
    const nonce = String(headers['x-wm-nonce'] || '');
    const signature = String(headers['x-wm-signature'] || '');

    if (!ts || !nonce || !signature) return { ok: false, status: 401, error: 'Missing signature headers' };
    if (!TS_RE.test(ts)) return { ok: false, status: 401, error: 'Malformed timestamp' };
    if (!NONCE_RE.test(nonce)) return { ok: false, status: 401, error: 'Malformed nonce' };

    const t = now();
    if (Math.abs(t - Number(ts)) > maxSkewMs) return { ok: false, status: 401, error: 'Signature expired' };

    const expected = signV2({
      ts,
      nonce,
      method: req.method || 'GET',
      pathWithQuery: req.originalUrl || req.url || '',
      bodyHash: sha256Hex(req.rawBody || '')
    }, key);

    if (!safeEqualHex(signature, expected)) return { ok: false, status: 401, error: 'Invalid signature' };

    // Remember the nonce only once the signature is valid, so junk
    // requests cannot fill the map.
    sweep(t);
    if (seen.has(nonce)) return { ok: false, status: 401, error: 'Replayed request' };
    seen.set(nonce, t + maxSkewMs * 2);

    return { ok: true };
  }

  function guard(handler) {
    return async (req, res) => {
      const check = verify(req);

      if (!check.ok) {
        log.warn(`[DeskAuth] rejected ${req.method} ${req.path}: ${check.error}`);
        return res.status(check.status).json({ ok: false, error: check.error });
      }

      res.setHeader('Cache-Control', 'private, no-store');

      try {
        await handler(req, res);
      } catch (err) {
        log.error(`[DeskAuth] ${req.method} ${req.path} failed:`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
      }
    };
  }

  return { verify, guard, seenCount: () => seen.size };
}

module.exports = { createDeskAuth, signV2, sha256Hex, canonical, VERSION, MAX_SKEW_MS };
