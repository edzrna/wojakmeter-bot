require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const Binance = require("node-binance-api");
const emotionTrader = require("./emotion-trader");

// ===============================
// CONFIG
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN en .env");

const PORT = process.env.PORT || 3000;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || null;

// ===============================
// PERSONAL PLAN CONFIG
// ===============================
const PERSONAL_ALERTS_ENABLED = process.env.PERSONAL_ALERTS_ENABLED === "true";
const PRIVATE_TELEGRAM_USER_ID = process.env.PRIVATE_TELEGRAM_USER_ID || null;

const PERSONAL_PLAN = {
  balance: Number(process.env.PERSONAL_BALANCE || 53),
  riskPerTrade: Number(process.env.PERSONAL_RISK_PER_TRADE || 0.75),
  maxDailyLoss: Number(process.env.PERSONAL_MAX_DAILY_LOSS || 1.5),
  dailyProfitLock: Number(process.env.PERSONAL_DAILY_PROFIT_LOCK || 2.5),
  maxTradesPerDay: Number(process.env.PERSONAL_MAX_TRADES_PER_DAY || 2),
  defaultLeverage: Number(process.env.PERSONAL_DEFAULT_LEVERAGE || 5),
  maxLeverage: Number(process.env.PERSONAL_MAX_LEVERAGE || 7),
  minSignalScore: Number(process.env.PERSONAL_MIN_SIGNAL_SCORE || 80)
};

let personalTradingState = {
  date: new Date().toISOString().slice(0, 10),
  tradesToday: 0,
  pnlToday: 0,
  coolingDown: false
};

// ===============================
// MARKET SCANNER CONFIG
// ===============================
const MARKET_SCANNER_ENABLED =
  process.env.BINANCE_PERSONAL_SCANNER_ENABLED === "true" ||
  process.env.MARKET_SCANNER_ENABLED === "true";

const MARKET_SCAN_INTERVAL_MS = Number(
  process.env.BINANCE_SCAN_INTERVAL_MS ||
  process.env.MARKET_SCAN_INTERVAL_MS ||
  60000
);

const MARKET_SCAN_SYMBOLS = String(
  process.env.BINANCE_SCAN_SYMBOLS ||
    process.env.MARKET_SCAN_SYMBOLS ||
    "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,PEPEUSDT,WIFUSDT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const MARKET_MIN_SIGNAL_SCORE = Number(
  process.env.BINANCE_MIN_SIGNAL_SCORE ||
  process.env.MARKET_MIN_SIGNAL_SCORE ||
  80
);

const PERSONAL_MARKET_ALERT_COOLDOWN_MS = Number(
  process.env.PERSONAL_BINANCE_ALERT_COOLDOWN_MS ||
  process.env.PERSONAL_MARKET_ALERT_COOLDOWN_MS ||
  20 * 60 * 1000
);

let lastPersonalMarketAlerts = new Map();

const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// ===============================
// API
// ===============================
const API_BASE = "https://api.coingecko.com/api/v3";
const VS_CURRENCY = "usd";

// ===============================
// CACHE
// ===============================
const cache = {
  markets: { data: null, ts: 0 },
  trending: { data: null, ts: 0 },
  global: { data: null, ts: 0 },
};

const MARKET_CACHE_TTL = 60 * 1000;
const TRENDING_CACHE_TTL = 2 * 60 * 1000;
const GLOBAL_CACHE_TTL = 2 * 60 * 1000;

// ===============================
// USER COOLDOWN
// ===============================
const userCooldowns = new Map();
const USER_COOLDOWN_MS = 800;

// ===============================
// WATCHLISTS IN MEMORY
// ===============================
const userWatchlists = new Map();

// ===============================
// AUTO BROADCAST STATE
// ===============================
let lastBroadcastState = {
  emotionKey: null,
  score: null,
  change: null,
  btcDom: null,
  volume: null,
  spotlightCoinId: null,
  ts: 0
};

const BROADCAST_INTERVAL_MS = 2 * 60 * 1000;
const MIN_BROADCAST_GAP_MS = 10 * 60 * 1000;
const SCORE_SHIFT_THRESHOLD = 8;
const BREAKING_SCORE_SHIFT_THRESHOLD = 15;

// ===============================
// EMOTIONS
// ===============================
const EMOTION_CONFIG = [
  { emoji: "🤩", key: "euphoria", label: "Euphoria", min: 12, max: 9999 },
  { emoji: "😌", key: "content", label: "Content", min: 6, max: 11.9999 },
  { emoji: "🙂", key: "optimism", label: "Optimism", min: 2, max: 5.9999 },
  { emoji: "😐", key: "neutral", label: "Neutral", min: -1.9999, max: 1.9999 },
  { emoji: "🤔", key: "doubt", label: "Doubt", min: -4.9999, max: -2 },
  { emoji: "😟", key: "concern", label: "Concern", min: -7.9999, max: -5 },
  { emoji: "😡", key: "frustration", label: "Frustration", min: -9999, max: -8 },
];

const EMOJI_SET = new Set(EMOTION_CONFIG.map((e) => e.emoji));

// ===============================
// STICKERS
// ===============================
const STICKERS = {
  neutral:
    "CAACAgEAAxkBAAIDAWn6pso8JitfvHNu4rQfYboxH07AAALvBwACfBjRR_P2E1ZGYEM_OwQ",
  doubt:
    "CAACAgEAAxkBAAIDCWn6pulfETzi_2xZrRrSVSlWAinXAAJOBgACQo3YR_gUHRx_RH9rOwQ",
  concern:
    "CAACAgEAAxkBAAIDC2n6puzIjSENdeQB9OJvtBIdZPikAALGBwACdUvZR9lUnX1bXtqqOwQ",
  frustration:
    "CAACAgEAAxkBAAIDDWn6pu-U6zz8-_pIR_VeRNQGAUryAAJ9BwACHG_QR_1lZUwb86ocOwQ",
  optimism:
    "CAACAgEAAxkBAAIDA2n6ptX_t-iHG9CJphLYmcjJB0ecAAIpBgACI4LYR2v5c7BzVBG1OwQ",
  content:
    "CAACAgEAAxkBAAIDBWn6ptr4_5U9YUZsezSYNzJ3h4UkAAJ-BwACTGzZR5Kc0F-t6MdIOwQ",
  euphoria:
    "CAACAgEAAxkBAAIDB2n6puH1J-pEl7lVktyW2Y1eprH0AALeBgACuhnYR3yJfsZTlcMKOwQ"
};

// ===============================
// NARRATIVES
// ===============================
const NARRATIVE_VARIANTS = {
  euphoria: [
    "Momentum is overheated. Traders are leaning aggressively risk-on.",
    "Market confidence is surging fast. Risk appetite is elevated.",
    "Buyers are in control and sentiment is running hot."
  ],
  content: [
    "The market is constructive. Confidence is present without extreme euphoria.",
    "Conditions look stable and bullish without feeling stretched.",
    "Traders are comfortable holding risk, but not chasing hard."
  ],
  optimism: [
    "Sentiment is improving. Buyers are gaining confidence.",
    "Momentum is recovering and optimism is building.",
    "The market is leaning positive with early conviction."
  ],
  neutral: [
    "The market is balanced. No strong emotional edge yet.",
    "Price action is undecided. Emotion is still centered.",
    "The market feels calm, but not committed."
  ],
  doubt: [
    "Confidence is weakening. Traders are becoming hesitant.",
    "The market is losing conviction and second-guessing itself.",
    "Buyers are slowing down and hesitation is growing."
  ],
  concern: [
    "Pressure is building. Sentiment is turning defensive.",
    "The market is getting uncomfortable and more reactive.",
    "Risk appetite is fading as pressure increases."
  ],
  frustration: [
    "The market is under stress. Emotion is clearly risk-off.",
    "Panic is rising and traders are losing patience.",
    "This is a heavy emotional drawdown environment."
  ]
};

// ===============================
// HELPERS
// ===============================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHTML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickRandom(arr = []) {
  return arr[Math.floor(Math.random() * arr.length)] || "";
}

function scoreFromChange(change) {
  return Math.round(clamp(50 + safe(change) * 10, 0, 100));
}

function formatUsd(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  const num = Number(value);
  if (num >= 1_000_000_000_000) return `$${(num / 1_000_000_000_000).toFixed(2)}T`;
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  if (num >= 1) return `$${num.toFixed(2)}`;
  return `$${num.toFixed(6)}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  const num = Number(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function normalizePairSymbol(symbol = "") {
  return String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildTradeLinksFromSymbol(symbol = "") {
  const base = normalizePairSymbol(symbol).replace("USDT", "");
  const futuresPair = `${base}USDT`;
  const spotPair = `${base}_USDT`;
  return {
    pair: futuresPair,
    binanceFutures: `https://www.binance.com/en/futures/${futuresPair}`,
    binanceSpot: `https://www.binance.com/en/trade/${spotPair}`,
    tradingView: `https://www.tradingview.com/symbols/${futuresPair}/`
  };
}

function buildTradeLinksBlock(symbol = "") {
  const links = buildTradeLinksFromSymbol(symbol);
  return (
    `\n\n🔗 <b>Trade / Chart</b>\n` +
    `Pair: <b>${escapeHTML(links.pair)}</b>\n` +
    `<a href="${links.binanceFutures}">Binance Futures</a> · ` +
    `<a href="${links.binanceSpot}">Binance Spot</a> · ` +
    `<a href="${links.tradingView}">TradingView</a>`
  );
}

function getSignalQuality(score) {
  if (score >= 90) return "Extreme / High volatility";
  if (score >= 80) return "High-quality watchlist";
  if (score >= 65) return "Possible setup";
  if (score >= 50) return "Observation only";
  if (score >= 35) return "Weak / uncertain";
  return "High risk / panic zone";
}

function getDisciplineNote(score, change) {
  const n = safe(change);
  if (score >= 85) {
    return (
      `\n\n⚠️ <b>Discipline Note</b>\n` +
      `Momentum is hot. Avoid chasing extended green candles. Wait for pullback or confirmation.`
    );
  }
  if (score <= 20) {
    return (
      `\n\n⚠️ <b>Discipline Note</b>\n` +
      `Panic conditions detected. Do not catch the knife. Wait for stabilization.`
    );
  }
  if (n > 6) {
    return (
      `\n\n⚠️ <b>Discipline Note</b>\n` +
      `Strong move detected. This may be FOMO territory. Wait for a cleaner entry.`
    );
  }
  if (n < -6) {
    return (
      `\n\n⚠️ <b>Discipline Note</b>\n` +
      `Heavy drop detected. Look for structure before considering any entry.`
    );
  }
  return (
    `\n\n🧠 <b>Discipline Note</b>\n` +
    `This is a market read, not a direct entry. Define risk before trading.`
  );
}

function buildSignalQualityBlock(score, change) {
  return (
    `\n\n🧪 <b>Signal Quality</b>\n` +
    `Status: <b>${escapeHTML(getSignalQuality(score))}</b>` +
    getDisciplineNote(score, change)
  );
}

