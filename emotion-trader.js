// ===============================
// WOJAKMETER — EMOTION TRADER v2
// REST polling en lugar de WebSocket
// Más confiable en hosting cloud (Railway, Heroku, etc.)
// ===============================

const Binance = require("node-binance-api");

// ===============================
// PAIRS — 27 pares monitoreados
// ===============================
const EMOTION_TRADE_PAIRS = [
  // Top Market Cap
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
  "AVAXUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT", "UNIUSDT",
  // Meme coins
  "DOGEUSDT", "PEPEUSDT", "WIFUSDT", "SHIBUSDT", "FLOKIUSDT",
  "BONKUSDT", "MEMEUSDT",
  // Alto volumen futuros
  "SOLUSDT", "LINKUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT", "SUIUSDT", "INJUSDT", "TIAUSDT", "SEIUSDT"
];

// ===============================
// EMOTION CONFIG
// ===============================
const EMOTIONS = [
  { key: "euphoria",    emoji: "🤩", label: "Euphoria",    minPct:  12    },
  { key: "content",     emoji: "😌", label: "Content",     minPct:   6    },
  { key: "optimism",    emoji: "🙂", label: "Optimism",    minPct:   2    },
  { key: "neutral",     emoji: "😐", label: "Neutral",     minPct:  -2    },
  { key: "doubt",       emoji: "🤔", label: "Doubt",       minPct:  -5    },
  { key: "concern",     emoji: "😟", label: "Concern",     minPct:  -8    },
  { key: "frustration", emoji: "😡", label: "Frustration", minPct: -9999  },
];

const EMOTION_ORDER = EMOTIONS.map((e) => e.key);

// ===============================
// TRANSITION RULES
// ===============================
const TRANSITION_RULES = {
  "neutral→optimism":    { action: "LONG",        leverage: 3, strength: "medium", note: "Mercado despertando al alza" },
  "optimism→content":    { action: "LONG",        leverage: 4, strength: "strong", note: "Momentum alcista confirmado" },
  "doubt→neutral":       { action: "LONG",        leverage: 3, strength: "medium", note: "Presión bajista cediendo" },
  "frustration→concern": { action: "LONG",        leverage: 3, strength: "medium", note: "Posible suelo emocional" },
  "concern→doubt":       { action: "LONG",        leverage: 4, strength: "strong", note: "Reversión desde pánico" },
  "neutral→doubt":       { action: "SHORT",       leverage: 3, strength: "medium", note: "Mercado perdiendo convicción" },
  "doubt→concern":       { action: "SHORT",       leverage: 4, strength: "strong", note: "Presión bajista confirmada" },
  "optimism→neutral":    { action: "SHORT",       leverage: 3, strength: "medium", note: "Momentum alcista perdiendo fuerza" },
  "euphoria→content":    { action: "SHORT",       leverage: 3, strength: "medium", note: "Posible techo emocional" },
  "content→optimism":    { action: "SHORT",       leverage: 3, strength: "weak",   note: "Enfriamiento desde zona alta" },
  "optimism→euphoria":   { action: "CLOSE_LONG",  leverage: 0, strength: "exit",   note: "Euforia — cerrar LONG, no perseguir" },
  "concern→frustration": { action: "CLOSE_SHORT", leverage: 0, strength: "exit",   note: "Pánico extremo — cerrar SHORT" },
};

// ===============================
// CONFLUENCE THRESHOLDS
// ===============================
const CONFLUENCE = { weak: 1, medium: 3, strong: 6 };

// ===============================
// POLL INTERVAL
// ===============================
const POLL_INTERVAL_MS = 30 * 1000; // cada 30 segundos

// ===============================
// STATE
// ===============================
let _config  = null;
let _binance = null;

// { symbol: { emotion, prevEmotion, pct, price, ts } }
const pairState = new Map();

const transitionHistory = [];
const MAX_HISTORY = 50;

let lastSignalTs = 0;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;

let emoPosition      = null;
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
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000)     return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000)         return `$${(num / 1_000).toFixed(2)}K`;
  if (num >= 1)             return `$${num.toFixed(2)}`;
  return `$${num.toFixed(6)}`;
}

