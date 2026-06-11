// ===============================
// WOJAKMETER — EMOTION TRADER v3
// WebSocket Binance + Funding Rate + Liquidaciones
// + REST CoinGecko como respaldo
// ===============================

const WebSocket = require("ws");
const Binance   = require("node-binance-api");

// ===============================
// PAIRS — 27 pares
// ===============================
const EMOTION_TRADE_PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","XRPUSDT","ADAUSDT",
  "AVAXUSDT","DOTUSDT","MATICUSDT","LTCUSDT","UNIUSDT",
  "DOGEUSDT","PEPEUSDT","WIFUSDT","SHIBUSDT","FLOKIUSDT",
  "BONKUSDT","MEMEUSDT",
  "SOLUSDT","LINKUSDT","NEARUSDT","APTUSDT","ARBUSDT",
  "OPUSDT","SUIUSDT","INJUSDT","TIAUSDT","SEIUSDT"
];

// ===============================
// EMOTION CONFIG
// ===============================
const EMOTIONS = [
  { key: "euphoria",    emoji: "🤩", label: "Euphoria",    minPct:  12   },
  { key: "content",     emoji: "😌", label: "Content",     minPct:   6   },
  { key: "optimism",    emoji: "🙂", label: "Optimism",    minPct:   2   },
  { key: "neutral",     emoji: "😐", label: "Neutral",     minPct:  -2   },
  { key: "doubt",       emoji: "🤔", label: "Doubt",       minPct:  -5   },
  { key: "concern",     emoji: "😟", label: "Concern",     minPct:  -8   },
  { key: "frustration", emoji: "😡", label: "Frustration", minPct: -9999 },
];

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
  "optimism→euphoria":   { action: "CLOSE_LONG",  leverage: 0, strength: "exit",   note: "Euforia — cerrar LONG" },
  "concern→frustration": { action: "CLOSE_SHORT", leverage: 0, strength: "exit",   note: "Pánico extremo — cerrar SHORT" },
};

const CONFLUENCE = { weak: 1, medium: 3, strong: 6 };
const SIGNAL_COOLDOWN_MS     = 15 * 60 * 1000;
const EVAL_INTERVAL_MS       = 60 * 1000;
const PRICE_WINDOW_5M_MS     = 5  * 60 * 1000;
const PRICE_WINDOW_15M_MS    = 15 * 60 * 1000;
const FUNDING_REFRESH_MS     = 5  * 60 * 1000;
const LIQUIDATION_WINDOW_MS  = 10 * 60 * 1000;

// ===============================
// STATE
// ===============================
let _config  = null;
let _binance = null;
let _ws      = null;
let _wsReconnectTimer = null;

const pairState       = new Map(); // { emotion, prevEmotion, pct5m, pct15m, price, ts }
const priceBuffer     = new Map(); // { symbol: [{price, ts}] }
const fundingRates    = new Map(); // { symbol: rate }
const liquidations    = [];        // [{symbol, side, qty, price, ts}]
const transitionHistory = [];
const MAX_HISTORY = 50;

let lastSignalTs     = 0;
let emoPosition      = null;
let _pendingEmoTrade = null;

