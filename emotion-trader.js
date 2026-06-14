// ===============================
// WOJAKMETER — EMOTION TRADER v4 SAFE-CONFIRM
// WebSocket Binance + Funding Rate + Liquidations
// + REST CoinGecko fallback
// Requires manual confirmation before execution
// ===============================

const WebSocket = require("ws");
const Binance = require("node-binance-api");

// ===============================
// PAIRS
// ===============================
const EMOTION_TRADE_PAIRS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
  "AVAXUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT", "UNIUSDT",
  "DOGEUSDT", "PEPEUSDT", "WIFUSDT", "SHIBUSDT", "FLOKIUSDT",
  "BONKUSDT", "MEMEUSDT",
  "SOLUSDT", "LINKUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT", "SUIUSDT", "INJUSDT", "TIAUSDT", "SEIUSDT"
];

// ===============================
// EMOTIONS
// ===============================
const EMOTIONS = [
  { key: "euphoria", emoji: "🤩", label: "Euphoria", minPct: 12 },
  { key: "content", emoji: "😌", label: "Content", minPct: 6 },
  { key: "optimism", emoji: "🙂", label: "Optimism", minPct: 2 },
  { key: "neutral", emoji: "😐", label: "Neutral", minPct: -2 },
  { key: "doubt", emoji: "🤔", label: "Doubt", minPct: -5 },
  { key: "concern", emoji: "😟", label: "Concern", minPct: -8 },
  { key: "frustration", emoji: "😡", label: "Frustration", minPct: -9999 }
];

// ===============================
// TRANSITION RULES — SAFER VERSION
// ===============================
const TRANSITION_RULES = {
  "neutral→optimism": {
    action: "LONG",
    leverage: 3,
    strength: "medium",
    note: "Market waking up to the upside"
  },

  "optimism→content": {
    action: "LONG",
    leverage: 4,
    strength: "strong",
    note: "Bullish momentum confirmed"
  },

  "doubt→neutral": {
    action: "LONG",
    leverage: 3,
    strength: "medium",
    note: "Bearish pressure fading"
  },

  "frustration→concern": {
    action: "LONG",
    leverage: 3,
    strength: "medium",
    note: "Possible emotional bottom"
  },

  "concern→doubt": {
    action: "LONG",
    leverage: 4,
    strength: "strong",
    note: "Reversal from panic zone"
  },

  "neutral→doubt": {
    action: "SHORT",
    leverage: 3,
    strength: "medium",
    note: "Market losing conviction"
  },

  "doubt→concern": {
    action: "SHORT",
    leverage: 4,
    strength: "strong",
    note: "Bearish pressure confirmed"
  },

  "optimism→neutral": {
    action: "SHORT",
    leverage: 3,
    strength: "medium",
    note: "Bullish momentum losing steam"
  },

  "euphoria→content": {
    action: "SHORT",
    leverage: 3,
    strength: "medium",
    note: "Possible emotional top"
  },

  "content→optimism": {
    action: "SHORT",
    leverage: 2,
    strength: "weak",
    note: "Cooling from high zone"
  },

  "optimism→euphoria": {
    action: "CLOSE_LONG",
    leverage: 0,
    strength: "exit",
    note: "Euphoria reached — close LONG"
  },

  "concern→frustration": {
    action: "CLOSE_SHORT",
    leverage: 0,
    strength: "exit",
    note: "Extreme panic — close SHORT"
  }
};

// ===============================
// CONFLUENCE / INTERVALS
// ===============================
const CONFLUENCE = {
  weak: 2,
  medium: 3,
  strong: 5
};

const SIGNAL_COOLDOWN_MS = 20 * 60 * 1000;
const EVAL_INTERVAL_MS = 60 * 1000;
const PRICE_WINDOW_5M_MS = 5 * 60 * 1000;
const PRICE_WINDOW_15M_MS = 15 * 60 * 1000;
const FUNDING_REFRESH_MS = 5 * 60 * 1000;
const LIQUIDATION_WINDOW_MS = 10 * 60 * 1000;

// ===============================
// STATE
// ===============================
let _config = null;
let _binance = null;
let _ws = null;
let _wsReconnectTimer = null;

const pairState = new Map();
const priceBuffer = new Map();
const fundingRates = new Map();
const liquidations = [];
const transitionHistory = [];

const MAX_HISTORY = 50;

let lastSignalTs = 0;
let emoPosition = null;
let _pendingEmoTrade = null;

// ===============================
// HELPERS
// ===============================
function escapeHTML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatUsd(n) {
  const num = Number(n);

  if (!Number.isFinite(num)) return "$0.00";

  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);

  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;

  return `${sign}$${abs.toFixed(6)}`;
}