function trendArrow(value) {
  if (value > 0) return "📈";
  if (value < 0) return "📉";
  return "➡️";
}

function getEmotionByChange(change24h) {
  const n = safe(change24h, 0);
  return (
    EMOTION_CONFIG.find((e) => n >= e.min && n <= e.max) ||
    EMOTION_CONFIG.find((e) => e.key === "neutral")
  );
}

function matchEmotionByEmoji(emoji) {
  return EMOTION_CONFIG.find((x) => x.emoji === emoji) || null;
}

function isUserCoolingDown(userId) {
  const now = Date.now();
  const last = userCooldowns.get(userId) || 0;
  if (now - last < USER_COOLDOWN_MS) return true;
  userCooldowns.set(userId, now);
  return false;
}

function getEmotionNarrative(emotionKey) {
  return pickRandom(NARRATIVE_VARIANTS[emotionKey]) || "The emotional state of the market is shifting.";
}

function getAlertLevel(score) {
  if (score >= 85) return { key: "extreme_bull", label: "Extreme Bullish", icon: "🟢" };
  if (score >= 70) return { key: "bullish", label: "Bullish", icon: "🟩" };
  if (score >= 45) return { key: "balanced", label: "Balanced", icon: "⚪" };
  if (score >= 20) return { key: "risk_off", label: "Risk-Off", icon: "🟧" };
  return { key: "panic", label: "Panic", icon: "🔴" };
}

function isPrivateOwner(ctx) {
  if (!PRIVATE_TELEGRAM_USER_ID) return false;
  return String(ctx.from?.id || "") === String(PRIVATE_TELEGRAM_USER_ID);
}

async function replyOwnerOnly(ctx) {
  return ctx.reply("🚫 This command is private.", {
    reply_markup: buildMainKeyboard().reply_markup
  });
}

function resetPersonalStateIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (personalTradingState.date !== today) {
    personalTradingState = {
      date: today,
      tradesToday: 0,
      pnlToday: 0,
      coolingDown: false
    };
  }
}

function canSendPersonalAlert(score) {
  resetPersonalStateIfNewDay();
  if (!PERSONAL_ALERTS_ENABLED) return false;
  if (!PRIVATE_TELEGRAM_USER_ID) return false;
  if (score < PERSONAL_PLAN.minSignalScore) return false;
  if (personalTradingState.coolingDown) return false;
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return false;
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return false;
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return false;
  return true;
}

function buildMyPlanMessage() {
  resetPersonalStateIfNewDay();
  return (
    `🧠 <b>My WojakMeter Trading Plan</b>\n\n` +
    `💼 Balance: <b>$${PERSONAL_PLAN.balance.toFixed(2)}</b>\n` +
    `🎯 Risk per trade: <b>$${PERSONAL_PLAN.riskPerTrade.toFixed(2)}</b>\n` +
    `🛑 Max daily loss: <b>-$${PERSONAL_PLAN.maxDailyLoss.toFixed(2)}</b>\n` +
    `🔒 Daily profit lock: <b>+$${PERSONAL_PLAN.dailyProfitLock.toFixed(2)}</b>\n` +
    `📌 Max trades per day: <b>${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `⚙️ Default leverage: <b>${PERSONAL_PLAN.defaultLeverage}x</b>\n` +
    `🚫 Max leverage: <b>${PERSONAL_PLAN.maxLeverage}x</b>\n` +
    `🧪 Min personal signal score: <b>${PERSONAL_PLAN.minSignalScore}/100</b>\n\n` +
    `📊 <b>Today</b>\n` +
    `Trades: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `PnL: <b>${personalTradingState.pnlToday >= 0 ? "+" : ""}$${personalTradingState.pnlToday.toFixed(2)}</b>\n` +
    `Cooling down: <b>${personalTradingState.coolingDown ? "Yes" : "No"}</b>\n\n` +
    `🤖 <b>AutoTrade</b>\n` +
    `Estado: <b>${autoTradeActive ? "ON ✅" : "OFF 🛑"}</b>\n` +
    `Testnet: <b>${USE_TESTNET ? "Sí (seguro)" : "❗ REAL MONEY"}</b>\n` +
    `Score LONG: <b>≥${SCORE_LONG_MIN}</b> | Score SHORT: <b>≤${SCORE_SHORT_MAX}</b>\n\n` +
    `🧠 <b>Rule</b>\n` +
    `No trade is valid without defined risk, stop loss and emotional control.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildPersonalAlertMessage(coin, title = "Personal Watchlist Alert") {
  resetPersonalStateIfNewDay();
  const change = safe(coin.price_change_percentage_24h);
  const score = scoreFromChange(change);
  const emotion = getEmotionByChange(change);
  const symbol = (coin.symbol || "").toUpperCase();
  const links = buildTradeLinksFromSymbol(symbol);
  return (
    `🔥 <b>WOJAKMETER PERSONAL ALERT</b>\n\n` +
    `Type: <b>${escapeHTML(title)}</b>\n` +
    `Pair: <b>${escapeHTML(links.pair)}</b>\n` +
    `${emotion.emoji} Mood: <b>${emotion.label}</b>\n` +
    `Score: <b>${score}/100</b>\n` +
    `Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n\n` +
    `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
    `📉 24h: <b>${formatPercent(change)}</b>\n` +
    `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
    `🧠 <b>Your Plan</b>\n` +
    `Risk max: <b>$${PERSONAL_PLAN.riskPerTrade.toFixed(2)}</b>\n` +
    `Suggested leverage: <b>3x-${PERSONAL_PLAN.defaultLeverage}x</b>\n` +
    `Max leverage: <b>${PERSONAL_PLAN.maxLeverage}x</b>\n` +
    `Trades today: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `PnL today: <b>${personalTradingState.pnlToday >= 0 ? "+" : ""}$${personalTradingState.pnlToday.toFixed(2)}</b>\n\n` +
    `⚠️ <b>Discipline</b>\n` +
    `This is not a direct entry. Wait for confirmation. Do not chase. Define stop loss first.` +
    buildTradeLinksBlock(symbol) +
    `\n\n🌐 wojakmeter.com`
  );
}

async function sendPersonalAlert(coin, title = "Personal Watchlist Alert") {
  try {
    if (!coin) return;
    const score = scoreFromChange(coin.price_change_percentage_24h);
    if (!canSendPersonalAlert(score)) return;
    const msg = buildPersonalAlertMessage(coin, title);
    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, msg, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("Personal alert error:", err.message);
  }
}

// ===============================
// BINANCE FUTURES AUTO-TRADER
// ===============================
const BINANCE_API_KEY    = process.env.BINANCE_API_KEY    || "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || "";
const USE_TESTNET        = process.env.BINANCE_TESTNET !== "false";

const AUTO_TRADE_ENABLED_ENV = process.env.AUTO_TRADE_ENABLED === "true";
const AUTO_TRADE_CONFIRM     = process.env.AUTO_TRADE_CONFIRM !== "false";
const SL_PCT                 = Number(process.env.AUTO_TRADE_SL_PCT   || 1.5);
const TP_PCT                 = Number(process.env.AUTO_TRADE_TP_PCT   || 3.0);
const AT_LEVERAGE            = Number(process.env.AUTO_TRADE_LEVERAGE  || 5);
const SCORE_LONG_MIN         = Number(process.env.AUTO_TRADE_SCORE_LONG  || 80);
const SCORE_SHORT_MAX        = Number(process.env.AUTO_TRADE_SCORE_SHORT || 20);

let autoTradeActive   = AUTO_TRADE_ENABLED_ENV;
let pendingConfirm    = null;
let openPosition      = null;
let lastTradeSignalTs = 0;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

const binanceClient = new Binance().options({
  APIKEY:        BINANCE_API_KEY,
  APISECRET:     BINANCE_API_SECRET,
  useServerTime: true,
  recvWindow:    10000,
  urls: {
    base: USE_TESTNET
      ? "https://testnet.binancefuture.com/fapi/"
      : "https://fapi.binance.com/fapi/",
  },
});

function canOpenTrade() {
  resetPersonalStateIfNewDay();
  if (!autoTradeActive) return false;
  if (openPosition)     return false;
  if (personalTradingState.coolingDown) return false;
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return false;
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return false;
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return false;
  if (Date.now() - lastTradeSignalTs < SIGNAL_COOLDOWN_MS) return false;
  return true;
}

async function sendPrivate(text) {
  if (!PRIVATE_TELEGRAM_USER_ID) return;
  try {
    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("[AutoTrader] sendPrivate error:", err.message);
  }
}

async function atSetLeverage(symbol) {
  return new Promise((resolve, reject) => {
    binanceClient.futuresLeverage(symbol, AT_LEVERAGE, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function atGetMarkPrice(symbol) {
  return new Promise((resolve, reject) => {
    binanceClient.futuresMarkPrice(symbol, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(parseFloat(res?.markPrice || res?.price || 0));
    });
  });
}

async function atGetFuturesBalance() {
  return new Promise((resolve, reject) => {
    binanceClient.futuresBalance((err, balances) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      const usdt = (balances || []).find((b) => b.asset === "USDT");
      resolve(parseFloat(usdt?.availableBalance || 0));
    });
  });
}

async function atGetExchangeInfo(symbol) {
  return new Promise((resolve, reject) => {
    binanceClient.futuresExchangeInfo((err, info) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      const sym = (info?.symbols || []).find((s) => s.symbol === symbol);
      resolve(sym || null);
    });
  });
}

function atGetLotStepSize(symbolInfo) {
  const lotFilter = (symbolInfo?.filters || []).find((f) => f.filterType === "LOT_SIZE");
  return parseFloat(lotFilter?.stepSize || "0.001");
}

function atRoundQty(qty, stepSize) {
  const precision = Math.round(-Math.log10(stepSize));
  return parseFloat(qty.toFixed(precision));
}

async function atPlaceMarketOrder(symbol, side, qty) {
  return new Promise((resolve, reject) => {
    binanceClient.futuresOrder(side, symbol, qty, false, { type: "MARKET" }, (err, res) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(res);
    });
  });
}

async function atPlaceSlTpOrders(symbol, side, qty, entryPrice) {
  const oppositeSide = side === "BUY" ? "SELL" : "BUY";
  let slPrice, tpPrice;
  if (side === "BUY") {
    slPrice = parseFloat((entryPrice * (1 - SL_PCT / 100)).toFixed(2));
    tpPrice = parseFloat((entryPrice * (1 + TP_PCT / 100)).toFixed(2));
  } else {
    slPrice = parseFloat((entryPrice * (1 + SL_PCT / 100)).toFixed(2));
    tpPrice = parseFloat((entryPrice * (1 - TP_PCT / 100)).toFixed(2));
  }

  const slOrder = await new Promise((resolve, reject) => {
    binanceClient.futuresOrder(
      oppositeSide, symbol, qty, slPrice,
      { type: "STOP_MARKET", stopPrice: slPrice, closePosition: true },
      (err, res) => {
        if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
        resolve(res);
      }
    );
  });

  const tpOrder = await new Promise((resolve, reject) => {
    binanceClient.futuresOrder(
      oppositeSide, symbol, qty, tpPrice,
      { type: "TAKE_PROFIT_MARKET", stopPrice: tpPrice, closePosition: true },
      (err, res) => {
        if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
        resolve(res);
      }
    );
  });

  return { slPrice, tpPrice, slOrderId: slOrder.orderId, tpOrderId: tpOrder.orderId };
}