function formatPct(n) {
  return `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getEmotion(pct) {
  const n = Number(pct) || 0;
  for (const e of EMOTIONS) {
    if (n >= e.minPct) return e;
  }
  return EMOTIONS[EMOTIONS.length - 1];
}

function getTransitionKey(prev, next) {
  return `${prev}→${next}`;
}

// ===============================
// FETCH PRICES FROM BINANCE REST
// Usa el endpoint público de futuros — no requiere API key
// ===============================
async function fetchAllTickers() {
  try {
    // Usa CoinGecko — ya funciona desde Railway
    const url = "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1" +
      "&sparkline=false&price_change_percentage=24h";

    const cgHeaders = { "User-Agent": "WojakMeterBot/2.0", "Accept": "application/json" };
    if (process.env.COINGECKO_API_KEY) cgHeaders["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
    const res = await fetch(url, {
      headers: cgHeaders,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const coins = await res.json();
    if (!Array.isArray(coins)) return [];

    // Convertir formato CoinGecko → formato interno
    return coins.map((c) => ({
      symbol:             (c.symbol || "").toUpperCase() + "USDT",
      lastPrice:          String(c.current_price || 0),
      priceChangePercent: String(c.price_change_percentage_24h || 0),
    }));
  } catch (err) {
    console.error("[EmoTrader] fetchAllTickers error:", err.message);
    return [];
  }
}

// ===============================
// POLL LOOP — cada 30 segundos
// ===============================
async function pollLoop() {
  console.log("[EmoTrader] Iniciando poll REST...");

  // Primer poll inmediato al arrancar
  try {
    console.log("[EmoTrader] Primer poll inmediato...");
    const firstTickers = await fetchAllTickers();
    console.log(`[EmoTrader] Primer poll resultado: ${firstTickers.length} tickers`);
    if (firstTickers.length > 0) {
      const tickerMap = new Map(firstTickers.map((t) => [t.symbol, t]));
      for (const symbol of EMOTION_TRADE_PAIRS) {
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;
        const pct   = parseFloat(ticker.priceChangePercent || 0);
        const price = parseFloat(ticker.lastPrice || 0);
        pairState.set(symbol, { emotion: getEmotion(pct).key, prevEmotion: null, pct, price, ts: Date.now() });
      }
      console.log(`[EmoTrader] Estado inicial cargado: ${pairState.size} pares`);
    }
  } catch (err) {
    console.error("[EmoTrader] Error en primer poll:", err.message);
  }

  setInterval(async () => {
    try {
      const tickers = await fetchAllTickers();
      if (!tickers.length) {
        console.warn("[EmoTrader] Poll sin datos");
        return;
      }

      // Crear mapa rápido symbol → ticker
      const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));

      for (const symbol of EMOTION_TRADE_PAIRS) {
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;

        const pct   = parseFloat(ticker.priceChangePercent || 0);
        const price = parseFloat(ticker.lastPrice || 0);
        const emotion = getEmotion(pct);

        const existing    = pairState.get(symbol);
        const prevEmotion = existing?.emotion || null;

        pairState.set(symbol, {
          emotion:     emotion.key,
          prevEmotion,
          pct,
          price,
          ts: Date.now(),
        });

        // Detectar transición
        if (prevEmotion && prevEmotion !== emotion.key) {
          await processTransition(symbol, prevEmotion, emotion.key, pct, price);
        }
      }

      console.log(`[EmoTrader] Poll OK — ${pairState.size} pares actualizados`);
    } catch (err) {
      console.error("[EmoTrader] pollLoop error:", err.message);
    }
  }, POLL_INTERVAL_MS);
}

// ===============================
// PROCESS TRANSITION
// ===============================
async function processTransition(symbol, prevEmotion, nextEmotion, pct, price) {
  const transitionKey = getTransitionKey(prevEmotion, nextEmotion);
  const rule          = TRANSITION_RULES[transitionKey];

  if (!rule) return;

  transitionHistory.unshift({ symbol, transitionKey, action: rule.action, strength: rule.strength, pct, ts: Date.now() });
  if (transitionHistory.length > MAX_HISTORY) transitionHistory.pop();

  console.log(`[EmoTrader] ${symbol}: ${transitionKey} → ${rule.action} (${rule.strength})`);

  // Señales de cierre
  if (rule.action === "CLOSE_LONG" && emoPosition?.side === "BUY") {
    await closeEmoPosition(`Señal emocional: ${transitionKey}`);
    return;
  }
  if (rule.action === "CLOSE_SHORT" && emoPosition?.side === "SELL") {
    await closeEmoPosition(`Señal emocional: ${transitionKey}`);
    return;
  }

  if (rule.action !== "LONG" && rule.action !== "SHORT") return;

  if (Date.now() - lastSignalTs < SIGNAL_COOLDOWN_MS) return;
  if (emoPosition) return;
  if (_pendingEmoTrade) return;

  // Medir confluencia
  const confluencePairs = [];
  for (const [sym, state] of pairState.entries()) {
    if (!state.prevEmotion || !state.emotion) continue;
    if (getTransitionKey(state.prevEmotion, state.emotion) === transitionKey) {
      const emo = EMOTIONS.find((e) => e.key === state.emotion);
      confluencePairs.push({ symbol: sym, emoji: emo?.emoji || "❓", transition: transitionKey, pct: state.pct });
    }
  }

  const count = confluencePairs.length;
  let signalLevel = null;
  if (count >= CONFLUENCE.strong) signalLevel = "strong";
  else if (count >= CONFLUENCE.medium) signalLevel = "medium";
  else if (count >= CONFLUENCE.weak) signalLevel = "weak";

  if (!signalLevel) return;

  // Solo alertar para señales débiles
  if (signalLevel === "weak") {
    await sendPrivate(
      `🟡 <b>EmoTrader — Señal Débil</b>\n\n` +
      `Transición: <b>${escapeHTML(transitionKey)}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Precio: <b>${formatUsd(price)}</b>\n` +
      `Movimiento 24h: <b>${formatPct(pct)}</b>\n` +
      `Confluencia: <b>${count} par(es)</b>\n\n` +
      `ℹ️ Señal insuficiente para operar. Monitoreando...`
    );
    return;
  }

  // Señal media o fuerte → proponer trade
  const side       = rule.action === "LONG" ? "BUY" : "SELL";
  const bestPair   = confluencePairs.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
  const tradeSymbol = bestPair?.symbol || symbol;

  await executeEmoTrade(tradeSymbol, side, rule.leverage, rule, {
    transitionKey,
    pairs: confluencePairs,
    signalLevel,
  });
}

// ===============================
// SEND PRIVATE
// ===============================
async function sendPrivate(text) {
  if (!_config?.bot || !_config?.PRIVATE_TELEGRAM_USER_ID) return;
  try {
    await _config.bot.telegram.sendMessage(_config.PRIVATE_TELEGRAM_USER_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("[EmoTrader] sendPrivate:", err.message);
  }
}

// ===============================
// BINANCE FUTURES ORDERS
// ===============================
async function atSetLeverage(symbol, leverage) {
  return new Promise((resolve, reject) => {
    _binance.futuresLeverage(symbol, leverage, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function atGetMarkPrice(symbol) {
  return new Promise((resolve, reject) => {
    _binance.futuresMarkPrice(symbol, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(parseFloat(res?.markPrice || res?.price || 0));
    });
  });
}

async function atGetExchangeInfo(symbol) {
  return new Promise((resolve, reject) => {
    _binance.futuresExchangeInfo((err, info) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve((info?.symbols || []).find((s) => s.symbol === symbol) || null);
    });
  });
}

function getLotStepSize(symbolInfo) {
  const f = (symbolInfo?.filters || []).find((f) => f.filterType === "LOT_SIZE");
  return parseFloat(f?.stepSize || "0.001");
}

function roundQty(qty, stepSize) {
  const precision = Math.round(-Math.log10(stepSize));
  return parseFloat(qty.toFixed(precision));
}

async function atPlaceMarketOrder(symbol, side, qty) {
  return new Promise((resolve, reject) => {
    _binance.futuresOrder(side, symbol, qty, false, { type: "MARKET" }, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function atPlaceSlTp(symbol, side, qty, entryPrice) {
  const oppSide = side === "BUY" ? "SELL" : "BUY";
  const slPct   = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);
  const tpPct   = Number(process.env.AUTO_TRADE_TP_PCT || 3.0);

  const slPrice = side === "BUY"
    ? parseFloat((entryPrice * (1 - slPct / 100)).toFixed(2))
    : parseFloat((entryPrice * (1 + slPct / 100)).toFixed(2));

  const tpPrice = side === "BUY"
    ? parseFloat((entryPrice * (1 + tpPct / 100)).toFixed(2))
    : parseFloat((entryPrice * (1 - tpPct / 100)).toFixed(2));

  const slOrder = await new Promise((resolve, reject) => {
    _binance.futuresOrder(oppSide, symbol, qty, slPrice,
      { type: "STOP_MARKET", stopPrice: slPrice, closePosition: true },
      (err, res) => { if (err) return reject(new Error(err.body || err.message)); resolve(res); }
    );
  });

  const tpOrder = await new Promise((resolve, reject) => {
    _binance.futuresOrder(oppSide, symbol, qty, tpPrice,
      { type: "TAKE_PROFIT_MARKET", stopPrice: tpPrice, closePosition: true },
      (err, res) => { if (err) return reject(new Error(err.body || err.message)); resolve(res); }
    );
  });

  return { slPrice, tpPrice, slOrderId: slOrder.orderId, tpOrderId: tpOrder.orderId };
}

async function atCancelOrder(symbol, orderId) {
  return new Promise((resolve) => {
    _binance.futuresCancel(symbol, { orderId }, () => resolve());
  });
}

// ===============================
// EXECUTE TRADE
// ===============================
async function executeEmoTrade(symbol, side, leverage, rule, confluenceData) {
  try {
    if (!_config?.PERSONAL_PLAN) return;
    _config.resetPersonalStateIfNewDay?.();

    const state = _config.personalTradingState;
    const plan  = _config.PERSONAL_PLAN;

    if (state.coolingDown)                               return;
    if (state.tradesToday >= plan.maxTradesPerDay)       return;
    if (state.pnlToday <= -Math.abs(plan.maxDailyLoss)) return;
    if (state.pnlToday >= plan.dailyProfitLock)         return;
    if (emoPosition)                                     return;

    await atSetLeverage(symbol, leverage);
    const [markPrice, symbolInfo] = await Promise.all([
      atGetMarkPrice(symbol),
      atGetExchangeInfo(symbol),
    ]);

    if (!markPrice) throw new Error("No mark price");

    const riskUsd  = plan.riskPerTrade;
    const notional = riskUsd * leverage;
    const stepSize = getLotStepSize(symbolInfo);
    const qty      = roundQty(notional / markPrice, stepSize);
    if (qty <= 0) throw new Error("Qty = 0");

    const slPct = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);
    const tpPct = Number(process.env.AUTO_TRADE_TP_PCT || 3.0);

    const confluenceLines = confluenceData.pairs
      .slice(0, 8)
      .map((p) => `  ${p.emoji} <b>${p.symbol}</b> ${formatPct(p.pct)}`)
      .join("\n");

    _pendingEmoTrade = { symbol, side, qty, price: markPrice, leverage, rule, confluenceData, ts: Date.now() };

    await sendPrivate(
      `🧬 <b>EMOTION TRADE PENDIENTE</b>\n\n` +
      `Transición: <b>${escapeHTML(confluenceData.transitionKey)}</b>\n` +
      `Dirección: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
      `Qty: <b>${qty}</b> | Leverage: <b>${leverage}x</b>\n` +
      `Risk: <b>${formatUsd(riskUsd)}</b> | Notional: <b>${formatUsd(notional)}</b>\n` +
      `SL: <b>${slPct}%</b> | TP: <b>${tpPct}%</b>\n\n` +
      `🧠 <b>Por qué:</b> ${escapeHTML(rule.note)}\n\n` +
      `📊 <b>Confluencia (${confluenceData.pairs.length} pares):</b>\n` +
      `${confluenceLines}\n\n` +
      `Fuerza: <b>${escapeHTML(confluenceData.signalLevel.toUpperCase())}</b>\n\n` +
      `✅ /emoconfirmar — ejecutar\n` +
      `❌ /emocancelar  — descartar\n\n` +
      `⚠️ Expira en 3 minutos.`
    );

    setTimeout(() => {
      if (_pendingEmoTrade && Date.now() - _pendingEmoTrade.ts >= 3 * 60 * 1000) {
        _pendingEmoTrade = null;
        sendPrivate("⏱ <b>Emotion trade expirado</b> (3 min sin confirmar).");
      }
    }, 3 * 60 * 1000);

  } catch (err) {
    console.error("[EmoTrader] executeEmoTrade:", err.message);
    await sendPrivate(`⚠️ <b>EmoTrader error</b>\n${escapeHTML(err.message)}`);
  }
}