function formatPct(n) {
  const num = Number(n) || 0;
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEmotion(pct) {
  const n = Number(pct) || 0;

  for (const e of EMOTIONS) {
    if (n >= e.minPct) return e;
  }

  return EMOTIONS[EMOTIONS.length - 1];
}

function pushPrice(symbol, price) {
  const cleanPrice = Number(price);

  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) return;

  if (!priceBuffer.has(symbol)) {
    priceBuffer.set(symbol, []);
  }

  const buf = priceBuffer.get(symbol);

  buf.push({
    price: cleanPrice,
    ts: Date.now()
  });

  const cutoff = Date.now() - 20 * 60 * 1000;

  while (buf.length > 0 && buf[0].ts < cutoff) {
    buf.shift();
  }
}

function calcPct(symbol, windowMs) {
  const buf = priceBuffer.get(symbol);

  if (!buf || buf.length < 2) return 0;

  const cutoff = Date.now() - windowMs;
  const recent = buf.filter((p) => p.ts >= cutoff);

  if (recent.length < 2) return 0;

  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;

  if (!oldest || oldest <= 0) return 0;

  return ((newest - oldest) / oldest) * 100;
}

function getRecentLiquidations(symbol, side) {
  const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;

  return liquidations.filter(
    (l) => l.symbol === symbol && l.side === side && l.ts >= cutoff
  );
}

function getFundingSignal(symbol, direction) {
  const rate = fundingRates.get(symbol);

  if (rate === undefined) return "neutral";

  if (direction === "LONG" && rate < -0.01) return "strong";
  if (direction === "LONG" && rate > 0.05) return "weak";

  if (direction === "SHORT" && rate > 0.05) return "strong";
  if (direction === "SHORT" && rate < -0.01) return "weak";

  return "neutral";
}

function getSlPct() {
  return Number(process.env.AUTO_TRADE_SL_PCT || 1.5);
}

function getTpPct() {
  return Number(process.env.AUTO_TRADE_TP_PCT || 3.0);
}

function getMaxAllowedLeverage(plan, ruleLeverage) {
  const maxPlanLev = Number(plan?.maxLeverage || 5);
  const ruleLev = Number(ruleLeverage || 1);

  return Math.max(1, Math.min(maxPlanLev, ruleLev));
}

// ===============================
// WEBSOCKET — BINANCE FUTURES
// ===============================
function buildWsUrl() {
  const tickers = EMOTION_TRADE_PAIRS
    .map((s) => `${s.toLowerCase()}@miniTicker`)
    .join("/");

  const liqStream = "!forceOrder@arr";

  return `wss://fstream.binance.com/stream?streams=${tickers}/${liqStream}`;
}

function connectWebSocket() {
  if (_ws) {
    try {
      _ws.terminate();
    } catch (_) {}
  }

  console.log("[EmoTrader] Connecting WebSocket Binance...");

  _ws = new WebSocket(buildWsUrl());

  _ws.on("open", () => {
    console.log(
      `[EmoTrader] WebSocket connected — ${EMOTION_TRADE_PAIRS.length} pairs + liquidations`
    );

    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }
  });

  _ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      const data = msg?.data || msg;

      if (!data) return;

      if (data.e === "24hrMiniTicker") {
        const symbol = data.s;

        if (EMOTION_TRADE_PAIRS.includes(symbol)) {
          pushPrice(symbol, data.c);
        }
      }

      if (data.e === "forceOrder") {
        const o = data.o;

        if (o && EMOTION_TRADE_PAIRS.includes(o.s)) {
          liquidations.push({
            symbol: o.s,
            side: o.S,
            qty: parseFloat(o.q),
            price: parseFloat(o.p),
            ts: Date.now()
          });

          const cutoff = Date.now() - 30 * 60 * 1000;

          while (liquidations.length > 0 && liquidations[0].ts < cutoff) {
            liquidations.shift();
          }

          console.log(
            `[EmoTrader] Liquidation: ${o.S} ${o.s} qty=${o.q} price=${o.p}`
          );
        }
      }
    } catch (_) {}
  });

  _ws.on("error", (err) => {
    console.error("[EmoTrader] WebSocket error:", err.message);
  });

  _ws.on("close", () => {
    console.warn("[EmoTrader] WebSocket closed. Reconnecting in 5s...");

    _wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  });
}

// ===============================
// FUNDING RATE POLLER
// ===============================
async function fetchFundingRates() {
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex", {
      headers: {
        "User-Agent": "WojakMeterBot/4.0"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) return;

    let updated = 0;

    for (const item of data) {
      if (EMOTION_TRADE_PAIRS.includes(item.symbol)) {
        fundingRates.set(item.symbol, parseFloat(item.lastFundingRate) * 100);
        updated++;
      }
    }

    console.log(`[EmoTrader] Funding rates updated: ${updated} pairs`);
  } catch (err) {
    console.error("[EmoTrader] fetchFundingRates error:", err.message);
  }
}

