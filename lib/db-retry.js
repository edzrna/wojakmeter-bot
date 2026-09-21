'use strict';

// ===============================
// NEON WITH RETRIES — lib/db-retry.js
//
// The Neon driver talks HTTPS. Now and then a request dies before it
// reaches the database ("Error connecting to database: TypeError:
// fetch failed"): a network blip between Railway and Neon, not a bad
// query. Every write in the lab is an upsert, so running the same
// statement again is safe; this wrapper tries twice more, with a
// pause, and only for errors that look like the connection. A real
// SQL error is thrown at once.
//
// Keeps the tagged-template shape the store uses: sql`SELECT ...`.
// ===============================

const TRANSIENT = /fetch failed|Error connecting to database|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;

function withRetry(sql, {
  tries = 3,
  delays = [500, 2000],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isTransient = err => TRANSIENT.test(String(err?.message || err)),
  onRetry = () => {}
} = {}) {
  return async function retrying(strings, ...values) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sql(strings, ...values);
      } catch (err) {
        if (attempt >= tries || !isTransient(err)) throw err;
        onRetry(err, attempt);
        await sleep(delays[attempt - 1] ?? delays[delays.length - 1]);
      }
    }
  };
}

module.exports = { withRetry, TRANSIENT };