async function atCancelOrder(symbol, orderId) {
  return new Promise((resolve) => {
    binanceClient.futuresCancel(symbol, { orderId }, (err, res) => {
      if (err) console.error("[AutoTrader] cancelOrder error:", err.message);
      resolve(res);
    });
  });
}

async function atGetOpenPositions() {
  return new Promise((resolve, reject) => {
    binanceClient.futuresPositionRisk((err, positions) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve((positions || []).filter((p) => parseFloat(p.positionAmt) !== 0));
    });
  });
}

async function atGetOpenOrders(symbol) {
  return new Promise((resolve, reject) => {
    binanceClient.futuresOpenOrders(symbol, (err, orders) => {
      if (err) return reject(new Error(err.body || err.message || JSON.stringify(err)));
      resolve(orders || []);
    });
  });
}

async function atExecuteTrade(side, symbol, score) {
  try {
    await atSetLeverage(symbol);
    const [markPrice, symbolInfo] = await Promise.all([
      atGetMarkPrice(symbol),
      atGetExchangeInfo(symbol),
    ]);

    if (!markPrice || markPrice <= 0) throw new Error("No se pudo obtener mark price");

    const riskUsd  = PERSONAL_PLAN.riskPerTrade;
    const notional = riskUsd * AT_LEVERAGE;
    const rawQty   = notional / markPrice;
    const stepSize = atGetLotStepSize(symbolInfo);
    const qty      = atRoundQty(rawQty, stepSize);

    if (qty <= 0) throw new Error("Qty calculada es 0 — revisa balance y riskPerTrade");

    if (AUTO_TRADE_CONFIRM) {
      const slEst = side === "BUY"
        ? markPrice * (1 - SL_PCT / 100)
        : markPrice * (1 + SL_PCT / 100);
      const tpEst = side === "BUY"
        ? markPrice * (1 + TP_PCT / 100)
        : markPrice * (1 - TP_PCT / 100);

      pendingConfirm = { side, symbol, qty, price: markPrice, slPrice: slEst, tpPrice: tpEst, score, ts: Date.now() };

      await sendPrivate(
        `🤖 <b>AUTO-TRADE PENDIENTE</b>\n\n` +
        `Par: <b>${escapeHTML(symbol)}</b>\n` +
        `Dirección: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
        `Score WojakMeter: <b>${score}/100</b>\n` +
        `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
        `Qty: <b>${qty}</b>\n` +
        `Leverage: <b>${AT_LEVERAGE}x</b>\n` +
        `Notional: <b>${formatUsd(notional)}</b>\n` +
        `Risk: <b>${formatUsd(riskUsd)}</b>\n\n` +
        `🛑 SL estimado: <b>${formatUsd(slEst)}</b>\n` +
        `✅ TP estimado: <b>${formatUsd(tpEst)}</b>\n\n` +
        `Responde:\n` +
        `✅ /confirmar — ejecutar ahora\n` +
        `❌ /cancelar  — descartar\n\n` +
        `⚠️ Esta confirmación expira en 3 minutos.`
      );

      setTimeout(() => {
        if (pendingConfirm && Date.now() - pendingConfirm.ts >= 3 * 60 * 1000) {
          pendingConfirm = null;
          sendPrivate("⏱ <b>Auto-trade expirado</b>\nNo se ejecutó la orden (timeout 3 min).");
        }
      }, 3 * 60 * 1000);

      return;
    }

    await atExecuteConfirmed(symbol, side, qty, markPrice, score);
  } catch (err) {
    console.error("[AutoTrader] executeTrade error:", err.message);
    await sendPrivate(`⚠️ <b>AutoTrade error</b>\n\n${escapeHTML(err.message)}`);
  }
}