async function confirmEmoTrade() {
  if (!_pendingEmoTrade) return;
  const { symbol, side, qty, price, leverage, rule } = _pendingEmoTrade;
  _pendingEmoTrade = null;

  try {
    await sendPrivate(`⏳ Ejecutando ${side === "BUY" ? "LONG" : "SHORT"} en ${symbol}...`);
    const order     = await atPlaceMarketOrder(symbol, side, qty);
    const fillPrice = parseFloat(order.avgPrice || order.price || price);

    await sleep(500);
    const { slPrice, tpPrice, slOrderId, tpOrderId } = await atPlaceSlTp(symbol, side, qty, fillPrice);

    emoPosition = { symbol, side, qty, entryPrice: fillPrice, slOrderId, tpOrderId, leverage, rule, ts: Date.now() };
    lastSignalTs = Date.now();

    if (_config?.personalTradingState) _config.personalTradingState.tradesToday += 1;

    await sendPrivate(
      `✅ <b>EMOTION TRADE EJECUTADO</b>\n\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Dirección: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(fillPrice)}</b>\n` +
      `Qty: <b>${qty}</b> | Leverage: <b>${leverage}x</b>\n\n` +
      `🛑 SL: <b>${formatUsd(slPrice)}</b>\n` +
      `✅ TP: <b>${formatUsd(tpPrice)}</b>\n\n` +
      `🧠 ${escapeHTML(rule.note)}\n\n` +
      `Usa /emocerrar para cerrar manualmente.\n` +
      `🌐 wojakmeter.com`
    );

    console.log(`[EmoTrader] Trade ejecutado: ${side} ${symbol} entry=${fillPrice}`);
  } catch (err) {
    console.error("[EmoTrader] confirmEmoTrade:", err.message);
    await sendPrivate(`⚠️ <b>Error al ejecutar</b>\n${escapeHTML(err.message)}`);
  }
}