// ===============================
// REST FALLBACK — COINGECKO
// ===============================
async function fetchCoinGeckoFallback() {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h";

    const headers = {
      "User-Agent": "WojakMeterBot/4.0",
      Accept: "application/json"
    };

    if (process.env.COINGECKO_API_KEY) {
      headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const coins = await res.json();

    if (!Array.isArray(coins)) return;

    let loaded = 0;

    for (const c of coins) {
      const symbol = `${(c.symbol || "").toUpperCase()}USDT`;

      if (EMOTION_TRADE_PAIRS.includes(symbol)) {
        const buf = priceBuffer.get(symbol);

        const hasRecentData =
          buf &&
          buf.length > 0 &&
          Date.now() - buf[buf.length - 1].ts < 2 * 60 * 1000;

        if (!hasRecentData) {
          pushPrice(symbol, c.current_price);
          loaded++;
        }
      }
    }

    if (loaded > 0) {
      console.log(
        `[EmoTrader] CoinGecko fallback: ${loaded} pairs without WebSocket data`
      );
    }
  } catch (err) {
    console.error("[EmoTrader] CoinGecko fallback error:", err.message);
  }
}

// ===============================
// EVALUATION LOOP
// ===============================
function startEvaluationLoop() {
  setInterval(async () => {
    let evaluated = 0;

    for (const symbol of EMOTION_TRADE_PAIRS) {
      const pct5m = calcPct(symbol, PRICE_WINDOW_5M_MS);
      const pct15m = calcPct(symbol, PRICE_WINDOW_15M_MS);
      const buf = priceBuffer.get(symbol);
      const price = buf?.length ? buf[buf.length - 1].price : 0;

      if (!price) continue;

      const emo5m = getEmotion(pct5m);
      const emo15m = getEmotion(pct15m);

      const existing = pairState.get(symbol);
      const prevEmotion = existing?.emotion || null;

      pairState.set(symbol, {
        emotion: emo5m.key,
        prevEmotion,
        pct5m,
        pct15m,
        price,
        funding: fundingRates.get(symbol) || 0,
        ts: Date.now()
      });

      if (prevEmotion && prevEmotion !== emo5m.key) {
        await processTransition(
          symbol,
          prevEmotion,
          emo5m.key,
          pct5m,
          pct15m,
          price,
          emo15m.key
        );
      }

      evaluated++;
    }

    console.log(`[EmoTrader] Poll OK — ${evaluated} pairs evaluated`);
  }, EVAL_INTERVAL_MS);
}

