"use strict";
// No exchange or Telegram dependencies. Reading diagnostics never executes trades.
const MOODS = ['frustration','concern','doubt','neutral','optimism','content','euphoria'];
function mood(score) { return MOODS[[20,35,45,60,70,85].filter(n => score >= n).length]; }
function normalizeContext(data, now = Date.now()) {
  if (!data?.ok || typeof data.score !== 'number' || !Number.isFinite(data.score) || data.score < 0 || data.score > 100 || !Number.isFinite(data.ts)) throw new Error('Invalid market index');
  if (now - data.ts > 30 * 60000 || data.ts > now + 60000) throw new Error('Market index is stale');
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { score: data.score, mood: mood(data.score), ts: data.ts,
    confidence: numeric(data.confidence), delta: numeric(data.delta),
    measurements: Object.fromEntries(['change','breadth','volatility'].map(k => [k, numeric(data.measurements?.[k])])),
    missing: Array.isArray(data.missing) ? data.missing.filter(x => typeof x === 'string') : [] };
}
function createRuntime({fetcher = global.fetch, now = Date.now} = {}) {
  const state = {ready:false, bootError:null, lastEvaluation:null, evaluating:false, executionBusy:false, context:null, contextError:null};
  let timer;
  let executionLocked = false;
  return {
    state,
    async exclusive(gate, task) {
      if (executionLocked || !gate()) return false;
      executionLocked = state.executionBusy = true;
      try { return await task(); } finally { executionLocked = state.executionBusy = false; }
    },
    async refreshContext() {
      try {
        const origin = process.env.WOJAKMETER_SITE_URL || 'https://wojakmeter.com';
        const res = await fetcher(new URL('/api/index-score', origin), {signal:AbortSignal.timeout(10000)});
        if (!res.ok) throw new Error(`Market API HTTP ${res.status}`);
        state.context = normalizeContext(await res.json(), now()); state.contextError = null;
      } catch (err) { state.context = null; state.contextError = err.message; }
    },
    async tick(task) {
      if (state.evaluating) return false;
      state.evaluating = true;
      try { await task(); state.lastEvaluation = now(); return true; }
      finally { state.evaluating = false; }
    },
    start(task, ms = 60000) {
      clearInterval(timer);
      const run = () => this.tick(task).catch(err => { state.bootError = err.message; });
      timer = setInterval(run, ms); run();
    },
    stop() { clearInterval(timer); }
  };
}
module.exports = {createRuntime, normalizeContext, mood};