async function closeEmoPosition(reason = "Manual") {
  if (!emoPosition) { await sendPrivate("⚠️ No hay posición de EmoTrader abierta."); return; }
  try {
    const { symbol, side, qty, entryPrice, slOrderId, tpOrderId } = emoPosition;
    const closeSide = side === "BUY" ? "SELL" : "BUY";

    if (slOrderId) await atCancelOrder(symbol, slOrderId);
    if (tpOrderId) await atCancelOrder(symbol, tpOrderId);
    await sleep(300);

    const order     = await atPlaceMarketOrder(symbol, closeSide, qty);
    const exitPrice = parseFloat(order.avgPrice || order.price || entryPrice);
    const pnlRaw    = side === "BUY" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    const pnl       = parseFloat(pnlRaw.toFixed(2));

    if (_config?.personalTradingState) {
      _config.personalTradingState.pnlToday += pnl;
      if (_config.PERSONAL_PLAN) _config.PERSONAL_PLAN.balance += pnl;
      if (
        _config.personalTradingState.pnlToday >= _config.PERSONAL_PLAN.dailyProfitLock ||
        _config.personalTradingState.pnlToday <= -Math.abs(_config.PERSONAL_PLAN.maxDailyLoss)
      ) _config.personalTradingState.coolingDown = true;
    }

    emoPosition = null;

    await sendPrivate(
      `${pnl >= 0 ? "💚" : "💔"} <b>EMOTION TRADE CERRADO</b>\n\n` +
      `Razón: <b>${escapeHTML(reason)}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Side: <b>${side === "BUY" ? "LONG" : "SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(entryPrice)}</b>\n` +
      `Exit: <b>${formatUsd(exitPrice)}</b>\n` +
      `PnL: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n\n` +
      `🌐 wojakmeter.com`
    );
  } catch (err) {
    console.error("[EmoTrader] closeEmoPosition:", err.message);
    await sendPrivate(`⚠️ <b>Error al cerrar</b>\n${escapeHTML(err.message)}`);
  }
}

