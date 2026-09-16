// ===============================
// WOJAKMETER — DESK API (bot side)
// Drop this file next to index.js on Railway.
//
// Exposes a small authenticated surface that the Vercel site
// proxies to. Every request must carry a fresh HMAC signature,
// so even if the URL leaks, nobody can call it.
//
// Wire it up in index.js with:
//
//   const deskApi = require("./desk-api");
//   deskApi.mount(app, {
//     getState: () => ({
//       autoTradeActive, openPosition, pendingConfirm,
//       personalTradingState, smartAtState,
//       PERSONAL_PLAN, SMART_AT
//     }),
//     evaluateSmartSignals,
//     closePosition: atCloseTrackedPosition,
//     setPaused: (v, reason) => {
//       smartAtState.paused = v;
//       smartAtState.pauseReason = reason;
//     },
//     getMarkPrice: atGetMarkPrice,
//     getOpenPositions: atGetOpenPositions
//   });
// ===============================

const crypto = require("crypto");
const { normalizePositions } = require("./desk-positions");

// Requests older than this are rejected, so a captured request
// cannot be replayed hours later.
const MAX_SKEW_MS = 5 * 60 * 1000;

function sign(message, secret) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verify(req) {
  const secret = process.env.BOT_API_SECRET;

  if (!secret) {
    return { ok: false, error: "BOT_API_SECRET not set on the bot" };
  }

  const ts = req.headers["x-wm-timestamp"];
  const signature = req.headers["x-wm-signature"];

  if (!ts || !signature) {
    return { ok: false, error: "Missing signature headers" };
  }

  const age = Math.abs(Date.now() - Number(ts));

  if (!Number.isFinite(age) || age > MAX_SKEW_MS) {
    return { ok: false, error: "Signature expired" };
  }

  const body = req.method === "POST" ? JSON.stringify(req.body || {}) : "";
  const payload = `${ts}.${req.path}.${body}`;

  if (!safeEqual(signature, sign(payload, secret))) {
    return { ok: false, error: "Invalid signature" };
  }

  return { ok: true };
}

