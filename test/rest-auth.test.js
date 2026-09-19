'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createBinanceRest, klineWeight } = require('../lib/binance-rest');
const { createDeskAuth, signV2, sha256Hex } = require('../lib/desk-auth');
const { response } = require('./helpers');

const I = 15 * 60 * 1000;

function fakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 5)) {
  let t = start;
  const waits = [];
  return {
    now: () => t,
    sleep: async ms => { waits.push(ms); t += ms; },
    advance: ms => { t += ms; },
    waits
  };
}

test('klinesRange pages by 1500 and asks for no more than it needs', async () => {
  const clock = fakeClock();
  const start = Date.UTC(2025, 0, 1);
  const all = Array.from({ length: 4000 }, (_, i) => start + i * I);
  const asked = [];

  const fetcher = async url => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get('limit'));
    const from = Number(u.searchParams.get('startTime'));
    const to = Number(u.searchParams.get('endTime'));
    asked.push(limit);
    const rows = all.filter(t => t >= from && t <= to).slice(0, limit)
      .map(t => [t, '1', '2', '0.5', '1.5', '0', t + I - 1, '100', 1, '0', '0', '0']);
    return response(rows);
  };

  const rest = createBinanceRest({ fetcher, now: clock.now, sleep: clock.sleep, minGapMs: 0 });
  const got = await rest.klinesRange('BTCUSDT', '15m', all[100], all[3299], I);

  assert.equal(got.length, 3200);
  assert.equal(got[0].t, all[100]);
  assert.equal(got[3199].t, all[3299]);
  assert.deepEqual(asked, [1500, 1500, 200]);
  assert.deepEqual([99, 100, 499, 500, 1000, 1001, 1500].map(klineWeight), [1, 2, 2, 5, 5, 10, 10]);
});

test('weight budget: waits for the next minute instead of crossing it', async () => {
  const clock = fakeClock();
  let used = 1195;
  const fetcher = async () => response([], 200, { 'x-mbx-used-weight-1m': String(used) });
  const rest = createBinanceRest({ fetcher, now: clock.now, sleep: clock.sleep, minGapMs: 0 });

  await rest.request('/fapi/v1/ping', {}, { weight: 1 });
  assert.equal(clock.waits.length, 0);

  used = 12;
  await rest.request('/fapi/v1/klines', {}, { weight: 10 }); // 1195 + 10 > 1200
  assert.equal(clock.waits.length, 1);
  assert.ok(clock.waits[0] >= 55_000 && clock.waits[0] <= 61_000, `waited ${clock.waits[0]}`);
});

test('429 blocks the whole queue; a block longer than maxWait fails with its reason', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1
      ? response({ code: -1003, msg: 'Too many requests' }, 429, { 'retry-after': '120' })
      : response({ ok: true });
  };
  const rest = createBinanceRest({ fetcher, now: clock.now, sleep: clock.sleep, minGapMs: 0 });

  await assert.rejects(rest.request('/fapi/v1/ping'), err => err.status === 429 && /-1003 Too many requests/.test(err.message));
  await rest.request('/fapi/v1/ping');
  assert.ok(clock.waits.some(w => w >= 119_000), 'honours Retry-After');

  const clock2 = fakeClock();
  const banned = async () => response({ code: -1003, msg: 'banned' }, 418, { 'retry-after': '7200' });
  const rest2 = createBinanceRest({ fetcher: banned, now: clock2.now, sleep: clock2.sleep, minGapMs: 0, maxWaitMs: 60_000 });
  await assert.rejects(rest2.request('/x'), /HTTP 418/);
  await assert.rejects(rest2.request('/x'), err => err.code === 'BLOCKED' && /HTTP 418/.test(err.message));
  assert.ok(rest2.stats().blockedUntil > clock2.now());
});

test('451 (restricted location) fails fast and says where the problem is', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return response({ code: 0, msg: 'Service unavailable from a restricted location' }, 451);
  };
  const rest = createBinanceRest({ fetcher, now: clock.now, sleep: clock.sleep, minGapMs: 0 });

  await assert.rejects(rest.request('/fapi/v1/klines'), err => err.status === 451 && /restricted location/.test(err.message));
  await assert.rejects(rest.request('/fapi/v1/klines'), err => err.code === 'BLOCKED' && /region Binance serves/.test(err.message));
  assert.equal(calls, 1, 'the second request never reached Binance');
  assert.equal(clock.waits.length, 0, 'nobody sat waiting for a block that will not lift');
  assert.match(rest.stats().blockReason, /HTTP 451/);
});