// ===============================
// TELEGRAM HANDLERS
// ===============================
async function handleEmoStatus(ctx) {
  if (!pairState.size) {
    return ctx.reply("⏳ Cargando datos... espera 30 segundos y vuelve a intentar.", { parse_mode: "HTML" });
  }

  const lines = EMOTION_TRADE_PAIRS.map((symbol) => {
    const state = pairState.get(symbol);
    if (!state) return `• <b>${symbol}</b> — sin datos`;
    const emo   = EMOTIONS.find((e) => e.key === state.emotion);
    const arrow = state.prevEmotion && state.prevEmotion !== state.emotion
      ? ` ← ${EMOTIONS.find((e) => e.key === state.prevEmotion)?.emoji || ""}`
      : "";
    return `${emo?.emoji || "❓"} <b>${symbol}</b> ${formatPct(state.pct)}${arrow}`;
  });

  const posInfo = emoPosition
    ? `\n\n📈 <b>Posición abierta:</b>\n${emoPosition.side === "BUY" ? "LONG" : "SHORT"} ${emoPosition.symbol} entry ${formatUsd(emoPosition.entryPrice)}`
    : "\n\n⬜ Sin posición abierta";

  return ctx.reply(
    `🧬 <b>EmoTrader — Estado Actual</b>\n\n` +
    lines.join("\n") + posInfo + `\n\n🌐 wojakmeter.com`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
}

async function handleEmoHistory(ctx) {
  if (!transitionHistory.length) return ctx.reply("📜 Sin transiciones registradas aún.");
  const lines = transitionHistory.slice(0, 15).map((t) => {
    const rule = TRANSITION_RULES[t.transitionKey];
    const icon = rule?.action === "LONG" ? "📈" : rule?.action === "SHORT" ? "📉" : "🔄";
    const time = new Date(t.ts).toTimeString().slice(0, 5);
    return `${icon} <b>${t.symbol}</b> ${escapeHTML(t.transitionKey)} [${time}]`;
  });
  return ctx.reply(
    `📜 <b>EmoTrader — Historial</b>\n\n` + lines.join("\n") + `\n\n🌐 wojakmeter.com`,
    { parse_mode: "HTML" }
  );
}

async function handleEmoPairs(ctx) {
  return ctx.reply(
    `📋 <b>EmoTrader — ${EMOTION_TRADE_PAIRS.length} Pares Monitoreados</b>\n\n` +
    EMOTION_TRADE_PAIRS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    { parse_mode: "HTML" }
  );
}

async function handleEmoConfirmar(ctx) {
  if (!_pendingEmoTrade) return ctx.reply("⚠️ No hay trade pendiente de confirmación.");
  await ctx.reply("✅ Confirmado. Ejecutando...");
  await confirmEmoTrade();
}

async function handleEmoCancelar(ctx) {
  if (!_pendingEmoTrade) return ctx.reply("⚠️ No hay trade pendiente.");
  const { side, symbol } = _pendingEmoTrade;
  _pendingEmoTrade = null;
  return ctx.reply(`❌ Emotion trade ${side} en ${symbol} cancelado.`);
}

async function handleEmoCerrar(ctx) {
  if (!emoPosition) return ctx.reply("⚠️ No hay posición de EmoTrader abierta.");
  await ctx.reply("⏳ Cerrando posición...");
  await closeEmoPosition("Manual por Telegram");
}

// ===============================
// INIT
// ===============================
function start(config) {
  _config = config;

  _binance = new Binance().options({
    APIKEY:        config.binanceApiKey    || "",
    APISECRET:     config.binanceApiSecret || "",
    useServerTime: true,
    recvWindow:    10000,
    urls: {
      base: config.useTestnet
        ? "https://testnet.binancefuture.com/fapi/"
        : "https://fapi.binance.com/fapi/",
    },
  });

  pollLoop();
  console.log(`[EmoTrader] ===== INICIADO ===== ${EMOTION_TRADE_PAIRS.length} pares | poll cada ${POLL_INTERVAL_MS / 1000}s | testnet: ${config.useTestnet}`);
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
  getPairState:   () => Object.fromEntries(pairState),
  getHistory:     () => transitionHistory,
};
