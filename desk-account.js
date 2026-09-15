'use strict';
function createAccountReader(read, now = Date.now) {
  let result = null, pending = null, lastAttempt = -Infinity;
  return async function account() {
    if (pending) return pending;
    if (now() - lastAttempt < 30000) return result;
    lastAttempt = now();
    pending = (async () => {
      try {
        const data = await read();
        const number = key => {
          const raw = data?.[key];
          if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) throw Error('Invalid account response: ' + key);
          return Number(raw);
        };
        result = {ok:true, ts:now(), walletBalance:number('totalWalletBalance'), availableBalance:number('availableBalance'), marginBalance:number('totalMarginBalance'), unrealizedPnl:number('totalUnrealizedProfit')};
      } catch (err) { result = {ok:false, ts:now(), error:err.message}; }
      finally { pending = null; }
      return result;
    })();
    return pending;
  };
}
function createRecovery({pause, isBusy, read, apply, state}) {
  let running = false;
  return {
    start() {
      if (running || isBusy()) return false;
      // Pause before the first await; this endpoint never resumes entries.
      pause(); running = true; state.recovering = true;
      state.recoveryError = null;
      Promise.resolve().then(read).then(data => {
        apply(data); state.ready = true; state.bootError = null;
        state.recoveredAt = Date.now();
      }).catch(err => { state.recoveryError = err.message; })
        .finally(() => { pause(); running = false; state.recovering = false; });
      return true;
    }
  };
}
module.exports = {createAccountReader, createRecovery};