// ===============================
// PROCESS EMOTION TRANSITION
// ===============================
async function processTransition(
  symbol,
  prevEmotion,
  nextEmotion,
  pct5m,
  pct15m,
  price,
  emotion15m
) {
  const transitionKey = `${prevEmotion}→${nextEmotion}`;
  const rule = TRANSITION_RULES[transitionKey];

  if (!rule) return;

  transitionHistory.unshift({
    symbol,
    transitionKey,
    action: rule.action,
    strength: rule.strength,
    pct5m,
    pct15m,
    price,
    ts: Date.now()
  });

  if (transitionHistory.length > MAX_HISTORY) {
    transitionHistory.pop();
  }

  console.log(
    `[EmoTrader] ${symbol}: ${transitionKey} → ${rule.action} (${rule.strength}) 5m:${pct5m.toFixed(
      2
    )}% 15m:${pct15m.toFixed(2)}%`
  );

  // Exit signals
  if (rule.action === "CLOSE_LONG" && emoPosition?.side === "BUY") {
    await closeEmoPosition(`Signal: ${transitionKey}`);
    return;
  }

  if (rule.action === "CLOSE_SHORT" && emoPosition?.side === "SELL") {
    await closeEmoPosition(`Signal: ${transitionKey}`);
    return;
  }

  if (rule.action !== "LONG" && rule.action !== "SHORT") return;

  if (Date.now() - lastSignalTs < SIGNAL_COOLDOWN_MS) return;
  if (emoPosition || _pendingEmoTrade) return;

  // Confluence check
  const confluencePairs = [];

  for (const [sym, state] of pairState.entries()) {
    if (!state.prevEmotion || !state.emotion) continue;

    if (`${state.prevEmotion}→${state.emotion}` === transitionKey) {
      const emo = EMOTIONS.find((e) => e.key === state.emotion);

      confluencePairs.push({
        symbol: sym,
        emoji: emo?.emoji || "❓",
        transition: transitionKey,
        pct5m: state.pct5m,
        pct15m: state.pct15m,
        funding: state.funding,
        price: state.price
      });
    }
  }

  const count = confluencePairs.length;

  let signalLevel = null;

  if (count >= CONFLUENCE.strong) {
    signalLevel = "strong";
  } else if (count >= CONFLUENCE.medium) {
    signalLevel = "medium";
  } else if (count >= CONFLUENCE.weak) {
    signalLevel = "weak";
  }

  if (!signalLevel) return;

  const side = rule.action === "LONG" ? "BUY" : "SELL";
  const funding = getFundingSignal(symbol, rule.action);
  const recentLiqs = getRecentLiquidations(
    symbol,
    side === "BUY" ? "SELL" : "BUY"
  );

  // Weak signal = alert only, no trade proposal
  if (signalLevel === "weak") {
    const hasExtra = funding === "strong" || recentLiqs.length >= 2;

    await sendPrivate(
      `🟡 <b>EmoTrader — Weak Signal</b>\n\n` +
        `Transition: <b>${escapeHTML(transitionKey)}</b>\n` +
        `Pair: <b>${escapeHTML(symbol)}</b>\n` +
        `Price: <b>${formatUsd(price)}</b>\n` +
        `5m: <b>${formatPct(pct5m)}</b> | 15m: <b>${formatPct(pct15m)}</b>\n` +
        `Funding: <b>${formatPct(fundingRates.get(symbol) || 0)}</b>\n` +
        `Recent liquidations: <b>${recentLiqs.length}</b>\n` +
        `Confluence: <b>${count} pairs</b>\n\n` +
        `${
          hasExtra
            ? "⚡ Signal reinforced by funding/liquidations."
            : "ℹ️ Signal too weak. Monitoring only."
        }\n\n` +
        `No trade proposed. Waiting for stronger confirmation.`
    );

    return;
  }

  // Medium / Strong signal = proposal only, manual confirmation required
  const bestPair = confluencePairs.sort(
    (a, b) => Math.abs(b.pct5m) - Math.abs(a.pct5m)
  )[0];

  const tradeSymbol = bestPair?.symbol || symbol;

  await executeEmoTrade(tradeSymbol, side, rule.leverage, rule, {
    transitionKey,
    pairs: confluencePairs,
    signalLevel,
    pct5m,
    pct15m,
    emotion15m,
    funding,
    recentLiqs: recentLiqs.length
  });
}

// ===============================
// SEND PRIVATE MESSAGE
// ===============================
async function sendPrivate(text) {
  if (!_config?.bot || !_config?.PRIVATE_TELEGRAM_USER_ID) return;

  try {
    await _config.bot.telegram.sendMessage(
      _config.PRIVATE_TELEGRAM_USER_ID,
      text,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  } catch (err) {
    console.error("[EmoTrader] sendPrivate:", err.message);
  }
}

// ===============================
// BINANCE PROMISE HELPER
// ===============================
function promisifyBinance(fn) {
  return new Promise((resolve, reject) => {
    fn((err, res) => {
      if (err) {
        return reject(
          new Error(err.body || err.message || JSON.stringify(err))
        );
      }

      resolve(res);
    });
  });
}

// ===============================
// BINANCE FUTURES HELPERS
// ===============================
async function atSetLeverage(symbol, leverage) {
  return promisifyBinance((cb) =>
    _binance.futuresLeverage(symbol, leverage, cb)
  );
}

async function atGetMarkPrice(symbol) {
  const res = await promisifyBinance((cb) =>
    _binance.futuresMarkPrice(symbol, cb)
  );

  return parseFloat(res?.markPrice || res?.price || 0);
}

async function atGetExchangeInfo(symbol) {
  const info = await promisifyBinance((cb) =>
    _binance.futuresExchangeInfo(cb)
  );

  return (info?.symbols || []).find((s) => s.symbol === symbol) || null;
}

function getFilter(symbolInfo, filterType) {
  return (symbolInfo?.filters || []).find(
    (f) => f.filterType === filterType
  );
}

function getLotStepSize(symbolInfo) {
  const f = getFilter(symbolInfo, "LOT_SIZE");

  return parseFloat(f?.stepSize || "0.001");
}

function getMinQty(symbolInfo) {
  const f = getFilter(symbolInfo, "LOT_SIZE");

  return parseFloat(f?.minQty || "0");
}

function getMinNotional(symbolInfo) {
  const f =
    getFilter(symbolInfo, "MIN_NOTIONAL") ||
    getFilter(symbolInfo, "NOTIONAL");

  return parseFloat(f?.notional || f?.minNotional || "5");
}

function getTickSize(symbolInfo) {
  const f = getFilter(symbolInfo, "PRICE_FILTER");

  return parseFloat(f?.tickSize || "0.01");
}

function roundQty(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return qty;

  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));

  return parseFloat(
    (Math.floor(qty / stepSize) * stepSize).toFixed(precision)
  );
}

