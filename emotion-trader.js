// ===============================
// WOJAKMETER — EMOTION TRADER
// Sistema de auto-trade basado en estados emocionales
// y transiciones entre ellos via WebSocket de Binance
//
// INTEGRACIÓN EN index.js:
//   1. Al inicio del archivo:
//      const emotionTrader = require("./emotion-trader");
//
//   2. Al final del bloque de inicio (después de bot.launch()):
//      emotionTrader.start({
//        bot,
//        PERSONAL_PLAN,
//        personalTradingState,
//        resetPersonalStateIfNewDay,
//        PRIVATE_TELEGRAM_USER_ID: process.env.PRIVATE_TELEGRAM_USER_ID,
//        binanceApiKey: process.env.BINANCE_API_KEY,
//        binanceApiSecret: process.env.BINANCE_API_SECRET,
//        useTestnet: process.env.BINANCE_TESTNET !== "false",
//      });
//
//   3. Nuevos commands en index.js:
//      bot.command("emostatus",  (ctx) => emotionTrader.handleEmoStatus(ctx));
//      bot.command("emohistory", (ctx) => emotionTrader.handleEmoHistory(ctx));
//      bot.command("emopairs",   (ctx) => emotionTrader.handleEmoPairs(ctx));
//
//   4. En buildMainKeyboard() añadir:
//      ["🧬 Emo Status", "📜 Emo History"],
//
//   5. En el handler de texto:
//      if (text.includes("Emo Status"))  return emotionTrader.handleEmoStatus(ctx);
//      if (text.includes("Emo History")) return emotionTrader.handleEmoHistory(ctx);
// ===============================

const WebSocket = require("ws");
const Binance   = require("node-binance-api");

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
  { key: "euphoria",    emoji: "🤩", label: "Euphoria",    minPct: 12    },
  { key: "content",     emoji: "😌", label: "Content",     minPct: 6     },
  { key: "optimism",    emoji: "🙂", label: "Optimism",    minPct: 2     },
  { key: "neutral",     emoji: "😐", label: "Neutral",     minPct: -2    },
  { key: "doubt",       emoji: "🤔", label: "Doubt",       minPct: -5    },
  { key: "concern",     emoji: "😟", label: "Concern",     minPct: -8    },
  { key: "frustration", emoji: "😡", label: "Frustration", minPct: -9999 },
];

// Orden numérico: 0=euphoria ... 6=frustration
const EMOTION_ORDER = EMOTIONS.map((e) => e.key);

// ===============================
// TRANSITION RULES
// Qué hacer cuando el mercado transiciona entre estados
// ===============================
const TRANSITION_RULES = {
  // Entradas LONG (mercado mejorando)
  "neutral→optimism":    { action: "LONG",  leverage: 3, strength: "medium", note: "Mercado despertando al alza" },
  "optimism→content":    { action: "LONG",  leverage: 4, strength: "strong", note: "Momentum confirmado" },
  "doubt→neutral":       { action: "LONG",  leverage: 3, strength: "medium", note: "Presión bajista cediendo" },
  "frustration→concern": { action: "LONG",  leverage: 3, strength: "medium", note: "Posible suelo emocional" },
  "concern→doubt":       { action: "LONG",  leverage: 4, strength: "strong", note: "Reversión desde pánico" },

  // Entradas SHORT (mercado deteriorando)
  "neutral→doubt":       { action: "SHORT", leverage: 3, strength: "medium", note: "Mercado perdiendo convicción" },
  "doubt→concern":       { action: "SHORT", leverage: 4, strength: "strong", note: "Presión bajista confirmada" },
  "optimism→neutral":    { action: "SHORT", leverage: 3, strength: "medium", note: "Momentum alcista perdiendo fuerza" },
  "euphoria→content":    { action: "SHORT", leverage: 3, strength: "medium", note: "Posible techo emocional" },
  "content→optimism":    { action: "SHORT", leverage: 3, strength: "weak",   note: "Enfriamiento desde zona alta" },

  // Señales de cierre (no abrir, cerrar si hay posición)
  "optimism→euphoria":   { action: "CLOSE_LONG",  leverage: 0, strength: "exit", note: "Euforia — cerrar LONG, no perseguir" },
  "concern→frustration": { action: "CLOSE_SHORT", leverage: 0, strength: "exit", note: "Pánico extremo — cerrar SHORT" },
};

// ===============================
// CONFLUENCE THRESHOLDS
// Cuántos pares necesitan alinearse para disparar señal
// ===============================
const CONFLUENCE = {
  weak:   1,   // solo alerta, no opera
  medium: 3,   // avisa + pide confirmación
  strong: 6,   // señal fuerte
};