async function atExecuteConfirmed(symbol, side, qty, price, score) {
  try {
    await sendPrivate(`⏳ <b>Ejecutando orden ${side}...</b>\nPar: ${symbol} | Qty: ${qty}`);

    const order      = await atPlaceMarketOrder(symbol, side, qty);
    const fillPrice  = parseFloat(order.avgPrice || order.price || price);

    await sleep(500);

    const { slPrice, tpPrice, slOrderId, tpOrderId } = await atPlaceSlTpOrders(
      symbol, side, qty, fillPrice
    );

    openPosition = { side, symbol, entryPrice: fillPrice, qty, slOrderId, tpOrderId, score, ts: Date.now() };
    lastTradeSignalTs = Date.now();
    personalTradingState.tradesToday += 1;

    await sendPrivate(
      `✅ <b>ORDEN EJECUTADA</b>\n\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Dirección: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `Entry Price: <b>${formatUsd(fillPrice)}</b>\n` +
      `Qty: <b>${qty}</b>\n` +
      `Leverage: <b>${AT_LEVERAGE}x</b>\n\n` +
      `🛑 Stop Loss: <b>${formatUsd(slPrice)}</b>\n` +
      `✅ Take Profit: <b>${formatUsd(tpPrice)}</b>\n\n` +
      `Score WojakMeter: <b>${score}/100</b>\n` +
      `Order ID: <code>${order.orderId}</code>\n\n` +
      `Usa /posicion para ver estado.\n` +
      `Usa /cerrar para cerrar manualmente.\n\n` +
      `🌐 wojakmeter.com`
    );

    console.log(`[AutoTrader] Orden ejecutada: ${side} ${symbol} qty=${qty} entry=${fillPrice}`);
  } catch (err) {
    console.error("[AutoTrader] executeConfirmed error:", err.message);
    await sendPrivate(`⚠️ <b>Error al ejecutar</b>\n\n${escapeHTML(err.message)}`);
  }
}

async function atClosePosition(reason = "Manual") {
  if (!openPosition) {
    await sendPrivate("⚠️ No hay posición abierta para cerrar.");
    return;
  }
  try {
    const { symbol, side, qty, entryPrice, slOrderId, tpOrderId } = openPosition;
    const closeSide = side === "BUY" ? "SELL" : "BUY";

    if (slOrderId) await atCancelOrder(symbol, slOrderId).catch(() => {});
    if (tpOrderId) await atCancelOrder(symbol, tpOrderId).catch(() => {});
    await sleep(300);

    const closeOrder = await atPlaceMarketOrder(symbol, closeSide, qty);
    const exitPrice  = parseFloat(closeOrder.avgPrice || closeOrder.price || entryPrice);

    const pnlRaw = side === "BUY"
      ? (exitPrice - entryPrice) * qty
      : (entryPrice - exitPrice) * qty;
    const pnl = parseFloat(pnlRaw.toFixed(2));

    personalTradingState.pnlToday += pnl;
    PERSONAL_PLAN.balance          += pnl;

    if (
      personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock ||
      personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)
    ) {
      personalTradingState.coolingDown = true;
    }

    openPosition = null;

    await sendPrivate(
      `${pnl >= 0 ? "💚" : "💔"} <b>POSICIÓN CERRADA</b>\n\n` +
      `Razón: <b>${escapeHTML(reason)}</b>\n` +
      `Par: <b>${escapeHTML(symbol)}</b>\n` +
      `Side: <b>${side === "BUY" ? "LONG" : "SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(entryPrice)}</b>\n` +
      `Exit: <b>${formatUsd(exitPrice)}</b>\n` +
      `PnL: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n\n` +
      `PnL del día: <b>${personalTradingState.pnlToday >= 0 ? "+" : ""}${formatUsd(personalTradingState.pnlToday)}</b>\n\n` +
      `🌐 wojakmeter.com`
    );

    console.log(`[AutoTrader] Posición cerrada: ${symbol} pnl=${pnl}`);
  } catch (err) {
    console.error("[AutoTrader] closePosition error:", err.message);
    await sendPrivate(`⚠️ <b>Error al cerrar posición</b>\n\n${escapeHTML(err.message)}`);
  }
}

async function evaluateAndTrade(nextState) {
  try {
    if (!autoTradeActive) return;
    if (!canOpenTrade())  return;

    const { score, emotionKey } = nextState;
    let side   = null;
    let symbol = "BTCUSDT";

    if (score >= SCORE_LONG_MIN)   side = "BUY";
    else if (score <= SCORE_SHORT_MAX) side = "SELL";

    if (!side) return;

    console.log(`[AutoTrader] Señal: ${side} | Score: ${score} | Emotion: ${emotionKey}`);
    await atExecuteTrade(side, symbol, score);
  } catch (err) {
    console.error("[AutoTrader] evaluateAndTrade error:", err.message);
  }
}

// ===============================
// COINGECKO MARKET PERSONAL SCANNER
// ===============================
function detectMarketSetup(coin) {
  if (!coin) return null;
  const symbol      = (coin.symbol || "").toUpperCase();
  const name        = coin.name || symbol;
  const price       = safe(coin.current_price);
  const change24h   = safe(coin.price_change_percentage_24h);
  const volume      = safe(coin.total_volume);
  const marketCap   = safe(coin.market_cap);
  if (!symbol || !price || !volume) return null;

  const volumeToMcap = marketCap > 0 ? volume / marketCap : 0;
  let type = "Observation", direction = "WAIT", mood = "Neutral", score = 50, reason = [], warning = "This is a market scanner alert, not a direct entry.";

  if (change24h >= 4 && volumeToMcap >= 0.04) {
    type = "Momentum Watch / Strong Gainer"; direction = "WAIT FOR PULLBACK"; mood = "Optimism / Euphoria"; score = 65;
    score += Math.min(20, change24h * 2); score += Math.min(10, volumeToMcap * 100);
    reason.push(`Strong 24h move: ${formatPercent(change24h)}`);
    reason.push(`Healthy volume vs market cap: ${(volumeToMcap * 100).toFixed(2)}%`);
    reason.push("Market is showing strong buyer attention.");
    warning = "Avoid chasing. Wait for pullback, retest, or clean confirmation.";
  }
  if (change24h <= -4 && volumeToMcap >= 0.04) {
    type = "Capitulation Watch / Heavy Loser"; direction = "WAIT FOR STABILIZATION"; mood = "Concern / Panic"; score = 65;
    score += Math.min(20, Math.abs(change24h) * 2); score += Math.min(10, volumeToMcap * 100);
    reason.push(`Heavy 24h drop: ${formatPercent(change24h)}`);
    reason.push(`High activity vs market cap: ${(volumeToMcap * 100).toFixed(2)}%`);
    reason.push("Market is showing strong emotional pressure.");
    warning = "Do not catch the knife. Wait for stabilization or reversal structure.";
  }
  if (Math.abs(change24h) >= 2 && volumeToMcap >= 0.08) {
    type = change24h > 0 ? "Volume Momentum Watch" : "Volume Stress Watch";
    direction = change24h > 0 ? "LONG WATCH" : "SHORT / REVERSAL WATCH";
    mood = change24h > 0 ? "Optimism / Activity" : "Concern / Activity";
    score = Math.max(score, 70);
    score += Math.min(15, Math.abs(change24h) * 2); score += Math.min(10, volumeToMcap * 80);
    reason.push(`Unusual volume activity: ${(volumeToMcap * 100).toFixed(2)}% of market cap`);
    reason.push(`24h move: ${formatPercent(change24h)}`);
    warning = "Volume is active. Wait for confirmation before entering.";
  }

  score = Math.round(clamp(score, 0, 100));
  if (score < MARKET_MIN_SIGNAL_SCORE) return null;

  return { symbol: `${symbol}USDT`, baseSymbol: symbol, name, interval: "24h", type, direction, mood, score, close: price, move1: change24h, move5: change24h, move20: change24h, volRatio: volumeToMcap * 100, rsi: 50, volume, marketCap, reason, warning };
}

function buildMarketPersonalSignalMessage(signal) {
  resetPersonalStateIfNewDay();
  const links = buildTradeLinksFromSymbol(signal.baseSymbol || signal.symbol);
  const reasonLines = signal.reason.length
    ? signal.reason.map((r) => `• ${escapeHTML(r)}`).join("\n")
    : "• Market movement detected.";
  return (
    `🔥 <b>WOJAKMETER PERSONAL SIGNAL</b>\n\n` +
    `Pair: <b>${escapeHTML(signal.symbol)}</b>\n` +
    `Source: <b>CoinGecko Market Scanner</b>\n` +
    `Timeframe: <b>${escapeHTML(signal.interval)}</b>\n` +
    `Type: <b>${escapeHTML(signal.type)}</b>\n` +
    `Direction: <b>${escapeHTML(signal.direction)}</b>\n` +
    `Mood: <b>${escapeHTML(signal.mood)}</b>\n` +
    `Score: <b>${signal.score}/100</b>\n\n` +
    `📊 <b>Market Data</b>\n` +
    `Price: <b>${formatUsd(signal.close)}</b>\n` +
    `24h Move: <b>${formatPercent(signal.move1)}</b>\n` +
    `Volume: <b>${formatUsd(signal.volume)}</b>\n` +
    `Market Cap: <b>${formatUsd(signal.marketCap)}</b>\n` +
    `Volume/MCap: <b>${signal.volRatio.toFixed(2)}%</b>\n\n` +
    `🧠 <b>Why it triggered</b>\n` +
    `${reasonLines}\n\n` +
    `⚠️ <b>Execution Warning</b>\n` +
    `${escapeHTML(signal.warning)}\n\n` +
    `🧠 <b>Your Plan</b>\n` +
    `Risk max: <b>$${PERSONAL_PLAN.riskPerTrade.toFixed(2)}</b>\n` +
    `Suggested leverage: <b>3x-${PERSONAL_PLAN.defaultLeverage}x</b>\n` +
    `Max leverage: <b>${PERSONAL_PLAN.maxLeverage}x</b>\n` +
    `Trades today: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `PnL today: <b>${personalTradingState.pnlToday >= 0 ? "+" : ""}$${personalTradingState.pnlToday.toFixed(2)}</b>\n\n` +
    `🔗 <b>Trade / Chart</b>\n` +
    `<a href="${links.binanceFutures}">Binance Futures</a> · ` +
    `<a href="${links.tradingView}">TradingView</a>\n\n` +
    `🚫 This is not financial advice. Wait for confirmation and define stop loss first.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function canSendMarketPersonalSignal(signal) {
  resetPersonalStateIfNewDay();
  if (!MARKET_SCANNER_ENABLED)   return false;
  if (!PERSONAL_ALERTS_ENABLED)  return false;
  if (!PRIVATE_TELEGRAM_USER_ID) return false;
  if (signal.score < MARKET_MIN_SIGNAL_SCORE) return false;
  if (personalTradingState.coolingDown) return false;
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return false;
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return false;
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return false;
  const key  = `${signal.symbol}:${signal.type}`;
  const last = lastPersonalMarketAlerts.get(key) || 0;
  if (Date.now() - last < PERSONAL_MARKET_ALERT_COOLDOWN_MS) return false;
  lastPersonalMarketAlerts.set(key, Date.now());
  return true;
}

async function sendMarketPersonalSignal(signal) {
  try {
    if (!canSendMarketPersonalSignal(signal)) return;
    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, buildMarketPersonalSignalMessage(signal), {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    console.log(`Market personal signal sent: ${signal.symbol} ${signal.type} score ${signal.score}`);
  } catch (err) {
    console.error("Send market personal signal error:", err.message);
  }
}

async function scanMarketPersonalSignals() {
  try {
    if (!MARKET_SCANNER_ENABLED || !PERSONAL_ALERTS_ENABLED || !PRIVATE_TELEGRAM_USER_ID) return;
    resetPersonalStateIfNewDay();
    if (personalTradingState.coolingDown) return;
    if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return;
    if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return;
    if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return;

    const markets      = await getMarkets(true);
    const allowedBases = MARKET_SCAN_SYMBOLS.map((s) => String(s).replace("USDT", "").toUpperCase());
    const filtered     = markets.filter((coin) => allowedBases.includes((coin.symbol || "").toUpperCase()));
    const signals      = filtered.map(detectMarketSetup).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);

    for (const signal of signals) {
      await sendMarketPersonalSignal(signal);
      await sleep(750);
    }
  } catch (err) {
    console.error("Market personal scanner error:", err.message);
  }
}

// ===============================
// KEYBOARD
// ===============================
function buildMainKeyboard() {
  return Markup.keyboard([
    ["🧠 Signal", "📊 Market"],
    ["🔥 Trending", "🌟 Spotlight"],
    ["⚠️ Risk", "₿ BTC Mood"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["🧪 Radar", "🧠 Discipline"],
    ["📋 My Plan"],
    ["🤖 AutoTrade ON", "🛑 AutoTrade OFF"],
    ["📈 Posición", "📋 Órdenes"],
    ["🧬 Emo Status", "📜 Emo History"],
    ["/coin btc", "/daily"],
    ["/mywatchlist", "/scan"],
    ["/scandebug", "/testsignal"],
    ["🤩", "😌", "🙂", "😐"],
    ["🤔", "😟", "😡"],
    ["/start", "/help", "/teststicker", "/testchannel"]
  ]).resize();
}

function normalizeCoinKey(input) {
  return String(input || "").trim().toLowerCase();
}

function getUserWatchlist(userId) {
  if (!userWatchlists.has(userId)) userWatchlists.set(userId, new Set());
  return userWatchlists.get(userId);
}

// ===============================
// TELEGRAM SENDERS
// ===============================
async function sendEmotionSticker(ctx, emotionKey) {
  const sticker = STICKERS[emotionKey];
  if (!sticker) return;
  try {
    await ctx.replyWithSticker(sticker, { reply_markup: buildMainKeyboard().reply_markup });
  } catch (e) {
    console.error("Sticker error:", e.message);
  }
}

async function sendStickerToChannel(emotionKey) {
  if (!TELEGRAM_CHANNEL_ID) return;
  const sticker = STICKERS[emotionKey];
  if (!sticker) return;
  try {
    await bot.telegram.sendSticker(TELEGRAM_CHANNEL_ID, sticker);
  } catch (err) {
    console.error("Channel sticker error:", err.message);
  }
}

async function sendMessageToChannel(text) {
  if (!TELEGRAM_CHANNEL_ID) return;
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHANNEL_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("Channel message error:", err.message);
  }
}

// ===============================
// FETCH WITH RETRY
// ===============================
async function fetchJSON(url, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs  = options.timeoutMs  ?? 15000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json", "User-Agent": "WojakMeterBot/1.0" };
      if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.status === 429) {
        if (attempt < maxRetries) { await sleep(1500 * attempt); continue; }
        const err = new Error("Request failed: 429"); err.status = 429; throw err;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err  = new Error(`Request failed: ${res.status} ${text}`.trim()); err.status = res.status; throw err;
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      const isLast    = attempt === maxRetries;
      const isTimeout = err.name === "AbortError";
      if (!isLast && (isTimeout || err.status === 429)) { await sleep(1000 * attempt); continue; }
      throw err;
    }
  }
}

// ===============================
// API LAYER + CACHE
// ===============================
async function getMarkets(force = false) {
  const now = Date.now();
  if (!force && cache.markets.data && now - cache.markets.ts < MARKET_CACHE_TTL) return cache.markets.data;
  const url = `${API_BASE}/coins/markets?vs_currency=${VS_CURRENCY}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h`;
  const data = await fetchJSON(url, { maxRetries: 3, timeoutMs: 15000 });
  cache.markets = { data: Array.isArray(data) ? data : [], ts: now };
  return cache.markets.data;
}

async function getTrending(force = false) {
  const now = Date.now();
  if (!force && cache.trending.data && now - cache.trending.ts < TRENDING_CACHE_TTL) return cache.trending.data;
  const data = await fetchJSON(`${API_BASE}/search/trending`, { maxRetries: 3, timeoutMs: 15000 });
  cache.trending = { data, ts: now };
  return data;
}

async function getGlobal(force = false) {
  const now = Date.now();
  if (!force && cache.global.data && now - cache.global.ts < GLOBAL_CACHE_TTL) return cache.global.data;
  const data = await fetchJSON(`${API_BASE}/global`, { maxRetries: 3, timeoutMs: 15000 });
  cache.global = { data, ts: now };
  return data;
}

// ===============================
// BUILDERS / FORMATTERS
// ===============================
function formatCoinLine(coin, index) {
  const symbol  = (coin.symbol || "").toUpperCase();
  const change  = safe(coin.price_change_percentage_24h, 0);
  const emotion = getEmotionByChange(change);
  const links   = buildTradeLinksFromSymbol(symbol);
  return `${index}. ${emotion.emoji} <b>${escapeHTML(coin.name || "Unknown")}</b> (${escapeHTML(symbol)})\n` +
         `   ${trendArrow(change)} ${formatPercent(change)} · ${formatUsd(coin.current_price)}\n` +
         `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`;
}

function formatCoinsBlock(title, coins) {
  if (!coins || !coins.length) return `⚠️ <b>${escapeHTML(title)}</b>\nNo data found.`;
  return `📌 <b>${escapeHTML(title)}</b>\n\n${coins.map((coin, i) => formatCoinLine(coin, i + 1)).join("\n\n")}`;
}

function buildPrettyAlert({ title, emotion, score, change, btcDom, volume, narrative }) {
  const level = getAlertLevel(score);
  return (
    `${level.icon} <b>${title}</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${narrative}` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildEmotionShiftAlert({ prevEmotion, nextEmotion, prevScore, nextScore, change, btcDom, volume }) {
  return (
    `🚨 <b>Emotion Shift</b>\n\n` +
    `${prevEmotion.emoji} <b>${prevEmotion.label}</b> → ${nextEmotion.emoji} <b>${nextEmotion.label}</b>\n` +
    `📊 Score: <b>${prevScore}</b> → <b>${nextScore}</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(nextScore))}</b>\n` +
    `📉 Market: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(nextEmotion.key)}` +
    buildSignalQualityBlock(nextScore, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildPanicAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🔴 <b>Panic Alert</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score collapsed to <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ Risk-off conditions are taking control.` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildEuphoriaAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🟢 <b>Euphoria Alert</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score reached <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📈 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ Momentum is overheating. Traders are chasing hard.` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildVolumeSpikeAlert({ emotion, score, change, btcDom, volume, prevVolume }) {
  const jump = prevVolume > 0 ? ((volume - prevVolume) / prevVolume) * 100 : 0;
  return (
    `💥 <b>Volume Spike</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n` +
    `📈 Spike: <b>${formatPercent(jump)}</b>\n\n` +
    `⚡ Activity just accelerated. Something is moving.` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildBreakingAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🚨 <b>BREAKING SIGNAL</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildCoinSpotlight(title, coin) {
  if (!coin) return null;
  const change  = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);
  const score   = scoreFromChange(change);
  const symbol  = (coin.symbol || "").toUpperCase();
  return (
    `🌟 <b>${title}</b>\n\n` +
    `${emotion.emoji} <b>${escapeHTML(coin.name)}</b> (${escapeHTML(symbol)})\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
    `📉 24h: <b>${formatPercent(change)}</b>\n` +
    `💰 MCap: <b>${formatUsd(coin.market_cap)}</b>\n` +
    `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildTradeLinksBlock(symbol) +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildCoinExtremeAlert(coin) {
  const change  = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);
  const score   = scoreFromChange(change);
  const symbol  = (coin.symbol || "").toUpperCase();
  const title   = score >= 85 ? "Coin Euphoria / FOMO Watch" : "Coin Panic / Capitulation Watch";
  return (
    `🚨 <b>${title}</b>\n\n` +
    `${emotion.emoji} <b>${escapeHTML(coin.name)}</b> (${escapeHTML(symbol)})\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
    `📉 24h: <b>${formatPercent(change)}</b>\n` +
    `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildTradeLinksBlock(symbol) +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function buildDailyWrap(globalData, markets) {
  const data    = globalData?.data || {};
  const change  = safe(data.market_cap_change_percentage_24h_usd);
  const score   = scoreFromChange(change);
  const emotion = getEmotionByChange(change);

  const gainers = [...markets].filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h)).slice(0, 3);
  const losers  = [...markets].filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h)).slice(0, 3);

  const formatMiniLine = (c) => {
    const symbol = (c.symbol || "").toUpperCase();
    const links  = buildTradeLinksFromSymbol(symbol);
    return `• <b>${escapeHTML(symbol)}</b> ${formatPercent(safe(c.price_change_percentage_24h))} · <a href="${links.binanceFutures}">Futures</a>`;
  };

  return (
    `🧾 <b>WojakMeter Daily Wrap</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 Market: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${safe(data.market_cap_percentage?.btc).toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(safe(data.total_volume?.usd))}</b>\n\n` +
    `🚀 <b>Top Gainers</b>\n${gainers.map(formatMiniLine).join("\n")}\n\n` +
    `💥 <b>Top Losers</b>\n${losers.map(formatMiniLine).join("\n")}\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function formatMarketOverview(globalData) {
  const data    = globalData?.data || {};
  const change  = data.market_cap_change_percentage_24h_usd ?? 0;
  const emotion = getEmotionByChange(change);
  const score   = scoreFromChange(change);
  const level   = getAlertLevel(score);
  return (
    `${level.icon} <b>WojakMeter Signal</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 24h Change: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC Dominance: <b>${(data.market_cap_percentage?.btc ?? 0).toFixed(2)}%</b>\n` +
    `💰 Market Cap: <b>${formatUsd(data.total_market_cap?.usd ?? 0)}</b>\n` +
    `💸 Volume 24h: <b>${formatUsd(data.total_volume?.usd ?? 0)}</b>\n` +
    `🪙 Active Coins: <b>${data.active_cryptocurrencies ?? 0}</b>\n` +
    `🏦 Markets: <b>${data.markets ?? 0}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function formatTrendingLines(trendingData, marketMap) {
  const coins = trendingData?.coins || [];
  if (!coins.length) return "⚠️ No trending coins found right now.";
  return coins.slice(0, 10).map((entry, i) => {
    const item       = entry.item || {};
    const symbol     = (item.symbol || "").toUpperCase();
    const marketCoin = marketMap.get((item.id || "").toLowerCase());
    const change     = marketCoin?.price_change_percentage_24h ?? 0;
    const price      = marketCoin?.current_price;
    const emotion    = getEmotionByChange(change);
    const links      = buildTradeLinksFromSymbol(symbol);
    const extra      = price !== undefined ? ` · ${formatUsd(price)} · ${formatPercent(change)}` : "";
    return `${i + 1}. ${emotion.emoji} <b>${escapeHTML(item.name || "Unknown")}</b> (${escapeHTML(symbol)})${extra}\n` +
           `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`;
  }).join("\n\n");
}

function getStrongestMover(markets = []) {
  if (!Array.isArray(markets) || !markets.length) return null;
  return [...markets].filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => Math.abs(safe(b.price_change_percentage_24h, 0)) - Math.abs(safe(a.price_change_percentage_24h, 0)))[0] || null;
}

function getSpotlights(markets = []) {
  const valid = markets.filter((c) => c.price_change_percentage_24h != null);
  return {
    topGainer:    [...valid].sort((a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h))[0] || null,
    topLoser:     [...valid].sort((a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h))[0] || null,
    volumeLeader: [...valid].sort((a, b) => safe(b.total_volume) - safe(a.total_volume))[0] || null
  };
}

function getCoinAlertType(change) {
  const score = scoreFromChange(change);
  if (score >= 85) return "coin_euphoria";
  if (score <= 20) return "coin_panic";
  return null;
}

// ===============================
// EVENT DETECTION
// ===============================
function detectMarketEvents(prev, next) {
  const events = [];
  if (!prev.emotionKey || prev.emotionKey !== next.emotionKey) events.push({ type: "emotion_shift" });
  if (next.score <= 20 && safe(prev.score, 100) > 20)         events.push({ type: "panic_alert" });
  if (next.score >= 85 && safe(prev.score, 0) < 85)           events.push({ type: "euphoria_alert" });
  if (next.volume && prev.volume && next.volume > prev.volume * 1.18) events.push({ type: "volume_spike" });
  if (Math.abs(safe(next.btcDom) - safe(prev.btcDom)) >= 0.6) events.push({ type: "btc_dominance_shift" });
  return events;
}

// ===============================
// BUSINESS LOGIC
// ===============================
async function replyWithError(ctx, error, prefix = "Error") {
  console.error(prefix, error);
  const msg = error?.status === 429
    ? "⚠️ Too many requests right now. Please try again in a moment."
    : "⚠️ Something went wrong while fetching market data.";
  try { await ctx.reply(msg, { reply_markup: buildMainKeyboard().reply_markup }); } catch (_) {}
}

async function sendSignal(ctx) {
  try {
    const global  = await getGlobal();
    const data    = global?.data || {};
    const change  = safe(data.market_cap_change_percentage_24h_usd);
    const score   = scoreFromChange(change);
    const emotion = getEmotionByChange(change);
    const text    = buildPrettyAlert({
      title: "WojakMeter Signal", emotion, score, change,
      btcDom: safe(data.market_cap_percentage?.btc),
      volume: safe(data.total_volume?.usd),
      narrative: getEmotionNarrative(emotion.key)
    });
    await sendEmotionSticker(ctx, emotion.key);
    return ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  } catch (error) { return replyWithError(ctx, error, "Error signal"); }
}

async function sendSpotlight(ctx) {
  try {
    const markets = await getMarkets();
    const coin    = getStrongestMover(markets);
    if (!coin) return ctx.reply("⚠️ No spotlight coin available right now.", { reply_markup: buildMainKeyboard().reply_markup });
    await sendEmotionSticker(ctx, getEmotionByChange(coin.price_change_percentage_24h).key);
    return ctx.reply(buildCoinSpotlight("Coin Spotlight", coin), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  } catch (error) { return replyWithError(ctx, error, "Error spotlight"); }
}

async function sendRisk(ctx) {
  try {
    const global  = await getGlobal();
    const data    = global?.data || {};
    const change  = safe(data.market_cap_change_percentage_24h_usd);
    const score   = scoreFromChange(change);
    let label = "Balanced";
    if (score <= 20) label = "Panic";
    else if (score <= 34) label = "Defensive";
    else if (score <= 44) label = "Hesitation";
    else if (score >= 85) label = "Overheated";
    else if (score >= 70) label = "Constructive";
    else if (score >= 60) label = "Positive";
    return ctx.reply(
      `⚠️ <b>Risk Tone</b>\n\n📊 Score: <b>${score}/100</b>\n🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n🧠 Tone: <b>${label}</b>\n📉 Move: <b>${formatPercent(change)}</b>` +
      buildSignalQualityBlock(score, change) + `\n\n🌐 wojakmeter.com`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error risk"); }
}

async function sendBtcMood(ctx) {
  try {
    const markets = await getMarkets();
    const btc     = markets.find((c) => (c.symbol || "").toLowerCase() === "btc");
    if (!btc) return ctx.reply("⚠️ BTC data unavailable.", { reply_markup: buildMainKeyboard().reply_markup });
    const change  = safe(btc.price_change_percentage_24h);
    const emotion = getEmotionByChange(change);
    const score   = scoreFromChange(change);
    const symbol  = (btc.symbol || "").toUpperCase();
    return ctx.reply(
      `₿ <b>BTC Mood</b>\n\n${emotion.emoji} <b>${emotion.label}</b>\n📊 Score: <b>${score}/100</b>\n🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n💵 Price: <b>${formatUsd(btc.current_price)}</b>\n📉 24h: <b>${formatPercent(change)}</b>\n\n⚡ ${getEmotionNarrative(emotion.key)}` +
      buildTradeLinksBlock(symbol) + buildSignalQualityBlock(score, change) + `\n\n🌐 wojakmeter.com`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error moodbtc"); }
}

async function sendCoinSignal(ctx, symbolOrId) {
  try {
    const markets = await getMarkets();
    const query   = String(symbolOrId || "").trim().toLowerCase();
    const coin    = markets.find((c) =>
      (c.symbol || "").toLowerCase() === query ||
      (c.id || "").toLowerCase() === query ||
      (c.name || "").toLowerCase() === query
    );
    if (!coin) return ctx.reply(`⚠️ Coin not found: <b>${escapeHTML(query)}</b>`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
    const change  = safe(coin.price_change_percentage_24h);
    const score   = scoreFromChange(change);
    const emotion = getEmotionByChange(change);
    const symbol  = (coin.symbol || "").toUpperCase();
    await sendEmotionSticker(ctx, emotion.key);
    return ctx.reply(
      `🪙 <b>${escapeHTML(coin.name)}</b> (${escapeHTML(symbol)})\n\n${emotion.emoji} <b>${emotion.label}</b>\n📊 Score: <b>${score}/100</b>\n🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n💵 Price: <b>${formatUsd(coin.current_price)}</b>\n📉 24h: <b>${formatPercent(change)}</b>\n💰 MCap: <b>${formatUsd(coin.market_cap)}</b>\n💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n⚡ ${getEmotionNarrative(emotion.key)}` +
      buildTradeLinksBlock(symbol) + buildSignalQualityBlock(score, change) + `\n\n🌐 wojakmeter.com`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error coin signal"); }
}

async function sendDaily(ctx) {
  try {
    const [global, markets] = await Promise.all([getGlobal(), getMarkets()]);
    return ctx.reply(buildDailyWrap(global, markets), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  } catch (error) { return replyWithError(ctx, error, "Error daily"); }
}

async function sendEmotionCoins(ctx, emotionEmoji) {
  const emotion = matchEmotionByEmoji(emotionEmoji);
  if (!emotion) return ctx.reply("⚠️ Emoji not supported.", { reply_markup: buildMainKeyboard().reply_markup });
  try {
    const markets  = await getMarkets();
    const filtered = markets
      .filter((coin) => { const c = safe(coin.price_change_percentage_24h, 0); return c >= emotion.min && c <= emotion.max; })
      .sort((a, b) => safe(b.market_cap, 0) - safe(a.market_cap, 0)).slice(0, 12);
    if (!filtered.length) return ctx.reply(`${emotion.emoji} No coins found in <b>${emotion.label}</b> right now.`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
    return ctx.reply(formatCoinsBlock(`${emotion.label} Coins`, filtered), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  } catch (error) { return replyWithError(ctx, error, "Error filtering coins"); }
}

async function sendTopGainers(ctx) {
  try {
    const markets = await getMarkets();
    const gainers = [...markets].filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => safe(b.price_change_percentage_24h, 0) - safe(a.price_change_percentage_24h, 0)).slice(0, 10);
    const avgChange = gainers.length ? gainers.reduce((s, c) => s + safe(c.price_change_percentage_24h, 0), 0) / gainers.length : 0;
    await sendEmotionSticker(ctx, getEmotionByChange(avgChange).key);
    return ctx.reply(
      formatCoinsBlock("Top Gainers (24h)", gainers) + `\n\n⚠️ <b>Discipline</b>\nStrong gainers can become FOMO traps. Wait for pullback or confirmation.`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error top gainers"); }
}

async function sendTopLosers(ctx) {
  try {
    const markets = await getMarkets();
    const losers  = [...markets].filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => safe(a.price_change_percentage_24h, 0) - safe(b.price_change_percentage_24h, 0)).slice(0, 10);
    const avgChange = losers.length ? losers.reduce((s, c) => s + safe(c.price_change_percentage_24h, 0), 0) / losers.length : 0;
    await sendEmotionSticker(ctx, getEmotionByChange(avgChange).key);
    return ctx.reply(
      formatCoinsBlock("Top Losers (24h)", losers) + `\n\n⚠️ <b>Discipline</b>\nHeavy losers can be falling knives. Wait for stabilization before considering any entry.`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error top losers"); }
}

async function sendTrending(ctx) {
  try {
    const [trending, markets] = await Promise.all([getTrending(), getMarkets()]);
    const marketMap = new Map(markets.map((coin) => [(coin.id || "").toLowerCase(), coin]));
    let totalChange = 0, count = 0;
    (trending?.coins || []).forEach((entry) => {
      const marketCoin = marketMap.get((entry.item?.id || "").toLowerCase());
      if (marketCoin?.price_change_percentage_24h != null) { totalChange += marketCoin.price_change_percentage_24h; count++; }
    });
    const avgChange = count ? totalChange / count : 0;
    const emotion   = getEmotionByChange(avgChange);
    const score     = scoreFromChange(avgChange);
    await sendEmotionSticker(ctx, emotion.key);
    return ctx.reply(
      `🔥 <b>Trending Coins</b>\n\n🧠 Mood: <b>${emotion.label}</b>\n📊 Trending Score: <b>${score}/100</b>\n🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n\n${formatTrendingLines(trending, marketMap)}\n\n⚠️ <b>Discipline</b>\nTrending does not mean safe entry. Avoid chasing without confirmation.\n\n🌐 wojakmeter.com`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error trending"); }
}

async function sendMarketOverview(ctx) {
  try {
    const global  = await getGlobal();
    const change  = global?.data?.market_cap_change_percentage_24h_usd ?? 0;
    await sendEmotionSticker(ctx, getEmotionByChange(change).key);
    return ctx.reply(formatMarketOverview(global), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  } catch (error) { return replyWithError(ctx, error, "Error market overview"); }
}

async function sendDiscipline(ctx) {
  return ctx.reply(
    `🧠 <b>WojakMeter Discipline Check</b>\n\nBefore entering any trade, answer this:\n\n1. Do I have a clear entry?\n2. Do I have a stop loss?\n3. Is my risk defined?\n4. Am I chasing a green candle?\n5. Am I trying to recover a loss?\n6. Can I accept this loss calmly?\n\n⚠️ <b>Rule:</b>\nIf the trade is emotional, it is not a setup.\n\n🧠 <b>WojakMeter Reminder:</b>\nThe market does not reward urgency. It rewards patience, risk control and clean execution.\n\n🌐 wojakmeter.com`,
    { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
  );
}

async function sendRadar(ctx) {
  try {
    const markets = await getMarkets();
    const valid   = markets.filter((c) => c.price_change_percentage_24h != null);
    const gainers = [...valid].sort((a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h)).slice(0, 5);
    const losers  = [...valid].sort((a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h)).slice(0, 5);
    const volumeLeaders = [...valid].sort((a, b) => safe(b.total_volume) - safe(a.total_volume)).slice(0, 5);

    const formatRadarLine = (coin) => {
      const symbol  = (coin.symbol || "").toUpperCase();
      const change  = safe(coin.price_change_percentage_24h);
      const score   = scoreFromChange(change);
      const emotion = getEmotionByChange(change);
      const links   = buildTradeLinksFromSymbol(symbol);
      return (
        `• ${emotion.emoji} <b>${escapeHTML(symbol)}</b> ${formatPercent(change)} · Score <b>${score}/100</b>\n` +
        `  Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
        `  <a href="${links.binanceFutures}">Futures</a> · <a href="${links.binanceSpot}">Spot</a> · <a href="${links.tradingView}">Chart</a>`
      );
    };

    return ctx.reply(
      `🧪 <b>WojakMeter Radar</b>\n\nThis radar highlights movement, not guaranteed entries.\n\n` +
      `🚀 <b>Strongest 24h Gainers</b>\n${gainers.map(formatRadarLine).join("\n\n")}\n\n` +
      `💥 <b>Strongest 24h Losers</b>\n${losers.map(formatRadarLine).join("\n\n")}\n\n` +
      `💸 <b>Volume Leaders</b>\n${volumeLeaders.map(formatRadarLine).join("\n\n")}\n\n` +
      `🧠 <b>Discipline:</b>\nDo not chase. Wait for confirmation. Define risk first.\n\n🌐 wojakmeter.com`,
      { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
    );
  } catch (error) { return replyWithError(ctx, error, "Error radar"); }
}

// ===============================
// AUTO BROADCAST
// ===============================
function shouldBroadcast(nextState) {
  const now           = Date.now();
  if (!lastBroadcastState.emotionKey) return true;
  const emotionChanged  = nextState.emotionKey !== lastBroadcastState.emotionKey;
  const scoreShift      = Math.abs(safe(nextState.score) - safe(lastBroadcastState.score)) >= SCORE_SHIFT_THRESHOLD;
  const panicEntered    = nextState.score <= 20 && safe(lastBroadcastState.score) > 20;
  const euphoriaEntered = nextState.score >= 85 && safe(lastBroadcastState.score) < 85;
  const enoughTime      = now - lastBroadcastState.ts >= MIN_BROADCAST_GAP_MS;
  return emotionChanged || panicEntered || euphoriaEntered || (scoreShift && enoughTime);
}

async function runChannelBroadcast() {
  try {
    if (!TELEGRAM_CHANNEL_ID) return;
    const global  = await getGlobal();
    const markets = await getMarkets();
    const data    = global?.data || {};
    const change  = safe(data.market_cap_change_percentage_24h_usd);
    const score   = scoreFromChange(change);
    const emotion = getEmotionByChange(change);
    const btcDom  = safe(data.market_cap_percentage?.btc);
    const volume  = safe(data.total_volume?.usd);

    const nextState = { emotionKey: emotion.key, score, change, btcDom, volume, ts: Date.now() };

    if (!shouldBroadcast(nextState)) {
      // Aun sin broadcast, evaluamos señal de auto-trade
      await evaluateAndTrade(nextState);
      return;
    }

    const events = detectMarketEvents(lastBroadcastState, nextState);
    if (!events.length) {
      await evaluateAndTrade(nextState);
      return;
    }

    await sendStickerToChannel(emotion.key);

    for (const event of events) {
      let msg = null;
      if (event.type === "emotion_shift") {
        const prevEmotion = EMOTION_CONFIG.find((e) => e.key === lastBroadcastState.emotionKey) || { emoji: "⚪", label: "Unknown" };
        msg = buildEmotionShiftAlert({ prevEmotion, nextEmotion: emotion, prevScore: safe(lastBroadcastState.score), nextScore: score, change, btcDom, volume });
      }
      if (event.type === "panic_alert")    msg = buildPanicAlert({ emotion, score, change, btcDom, volume });
      if (event.type === "euphoria_alert") msg = buildEuphoriaAlert({ emotion, score, change, btcDom, volume });
      if (event.type === "volume_spike")   msg = buildVolumeSpikeAlert({ emotion, score, change, btcDom, volume, prevVolume: safe(lastBroadcastState.volume) });
      if (event.type === "btc_dominance_shift") {
        msg =
          `₿ <b>BTC Dominance Shift</b>\n\n📊 Score: <b>${score}/100</b>\n🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
          `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n↕ Previous: <b>${safe(lastBroadcastState.btcDom).toFixed(2)}%</b>\n📉 Market Move: <b>${formatPercent(change)}</b>\n\n` +
          `⚡ Bitcoin dominance is moving fast. Rotation risk is rising.` +
          buildSignalQualityBlock(score, change) + `\n\n🌐 wojakmeter.com`;
      }
      if (msg) { await sendMessageToChannel(msg); await sleep(1200); }
    }

    const scoreJump = Math.abs(score - safe(lastBroadcastState.score));
    if (scoreJump >= BREAKING_SCORE_SHIFT_THRESHOLD) {
      await sendMessageToChannel(buildBreakingAlert({ emotion, score, change, btcDom, volume }));
      await sleep(1200);
    }

    const strongest = getStrongestMover(markets);
    if (strongest) {
      const coinAlertType = getCoinAlertType(strongest.price_change_percentage_24h);
      if (coinAlertType && strongest.id !== lastBroadcastState.spotlightCoinId) {
        await sendMessageToChannel(buildCoinExtremeAlert(strongest));
        await sendPersonalAlert(strongest, coinAlertType === "coin_euphoria" ? "FOMO Watch / Strong Mover" : "Capitulation Watch / Heavy Drop");
        lastBroadcastState.spotlightCoinId = strongest.id;
        await sleep(1200);
      }
    }

    const spotlights = getSpotlights(markets);
    if (score <= 20 && spotlights.topLoser) {
      await sendMessageToChannel(buildCoinSpotlight("Stress Spotlight", spotlights.topLoser));
      await sendPersonalAlert(spotlights.topLoser, "Stress Spotlight / Capitulation Watch");
    } else if (score >= 85 && spotlights.topGainer) {
      await sendMessageToChannel(buildCoinSpotlight("Momentum Spotlight", spotlights.topGainer));
      await sendPersonalAlert(spotlights.topGainer, "Momentum Spotlight / FOMO Watch");
    }

    lastBroadcastState = nextState;
    console.log("Broadcast events:", events.map((e) => e.type));

    // Evaluar señal de auto-trade después del broadcast
    await evaluateAndTrade(nextState);
  } catch (err) {
    console.error("Broadcast loop error:", err.message);
  }
}

// ===============================
// COMMANDS
// ===============================
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name ? escapeHTML(ctx.from.first_name) : "trader";
  await ctx.reply(
    `🤖 <b>Welcome to WojakMeter Bot</b>\n\nHi, <b>${firstName}</b>.\nUse the buttons or commands to read the market mood.\n\n<b>Main:</b>\n🧠 Signal\n📊 Market\n🔥 Trending\n🌟 Spotlight\n⚠️ Risk\n₿ BTC Mood\n🚀 Top Gainers\n💥 Top Losers\n🧪 Radar\n🧠 Discipline\n📋 My Plan private\n🪙 /coin btc\n🧾 /daily\n\n<b>AutoTrade:</b>\n🤖 AutoTrade ON / OFF\n/confirmar /cancelar /cerrar\n/posicion /ordenes /balance_binance`,
    { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🛠 <b>WojakMeter Bot Help</b>\n\n<b>Main:</b>\n🧠 Signal → live emotional market signal\n📊 Market → full global market overview\n🔥 Trending → trending coins + mood\n🌟 Spotlight → strongest coin move\n⚠️ Risk → current risk tone\n₿ BTC Mood → Bitcoin emotional read\n🚀 Top Gainers\n💥 Top Losers\n🧪 Radar\n🧠 Discipline\n📋 My Plan\n🪙 /coin btc\n🧾 /daily\n\n<b>AutoTrade (owner only):</b>\n🤖 AutoTrade ON → activa auto-trading\n🛑 AutoTrade OFF → desactiva\n/confirmar → confirma orden pendiente\n/cancelar → descarta orden pendiente\n/cerrar → cierra posición manualmente\n/posicion → estado de posición abierta\n/ordenes → órdenes SL/TP activas\n/balance_binance → balance de futuros\n\n<b>Private Owner:</b>\n/myplan /trade win 1.25 /trade loss 0.75\n/cooldown /resetday /scan /scandebug /testsignal\n\n<b>Watchlist:</b>\n/watch btc /unwatch btc /mywatchlist\n\n<b>Emotions:</b>\n🤩 😌 🙂 😐 🤔 😟 😡`,
    { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup }
  );
});

bot.command("signal",     sendSignal);
bot.command("market",     sendMarketOverview);
bot.command("trending",   sendTrending);
bot.command("spotlight",  sendSpotlight);
bot.command("risk",       sendRisk);
bot.command("moodbtc",    sendBtcMood);
bot.command("daily",      sendDaily);
bot.command("gainers",    sendTopGainers);
bot.command("losers",     sendTopLosers);
bot.command("radar",      sendRadar);
bot.command("discipline", sendDiscipline);

bot.command("emostatus",    async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoStatus(ctx); });
bot.command("emohistory",   async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoHistory(ctx); });
bot.command("emopairs",     async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoPairs(ctx); });
bot.command("emoconfirmar", async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoConfirmar(ctx); });
bot.command("emocancelar",  async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoCancelar(ctx); });
bot.command("emocerrar",    async (ctx) => { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoCerrar(ctx); });

// AutoTrade commands
bot.command("confirmar", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  if (!pendingConfirm) return ctx.reply("⚠️ No hay ninguna orden pendiente de confirmación.");
  const { side, symbol, qty, price, score } = pendingConfirm;
  pendingConfirm = null;
  await ctx.reply(`✅ Confirmado. Ejecutando ${side} en ${symbol}...`);
  await atExecuteConfirmed(symbol, side, qty, price, score);
});

bot.command("cancelar", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  if (!pendingConfirm) return ctx.reply("⚠️ No hay ninguna orden pendiente.");
  const { side, symbol } = pendingConfirm;
  pendingConfirm = null;
  return ctx.reply(`❌ Orden ${side} en ${symbol} cancelada.`);
});

bot.command("cerrar", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  if (!openPosition) return ctx.reply("⚠️ No tienes ninguna posición abierta.");
  await ctx.reply("⏳ Cerrando posición...");
  await atClosePosition("Manual por Telegram");
});

bot.command("posicion", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  try {
    const positions = await atGetOpenPositions();
    if (!positions.length && !openPosition) {
      return ctx.reply(
        `📈 <b>Posición Actual</b>\n\nNo hay posición abierta.\n\n🤖 AutoTrade: <b>${autoTradeActive ? "ON ✅" : "OFF 🛑"}</b>\nTestnet: <b>${USE_TESTNET ? "Sí" : "❗ REAL"}</b>`,
        { parse_mode: "HTML" }
      );
    }
    const lines = positions.map((p) => {
      const amt  = parseFloat(p.positionAmt);
      const pnl  = parseFloat(p.unRealizedProfit);
      return (
        `${amt > 0 ? "📈 LONG" : "📉 SHORT"} <b>${escapeHTML(p.symbol)}</b>\n` +
        `Entry: <b>${formatUsd(parseFloat(p.entryPrice))}</b>\n` +
        `Mark: <b>${formatUsd(parseFloat(p.markPrice))}</b>\n` +
        `PnL no realizado: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n` +
        `Qty: <b>${Math.abs(amt)}</b> | Leverage: <b>${p.leverage}x</b>`
      );
    });
    const pendingInfo = pendingConfirm
      ? `\n\n⏳ <b>Orden pendiente:</b>\n${pendingConfirm.side} ${pendingConfirm.symbol} — usa /confirmar o /cancelar`
      : "";
    return ctx.reply(
      `📈 <b>Posición Actual</b>\n\n${lines.join("\n\n")}${pendingInfo}\n\n🤖 AutoTrade: <b>${autoTradeActive ? "ON ✅" : "OFF 🛑"}</b>\nTestnet: <b>${USE_TESTNET ? "Sí" : "❗ REAL"}</b>\n\nUsa /cerrar para cerrar manualmente.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    return ctx.reply(`⚠️ Error al obtener posición:\n${err.message}`);
  }
});

bot.command("ordenes", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  try {
    const symbol = openPosition?.symbol || "BTCUSDT";
    const orders = await atGetOpenOrders(symbol);
    if (!orders.length) return ctx.reply(`📋 No hay órdenes abiertas para ${symbol}.`);
    const lines = orders.slice(0, 10).map((o) =>
      `• <b>${escapeHTML(o.type)}</b> ${escapeHTML(o.side)} ${o.origQty}\n  Stop: <b>${formatUsd(o.stopPrice || o.price)}</b> | ID: <code>${o.orderId}</code>`
    );
    return ctx.reply(`📋 <b>Órdenes Abiertas — ${escapeHTML(symbol)}</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  } catch (err) {
    return ctx.reply(`⚠️ Error al obtener órdenes:\n${err.message}`);
  }
});

bot.command("balance_binance", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  try {
    const balance = await atGetFuturesBalance();
    return ctx.reply(
      `💵 <b>Balance Futuros Binance</b>\n\nUSDT disponible: <b>${formatUsd(balance)}</b>\n\nRisk por trade: <b>${formatUsd(PERSONAL_PLAN.riskPerTrade)}</b>\nLeverage: <b>${AT_LEVERAGE}x</b>\nTestnet: <b>${USE_TESTNET ? "Sí" : "❗ REAL MONEY"}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    return ctx.reply(`⚠️ Error al obtener balance:\n${err.message}`);
  }
});

bot.command("testsignal", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  if (!PRIVATE_TELEGRAM_USER_ID) return ctx.reply("⚠️ PRIVATE_TELEGRAM_USER_ID is missing.", { reply_markup: buildMainKeyboard().reply_markup });
  const fakeSignal = {
    symbol: "BTCUSDT", baseSymbol: "BTC", interval: "24h", type: "TEST SIGNAL", direction: "LONG WATCH",
    mood: "Test / Bot working", score: 99, close: 65000, move1: 1.25, volume: 25000000000,
    marketCap: 1200000000000, volRatio: 2.08,
    reason: ["This is a manual test signal.", "If you see this, private market alerts are working."],
    warning: "This is only a test. Do not trade this."
  };
  try {
    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, buildMarketPersonalSignalMessage(fakeSignal), { parse_mode: "HTML", disable_web_page_preview: true });
    return ctx.reply("✅ Test signal sent to your private Telegram.", { reply_markup: buildMainKeyboard().reply_markup });
  } catch (err) {
    return ctx.reply(`⚠️ Test signal failed:\n\n${err.message}`, { reply_markup: buildMainKeyboard().reply_markup });
  }
});

bot.command("scandebug", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  resetPersonalStateIfNewDay();
  await ctx.reply("🧪 Running CoinGecko market scan debug...", { reply_markup: buildMainKeyboard().reply_markup });
  let checked = 0, found = [], errors = [], blockedReasons = [];
  if (!MARKET_SCANNER_ENABLED)   blockedReasons.push("MARKET_SCANNER_ENABLED is false");
  if (!PERSONAL_ALERTS_ENABLED)  blockedReasons.push("PERSONAL_ALERTS_ENABLED is false");
  if (!PRIVATE_TELEGRAM_USER_ID) blockedReasons.push("PRIVATE_TELEGRAM_USER_ID is missing");
  if (personalTradingState.coolingDown) blockedReasons.push("Cooling down is active");
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) blockedReasons.push("Max trades reached");
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) blockedReasons.push("Max daily loss reached");
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) blockedReasons.push("Daily profit lock reached");
  try {
    const markets      = await getMarkets(true);
    const allowedBases = MARKET_SCAN_SYMBOLS.map((s) => String(s).replace("USDT", "").toUpperCase());
    const filtered     = markets.filter((coin) => allowedBases.includes((coin.symbol || "").toUpperCase()));
    checked = filtered.length;
    found   = filtered.map(detectMarketSetup).filter(Boolean).sort((a, b) => b.score - a.score);
  } catch (err) { errors.push(err.message); }

  const topSignals = found.slice(0, 8).map((s, i) =>
    `${i + 1}. <b>${escapeHTML(s.symbol)}</b>\nType: <b>${escapeHTML(s.type)}</b>\nScore: <b>${s.score}/100</b>\n24h Move: <b>${formatPercent(s.move1)}</b>`
  ).join("\n\n");

  return ctx.reply(
    `✅ <b>Scan Debug Complete</b>\n\nCoins checked: <b>${checked}</b>\nSignals found: <b>${found.length}</b>\n\n` +
    `🚧 <b>Blocks</b>\n${blockedReasons.length ? blockedReasons.map((r) => `• ${escapeHTML(r)}`).join("\n") : "• None"}\n\n` +
    `⚠️ <b>Errors</b>\n${errors.length ? errors.map((e) => `• ${escapeHTML(e)}`).join("\n") : "• None"}\n\n` +
    (found.length ? `🔥 <b>Top Signals</b>\n${topSignals}` : `🧠 No signals found.`),
    { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup }
  );
});

bot.command("scan", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  await ctx.reply("🧪 Running CoinGecko market scanner now...", { reply_markup: buildMainKeyboard().reply_markup });
  await scanMarketPersonalSignals();
  return ctx.reply("✅ Scan complete.", { reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("myplan", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  return ctx.reply(buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("balance", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  const parts      = (ctx.message.text || "").split(" ").filter(Boolean);
  const newBalance = Number(parts[1]);
  if (!Number.isFinite(newBalance) || newBalance <= 0) return ctx.reply("Usage:\n/balance 53\n/balance 54.25", { reply_markup: buildMainKeyboard().reply_markup });
  PERSONAL_PLAN.balance = newBalance;
  return ctx.reply(`✅ Balance updated to <b>$${PERSONAL_PLAN.balance.toFixed(2)}</b>\n\n` + buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("trade", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  resetPersonalStateIfNewDay();
  const parts  = (ctx.message.text || "").split(" ").filter(Boolean);
  const result = (parts[1] || "").toLowerCase();
  const amount = Number(parts[2] || 0);
  if (!["win", "loss"].includes(result) || !Number.isFinite(amount) || amount <= 0) return ctx.reply("Usage:\n/trade win 1.25\n/trade loss 0.75", { reply_markup: buildMainKeyboard().reply_markup });
  personalTradingState.tradesToday += 1;
  if (result === "win") { personalTradingState.pnlToday += amount; PERSONAL_PLAN.balance += amount; }
  else { personalTradingState.pnlToday -= amount; PERSONAL_PLAN.balance -= amount; }
  let status = "✅ Trade logged.\n\n";
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock)                  { personalTradingState.coolingDown = true; status += "🔒 Daily profit lock reached.\n\n"; }
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss))           { personalTradingState.coolingDown = true; status += "🛑 Max daily loss reached.\n\n"; }
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay)                { personalTradingState.coolingDown = true; status += "📌 Max trades reached.\n\n"; }
  return ctx.reply(status + buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("cooldown", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  resetPersonalStateIfNewDay();
  personalTradingState.coolingDown = true;
  return ctx.reply("🧊 Cooling down activated.\n\n" + buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("resetday", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
  personalTradingState = { date: new Date().toISOString().slice(0, 10), tradesToday: 0, pnlToday: 0, coolingDown: false };
  return ctx.reply("🔄 Day reset.\n\n" + buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("coin", async (ctx) => {
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const query = parts.slice(1).join(" ");
  if (!query) return ctx.reply("Usage: /coin btc", { reply_markup: buildMainKeyboard().reply_markup });
  return sendCoinSignal(ctx, query);
});

bot.command("watch", async (ctx) => {
  const userId = ctx.from?.id;
  const parts  = (ctx.message.text || "").split(" ").filter(Boolean);
  const query  = normalizeCoinKey(parts[1]);
  if (!userId || !query) return ctx.reply("Usage: /watch btc", { reply_markup: buildMainKeyboard().reply_markup });
  getUserWatchlist(userId).add(query);
  return ctx.reply(`👁 Added <b>${escapeHTML(query.toUpperCase())}</b> to your watchlist.`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("unwatch", async (ctx) => {
  const userId = ctx.from?.id;
  const parts  = (ctx.message.text || "").split(" ").filter(Boolean);
  const query  = normalizeCoinKey(parts[1]);
  if (!userId || !query) return ctx.reply("Usage: /unwatch btc", { reply_markup: buildMainKeyboard().reply_markup });
  getUserWatchlist(userId).delete(query);
  return ctx.reply(`🗑 Removed <b>${escapeHTML(query.toUpperCase())}</b> from your watchlist.`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("mywatchlist", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const list = [...getUserWatchlist(userId)];
  if (!list.length) return ctx.reply("Your watchlist is empty.", { reply_markup: buildMainKeyboard().reply_markup });
  return ctx.reply(
    `👁 <b>Your Watchlist</b>\n\n${list.map((x, i) => `${i + 1}. ${escapeHTML(x.toUpperCase())}`).join("\n")}`,
    { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup }
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>\nUser ID: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
});

bot.command("teststicker", async (ctx) => {
  try {
    await ctx.replyWithSticker(STICKERS.neutral, { reply_markup: buildMainKeyboard().reply_markup });
  } catch (err) {
    await ctx.reply("⚠️ Could not send test sticker.", { reply_markup: buildMainKeyboard().reply_markup });
  }
});

bot.command("testchannel", async (ctx) => {
  try {
    await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, "✅ WojakMeter connected to channel");
    await ctx.reply("Sent to channel 🚀", { reply_markup: buildMainKeyboard().reply_markup });
  } catch (err) {
    await ctx.reply(`Channel error: ${err.message}`, { reply_markup: buildMainKeyboard().reply_markup });
  }
});

// ===============================
// STICKER CAPTURE
// ===============================
bot.on("sticker", async (ctx) => {
  const fileId = ctx.message.sticker.file_id;
  console.log("Sticker file_id:", fileId);
  await ctx.reply(`📌 Sticker guardado:\n\n<code>${fileId}</code>`, { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup });
});

// ===============================
// TEXT / BUTTON HANDLERS
// ===============================
bot.on("text", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId && isUserCoolingDown(userId)) return;
  const text = (ctx.message?.text || "").trim();
  if (text.startsWith("/")) return;

  if (text.includes("Signal"))      return sendSignal(ctx);
  if (text.includes("Market"))      return sendMarketOverview(ctx);
  if (text.includes("Trending"))    return sendTrending(ctx);
  if (text.includes("Spotlight"))   return sendSpotlight(ctx);
  if (text.includes("Risk"))        return sendRisk(ctx);
  if (text.includes("BTC Mood"))    return sendBtcMood(ctx);
  if (text.includes("Top Gainers")) return sendTopGainers(ctx);
  if (text.includes("Top Losers"))  return sendTopLosers(ctx);
  if (text.includes("Radar"))       return sendRadar(ctx);
  if (text.includes("Discipline"))  return sendDiscipline(ctx);

  if (text.includes("Emo Status"))  { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoStatus(ctx); }
  if (text.includes("Emo History")) { if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx); return emotionTrader.handleEmoHistory(ctx); }

  if (text.includes("AutoTrade ON")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    autoTradeActive = true;
    return ctx.reply(
      `🤖 <b>AutoTrade ACTIVADO</b>\n\nScore LONG: ≥${SCORE_LONG_MIN}/100\nScore SHORT: ≤${SCORE_SHORT_MAX}/100\nConfirmación: <b>${AUTO_TRADE_CONFIRM ? "Sí" : "No"}</b>\nTestnet: <b>${USE_TESTNET ? "SÍ (seguro)" : "❗ REAL MONEY"}</b>`,
      { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup }
    );
  }

  if (text.includes("AutoTrade OFF")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    autoTradeActive = false;
    return ctx.reply(
      `🛑 <b>AutoTrade DESACTIVADO</b>\n\nNo se abrirán nuevas órdenes automáticas.\nLas posiciones abiertas siguen activas.`,
      { parse_mode: "HTML", reply_markup: buildMainKeyboard().reply_markup }
    );
  }

  if (text.includes("Posición")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    return bot.handleUpdate({ update_id: 0, message: { ...ctx.message, text: "/posicion" } }).catch(() => {});
  }

  if (text.includes("Órdenes")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    return bot.handleUpdate({ update_id: 0, message: { ...ctx.message, text: "/ordenes" } }).catch(() => {});
  }

  if (text.includes("My Plan")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    return ctx.reply(buildMyPlanMessage(), { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buildMainKeyboard().reply_markup });
  }

  if (EMOJI_SET.has(text)) {
    const emotion = matchEmotionByEmoji(text);
    await sendEmotionSticker(ctx, emotion.key);
    return sendEmotionCoins(ctx, text);
  }

  return ctx.reply("Send an emotion or use the buttons.", { reply_markup: buildMainKeyboard().reply_markup });
});

// ===============================
// SAFETY
// ===============================
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err);
  try { ctx.reply("⚠️ Unexpected bot error."); } catch (_) {}
});

// ===============================
// CACHE WARMUP / REFRESH
// ===============================
async function warmUpCache() {
  try {
    await Promise.allSettled([getMarkets(), getTrending(), getGlobal()]);
    console.log("Cache warmed.");
  } catch (err) {
    console.error("Warm cache failed:", err.message);
  }
}

setInterval(async () => {
  try {
    await Promise.allSettled([getMarkets(true), getTrending(true), getGlobal(true)]);
    console.log("Background cache refresh OK");
  } catch (err) {
    console.error("Background cache refresh failed:", err.message);
  }
}, 90 * 1000);

setInterval(runChannelBroadcast, BROADCAST_INTERVAL_MS);
setInterval(scanMarketPersonalSignals, MARKET_SCAN_INTERVAL_MS);

// ===============================
// HEALTHCHECK
// ===============================
app.get("/", (req, res) => res.status(200).send("WojakMeter bot is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, service: "wojakmeter-bot", uptime: process.uptime(), timestamp: new Date().toISOString() }));

app.listen(PORT, "0.0.0.0", () => console.log(`HTTP server listening on port ${PORT}`));

// ===============================
// START
// ===============================
(async () => {
  await bot.launch();
  console.log("WojakMeter bot running...");
  await warmUpCache().catch(console.error);
  await runChannelBroadcast().catch(console.error);
  await scanMarketPersonalSignals().catch(console.error);

  // Iniciar EmoTrader
  emotionTrader.start({
    bot,
    PERSONAL_PLAN,
    personalTradingState,
    resetPersonalStateIfNewDay,
    PRIVATE_TELEGRAM_USER_ID,
    binanceApiKey:    BINANCE_API_KEY,
    binanceApiSecret: BINANCE_API_SECRET,
    useTestnet:       USE_TESTNET,
  });
})();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