function roundPrice(price, tickSize) {
  if (!tickSize || tickSize <= 0) return price;

  const precision = Math.max(0, Math.round(-Math.log10(tickSize)));

  return parseFloat(
    (Math.round(price / tickSize) * tickSize).toFixed(precision)
  );
}

async function atPlaceMarketOrder(symbol, side, qty) {
  return promisifyBinance((cb) =>
    _binance.futuresOrder(
      side,
      symbol,
      qty,
      false,
      {
        type: "MARKET"
      },
      cb
    )
  );
}

async function atPlaceSlTp(symbol, side, qty, entryPrice) {
  const oppSide = side === "BUY" ? "SELL" : "BUY";
  const symbolInfo = await atGetExchangeInfo(symbol);
  const tickSize = getTickSize(symbolInfo);

  const slPct = getSlPct();
  const tpPct = getTpPct();

  let slPrice =
    side === "BUY"
      ? entryPrice * (1 - slPct / 100)
      : entryPrice * (1 + slPct / 100);

  let tpPrice =
    side === "BUY"
      ? entryPrice * (1 + tpPct / 100)
      : entryPrice * (1 - tpPct / 100);

  slPrice = roundPrice(slPrice, tickSize);
  tpPrice = roundPrice(tpPrice, tickSize);

  const slOrder = await promisifyBinance((cb) =>
    _binance.futuresOrder(
      oppSide,
      symbol,
      qty,
      slPrice,
      {
        type: "STOP_MARKET",
        stopPrice: slPrice,
        reduceOnly: true,
        workingType: "MARK_PRICE"
      },
      cb
    )
  );

  const tpOrder = await promisifyBinance((cb) =>
    _binance.futuresOrder(
      oppSide,
      symbol,
      qty,
      tpPrice,
      {
        type: "TAKE_PROFIT_MARKET",
        stopPrice: tpPrice,
        reduceOnly: true,
        workingType: "MARK_PRICE"
      },
      cb
    )
  );

  return {
    slPrice,
    tpPrice,
    slOrderId: slOrder.orderId,
    tpOrderId: tpOrder.orderId
  };
}

async function atCancelOrder(symbol, orderId) {
  try {
    return await promisifyBinance((cb) =>
      _binance.futuresCancel(symbol, { orderId }, cb)
    );
  } catch (err) {
    console.error("[EmoTrader] cancel order error:", err.message);
    return null;
  }
}