test('bad symbols and bad rows are errors with a cause', async () => {
  const clock = fakeClock();
  const rest = createBinanceRest({
    fetcher: async url => url.includes('NOPE')
      ? response({ code: -1121, msg: 'Invalid symbol.' }, 400)
      : response([[1, 'x']]),
    now: clock.now,
    sleep: clock.sleep,
    minGapMs: 0
  });
  await assert.rejects(rest.klines('NOPEUSDT', '15m'), err => err.status === 400 && /Invalid symbol/.test(err.message));
  await assert.rejects(rest.klines('BTCUSDT', '15m'), /unparseable row 0/);
});

// ===============================
// DESK AUTH v2
// ===============================

const SECRET = 'test-secret';

function signed({ method = 'GET', url, body = '', ts, nonce = crypto.randomBytes(16).toString('hex'), secret = SECRET }) {
  const sig = signV2({ ts: String(ts), nonce, method, pathWithQuery: url, bodyHash: sha256Hex(body) }, secret);
  return {
    method,
    originalUrl: url,
    path: url.split('?')[0],
    rawBody: body ? Buffer.from(body) : undefined,
    headers: {
      'x-wm-sig-version': '2',
      'x-wm-timestamp': String(ts),
      'x-wm-nonce': nonce,
      'x-wm-signature': sig
    }
  };
}

test('v2 signature covers method, query and exact body bytes', () => {
  let t = 1_000_000_000_000;
  const auth = createDeskAuth({ secret: SECRET, now: () => t });

  assert.equal(auth.verify(signed({ url: '/desk/lab/report?model=hex', ts: t })).ok, true);

  const q = signed({ url: '/desk/lab/report?model=hex', ts: t });
  q.originalUrl = '/desk/lab/report?model=linear';
  assert.equal(auth.verify(q).error, 'Invalid signature', 'query is signed');

  const m = signed({ method: 'POST', url: '/desk/x', body: '{"a":1}', ts: t });
  m.method = 'DELETE';
  assert.equal(auth.verify(m).error, 'Invalid signature', 'method is signed');

  const b = signed({ method: 'POST', url: '/desk/x', body: '{"a":1}', ts: t });
  b.rawBody = Buffer.from('{"a": 1}');
  assert.equal(auth.verify(b).error, 'Invalid signature', 'body bytes are signed, not re-serialised');

  assert.equal(auth.verify(signed({ url: '/desk/x', ts: t, secret: 'other' })).error, 'Invalid signature');
  assert.equal(auth.verify(signed({ url: '/desk/x', ts: t - 6 * 60 * 1000 })).error, 'Signature expired');
  assert.equal(auth.verify(signed({ url: '/desk/x', ts: t, nonce: 'short' })).error, 'Malformed nonce');

  const v1 = signed({ url: '/desk/x', ts: t });
  delete v1.headers['x-wm-sig-version'];
  assert.equal(auth.verify(v1).error, 'Signature version 2 required');
});

test('a captured request cannot be replayed, even inside the window', () => {
  let t = 1_000_000_000_000;
  const auth = createDeskAuth({ secret: SECRET, now: () => t });
  const req = signed({ url: '/desk/lab/status', ts: t });

  assert.equal(auth.verify(req).ok, true);
  t += 1000;
  assert.equal(auth.verify(req).error, 'Replayed request');

  // Nonces are forgotten only after they could no longer be valid
  t += 11 * 60 * 1000;
  assert.equal(auth.verify(req).error, 'Signature expired');
  auth.verify(signed({ url: '/desk/lab/status', ts: t }));
  assert.equal(auth.seenCount(), 1, 'old nonces swept');
});

test('no secret on the service is a 503, not an open door', () => {
  const auth = createDeskAuth({ secret: () => undefined });
  const r = auth.verify(signed({ url: '/desk/x', ts: Date.now() }));
  assert.equal(r.status, 503);
  assert.match(r.error, /BOT_API_SECRET is not set/);
});