// ===============================
// STATE
// ===============================
let _config       = null;
let _binance      = null;
let _ws           = null;
let _wsReconnectTimer = null;

// Estado emocional actual por par
// { "BTCUSDT": { emotion, prevEmotion, pct5m, pct1m, price, ts } }
const pairState = new Map();

// Historial de transiciones recientes
const transitionHistory = [];
const MAX_HISTORY = 50;

// Última señal enviada (cooldown)
let lastSignalTs  = 0;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; // 15 min entre señales

// Precios de ticker acumulados para calcular % de movimiento
// { "BTCUSDT": [ {price, ts}, ... ] }
const priceBuffer = new Map();
const BUFFER_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

// Posición activa del emotion trader
let emoPosition = null;

// ===============================
// HELPERS
// ===============================
function escapeHTML(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function getEmotion(pct5m) {
  const n = Number(pct5m) || 0;
  for (const e of EMOTIONS) {
    if (n >= e.minPct) return e;
  }
  return EMOTIONS[EMOTIONS.length - 1];
}

function getEmotionIndex(key) {
  return EMOTION_ORDER.indexOf(key);
}

function isMovingBullish(prevKey, nextKey) {
  return getEmotionIndex(nextKey) < getEmotionIndex(prevKey);
}

function isMovingBearish(prevKey, nextKey) {
  return getEmotionIndex(nextKey) > getEmotionIndex(prevKey);
}

function getTransitionKey(prevKey, nextKey) {
  return `${prevKey}→${nextKey}`;
}

// Calcula % de cambio en los últimos N ms
function calcPctChange(symbol, windowMs = BUFFER_WINDOW_MS) {
  const buf = priceBuffer.get(symbol);
  if (!buf || buf.length < 2) return 0;

  const now    = Date.now();
  const cutoff = now - windowMs;
  const recent = buf.filter((p) => p.ts >= cutoff);

  if (recent.length < 2) return 0;

  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;

  if (!oldest) return 0;
  return ((newest - oldest) / oldest) * 100;
}

function pushPrice(symbol, price) {
  if (!priceBuffer.has(symbol)) priceBuffer.set(symbol, []);
  const buf = priceBuffer.get(symbol);
  buf.push({ price: Number(price), ts: Date.now() });

  // Limpiar entradas viejas (más de 10 min)
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
}

// ===============================
// BINANCE FUTURES ORDER (reutiliza lógica del index.js)
// ===============================
async function setLeverage(symbol, leverage) {
  return new Promise((resolve, reject) => {
    _binance.futuresLeverage(symbol, leverage, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function getMarkPrice(symbol) {
  return new Promise((resolve, reject) => {
    _binance.futuresMarkPrice(symbol, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(parseFloat(res?.markPrice || res?.price || 0));
    });
  });
}

async function getExchangeInfo(symbol) {
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

async function placeMarketOrder(symbol, side, qty) {
  return new Promise((resolve, reject) => {
    _binance.futuresOrder(side, symbol, qty, false, { type: "MARKET" }, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function placeSlTp(symbol, side, qty, entryPrice, slPct = 1.5, tpEmotion = null) {
  const oppSide = side === "BUY" ? "SELL" : "BUY";
  const slPrice = side === "BUY"
    ? parseFloat((entryPrice * (1 - slPct / 100)).toFixed(2))
    : parseFloat((entryPrice * (1 + slPct / 100)).toFixed(2));

  // TP dinámico basado en emoción objetivo si se provee, sino fijo 3%
  const tpPct   = 3.0;
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

async function cancelOrder(symbol, orderId) {
  return new Promise((resolve) => {
    _binance.futuresCancel(symbol, { orderId }, (err) => {
      if (err) console.error("[EmoTrader] cancelOrder:", err.message);
      resolve();
    });
  });
}

// ===============================
// SEND PRIVATE MESSAGE
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
// EXECUTE TRADE
// ===============================
async function executeEmoTrade(symbol, side, leverage, rule, confluenceData) {
  try {
    if (!_config?.PERSONAL_PLAN) return;
    _config.resetPersonalStateIfNewDay?.();

    const state = _config.personalTradingState;
    const plan  = _config.PERSONAL_PLAN;

    if (state.coolingDown)                              return;
    if (state.tradesToday >= plan.maxTradesPerDay)      return;
    if (state.pnlToday <= -Math.abs(plan.maxDailyLoss)) return;
    if (state.pnlToday >= plan.dailyProfitLock)         return;
    if (emoPosition)                                    return;

    await setLeverage(symbol, leverage);

    const [markPrice, symbolInfo] = await Promise.all([
      getMarkPrice(symbol),
      getExchangeInfo(symbol),
    ]);

    if (!markPrice) throw new Error("No mark price");

    const riskUsd  = plan.riskPerTrade;
    const notional = riskUsd * leverage;
    const stepSize = getLotStepSize(symbolInfo);
    const qty      = roundQty(notional / markPrice, stepSize);

    if (qty <= 0) throw new Error("Qty = 0");

    const slPct = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);

    // Construir mensaje de confirmación
    const confluenceLines = confluenceData.pairs
      .map((p) => `  ${p.emoji} <b>${p.symbol}</b> → ${p.transition}`)
      .join("\n");

    await sendPrivate(
      `🧬 <b>EMOTION TRADE PENDIENTE</b>\n\n` +
      `Transición: <b>${escapeHTML(confluenceData.transitionKey)}</b>\n` +
      `Dirección: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Leverage: <b>${leverage}x</b>\n` +
      `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
      `Risk: <b>${formatUsd(riskUsd)}</b>\n` +
      `Notional: <b>${formatUsd(notional)}</b>\n` +
      `SL: <b>${slPct}%</b> | TP: <b>3%</b>\n\n` +
      `🧠 <b>Por qué:</b>\n` +
      `${escapeHTML(rule.note)}\n\n` +
      `📊 <b>Confluencia (${confluenceData.pairs.length} pares):</b>\n` +
      `${confluenceLines}\n\n` +
      `Fuerza de señal: <b>${escapeHTML(rule.strength.toUpperCase())}</b>\n\n` +
      `Responde:\n` +
      `✅ /emoconfirmar — ejecutar\n` +
      `❌ /emocancelar  — descartar\n\n` +
      `⚠️ Expira en 3 minutos.`
    );

    // Guardar pending
    _pendingEmoTrade = { symbol, side, qty, price: markPrice, leverage, rule, confluenceData, ts: Date.now() };

    // Auto-expirar
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

let _pendingEmoTrade = null;

async function confirmEmoTrade() {
  if (!_pendingEmoTrade) return;
  const { symbol, side, qty, price, leverage, rule } = _pendingEmoTrade;
  _pendingEmoTrade = null;

  try {
    await sendPrivate(`⏳ Ejecutando ${side === "BUY" ? "LONG" : "SHORT"} en ${symbol}...`);

    const order     = await placeMarketOrder(symbol, side, qty);
    const fillPrice = parseFloat(order.avgPrice || order.price || price);
    const slPct     = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);

    await sleep(500);
    const { slPrice, tpPrice, slOrderId, tpOrderId } = await placeSlTp(symbol, side, qty, fillPrice, slPct);

    emoPosition = { symbol, side, qty, entryPrice: fillPrice, slOrderId, tpOrderId, leverage, rule, ts: Date.now() };

    if (_config?.personalTradingState) {
      _config.personalTradingState.tradesToday += 1;
    }

    lastSignalTs = Date.now();

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
  if (!emoPosition) {
    await sendPrivate("⚠️ No hay posición de EmoTrader abierta.");
    return;
  }
  try {
    const { symbol, side, qty, entryPrice, slOrderId, tpOrderId } = emoPosition;
    const closeSide = side === "BUY" ? "SELL" : "BUY";

    if (slOrderId) await cancelOrder(symbol, slOrderId);
    if (tpOrderId) await cancelOrder(symbol, tpOrderId);
    await sleep(300);

    const order     = await placeMarketOrder(symbol, closeSide, qty);
    const exitPrice = parseFloat(order.avgPrice || order.price || entryPrice);
    const pnlRaw    = side === "BUY"
      ? (exitPrice - entryPrice) * qty
      : (entryPrice - exitPrice) * qty;
    const pnl = parseFloat(pnlRaw.toFixed(2));

    if (_config?.personalTradingState) {
      _config.personalTradingState.pnlToday += pnl;
      if (_config.PERSONAL_PLAN) _config.PERSONAL_PLAN.balance += pnl;
      if (
        _config.personalTradingState.pnlToday >= _config.PERSONAL_PLAN.dailyProfitLock ||
        _config.personalTradingState.pnlToday <= -Math.abs(_config.PERSONAL_PLAN.maxDailyLoss)
      ) {
        _config.personalTradingState.coolingDown = true;
      }
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
// CONFLUENCE DETECTOR
// ===============================
function detectConfluence(transitionKey) {
  const pairs = [];

  for (const [symbol, state] of pairState.entries()) {
    if (!state.prevEmotion || !state.emotion) continue;
    const key = getTransitionKey(state.prevEmotion, state.emotion);
    if (key === transitionKey) {
      const emo = EMOTIONS.find((e) => e.key === state.emotion);
      pairs.push({
        symbol,
        emoji: emo?.emoji || "❓",
        transition: `${state.prevEmotion} → ${state.emotion}`,
        pct5m: state.pct5m,
      });
    }
  }

  return pairs;
}

// ===============================
// PROCESS EMOTION TRANSITION
// ===============================
async function processTransition(symbol, prevEmotion, nextEmotion, pct5m) {
  const transitionKey = getTransitionKey(prevEmotion, nextEmotion);
  const rule          = TRANSITION_RULES[transitionKey];

  if (!rule) return;

  // Registrar en historial
  transitionHistory.unshift({
    symbol,
    transitionKey,
    action: rule.action,
    strength: rule.strength,
    pct5m,
    ts: Date.now(),
  });
  if (transitionHistory.length > MAX_HISTORY) transitionHistory.pop();

  console.log(`[EmoTrader] ${symbol}: ${transitionKey} → ${rule.action} (${rule.strength})`);

  // Si es señal de cierre
  if (rule.action === "CLOSE_LONG" && emoPosition?.side === "BUY") {
    await closeEmoPosition(`Señal emocional: ${transitionKey}`);
    return;
  }
  if (rule.action === "CLOSE_SHORT" && emoPosition?.side === "SELL") {
    await closeEmoPosition(`Señal emocional: ${transitionKey}`);
    return;
  }

  // Si no es LONG o SHORT, salir
  if (rule.action !== "LONG" && rule.action !== "SHORT") return;

  // Cooldown entre señales
  if (Date.now() - lastSignalTs < SIGNAL_COOLDOWN_MS) return;

  // No abrir si ya hay posición
  if (emoPosition) return;

  // Medir confluencia
  const confluencePairs = detectConfluence(transitionKey);
  const count           = confluencePairs.length;

  // Nivel de señal
  let signalLevel = null;
  if (count >= CONFLUENCE.strong) signalLevel = "strong";
  else if (count >= CONFLUENCE.medium) signalLevel = "medium";
  else if (count >= CONFLUENCE.weak) signalLevel = "weak";

  if (!signalLevel) return;

  // Solo alertar sin operar para señales débiles
  if (signalLevel === "weak") {
    await sendPrivate(
      `🟡 <b>EmoTrader — Señal Débil</b>\n\n` +
      `${escapeHTML(transitionKey)}\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Movimiento 5m: <b>${formatPct(pct5m)}</b>\n` +
      `Confluencia: <b>${count} par(es)</b>\n\n` +
      `ℹ️ Señal insuficiente para operar. Monitoreando...`
    );
    return;
  }

  // Señal media o fuerte → proponer trade
  const side      = rule.action === "LONG" ? "BUY" : "SELL";
  const leverage  = rule.leverage;

  // Elegir el par con mayor movimiento como el par a tradear
  const bestPair  = confluencePairs.sort((a, b) => Math.abs(b.pct5m) - Math.abs(a.pct5m))[0];
  const tradeSymbol = bestPair?.symbol || symbol;

  await executeEmoTrade(tradeSymbol, side, leverage, rule, {
    transitionKey,
    pairs: confluencePairs,
    signalLevel,
  });
}

// ===============================
// EVALUATE PAIR STATE
// Llamado cada 60 segundos por par
// ===============================
async function evaluatePair(symbol) {
  try {
    const pct5m    = calcPctChange(symbol, 5 * 60 * 1000);
    const emotion  = getEmotion(pct5m);
    const existing = pairState.get(symbol);

    const prevEmotion = existing?.emotion || null;
    const price       = priceBuffer.get(symbol)?.slice(-1)[0]?.price || 0;

    pairState.set(symbol, {
      emotion:     emotion.key,
      prevEmotion,
      pct5m,
      price,
      ts: Date.now(),
    });

    // Detectar transición
    if (prevEmotion && prevEmotion !== emotion.key) {
      await processTransition(symbol, prevEmotion, emotion.key, pct5m);
    }
  } catch (err) {
    console.error(`[EmoTrader] evaluatePair ${symbol}:`, err.message);
  }
}

// ===============================
// WEBSOCKET — Binance Futures Mini Ticker
// Escucha todos los pares simultáneamente
// ===============================
function buildWsUrl() {
  const streams = EMOTION_TRADE_PAIRS
    .map((s) => `${s.toLowerCase()}@miniTicker`)
    .join("/");

  const base = process.env.BINANCE_TESTNET !== "false"
    ? "wss://stream.binancefuture.com/stream?streams="
    : "wss://fstream.binance.com/stream?streams=";

  return `${base}${streams}`;
}

function connectWebSocket() {
  const url = buildWsUrl();
  console.log("[EmoTrader] Conectando WebSocket...");

  _ws = new WebSocket(url);

  _ws.on("open", () => {
    console.log("[EmoTrader] WebSocket conectado —", EMOTION_TRADE_PAIRS.length, "pares");
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  });

  _ws.on("message", (raw) => {
    try {
      const msg  = JSON.parse(raw);
      const data = msg?.data || msg;
      if (!data || data.e !== "24hrMiniTicker") return;

      const symbol = data.s;
      const price  = parseFloat(data.c); // close price

      if (!EMOTION_TRADE_PAIRS.includes(symbol)) return;

      pushPrice(symbol, price);
    } catch (_) {}
  });

  _ws.on("error", (err) => {
    console.error("[EmoTrader] WebSocket error:", err.message);
  });

  _ws.on("close", () => {
    console.warn("[EmoTrader] WebSocket cerrado. Reconectando en 5s...");
    _wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  });
}

// ===============================
// EVALUATION LOOP
// Evalúa todos los pares cada 60 segundos
// ===============================
function startEvaluationLoop() {
  setInterval(async () => {
    for (const symbol of EMOTION_TRADE_PAIRS) {
      await evaluatePair(symbol);
      await sleep(100); // pequeña pausa entre pares
    }
  }, 60 * 1000);

  console.log("[EmoTrader] Loop de evaluación iniciado (60s)");
}

// ===============================
// TELEGRAM HANDLERS
// ===============================
async function handleEmoStatus(ctx) {
  const lines = [];

  for (const symbol of EMOTION_TRADE_PAIRS) {
    const state = pairState.get(symbol);
    if (!state) { lines.push(`• <b>${symbol}</b> — sin datos aún`); continue; }

    const emo   = EMOTIONS.find((e) => e.key === state.emotion);
    const arrow = state.prevEmotion && state.prevEmotion !== state.emotion
      ? ` ← ${EMOTIONS.find((e) => e.key === state.prevEmotion)?.emoji || ""}`
      : "";

    lines.push(
      `${emo?.emoji || "❓"} <b>${symbol}</b> ${formatPct(state.pct5m)}${arrow}`
    );
  }

  const posInfo = emoPosition
    ? `\n\n📈 <b>Posición abierta:</b>\n${emoPosition.side === "BUY" ? "LONG" : "SHORT"} ${emoPosition.symbol} entry ${formatUsd(emoPosition.entryPrice)}`
    : "\n\n⬜ Sin posición abierta";

  return ctx.reply(
    `🧬 <b>EmoTrader — Estado Actual</b>\n\n` +
    lines.join("\n") +
    posInfo +
    `\n\n🌐 wojakmeter.com`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
}

async function handleEmoHistory(ctx) {
  if (!transitionHistory.length) {
    return ctx.reply("📜 Sin transiciones registradas aún.");
  }

  const lines = transitionHistory.slice(0, 15).map((t) => {
    const rule  = TRANSITION_RULES[t.transitionKey];
    const icon  = rule?.action === "LONG" ? "📈" : rule?.action === "SHORT" ? "📉" : "🔄";
    const time  = new Date(t.ts).toTimeString().slice(0, 5);
    return `${icon} <b>${t.symbol}</b> ${escapeHTML(t.transitionKey)} [${time}]`;
  });

  return ctx.reply(
    `📜 <b>EmoTrader — Historial</b>\n\n` +
    lines.join("\n") +
    `\n\n🌐 wojakmeter.com`,
    { parse_mode: "HTML" }
  );
}

async function handleEmoPairs(ctx) {
  const lines = EMOTION_TRADE_PAIRS.map((s, i) => `${i + 1}. ${s}`);
  return ctx.reply(
    `📋 <b>EmoTrader — Pares Monitoreados (${EMOTION_TRADE_PAIRS.length})</b>\n\n` +
    lines.join("\n"),
    { parse_mode: "HTML" }
  );
}

async function handleEmoConfirmar(ctx) {
  if (!_pendingEmoTrade) return ctx.reply("⚠️ No hay trade pendiente.");
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

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    console.warn("[EmoTrader] Sin API keys — modo observación solo (sin trades)");
  }

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

  connectWebSocket();
  startEvaluationLoop();

  console.log("[EmoTrader] Iniciado —", EMOTION_TRADE_PAIRS.length, "pares | testnet:", config.useTestnet);
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