// ===============================
// EXECUTE EMOTION TRADE — CONFIRMATION REQUIRED
// ===============================
async function executeEmoTrade(symbol, side, leverage, rule, data) {
  try {
    if (!_config?.PERSONAL_PLAN) return;

    _config.resetPersonalStateIfNewDay?.();

    const state = _config.personalTradingState;
    const plan = _config.PERSONAL_PLAN;

    if (state.coolingDown) return;
    if (state.tradesToday >= plan.maxTradesPerDay) return;
    if (state.pnlToday <= -Math.abs(plan.maxDailyLoss)) return;
    if (state.pnlToday >= plan.dailyProfitLock) return;
    if (emoPosition || _pendingEmoTrade) return;

    const safeLeverage = getMaxAllowedLeverage(plan, leverage);

    await atSetLeverage(symbol, safeLeverage);

    const [markPrice, symbolInfo] = await Promise.all([
      atGetMarkPrice(symbol),
      atGetExchangeInfo(symbol)
    ]);

    if (!markPrice || markPrice <= 0) {
      throw new Error("No mark price available");
    }

    if (!symbolInfo) {
      throw new Error(`No exchange info for ${symbol}`);
    }

    const riskUsd = Number(plan.riskPerTrade || 1);
    const slPct = getSlPct();
    const tpPct = getTpPct();

    const stopDistanceUsd = markPrice * (slPct / 100);
    const rawQty = riskUsd / stopDistanceUsd;

    const stepSize = getLotStepSize(symbolInfo);
    const minQty = getMinQty(symbolInfo);
    const minNotional = getMinNotional(symbolInfo);

    const qty = roundQty(rawQty, stepSize);
    const notional = qty * markPrice;

    if (qty <= 0) {
      throw new Error("Calculated qty = 0");
    }

    if (minQty && qty < minQty) {
      throw new Error(`Qty too small. Qty=${qty}, minQty=${minQty}`);
    }

    if (minNotional && notional < minNotional) {
      throw new Error(
        `Notional too small: ${formatUsd(notional)}. Minimum approx: ${formatUsd(minNotional)}`
      );
    }

    const potentialWin = (riskUsd * (tpPct / slPct)).toFixed(2);

    const confluenceLines = data.pairs
      .slice(0, 8)
      .map(
        (p) =>
          `  ${p.emoji} <b>${p.symbol}</b> 5m:${formatPct(p.pct5m)} 15m:${formatPct(
            p.pct15m
          )} | funding:${formatPct(p.funding || 0)}`
      )
      .join("\n");

    _pendingEmoTrade = {
      symbol,
      side,
      qty,
      price: markPrice,
      leverage: safeLeverage,
      rule,
      data,
      riskUsd,
      slPct,
      tpPct,
      ts: Date.now()
    };

    await sendPrivate(
      `🧬 <b>EMOTION TRADE SIGNAL</b>\n\n` +
        `Transition: <b>${escapeHTML(data.transitionKey)}</b>\n` +
        `Direction: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
        `Pair: <b>${escapeHTML(symbol)}</b>\n` +
        `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
        `Qty: <b>${qty}</b>\n` +
        `Leverage: <b>${safeLeverage}x</b>\n` +
        `Notional: <b>${formatUsd(notional)}</b>\n\n` +
        `🧠 <b>Risk Model</b>\n` +
        `Max Risk: <b>-$${riskUsd.toFixed(2)}</b>\n` +
        `SL: <b>${slPct}%</b>\n` +
        `TP: <b>${tpPct}%</b>\n` +
        `R/R: <b>1:${(tpPct / slPct).toFixed(1)}</b>\n` +
        `Potential Win: <b>+$${potentialWin}</b>\n\n` +
        `📊 <b>Market Context</b>\n` +
        `5m: <b>${formatPct(data.pct5m)}</b> | 15m: <b>${formatPct(
          data.pct15m
        )}</b>\n` +
        `Funding: <b>${formatPct(fundingRates.get(symbol) || 0)}</b>\n` +
        `Liquidations 10m: <b>${data.recentLiqs}</b>\n\n` +
        `📌 <b>Confluence (${data.pairs.length} pairs)</b>\n${confluenceLines}\n\n` +
        `Strength: <b>${String(data.signalLevel).toUpperCase()}</b>\n` +
        `🧠 ${escapeHTML(rule.note)}\n\n` +
        `⚠️ <b>Manual confirmation required.</b>\n` +
        `✅ /emoconfirmar — execute\n` +
        `❌ /emocancelar — discard\n\n` +
        `⏱ Expires in 3 minutes.`
    );

    setTimeout(() => {
      if (
        _pendingEmoTrade &&
        Date.now() - _pendingEmoTrade.ts >= 3 * 60 * 1000
      ) {
        _pendingEmoTrade = null;
        sendPrivate(
          "⏱ <b>Emotion trade expired</b>\nOrder was not executed."
        );
      }
    }, 3 * 60 * 1000);
  } catch (err) {
    console.error("[EmoTrader] executeEmoTrade:", err.message);

    await sendPrivate(
      `⚠️ <b>EmoTrader error</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

async function confirmEmoTrade() {
  if (!_pendingEmoTrade) return;

  const {
    symbol,
    side,
    qty,
    price,
    leverage,
    rule,
    riskUsd,
    slPct,
    tpPct
  } = _pendingEmoTrade;

  _pendingEmoTrade = null;

  try {
    await sendPrivate(
      `⏳ <b>Executing ${side === "BUY" ? "LONG" : "SHORT"}</b>\n` +
        `Pair: <b>${escapeHTML(symbol)}</b>\n` +
        `Qty: <b>${qty}</b>\n` +
        `Leverage: <b>${leverage}x</b>`
    );

    const order = await atPlaceMarketOrder(symbol, side, qty);
    const fillPrice = parseFloat(order.avgPrice || order.price || price);

    await sleep(500);

    const { slPrice, tpPrice, slOrderId, tpOrderId } =
      await atPlaceSlTp(symbol, side, qty, fillPrice);

    emoPosition = {
      symbol,
      side,
      qty,
      entryPrice: fillPrice,
      slOrderId,
      tpOrderId,
      leverage,
      rule,
      riskUsd,
      slPct,
      tpPct,
      ts: Date.now()
    };

    lastSignalTs = Date.now();

    if (_config?.personalTradingState) {
      _config.personalTradingState.tradesToday += 1;
    }

    const potentialWin = (riskUsd * (tpPct / slPct)).toFixed(2);

    await sendPrivate(
      `✅ <b>EMOTION TRADE EXECUTED</b>\n\n` +
        `Pair: <b>${escapeHTML(symbol)}</b>\n` +
        `Direction: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
        `Entry: <b>${formatUsd(fillPrice)}</b>\n` +
        `Qty: <b>${qty}</b>\n` +
        `Leverage: <b>${leverage}x</b>\n\n` +
        `🛑 Stop Loss: <b>${formatUsd(slPrice)}</b> (-${slPct}%)\n` +
        `✅ Take Profit: <b>${formatUsd(tpPrice)}</b> (+${tpPct}%)\n` +
        `R/R: <b>1:${(tpPct / slPct).toFixed(1)}</b>\n` +
        `Max Risk: <b>-$${Number(riskUsd).toFixed(2)}</b>\n` +
        `Target: <b>+$${potentialWin}</b>\n\n` +
        `Use /emocerrar to close manually.\n` +
        `🌐 wojakmeter.com`
    );
  } catch (err) {
    console.error("[EmoTrader] confirmEmoTrade:", err.message);

    await sendPrivate(
      `⚠️ <b>Execution error</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

async function closeEmoPosition(reason = "Manual") {
  if (!emoPosition) {
    await sendPrivate("⚠️ No open EmoTrader position.");
    return;
  }

  try {
    const {
      symbol,
      side,
      qty,
      entryPrice,
      slOrderId,
      tpOrderId
    } = emoPosition;

    const closeSide = side === "BUY" ? "SELL" : "BUY";

    if (slOrderId) await atCancelOrder(symbol, slOrderId);
    if (tpOrderId) await atCancelOrder(symbol, tpOrderId);

    await sleep(300);

    const order = await atPlaceMarketOrder(symbol, closeSide, qty);
    const exitPrice = parseFloat(order.avgPrice || order.price || entryPrice);

    const pnlRaw =
      side === "BUY"
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

    const pnl = parseFloat(pnlRaw.toFixed(2));

    if (_config?.personalTradingState) {
      _config.personalTradingState.pnlToday += pnl;

      if (_config.PERSONAL_PLAN) {
        _config.PERSONAL_PLAN.balance += pnl;
      }

      if (
        _config.personalTradingState.pnlToday >=
          _config.PERSONAL_PLAN.dailyProfitLock ||
        _config.personalTradingState.pnlToday <=
          -Math.abs(_config.PERSONAL_PLAN.maxDailyLoss)
      ) {
        _config.personalTradingState.coolingDown = true;
      }
    }

    emoPosition = null;

    await sendPrivate(
      `${pnl >= 0 ? "💚" : "💔"} <b>EMOTION TRADE CLOSED</b>\n\n` +
        `Reason: <b>${escapeHTML(reason)}</b>\n` +
        `Pair: <b>${escapeHTML(symbol)}</b>\n` +
        `Side: <b>${side === "BUY" ? "LONG" : "SHORT"}</b>\n` +
        `Entry: <b>${formatUsd(entryPrice)}</b>\n` +
        `Exit: <b>${formatUsd(exitPrice)}</b>\n` +
        `PnL: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n\n` +
        `Daily PnL: <b>${
          (_config?.personalTradingState?.pnlToday || 0) >= 0 ? "+" : ""
        }${formatUsd(_config?.personalTradingState?.pnlToday || 0)}</b>\n` +
        `Balance: <b>${formatUsd(_config?.PERSONAL_PLAN?.balance || 0)}</b>`
    );
  } catch (err) {
    console.error("[EmoTrader] closeEmoPosition:", err.message);

    await sendPrivate(
      `⚠️ <b>Error closing position</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

// ===============================
// TELEGRAM HANDLERS
// ===============================
async function handleEmoStatus(ctx) {
  if (!pairState.size) {
    return ctx.reply("⏳ Loading data... wait 60 seconds.", {
      parse_mode: "HTML"
    });
  }

  const lines = EMOTION_TRADE_PAIRS.map((symbol) => {
    const state = pairState.get(symbol);

    if (!state) return `• <b>${symbol}</b> — no data`;

    const emo = EMOTIONS.find((e) => e.key === state.emotion);

    const funding = state.funding
      ? ` | F:${formatPct(state.funding)}`
      : "";

    const arrow =
      state.prevEmotion && state.prevEmotion !== state.emotion
        ? ` ← ${
            EMOTIONS.find((e) => e.key === state.prevEmotion)?.emoji || ""
          }`
        : "";

    return `${emo?.emoji || "❓"} <b>${symbol}</b> 5m:${formatPct(
      state.pct5m
    )} 15m:${formatPct(state.pct15m)}${funding}${arrow}`;
  });

  const posInfo = emoPosition
    ? `\n\n📈 <b>Open Position:</b> ${
        emoPosition.side === "BUY" ? "LONG" : "SHORT"
      } ${emoPosition.symbol} @ ${formatUsd(
        emoPosition.entryPrice
      )} | ${emoPosition.leverage}x`
    : "\n\n⬜ No open position";

  const pendingInfo = _pendingEmoTrade
    ? `\n\n⏳ <b>Pending:</b> ${_pendingEmoTrade.side} ${_pendingEmoTrade.symbol} — use /emoconfirmar or /emocancelar`
    : "";

  const recentLiqs = liquidations.filter(
    (l) => Date.now() - l.ts < 5 * 60 * 1000
  );

  return ctx.reply(
    `🧬 <b>EmoTrader v4 — Status</b>\n\n` +
      lines.join("\n") +
      posInfo +
      pendingInfo +
      `\n\n💥 Liquidations last 5min: <b>${recentLiqs.length}</b>\n` +
      `📊 Signal cooldown: <b>${Math.round(
        SIGNAL_COOLDOWN_MS / 60000
      )} min</b>\n` +
      `🧠 Confluence: weak=${CONFLUENCE.weak}, medium=${CONFLUENCE.medium}, strong=${CONFLUENCE.strong}\n` +
      `🌐 wojakmeter.com`,
    {
      parse_mode: "HTML",
      disable_web_page_preview: true
    }
  );
}

async function handleEmoHistory(ctx) {
  if (!transitionHistory.length) {
    return ctx.reply("📜 No transitions recorded yet.");
  }

  const lines = transitionHistory.slice(0, 15).map((t) => {
    const rule = TRANSITION_RULES[t.transitionKey];

    const icon =
      rule?.action === "LONG"
        ? "📈"
        : rule?.action === "SHORT"
          ? "📉"
          : "🔄";

    const time = new Date(t.ts).toTimeString().slice(0, 5);

    return `${icon} <b>${t.symbol}</b> ${escapeHTML(
      t.transitionKey
    )} 5m:${formatPct(t.pct5m)} 15m:${formatPct(
      t.pct15m || 0
    )} [${time}]`;
  });

  return ctx.reply(
    `📜 <b>EmoTrader — History</b>\n\n${lines.join(
      "\n"
    )}\n\n🌐 wojakmeter.com`,
    {
      parse_mode: "HTML"
    }
  );
}

async function handleEmoPairs(ctx) {
  return ctx.reply(
    `📋 <b>EmoTrader — ${EMOTION_TRADE_PAIRS.length} Pairs</b>\n\n` +
      EMOTION_TRADE_PAIRS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    {
      parse_mode: "HTML"
    }
  );
}

async function handleEmoConfirmar(ctx) {
  if (!_pendingEmoTrade) {
    return ctx.reply("⚠️ No pending emotion trade.");
  }

  await ctx.reply("✅ Confirmed. Executing...");

  await confirmEmoTrade();
}

async function handleEmoCancelar(ctx) {
  if (!_pendingEmoTrade) {
    return ctx.reply("⚠️ No pending emotion trade.");
  }

  const { side, symbol } = _pendingEmoTrade;

  _pendingEmoTrade = null;

  return ctx.reply(`❌ Emotion trade ${side} on ${symbol} cancelled.`);
}

async function handleEmoCerrar(ctx) {
  if (!emoPosition) {
    return ctx.reply("⚠️ No open EmoTrader position.");
  }

  await ctx.reply("⏳ Closing position...");

  await closeEmoPosition("Manual via Telegram");
}

// ===============================
// INIT
// ===============================
function start(config) {
  _config = config;

  _binance = new Binance().options({
    APIKEY: config.binanceApiKey || "",
    APISECRET: config.binanceApiSecret || "",
    useServerTime: true,
    recvWindow: 10000,
    urls: {
      base: config.useTestnet
        ? "https://testnet.binancefuture.com/fapi/"
        : "https://fapi.binance.com/fapi/"
    }
  });

  connectWebSocket();

  fetchFundingRates();

  setTimeout(async () => {
    await fetchCoinGeckoFallback();
    console.log("[EmoTrader] Base data loaded via CoinGecko fallback");
  }, 3000);

  startEvaluationLoop();

  setInterval(fetchFundingRates, FUNDING_REFRESH_MS);

  setInterval(fetchCoinGeckoFallback, 5 * 60 * 1000);

  console.log(
    `[EmoTrader] ===== STARTED v4 SAFE-CONFIRM ===== ` +
      `${EMOTION_TRADE_PAIRS.length} pairs | WS + Funding + Liquidations | ` +
      `confluence: weak=${CONFLUENCE.weak} medium=${CONFLUENCE.medium} strong=${CONFLUENCE.strong} | ` +
      `cooldown: ${SIGNAL_COOLDOWN_MS / 60000}min | testnet: ${
        config.useTestnet
      }`
  );
}

// ===============================
// EXPORTS
// ===============================
module.exports = {
  start,

  handleEmoStatus,
  handleEmoHistory,
  handleEmoPairs,

  handleEmoConfirmar,
  handleEmoCancelar,
  handleEmoCerrar,

  getEmoPosition: () => emoPosition,

  getPairState: () => Object.fromEntries(pairState),

  getHistory: () => transitionHistory
};