// ===============================
// HELPERS
// ===============================
function escapeHTML(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatUsd(n) {
  const num = Number(n);
  if (num >= 1_000_000_000) return `$${(num/1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000)     return `$${(num/1_000_000).toFixed(2)}M`;
  if (num >= 1_000)         return `$${(num/1_000).toFixed(2)}K`;
  if (num >= 1)             return `$${num.toFixed(2)}`;
  return `$${num.toFixed(6)}`;
}
function formatPct(n) { return `${Number(n)>=0?"+":""}${Number(n).toFixed(2)}%`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getEmotion(pct) {
  const n = Number(pct) || 0;
  for (const e of EMOTIONS) if (n >= e.minPct) return e;
  return EMOTIONS[EMOTIONS.length - 1];
}

function pushPrice(symbol, price) {
  if (!priceBuffer.has(symbol)) priceBuffer.set(symbol, []);
  const buf = priceBuffer.get(symbol);
  buf.push({ price: Number(price), ts: Date.now() });
  const cutoff = Date.now() - 20 * 60 * 1000;
  while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
}

function calcPct(symbol, windowMs) {
  const buf = priceBuffer.get(symbol);
  if (!buf || buf.length < 2) return 0;
  const cutoff = Date.now() - windowMs;
  const recent = buf.filter(p => p.ts >= cutoff);
  if (recent.length < 2) return 0;
  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;
  if (!oldest) return 0;
  return ((newest - oldest) / oldest) * 100;
}

function getRecentLiquidations(symbol, side) {
  const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;
  return liquidations.filter(l =>
    l.symbol === symbol && l.side === side && l.ts >= cutoff
  );
}

function getFundingSignal(symbol, direction) {
  const rate = fundingRates.get(symbol);
  if (rate === undefined) return "neutral";
  // Funding positivo = mercado long saturado = favorable para SHORT
  // Funding negativo = mercado short saturado = favorable para LONG
  if (direction === "LONG"  && rate < -0.01) return "strong";
  if (direction === "LONG"  && rate > 0.05)  return "weak";
  if (direction === "SHORT" && rate > 0.05)  return "strong";
  if (direction === "SHORT" && rate < -0.01) return "weak";
  return "neutral";
}

// ===============================
// WEBSOCKET — Binance Futures
// Escucha miniTicker + liquidaciones
// ===============================
function buildWsUrl() {
  const tickers = EMOTION_TRADE_PAIRS
    .map(s => `${s.toLowerCase()}@miniTicker`)
    .join("/");
  const liqStream = "!forceOrder@arr";
  return `wss://fstream.binance.com/stream?streams=${tickers}/${liqStream}`;
}

function connectWebSocket() {
  if (_ws) { try { _ws.terminate(); } catch(_) {} }
  console.log("[EmoTrader] Conectando WebSocket Binance...");

  _ws = new WebSocket(buildWsUrl());

  _ws.on("open", () => {
    console.log(`[EmoTrader] WebSocket conectado — ${EMOTION_TRADE_PAIRS.length} pares + liquidaciones`);
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  });

  _ws.on("message", (raw) => {
    try {
      const msg  = JSON.parse(raw);
      const data = msg?.data || msg;
      if (!data) return;

      // Mini ticker — precio en tiempo real
      if (data.e === "24hrMiniTicker") {
        const symbol = data.s;
        if (EMOTION_TRADE_PAIRS.includes(symbol)) {
          pushPrice(symbol, data.c);
        }
      }

      // Liquidaciones forzadas
      if (data.e === "forceOrder") {
        const o = data.o;
        if (o && EMOTION_TRADE_PAIRS.includes(o.s)) {
          liquidations.push({
            symbol: o.s,
            side:   o.S, // BUY o SELL
            qty:    parseFloat(o.q),
            price:  parseFloat(o.p),
            ts:     Date.now()
          });
          // Limpiar liquidaciones viejas
          const cutoff = Date.now() - 30 * 60 * 1000;
          while (liquidations.length > 0 && liquidations[0].ts < cutoff) {
            liquidations.shift();
          }
          console.log(`[EmoTrader] Liquidación: ${o.S} ${o.s} qty=${o.q} price=${o.p}`);
        }
      }
    } catch(_) {}
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
// FUNDING RATE POLLER
// ===============================
async function fetchFundingRates() {
  try {
    const url = "https://fapi.binance.com/fapi/v1/premiumIndex";
    const res  = await fetch(url, {
      headers: { "User-Agent": "WojakMeterBot/3.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return;

    let updated = 0;
    for (const item of data) {
      if (EMOTION_TRADE_PAIRS.includes(item.symbol)) {
        fundingRates.set(item.symbol, parseFloat(item.lastFundingRate) * 100);
        updated++;
      }
    }
    console.log(`[EmoTrader] Funding rates actualizados: ${updated} pares`);
  } catch (err) {
    console.error("[EmoTrader] fetchFundingRates error:", err.message);
  }
}

// ===============================
// REST FALLBACK — CoinGecko
// Se usa si el WebSocket no tiene datos
// ===============================
async function fetchCoinGeckoFallback() {
  try {
    const url = "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h";
    const headers = { "User-Agent": "WojakMeterBot/3.0", "Accept": "application/json" };
    if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;

    const res  = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const coins = await res.json();
    if (!Array.isArray(coins)) return;

    let loaded = 0;
    for (const c of coins) {
      const symbol = (c.symbol || "").toUpperCase() + "USDT";
      if (EMOTION_TRADE_PAIRS.includes(symbol)) {
        // Solo usar fallback si no tenemos datos recientes del WebSocket
        const buf = priceBuffer.get(symbol);
        const hasRecentData = buf && buf.length > 0 && (Date.now() - buf[buf.length-1].ts) < 2 * 60 * 1000;
        if (!hasRecentData) {
          pushPrice(symbol, c.current_price);
          loaded++;
        }
      }
    }
    if (loaded > 0) console.log(`[EmoTrader] Fallback CoinGecko: ${loaded} pares sin datos WebSocket`);
  } catch (err) {
    console.error("[EmoTrader] CoinGecko fallback error:", err.message);
  }
}

// ===============================
// EVALUATION LOOP — cada 60 segundos
// ===============================
function startEvaluationLoop() {
  setInterval(async () => {
    let evaluated = 0;
    for (const symbol of EMOTION_TRADE_PAIRS) {
      const pct5m  = calcPct(symbol, PRICE_WINDOW_5M_MS);
      const pct15m = calcPct(symbol, PRICE_WINDOW_15M_MS);
      const buf    = priceBuffer.get(symbol);
      const price  = buf?.length ? buf[buf.length-1].price : 0;

      if (!price) continue;

      // Usa 5m para emoción, confirmado por 15m
      const emo5m  = getEmotion(pct5m);
      const emo15m = getEmotion(pct15m);

      // Solo procesar si ambos timeframes están en zona similar
      const existing    = pairState.get(symbol);
      const prevEmotion = existing?.emotion || null;

      pairState.set(symbol, {
        emotion:     emo5m.key,
        prevEmotion,
        pct5m,
        pct15m,
        price,
        funding:     fundingRates.get(symbol) || 0,
        ts:          Date.now(),
      });

      // Detectar transición
      if (prevEmotion && prevEmotion !== emo5m.key) {
        await processTransition(symbol, prevEmotion, emo5m.key, pct5m, pct15m, price, emo15m.key);
      }
      evaluated++;
    }
    console.log(`[EmoTrader] Poll OK — ${evaluated} pares evaluados`);
  }, EVAL_INTERVAL_MS);
}

// ===============================
// PROCESS TRANSITION
// ===============================
async function processTransition(symbol, prevEmotion, nextEmotion, pct5m, pct15m, price, emotion15m) {
  const transitionKey = `${prevEmotion}→${nextEmotion}`;
  const rule          = TRANSITION_RULES[transitionKey];
  if (!rule) return;

  transitionHistory.unshift({ symbol, transitionKey, action: rule.action, strength: rule.strength, pct5m, ts: Date.now() });
  if (transitionHistory.length > MAX_HISTORY) transitionHistory.pop();

  console.log(`[EmoTrader] ${symbol}: ${transitionKey} → ${rule.action} (${rule.strength}) 5m:${pct5m.toFixed(2)}% 15m:${pct15m.toFixed(2)}%`);

  // Señales de cierre
  if (rule.action === "CLOSE_LONG"  && emoPosition?.side === "BUY")  { await closeEmoPosition(`Señal: ${transitionKey}`); return; }
  if (rule.action === "CLOSE_SHORT" && emoPosition?.side === "SELL") { await closeEmoPosition(`Señal: ${transitionKey}`); return; }
  if (rule.action !== "LONG" && rule.action !== "SHORT") return;

  if (Date.now() - lastSignalTs < SIGNAL_COOLDOWN_MS) return;
  if (emoPosition || _pendingEmoTrade) return;

  // Confluencia
  const confluencePairs = [];
  for (const [sym, state] of pairState.entries()) {
    if (!state.prevEmotion || !state.emotion) continue;
    if (`${state.prevEmotion}→${state.emotion}` === transitionKey) {
      const emo = EMOTIONS.find(e => e.key === state.emotion);
      confluencePairs.push({ symbol: sym, emoji: emo?.emoji || "❓", transition: transitionKey, pct5m: state.pct5m, funding: state.funding });
    }
  }

  const count = confluencePairs.length;
  let signalLevel = null;
  if (count >= CONFLUENCE.strong) signalLevel = "strong";
  else if (count >= CONFLUENCE.medium) signalLevel = "medium";
  else if (count >= CONFLUENCE.weak) signalLevel = "weak";
  if (!signalLevel) return;

  const side     = rule.action === "LONG" ? "BUY" : "SELL";
  const funding  = getFundingSignal(symbol, rule.action);
  const recentLiqs = getRecentLiquidations(symbol, side === "BUY" ? "SELL" : "BUY");

  // Señal débil → solo alerta si hay soporte de funding o liquidaciones
  if (signalLevel === "weak") {
    const hasExtra = funding === "strong" || recentLiqs.length >= 3;
    await sendPrivate(
      `🟡 <b>EmoTrader — Señal Débil</b>\n\n` +
      `Transición: <b>${escapeHTML(transitionKey)}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Precio: <b>${formatUsd(price)}</b>\n` +
      `5m: <b>${formatPct(pct5m)}</b> | 15m: <b>${formatPct(pct15m)}</b>\n` +
      `Funding: <b>${formatPct(fundingRates.get(symbol)||0)}</b>\n` +
      `Liquidaciones recientes: <b>${recentLiqs.length}</b>\n` +
      `Confluencia: <b>${count} par(es)</b>\n\n` +
      `${hasExtra ? "⚡ Señal reforzada por funding/liquidaciones" : "ℹ️ Señal insuficiente. Monitoreando..."}`
    );
    return;
  }

  // Señal media o fuerte → proponer trade
  const bestPair    = confluencePairs.sort((a,b) => Math.abs(b.pct5m) - Math.abs(a.pct5m))[0];
  const tradeSymbol = bestPair?.symbol || symbol;

  await executeEmoTrade(tradeSymbol, side, rule.leverage, rule, {
    transitionKey, pairs: confluencePairs, signalLevel,
    pct5m, pct15m, funding, recentLiqs: recentLiqs.length
  });
}

// ===============================
// SEND PRIVATE
// ===============================
async function sendPrivate(text) {
  if (!_config?.bot || !_config?.PRIVATE_TELEGRAM_USER_ID) return;
  try {
    await _config.bot.telegram.sendMessage(_config.PRIVATE_TELEGRAM_USER_ID, text, {
      parse_mode: "HTML", disable_web_page_preview: true,
    });
  } catch (err) { console.error("[EmoTrader] sendPrivate:", err.message); }
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
      resolve((info?.symbols || []).find(s => s.symbol === symbol) || null);
    });
  });
}
function getLotStepSize(symbolInfo) {
  const f = (symbolInfo?.filters || []).find(f => f.filterType === "LOT_SIZE");
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
    ? parseFloat((entryPrice*(1-slPct/100)).toFixed(2))
    : parseFloat((entryPrice*(1+slPct/100)).toFixed(2));
  const tpPrice = side === "BUY"
    ? parseFloat((entryPrice*(1+tpPct/100)).toFixed(2))
    : parseFloat((entryPrice*(1-tpPct/100)).toFixed(2));

  const slOrder = await new Promise((resolve, reject) => {
    _binance.futuresOrder(oppSide, symbol, qty, slPrice,
      { type: "STOP_MARKET", stopPrice: slPrice, closePosition: true },
      (err, res) => { if (err) return reject(new Error(err.body||err.message)); resolve(res); }
    );
  });
  const tpOrder = await new Promise((resolve, reject) => {
    _binance.futuresOrder(oppSide, symbol, qty, tpPrice,
      { type: "TAKE_PROFIT_MARKET", stopPrice: tpPrice, closePosition: true },
      (err, res) => { if (err) return reject(new Error(err.body||err.message)); resolve(res); }
    );
  });
  return { slPrice, tpPrice, slOrderId: slOrder.orderId, tpOrderId: tpOrder.orderId };
}
async function atCancelOrder(symbol, orderId) {
  return new Promise(resolve => {
    _binance.futuresCancel(symbol, { orderId }, () => resolve());
  });
}

// ===============================
// EXECUTE TRADE
// ===============================
async function executeEmoTrade(symbol, side, leverage, rule, data) {
  try {
    if (!_config?.PERSONAL_PLAN) return;
    _config.resetPersonalStateIfNewDay?.();
    const state = _config.personalTradingState;
    const plan  = _config.PERSONAL_PLAN;
    if (state.coolingDown)                               return;
    if (state.tradesToday >= plan.maxTradesPerDay)       return;
    if (state.pnlToday <= -Math.abs(plan.maxDailyLoss)) return;
    if (state.pnlToday >= plan.dailyProfitLock)         return;
    if (emoPosition || _pendingEmoTrade)                 return;

    await atSetLeverage(symbol, leverage);
    const [markPrice, symbolInfo] = await Promise.all([atGetMarkPrice(symbol), atGetExchangeInfo(symbol)]);
    if (!markPrice) throw new Error("No mark price");

    const riskUsd  = plan.riskPerTrade;
    const notional = riskUsd * leverage;
    const stepSize = getLotStepSize(symbolInfo);
    const qty      = roundQty(notional / markPrice, stepSize);
    if (qty <= 0) throw new Error("Qty = 0");

    const slPct = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);
    const tpPct = Number(process.env.AUTO_TRADE_TP_PCT || 3.0);

    const confluenceLines = data.pairs.slice(0,8)
      .map(p => `  ${p.emoji} <b>${p.symbol}</b> ${formatPct(p.pct5m)} | funding: ${formatPct(p.funding||0)}`)
      .join("\n");

    _pendingEmoTrade = { symbol, side, qty, price: markPrice, leverage, rule, data, ts: Date.now() };

    await sendPrivate(
      `🧬 <b>EMOTION TRADE PENDIENTE</b>\n\n` +
      `Transición: <b>${escapeHTML(data.transitionKey)}</b>\n` +
      `Dirección: <b>${side==="BUY"?"📈 LONG":"📉 SHORT"}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
      `Qty: <b>${qty}</b> | Leverage: <b>${leverage}x</b>\n` +
      `Risk: <b>${formatUsd(riskUsd)}</b> | Notional: <b>${formatUsd(notional)}</b>\n` +
      `SL: <b>${slPct}%</b> | TP: <b>${tpPct}%</b>\n\n` +
      `📊 <b>Contexto de mercado</b>\n` +
      `5m: <b>${formatPct(data.pct5m)}</b> | 15m: <b>${formatPct(data.pct15m)}</b>\n` +
      `Funding: <b>${formatPct(fundingRates.get(symbol)||0)}</b>\n` +
      `Liquidaciones 10m: <b>${data.recentLiqs}</b>\n\n` +
      `📌 <b>Confluencia (${data.pairs.length} pares):</b>\n${confluenceLines}\n\n` +
      `Fuerza: <b>${escapeHTML(data.signalLevel.toUpperCase())}</b>\n` +
      `🧠 ${escapeHTML(rule.note)}\n\n` +
      `✅ /emoconfirmar — ejecutar\n` +
      `❌ /emocancelar  — descartar\n\n` +
      `⚠️ Expira en 3 minutos.`
    );

    setTimeout(() => {
      if (_pendingEmoTrade && Date.now() - _pendingEmoTrade.ts >= 3*60*1000) {
        _pendingEmoTrade = null;
        sendPrivate("⏱ <b>Emotion trade expirado</b> (3 min sin confirmar).");
      }
    }, 3*60*1000);

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
    await sendPrivate(`⏳ Ejecutando ${side==="BUY"?"LONG":"SHORT"} en ${symbol}...`);
    const order     = await atPlaceMarketOrder(symbol, side, qty);
    const fillPrice = parseFloat(order.avgPrice || order.price || price);
    await sleep(500);
    const { slPrice, tpPrice, slOrderId, tpOrderId } = await atPlaceSlTp(symbol, side, qty, fillPrice);
    emoPosition  = { symbol, side, qty, entryPrice: fillPrice, slOrderId, tpOrderId, leverage, rule, ts: Date.now() };
    lastSignalTs = Date.now();
    if (_config?.personalTradingState) _config.personalTradingState.tradesToday += 1;
    await sendPrivate(
      `✅ <b>EMOTION TRADE EJECUTADO</b>\n\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Dirección: <b>${side==="BUY"?"📈 LONG":"📉 SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(fillPrice)}</b>\n` +
      `Qty: <b>${qty}</b> | Leverage: <b>${leverage}x</b>\n\n` +
      `🛑 SL: <b>${formatUsd(slPrice)}</b>\n` +
      `✅ TP: <b>${formatUsd(tpPrice)}</b>\n\n` +
      `🧠 ${escapeHTML(rule.note)}\n\n` +
      `Usa /emocerrar para cerrar manualmente.\n🌐 wojakmeter.com`
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
    const pnlRaw    = side === "BUY" ? (exitPrice-entryPrice)*qty : (entryPrice-exitPrice)*qty;
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
      `${pnl>=0?"💚":"💔"} <b>EMOTION TRADE CERRADO</b>\n\n` +
      `Razón: <b>${escapeHTML(reason)}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Side: <b>${side==="BUY"?"LONG":"SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(entryPrice)}</b>\n` +
      `Exit: <b>${formatUsd(exitPrice)}</b>\n` +
      `PnL: <b>${pnl>=0?"+":""}${formatUsd(pnl)}</b>\n\n🌐 wojakmeter.com`
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
  if (!pairState.size) return ctx.reply("⏳ Cargando datos... espera 60 segundos.", { parse_mode: "HTML" });

  const lines = EMOTION_TRADE_PAIRS.map(symbol => {
    const state = pairState.get(symbol);
    if (!state) return `• <b>${symbol}</b> — sin datos`;
    const emo     = EMOTIONS.find(e => e.key === state.emotion);
    const funding = state.funding ? ` | F:${formatPct(state.funding)}` : "";
    const arrow   = state.prevEmotion && state.prevEmotion !== state.emotion
      ? ` ← ${EMOTIONS.find(e => e.key === state.prevEmotion)?.emoji || ""}`
      : "";
    return `${emo?.emoji||"❓"} <b>${symbol}</b> 5m:${formatPct(state.pct5m)} 15m:${formatPct(state.pct15m)}${funding}${arrow}`;
  });

  const posInfo = emoPosition
    ? `\n\n📈 <b>Posición:</b> ${emoPosition.side==="BUY"?"LONG":"SHORT"} ${emoPosition.symbol} @ ${formatUsd(emoPosition.entryPrice)}`
    : "\n\n⬜ Sin posición abierta";

  const recentLiqs = liquidations.filter(l => Date.now() - l.ts < 5*60*1000);

  return ctx.reply(
    `🧬 <b>EmoTrader v3 — Estado</b>\n\n` +
    lines.join("\n") + posInfo +
    `\n\n💥 Liquidaciones últimos 5min: <b>${recentLiqs.length}</b>\n` +
    `🌐 wojakmeter.com`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
}

async function handleEmoHistory(ctx) {
  if (!transitionHistory.length) return ctx.reply("📜 Sin transiciones registradas aún.");
  const lines = transitionHistory.slice(0,15).map(t => {
    const rule = TRANSITION_RULES[t.transitionKey];
    const icon = rule?.action==="LONG"?"📈":rule?.action==="SHORT"?"📉":"🔄";
    const time = new Date(t.ts).toTimeString().slice(0,5);
    return `${icon} <b>${t.symbol}</b> ${escapeHTML(t.transitionKey)} 5m:${formatPct(t.pct5m)} [${time}]`;
  });
  return ctx.reply(`📜 <b>EmoTrader — Historial</b>\n\n${lines.join("\n")}\n\n🌐 wojakmeter.com`, { parse_mode: "HTML" });
}

async function handleEmoPairs(ctx) {
  return ctx.reply(
    `📋 <b>EmoTrader — ${EMOTION_TRADE_PAIRS.length} Pares</b>\n\n` +
    EMOTION_TRADE_PAIRS.map((s,i) => `${i+1}. ${s}`).join("\n"),
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

  // 1. Conectar WebSocket
  connectWebSocket();

  // 2. Primer fetch de funding rates
  fetchFundingRates();

  // 3. Fallback CoinGecko inmediato para tener datos base
  setTimeout(async () => {
    await fetchCoinGeckoFallback();
    console.log("[EmoTrader] Datos base cargados via CoinGecko fallback");
  }, 3000);

  // 4. Loop de evaluación
  startEvaluationLoop();

  // 5. Refresh periódico de funding rates
  setInterval(fetchFundingRates, FUNDING_REFRESH_MS);

  // 6. Fallback CoinGecko cada 5 minutos para pares sin datos WebSocket
  setInterval(fetchCoinGeckoFallback, 5 * 60 * 1000);

  console.log(`[EmoTrader] ===== INICIADO v3 ===== ${EMOTION_TRADE_PAIRS.length} pares | WS + Funding + Liquidaciones | testnet: ${config.useTestnet}`);
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