function guard(handler) {
  return async (req, res) => {
    const check = verify(req);

    if (!check.ok) {
      console.warn(`[DeskAPI] rejected ${req.path}: ${check.error}`);
      return res.status(401).json({ ok: false, error: check.error });
    }

    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[DeskAPI] ${req.path} error:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// Rolling log of closed trades, kept in memory
const tradeHistory = [];
const MAX_HISTORY = 50;

function recordTrade(entry) {
  tradeHistory.unshift({ ...entry, ts: entry.ts || Date.now() });
  if (tradeHistory.length > MAX_HISTORY) tradeHistory.pop();
}

function mount(app, deps) {
  const {
    getState,
    evaluateSmartSignals,
    closePosition,
    setPaused,
    getMarkPrice,
    getOpenPositions
  } = deps;

  // ── STATUS: everything the desk needs for one render ──
  app.get("/desk/status", guard(async (req, res) => {
    const s = getState();
    const account = await deps.readAccount();

    let positions = null, positionsError = null, positionsUpdatedAt = null;
    try {
      positions = normalizePositions(await getOpenPositions(), s.openPosition);
      positionsUpdatedAt = Date.now();
    } catch (err) { positionsError = err.message; }
    res.setHeader("Cache-Control", "private, no-store");

    res.json({
      ok: true,
      ts: Date.now(),
      account,
      positions, positionsError, positionsUpdatedAt,
      engine: {
        recovering: Boolean(s.runtime?.recovering),
        recoveryError: s.runtime?.recoveryError || null,
        recoveredAt: s.runtime?.recoveredAt || null,
        ready: Boolean(s.runtime?.ready),
        bootError: s.runtime?.bootError || null,
        evaluating: Boolean(s.runtime?.evaluating),
        lastEvaluation: s.runtime?.lastEvaluation || null,
        executionBusy: Boolean(s.runtime?.executionBusy),
        mode: s.SMART_AT?.autoExecuteOnTriple ? "Automatic" : "Confirmation required",
        entryRequirement: Math.max(2, Math.min(3, Number(s.SMART_AT?.minSignalsRequired) || 2)),
        automaticRequirement: s.SMART_AT?.autoExecuteOnTriple ? (s.SMART_AT.autoOnMedium ? Math.max(2, Math.min(3, Number(s.SMART_AT.minSignalsRequired)||2)) : 3) : null,
        blockers: [
          s.smartAtState?.lastEntrySkip && Date.now() - s.smartAtState.lastEntrySkip.at < 120000 && s.smartAtState.lastEntrySkip.reason,
          !s.runtime?.ready && "Account recovery is not complete",
          !s.autoTradeActive && "AutoTrade is OFF — enable it in the owner Telegram controls",
          s.smartAtState?.paused && (s.smartAtState.pauseReason || "Paused"),
          positionsError && "Exchange positions unavailable — verify account connection",
          (positions?.length || s.openPosition || s.emotion?.position) && "Position already open",
          (s.pendingConfirm || s.emotion?.pending) && "Waiting for Telegram confirmation",
          s.personalTradingState?.coolingDown && "Daily risk lock",
          s.personalTradingState?.tradesToday >= s.PERSONAL_PLAN?.maxTradesPerDay && "Daily trade limit reached",
          s.personalTradingState?.pnlToday <= -Math.abs(s.PERSONAL_PLAN?.maxDailyLoss) && "Daily loss limit reached",
          s.personalTradingState?.pnlToday >= s.PERSONAL_PLAN?.dailyProfitLock && "Daily profit lock reached",
          Date.now() - (s.smartAtState?.lastExecutionTs || 0) < (s.SMART_AT?.cooldownMs || 0) && "Execution cooldown"
        ].filter(Boolean)
      },
      market: s.runtime?.context && Date.now() - s.runtime.context.ts <= 1800000 ? s.runtime.context : null,
      marketError: s.runtime?.contextError || null,
      emotionEngine: { mode: "Confirmation required", position: s.emotion?.position ? {symbol:s.emotion.position.symbol, side:s.emotion.position.side} : null, pending: s.emotion?.pending ? {symbol:s.emotion.pending.symbol, side:s.emotion.pending.side} : null, transitions:s.emotion?.transitions || [] },
      autoTrade: {
        active: s.autoTradeActive,
        paused: s.smartAtState?.paused || false,
        pauseReason: s.smartAtState?.pauseReason || null,
        consecutiveLosses: s.smartAtState?.consecutiveLosses || 0,
        maxConsecutiveLosses: s.SMART_AT?.maxConsecutiveLosses || 2,
        totalTrades: s.smartAtState?.totalAutoTrades || 0
      },
      position: positions?.[0] || null,
      pending: s.pendingConfirm
        ? { symbol: s.pendingConfirm.symbol, side: s.pendingConfirm.side }
        : null,
      day: {
        trades: s.personalTradingState?.tradesToday || 0,
        maxTrades: s.PERSONAL_PLAN?.maxTradesPerDay || 0,
        pnl: s.personalTradingState?.pnlToday || 0,
        coolingDown: s.personalTradingState?.coolingDown || false,
        balance: account.ok ? account.walletBalance : null,
        maxDailyLoss: s.PERSONAL_PLAN?.maxDailyLoss || 0,
        profitLock: s.PERSONAL_PLAN?.dailyProfitLock || 0
      }
    });
  }));

  // ── SIGNALS: the live 3-way read ──
  app.get("/desk/signals", guard(async (req, res) => {
    const ev = await evaluateSmartSignals();

    res.json({
      ok: true,
      ts: ev.ts || null,
      error: ev.error || null,
      telemetry: deps.getTelemetry(),
      thresholds: { momentum: getState().SMART_AT.btcMomentumThreshold, confluence:getState().SMART_AT.confluenceMin, relativeVolume:1.2, participationLong:65, participationShort:35 },
      votes: {participation:ev.globalSignal || null, momentum:ev.btcSignal || null, volume:ev.confluenceSignal || null},
      coins: Array.isArray(ev.coins) ? ev.coins.slice(0,20).map(c => ({symbol:c.symbol,price:c.price,change24h:c.change24h,change1h:c.change1h,relativeVolume:c.relativeVolume,quoteVolume:c.quoteVolume,closedAt:c.closedAt})) : [],
      source: ev.source,
      strategy: ev.strategy,
      strategyScore: ev.strategyScore,
      marketMood: ev.marketMood,
      coverage: ev.coverage,
      direction: ev.direction,
      confidence: ev.confidence,
      aligned: ev.alignedCount,
      conflict: ev.conflict || false,
      globalScore: ev.globalScore,
      btcChange1h: ev.btcChange1h,
      confluenceCount: ev.confluenceCount,
      details: ev.details
    });
  }));

  // ── POSITIONS: raw from Binance ──
  app.get("/desk/positions", guard(async (req, res) => {
    const positions = await getOpenPositions();

    res.json({
      ok: true,
      positions: positions.map((p) => ({
        symbol: p.symbol,
        side: Number(p.positionAmt) > 0 ? "LONG" : "SHORT",
        qty: Math.abs(Number(p.positionAmt)),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unrealizedPnl: Number(p.unRealizedProfit),
        leverage: Number(p.leverage)
      }))
    });
  }));

  // ── HISTORY ──
  app.get("/desk/history", guard(async (req, res) => {
    res.json({ ok: true, trades: tradeHistory });
  }));

  app.post("/desk/recover", guard(async (req, res) => {
    if (!deps.recoverAccount()) return res.status(409).json({ok:false, error:"Engine is busy. Retry when the current cycle finishes."});
    res.status(202).json({ok:true, recovering:true});
  }));

  // ── CONTROLS ──
  app.post("/desk/pause", guard(async (req, res) => {
    setPaused(true, "Paused from desk");
    res.json({ ok: true, paused: true });
  }));

  app.post("/desk/resume", guard(async (req, res) => {
    setPaused(false, null);
    res.json({ ok: true, paused: false });
  }));

  app.post("/desk/close", guard(async (req, res) => {
    const s = getState();

    if (!s.openPosition) {
      return res.status(400).json({ ok: false, error: "No open position" });
    }

    const positions = normalizePositions(await getOpenPositions(), s.openPosition);
    const target = positions.find(p => p.id === req.body?.positionId);
    if (!target?.canClose) return res.status(409).json({ok:false, error:"Selected position changed or is not managed by AutoTrade. Refresh and manage external positions in Binance or Telegram."});
    await closePosition("Closed from desk");
    res.json({ ok: true });
  }));

  console.log("[DeskAPI] mounted — /desk/* endpoints are live and signed");
}

module.exports = { mount, recordTrade, tradeHistory };
