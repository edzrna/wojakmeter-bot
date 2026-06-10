require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

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
// BINANCE PERSONAL SCANNER CONFIG
// ===============================
const BINANCE_FUTURES_BASE = "https://fapi.binance.com";
const BINANCE_PERSONAL_SCANNER_ENABLED =
  process.env.BINANCE_PERSONAL_SCANNER_ENABLED === "true";

const BINANCE_SCAN_INTERVAL_MS = Number(process.env.BINANCE_SCAN_INTERVAL_MS || 60000);

const BINANCE_SCAN_SYMBOLS = String(
  process.env.BINANCE_SCAN_SYMBOLS ||
    "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,PEPEUSDT,WIFUSDT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const BINANCE_MIN_SIGNAL_SCORE = Number(process.env.BINANCE_MIN_SIGNAL_SCORE || 80);
const PERSONAL_BINANCE_ALERT_COOLDOWN_MS = Number(
  process.env.PERSONAL_BINANCE_ALERT_COOLDOWN_MS || 20 * 60 * 1000
);

let lastPersonalBinanceAlerts = new Map();

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
  const base = normalizePairSymbol(symbol);

  const futuresPair = base.endsWith("USDT") ? base : `${base}USDT`;
  const spotPair = base.endsWith("USDT")
    ? base.replace("USDT", "_USDT")
    : `${base}_USDT`;

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
// BINANCE FUTURES PERSONAL SCANNER
// ===============================
async function getBinanceKlines(symbol, interval = "15m", limit = 80) {
  const url =
    `${BINANCE_FUTURES_BASE}/fapi/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${encodeURIComponent(limit)}`;

  const data = await fetchJSON(url, { maxRetries: 2, timeoutMs: 10000 });
  if (!Array.isArray(data)) return [];

  return data.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
    takerBuyBaseVolume: Number(k[9]),
    takerBuyQuoteVolume: Number(k[10])
  }));
}

function calculateRSI(closes = [], period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 2) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateEMA(values = [], period = 9) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function average(values = []) {
  const valid = values.filter((v) => Number.isFinite(Number(v)));
  if (!valid.length) return 0;
  return valid.reduce((sum, v) => sum + Number(v), 0) / valid.length;
}

function percentMove(from, to) {
  if (!from || !to) return 0;
  return ((to - from) / from) * 100;
}

function getRecentHigh(candles = [], lookback = 20) {
  const recent = candles.slice(-lookback);
  if (!recent.length) return 0;
  return Math.max(...recent.map((c) => c.high));
}

function getRecentLow(candles = [], lookback = 20) {
  const recent = candles.slice(-lookback);
  if (!recent.length) return 0;
  return Math.min(...recent.map((c) => c.low));
}

function detectBinanceSetup(symbol, interval, candles) {
  if (!candles || candles.length < 40) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.quoteVolume || c.volume);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const close = last.close;
  const open = last.open;

  const move1 = percentMove(prev.close, close);
  const move5 = percentMove(candles[candles.length - 6].close, close);
  const move20 = percentMove(candles[candles.length - 21].close, close);

  const avgVol20 = average(volumes.slice(-21, -1));
  const volRatio = avgVol20 > 0 ? (last.quoteVolume || last.volume) / avgVol20 : 1;

  const rsi = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  const recentHigh = getRecentHigh(candles.slice(0, -1), 20);
  const recentLow = getRecentLow(candles.slice(0, -1), 20);

  const bullishCandle = close > open;
  const bearishCandle = close < open;

  const breakingHigh = recentHigh > 0 && close > recentHigh;
  const losingLow = recentLow > 0 && close < recentLow;

  const trendBullish = ema9 && ema21 && ema9 > ema21;
  const trendBearish = ema9 && ema21 && ema9 < ema21;

  let type = "Observation";
  let direction = "WAIT";
  let mood = "Neutral";
  let score = 50;
  let reason = [];
  let warning = "This is a watchlist alert, not a direct entry.";

  if (move5 >= 1.2 && volRatio >= 1.8 && bullishCandle) {
    type = "FOMO Watch / Strong Mover";
    direction = "WAIT FOR PULLBACK";
    mood = "Euphoria / Overheat";
    score = 70 + Math.min(20, move5 * 4) + Math.min(10, volRatio * 2);
    reason.push(`Strong ${interval} momentum: ${formatPercent(move5)}`);
    reason.push(`Volume spike: ${volRatio.toFixed(2)}x average`);
    warning = "Avoid chasing. Wait for pullback or retest.";
  }

  if (move5 <= -1.2 && volRatio >= 1.8 && bearishCandle) {
    type = "Capitulation Watch / Heavy Drop";
    direction = "WAIT FOR STABILIZATION";
    mood = "Panic / Sell Pressure";
    score = 70 + Math.min(20, Math.abs(move5) * 4) + Math.min(10, volRatio * 2);
    reason.push(`Heavy ${interval} drop: ${formatPercent(move5)}`);
    reason.push(`Volume spike: ${volRatio.toFixed(2)}x average`);
    warning = "Do not catch the knife. Wait for stabilization.";
  }

  if (
    trendBullish &&
    bullishCandle &&
    volRatio >= 1.25 &&
    rsi >= 45 &&
    rsi <= 68 &&
    move1 > 0.15 &&
    move5 > -0.8
  ) {
    type = "Possible LONG Setup";
    direction = "LONG WATCH";
    mood = "Optimism / Recovery";
    score = 72;
    if (volRatio >= 1.8) score += 8;
    if (breakingHigh) score += 8;
    if (rsi >= 50 && rsi <= 62) score += 5;
    if (move20 > 0) score += 5;

    reason.push("EMA trend improving: EMA9 above EMA21");
    reason.push(`Buyer candle with volume: ${volRatio.toFixed(2)}x average`);
    reason.push(`RSI healthy: ${rsi.toFixed(1)}`);
    if (breakingHigh) reason.push("Price is breaking recent high");

    warning = "Wait for confirmation or retest. Do not enter late.";
  }

  if (
    trendBearish &&
    bearishCandle &&
    volRatio >= 1.25 &&
    rsi >= 32 &&
    rsi <= 55 &&
    move1 < -0.15 &&
    move5 < 0.8
  ) {
    type = "Possible SHORT Setup";
    direction = "SHORT WATCH";
    mood = "Concern / Breakdown";
    score = 72;
    if (volRatio >= 1.8) score += 8;
    if (losingLow) score += 8;
    if (rsi >= 38 && rsi <= 50) score += 5;
    if (move20 < 0) score += 5;

    reason.push("EMA trend weakening: EMA9 below EMA21");
    reason.push(`Seller candle with volume: ${volRatio.toFixed(2)}x average`);
    reason.push(`RSI weak: ${rsi.toFixed(1)}`);
    if (losingLow) reason.push("Price is losing recent low");

    warning = "Wait for confirmation. Avoid shorting after an extended dump.";
  }

  score = Math.round(clamp(score, 0, 100));

  if (score < BINANCE_MIN_SIGNAL_SCORE) return null;

  return {
    symbol,
    interval,
    type,
    direction,
    mood,
    score,
    close,
    move1,
    move5,
    move20,
    volRatio,
    rsi,
    ema9,
    ema21,
    recentHigh,
    recentLow,
    reason,
    warning
  };
}

function buildBinancePersonalSignalMessage(signal) {
  resetPersonalStateIfNewDay();

  const links = buildTradeLinksFromSymbol(signal.symbol);
  const reasonLines = signal.reason.length
    ? signal.reason.map((r) => `• ${escapeHTML(r)}`).join("\n")
    : "• Market movement detected.";

  return (
    `🔥 <b>WOJAKMETER PERSONAL SIGNAL</b>\n\n` +
    `Pair: <b>${escapeHTML(signal.symbol)}</b>\n` +
    `Timeframe: <b>${escapeHTML(signal.interval)}</b>\n` +
    `Type: <b>${escapeHTML(signal.type)}</b>\n` +
    `Direction: <b>${escapeHTML(signal.direction)}</b>\n` +
    `Mood: <b>${escapeHTML(signal.mood)}</b>\n` +
    `Score: <b>${signal.score}/100</b>\n\n` +

    `📊 <b>Market Data</b>\n` +
    `Price: <b>${formatUsd(signal.close)}</b>\n` +
    `Last candle: <b>${formatPercent(signal.move1)}</b>\n` +
    `Recent move: <b>${formatPercent(signal.move5)}</b>\n` +
    `Trend move: <b>${formatPercent(signal.move20)}</b>\n` +
    `Volume: <b>${signal.volRatio.toFixed(2)}x avg</b>\n` +
    `RSI: <b>${signal.rsi.toFixed(1)}</b>\n\n` +

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

function canSendBinancePersonalSignal(signal) {
  resetPersonalStateIfNewDay();

  if (!BINANCE_PERSONAL_SCANNER_ENABLED) return false;
  if (!canSendPersonalAlert(signal.score)) return false;

  const key = `${signal.symbol}:${signal.interval}:${signal.type}`;
  const last = lastPersonalBinanceAlerts.get(key) || 0;
  const now = Date.now();

  if (now - last < PERSONAL_BINANCE_ALERT_COOLDOWN_MS) return false;

  lastPersonalBinanceAlerts.set(key, now);
  return true;
}

async function sendBinancePersonalSignal(signal) {
  try {
    if (!canSendBinancePersonalSignal(signal)) return;

    const msg = buildBinancePersonalSignalMessage(signal);

    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, msg, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });

    console.log(
      `Personal Binance signal sent: ${signal.symbol} ${signal.interval} ${signal.type} score ${signal.score}`
    );
  } catch (err) {
    console.error("Send Binance personal signal error:", err.message);
  }
}

async function scanBinancePersonalSignals() {
  try {
    if (!BINANCE_PERSONAL_SCANNER_ENABLED) return;
    if (!PERSONAL_ALERTS_ENABLED) return;
    if (!PRIVATE_TELEGRAM_USER_ID) return;

    resetPersonalStateIfNewDay();

    if (personalTradingState.coolingDown) return;
    if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return;
    if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return;
    if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return;

    const intervals = ["5m", "15m", "1h"];

    for (const symbol of BINANCE_SCAN_SYMBOLS) {
      for (const interval of intervals) {
        try {
          const candles = await getBinanceKlines(symbol, interval, 80);
          const signal = detectBinanceSetup(symbol, interval, candles);

          if (signal) {
            await sendBinancePersonalSignal(signal);
            await sleep(750);
          }
        } catch (err) {
          console.error(`Binance scan error ${symbol} ${interval}:`, err.message);
        }
      }

      await sleep(500);
    }
  } catch (err) {
    console.error("Binance personal scanner error:", err.message);
  }
}

function buildMainKeyboard() {
  return Markup.keyboard([
    ["🧠 Signal", "📊 Market"],
    ["🔥 Trending", "🌟 Spotlight"],
    ["⚠️ Risk", "₿ BTC Mood"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["🧪 Radar", "🧠 Discipline"],
    ["📋 My Plan"],
    ["/coin btc", "/daily"],
    ["/mywatchlist", "/scan"],
    ["🤩", "😌", "🙂", "😐"],
    ["🤔", "😟", "😡"],
    ["/start", "/help", "/teststicker", "/testchannel"]
  ]).resize();
}

function normalizeCoinKey(input) {
  return String(input || "").trim().toLowerCase();
}

function getUserWatchlist(userId) {
  if (!userWatchlists.has(userId)) {
    userWatchlists.set(userId, new Set());
  }
  return userWatchlists.get(userId);
}

// ===============================
// TELEGRAM SENDERS
// ===============================
async function sendEmotionSticker(ctx, emotionKey) {
  const sticker = STICKERS[emotionKey];
  if (!sticker) return;

  try {
    await ctx.replyWithSticker(sticker, {
      reply_markup: buildMainKeyboard().reply_markup
    });
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
  const timeoutMs = options.timeoutMs ?? 15000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "WojakMeterBot/1.0",
        },
        signal: controller.signal,
      });

      clearTimeout(t);

      if (res.status === 429) {
        const waitMs = 1500 * attempt;
        if (attempt < maxRetries) {
          await sleep(waitMs);
          continue;
        }
        const err = new Error("Request failed: 429");
        err.status = 429;
        throw err;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Request failed: ${res.status} ${text}`.trim());
        err.status = res.status;
        throw err;
      }

      return await res.json();
    } catch (err) {
      clearTimeout(t);

      const isLast = attempt === maxRetries;
      const isTimeout = err.name === "AbortError";

      if (!isLast && (isTimeout || err.status === 429)) {
        await sleep(1000 * attempt);
        continue;
      }

      throw err;
    }
  }
}

// ===============================
// API LAYER + CACHE
// ===============================
async function getMarkets(force = false) {
  const now = Date.now();
  if (!force && cache.markets.data && now - cache.markets.ts < MARKET_CACHE_TTL) {
    return cache.markets.data;
  }

  const url =
    `${API_BASE}/coins/markets` +
    `?vs_currency=${VS_CURRENCY}` +
    `&order=market_cap_desc` +
    `&per_page=100&page=1` +
    `&sparkline=false` +
    `&price_change_percentage=24h`;

  const data = await fetchJSON(url, { maxRetries: 3, timeoutMs: 15000 });

  cache.markets = {
    data: Array.isArray(data) ? data : [],
    ts: now,
  };

  return cache.markets.data;
}

async function getTrending(force = false) {
  const now = Date.now();
  if (!force && cache.trending.data && now - cache.trending.ts < TRENDING_CACHE_TTL) {
    return cache.trending.data;
  }

  const url = `${API_BASE}/search/trending`;
  const data = await fetchJSON(url, { maxRetries: 3, timeoutMs: 15000 });

  cache.trending = {
    data,
    ts: now,
  };

  return data;
}

async function getGlobal(force = false) {
  const now = Date.now();
  if (!force && cache.global.data && now - cache.global.ts < GLOBAL_CACHE_TTL) {
    return cache.global.data;
  }

  const url = `${API_BASE}/global`;
  const data = await fetchJSON(url, { maxRetries: 3, timeoutMs: 15000 });

  cache.global = {
    data,
    ts: now,
  };

  return data;
}

// ===============================
// BUILDERS / FORMATTERS
// ===============================
function formatCoinLine(coin, index) {
  const symbol = (coin.symbol || "").toUpperCase();
  const name = coin.name || "Unknown";
  const price = formatUsd(coin.current_price);
  const change = safe(coin.price_change_percentage_24h, 0);
  const emotion = getEmotionByChange(change);
  const links = buildTradeLinksFromSymbol(symbol);

  return `${index}. ${emotion.emoji} <b>${escapeHTML(name)}</b> (${escapeHTML(symbol)})\n` +
         `   ${trendArrow(change)} ${formatPercent(change)} · ${price}\n` +
         `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`;
}

function formatCoinsBlock(title, coins) {
  if (!coins || !coins.length) {
    return `⚠️ <b>${escapeHTML(title)}</b>\nNo data found.`;
  }

  const lines = coins.map((coin, i) => formatCoinLine(coin, i + 1));
  return `📌 <b>${escapeHTML(title)}</b>\n\n${lines.join("\n\n")}`;
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

function buildEmotionShiftAlert({
  prevEmotion,
  nextEmotion,
  prevScore,
  nextScore,
  change,
  btcDom,
  volume
}) {
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

  const change = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);
  const score = scoreFromChange(change);
  const symbol = (coin.symbol || "").toUpperCase();

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
  const change = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);
  const score = scoreFromChange(change);
  const symbol = (coin.symbol || "").toUpperCase();

  const title = score >= 85 ? "Coin Euphoria / FOMO Watch" : "Coin Panic / Capitulation Watch";

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
  const data = globalData?.data || {};
  const change = safe(data.market_cap_change_percentage_24h_usd);
  const score = scoreFromChange(change);
  const emotion = getEmotionByChange(change);

  const gainers = [...markets]
    .filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h))
    .slice(0, 3);

  const losers = [...markets]
    .filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h))
    .slice(0, 3);

  const formatMiniLine = (c) => {
    const symbol = (c.symbol || "").toUpperCase();
    const links = buildTradeLinksFromSymbol(symbol);
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
  const data = globalData?.data || {};
  const totalMcap = data.total_market_cap?.usd ?? 0;
  const totalVol = data.total_volume?.usd ?? 0;
  const btcDom = data.market_cap_percentage?.btc ?? 0;
  const active = data.active_cryptocurrencies ?? 0;
  const markets = data.markets ?? 0;
  const change = data.market_cap_change_percentage_24h_usd ?? 0;

  const emotion = getEmotionByChange(change);
  const score = scoreFromChange(change);
  const level = getAlertLevel(score);

  return (
    `${level.icon} <b>WojakMeter Signal</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
    `📉 24h Change: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC Dominance: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💰 Market Cap: <b>${formatUsd(totalMcap)}</b>\n` +
    `💸 Volume 24h: <b>${formatUsd(totalVol)}</b>\n` +
    `🪙 Active Coins: <b>${active}</b>\n` +
    `🏦 Markets: <b>${markets}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}` +
    buildSignalQualityBlock(score, change) +
    `\n\n🌐 wojakmeter.com`
  );
}

function formatTrendingLines(trendingData, marketMap) {
  const coins = trendingData?.coins || [];
  if (!coins.length) return "⚠️ No trending coins found right now.";

  return coins.slice(0, 10).map((entry, i) => {
    const item = entry.item || {};
    const symbol = (item.symbol || "").toUpperCase();
    const marketCoin = marketMap.get((item.id || "").toLowerCase());
    const change = marketCoin?.price_change_percentage_24h ?? 0;
    const price = marketCoin?.current_price;
    const emotion = getEmotionByChange(change);
    const links = buildTradeLinksFromSymbol(symbol);

    let extra = "";
    if (price !== undefined) {
      extra = ` · ${formatUsd(price)} · ${formatPercent(change)}`;
    }

    return `${i + 1}. ${emotion.emoji} <b>${escapeHTML(item.name || "Unknown")}</b> (${escapeHTML(symbol)})${extra}\n` +
           `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`;
  }).join("\n\n");
}

function getStrongestMover(markets = []) {
  if (!Array.isArray(markets) || !markets.length) return null;

  const sorted = [...markets]
    .filter((c) => c.price_change_percentage_24h != null)
    .sort((a, b) => Math.abs(safe(b.price_change_percentage_24h, 0)) - Math.abs(safe(a.price_change_percentage_24h, 0)));

  return sorted[0] || null;
}

function getSpotlights(markets = []) {
  const valid = markets.filter((c) => c.price_change_percentage_24h != null);

  const gainers = [...valid].sort(
    (a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h)
  );

  const losers = [...valid].sort(
    (a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h)
  );

  const volumeLeaders = [...valid].sort(
    (a, b) => safe(b.total_volume) - safe(a.total_volume)
  );

  return {
    topGainer: gainers[0] || null,
    topLoser: losers[0] || null,
    volumeLeader: volumeLeaders[0] || null
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

  if (!prev.emotionKey || prev.emotionKey !== next.emotionKey) {
    events.push({ type: "emotion_shift" });
  }

  if (next.score <= 20 && safe(prev.score, 100) > 20) {
    events.push({ type: "panic_alert" });
  }

  if (next.score >= 85 && safe(prev.score, 0) < 85) {
    events.push({ type: "euphoria_alert" });
  }

  if (next.volume && prev.volume && next.volume > prev.volume * 1.18) {
    events.push({ type: "volume_spike" });
  }

  if (Math.abs(safe(next.btcDom) - safe(prev.btcDom)) >= 0.6) {
    events.push({ type: "btc_dominance_shift" });
  }

  return events;
}

// ===============================
// BUSINESS LOGIC
// ===============================
async function replyWithError(ctx, error, prefix = "Error") {
  console.error(prefix, error);

  const msg =
    error?.status === 429
      ? "⚠️ Too many requests right now. Please try again in a moment."
      : "⚠️ Something went wrong while fetching market data.";

  try {
    await ctx.reply(msg, { reply_markup: buildMainKeyboard().reply_markup });
  } catch (_) {}
}

async function sendSignal(ctx) {
  try {
    const global = await getGlobal();
    const data = global?.data || {};
    const change = safe(data.market_cap_change_percentage_24h_usd);
    const score = scoreFromChange(change);
    const emotion = getEmotionByChange(change);

    const text = buildPrettyAlert({
      title: "WojakMeter Signal",
      emotion,
      score,
      change,
      btcDom: safe(data.market_cap_percentage?.btc),
      volume: safe(data.total_volume?.usd),
      narrative: getEmotionNarrative(emotion.key)
    });

    await sendEmotionSticker(ctx, emotion.key);

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error signal");
  }
}

async function sendSpotlight(ctx) {
  try {
    const markets = await getMarkets();
    const coin = getStrongestMover(markets);

    if (!coin) {
      return ctx.reply("⚠️ No spotlight coin available right now.", {
        reply_markup: buildMainKeyboard().reply_markup
      });
    }

    const emotion = getEmotionByChange(coin.price_change_percentage_24h);
    await sendEmotionSticker(ctx, emotion.key);

    return ctx.reply(buildCoinSpotlight("Coin Spotlight", coin), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error spotlight");
  }
}

async function sendRisk(ctx) {
  try {
    const global = await getGlobal();
    const data = global?.data || {};
    const change = safe(data.market_cap_change_percentage_24h_usd);
    const score = scoreFromChange(change);

    let label = "Balanced";
    if (score <= 20) label = "Panic";
    else if (score <= 34) label = "Defensive";
    else if (score <= 44) label = "Hesitation";
    else if (score >= 85) label = "Overheated";
    else if (score >= 70) label = "Constructive";
    else if (score >= 60) label = "Positive";

    return ctx.reply(
      `⚠️ <b>Risk Tone</b>\n\n` +
      `📊 Score: <b>${score}/100</b>\n` +
      `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
      `🧠 Tone: <b>${label}</b>\n` +
      `📉 Move: <b>${formatPercent(change)}</b>` +
      buildSignalQualityBlock(score, change) +
      `\n\n🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (error) {
    return replyWithError(ctx, error, "Error risk");
  }
}

async function sendBtcMood(ctx) {
  try {
    const markets = await getMarkets();
    const btc = markets.find((c) => (c.symbol || "").toLowerCase() === "btc");

    if (!btc) {
      return ctx.reply("⚠️ BTC data unavailable.", {
        reply_markup: buildMainKeyboard().reply_markup
      });
    }

    const change = safe(btc.price_change_percentage_24h);
    const emotion = getEmotionByChange(change);
    const score = scoreFromChange(change);
    const symbol = (btc.symbol || "").toUpperCase();

    return ctx.reply(
      `₿ <b>BTC Mood</b>\n\n` +
      `${emotion.emoji} <b>${emotion.label}</b>\n` +
      `📊 Score: <b>${score}/100</b>\n` +
      `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
      `💵 Price: <b>${formatUsd(btc.current_price)}</b>\n` +
      `📉 24h: <b>${formatPercent(change)}</b>\n\n` +
      `⚡ ${getEmotionNarrative(emotion.key)}` +
      buildTradeLinksBlock(symbol) +
      buildSignalQualityBlock(score, change) +
      `\n\n🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (error) {
    return replyWithError(ctx, error, "Error moodbtc");
  }
}

async function sendCoinSignal(ctx, symbolOrId) {
  try {
    const markets = await getMarkets();
    const query = String(symbolOrId || "").trim().toLowerCase();

    const coin = markets.find((c) =>
      (c.symbol || "").toLowerCase() === query ||
      (c.id || "").toLowerCase() === query ||
      (c.name || "").toLowerCase() === query
    );

    if (!coin) {
      return ctx.reply(`⚠️ Coin not found: <b>${escapeHTML(query)}</b>`, {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      });
    }

    const change = safe(coin.price_change_percentage_24h);
    const score = scoreFromChange(change);
    const emotion = getEmotionByChange(change);
    const symbol = (coin.symbol || "").toUpperCase();

    const text =
      `🪙 <b>${escapeHTML(coin.name)}</b> (${escapeHTML(symbol)})\n\n` +
      `${emotion.emoji} <b>${emotion.label}</b>\n` +
      `📊 Score: <b>${score}/100</b>\n` +
      `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
      `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
      `📉 24h: <b>${formatPercent(change)}</b>\n` +
      `💰 MCap: <b>${formatUsd(coin.market_cap)}</b>\n` +
      `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
      `⚡ ${getEmotionNarrative(emotion.key)}` +
      buildTradeLinksBlock(symbol) +
      buildSignalQualityBlock(score, change) +
      `\n\n🌐 wojakmeter.com`;

    await sendEmotionSticker(ctx, emotion.key);

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error coin signal");
  }
}

async function sendDaily(ctx) {
  try {
    const [global, markets] = await Promise.all([getGlobal(), getMarkets()]);
    return ctx.reply(buildDailyWrap(global, markets), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error daily");
  }
}

async function sendEmotionCoins(ctx, emotionEmoji) {
  const emotion = matchEmotionByEmoji(emotionEmoji);
  if (!emotion) {
    return ctx.reply("⚠️ Emoji not supported.", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  try {
    const markets = await getMarkets();
    const filtered = markets
      .filter((coin) => {
        const change = safe(coin.price_change_percentage_24h, 0);
        return change >= emotion.min && change <= emotion.max;
      })
      .sort((a, b) => safe(b.market_cap, 0) - safe(a.market_cap, 0))
      .slice(0, 12);

    if (!filtered.length) {
      return ctx.reply(
        `${emotion.emoji} No coins found in <b>${emotion.label}</b> right now.`,
        {
          parse_mode: "HTML",
          reply_markup: buildMainKeyboard().reply_markup
        }
      );
    }

    const text = formatCoinsBlock(`${emotion.label} Coins`, filtered);
    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error filtering coins");
  }
}

async function sendTopGainers(ctx) {
  try {
    const markets = await getMarkets();
    const gainers = [...markets]
      .filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => safe(b.price_change_percentage_24h, 0) - safe(a.price_change_percentage_24h, 0))
      .slice(0, 10);

    const avgChange =
      gainers.length
        ? gainers.reduce((sum, coin) => sum + safe(coin.price_change_percentage_24h, 0), 0) / gainers.length
        : 0;

    const emotion = getEmotionByChange(avgChange);
    await sendEmotionSticker(ctx, emotion.key);

    const text =
      formatCoinsBlock("Top Gainers (24h)", gainers) +
      `\n\n⚠️ <b>Discipline</b>\nStrong gainers can become FOMO traps. Wait for pullback or confirmation.`;

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error top gainers");
  }
}

async function sendTopLosers(ctx) {
  try {
    const markets = await getMarkets();
    const losers = [...markets]
      .filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => safe(a.price_change_percentage_24h, 0) - safe(b.price_change_percentage_24h, 0))
      .slice(0, 10);

    const avgChange =
      losers.length
        ? losers.reduce((sum, coin) => sum + safe(coin.price_change_percentage_24h, 0), 0) / losers.length
        : 0;

    const emotion = getEmotionByChange(avgChange);
    await sendEmotionSticker(ctx, emotion.key);

    const text =
      formatCoinsBlock("Top Losers (24h)", losers) +
      `\n\n⚠️ <b>Discipline</b>\nHeavy losers can be falling knives. Wait for stabilization before considering any entry.`;

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error top losers");
  }
}

async function sendTrending(ctx) {
  try {
    const [trending, markets] = await Promise.all([getTrending(), getMarkets()]);
    const marketMap = new Map(markets.map((coin) => [(coin.id || "").toLowerCase(), coin]));

    let totalChange = 0;
    let count = 0;

    const coins = trending?.coins || [];
    coins.forEach((entry) => {
      const item = entry.item || {};
      const marketCoin = marketMap.get((item.id || "").toLowerCase());

      if (marketCoin?.price_change_percentage_24h != null) {
        totalChange += marketCoin.price_change_percentage_24h;
        count++;
      }
    });

    const avgChange = count ? totalChange / count : 0;
    const emotion = getEmotionByChange(avgChange);
    const score = scoreFromChange(avgChange);

    await sendEmotionSticker(ctx, emotion.key);

    const text =
      `🔥 <b>Trending Coins</b>\n\n` +
      `🧠 Mood: <b>${emotion.label}</b>\n` +
      `📊 Trending Score: <b>${score}/100</b>\n` +
      `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n\n` +
      `${formatTrendingLines(trending, marketMap)}\n\n` +
      `⚠️ <b>Discipline</b>\nTrending does not mean safe entry. Avoid chasing without confirmation.\n\n` +
      `🌐 wojakmeter.com`;

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error trending");
  }
}

async function sendMarketOverview(ctx) {
  try {
    const global = await getGlobal();
    const data = global?.data || {};
    const change = data.market_cap_change_percentage_24h_usd ?? 0;

    const emotion = getEmotionByChange(change);
    await sendEmotionSticker(ctx, emotion.key);

    const text = formatMarketOverview(global);

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error market overview");
  }
}

async function sendDiscipline(ctx) {
  const text =
    `🧠 <b>WojakMeter Discipline Check</b>\n\n` +
    `Before entering any trade, answer this:\n\n` +
    `1. Do I have a clear entry?\n` +
    `2. Do I have a stop loss?\n` +
    `3. Is my risk defined?\n` +
    `4. Am I chasing a green candle?\n` +
    `5. Am I trying to recover a loss?\n` +
    `6. Can I accept this loss calmly?\n\n` +
    `⚠️ <b>Rule:</b>\n` +
    `If the trade is emotional, it is not a setup.\n\n` +
    `🧠 <b>WojakMeter Reminder:</b>\n` +
    `The market does not reward urgency. It rewards patience, risk control and clean execution.\n\n` +
    `🌐 wojakmeter.com`;

  return ctx.reply(text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildMainKeyboard().reply_markup
  });
}

async function sendRadar(ctx) {
  try {
    const markets = await getMarkets();

    const valid = markets.filter((c) => c.price_change_percentage_24h != null);

    const gainers = [...valid]
      .sort((a, b) => safe(b.price_change_percentage_24h) - safe(a.price_change_percentage_24h))
      .slice(0, 5);

    const losers = [...valid]
      .sort((a, b) => safe(a.price_change_percentage_24h) - safe(b.price_change_percentage_24h))
      .slice(0, 5);

    const volumeLeaders = [...valid]
      .sort((a, b) => safe(b.total_volume) - safe(a.total_volume))
      .slice(0, 5);

    const formatRadarLine = (coin) => {
      const symbol = (coin.symbol || "").toUpperCase();
      const change = safe(coin.price_change_percentage_24h);
      const score = scoreFromChange(change);
      const emotion = getEmotionByChange(change);
      const links = buildTradeLinksFromSymbol(symbol);

      return (
        `• ${emotion.emoji} <b>${escapeHTML(symbol)}</b> ` +
        `${formatPercent(change)} · Score <b>${score}/100</b>\n` +
        `  Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
        `  <a href="${links.binanceFutures}">Futures</a> · <a href="${links.binanceSpot}">Spot</a> · <a href="${links.tradingView}">Chart</a>`
      );
    };

    const text =
      `🧪 <b>WojakMeter Radar</b>\n\n` +
      `This radar highlights movement, not guaranteed entries.\n\n` +

      `🚀 <b>Strongest 24h Gainers</b>\n` +
      `${gainers.map(formatRadarLine).join("\n\n")}\n\n` +

      `💥 <b>Strongest 24h Losers</b>\n` +
      `${losers.map(formatRadarLine).join("\n\n")}\n\n` +

      `💸 <b>Volume Leaders</b>\n` +
      `${volumeLeaders.map(formatRadarLine).join("\n\n")}\n\n` +

      `🧠 <b>Discipline:</b>\n` +
      `Do not chase. Wait for confirmation. Define risk first.\n\n` +
      `🌐 wojakmeter.com`;

    return ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error radar");
  }
}

// ===============================
// AUTO BROADCAST
// ===============================
function shouldBroadcast(nextState) {
  const now = Date.now();

  if (!lastBroadcastState.emotionKey) return true;

  const emotionChanged = nextState.emotionKey !== lastBroadcastState.emotionKey;
  const scoreShift =
    Math.abs(safe(nextState.score) - safe(lastBroadcastState.score)) >= SCORE_SHIFT_THRESHOLD;

  const panicEntered = nextState.score <= 20 && safe(lastBroadcastState.score) > 20;
  const euphoriaEntered = nextState.score >= 85 && safe(lastBroadcastState.score) < 85;
  const enoughTimePassed = now - lastBroadcastState.ts >= MIN_BROADCAST_GAP_MS;

  return emotionChanged || panicEntered || euphoriaEntered || (scoreShift && enoughTimePassed);
}

async function runChannelBroadcast() {
  try {
    if (!TELEGRAM_CHANNEL_ID) return;

    const global = await getGlobal();
    const markets = await getMarkets();

    const data = global?.data || {};
    const change = safe(data.market_cap_change_percentage_24h_usd);
    const score = scoreFromChange(change);
    const emotion = getEmotionByChange(change);
    const btcDom = safe(data.market_cap_percentage?.btc);
    const volume = safe(data.total_volume?.usd);

    const nextState = {
      emotionKey: emotion.key,
      score,
      change,
      btcDom,
      volume,
      ts: Date.now()
    };

    if (!shouldBroadcast(nextState)) return;

    const events = detectMarketEvents(lastBroadcastState, nextState);
    if (!events.length) return;

    await sendStickerToChannel(emotion.key);

    for (const event of events) {
      let msg = null;

      if (event.type === "emotion_shift") {
        const prevEmotion =
          EMOTION_CONFIG.find((e) => e.key === lastBroadcastState.emotionKey) ||
          { emoji: "⚪", label: "Unknown" };

        msg = buildEmotionShiftAlert({
          prevEmotion,
          nextEmotion: emotion,
          prevScore: safe(lastBroadcastState.score),
          nextScore: score,
          change,
          btcDom,
          volume
        });
      }

      if (event.type === "panic_alert") {
        msg = buildPanicAlert({ emotion, score, change, btcDom, volume });
      }

      if (event.type === "euphoria_alert") {
        msg = buildEuphoriaAlert({ emotion, score, change, btcDom, volume });
      }

      if (event.type === "volume_spike") {
        msg = buildVolumeSpikeAlert({
          emotion,
          score,
          change,
          btcDom,
          volume,
          prevVolume: safe(lastBroadcastState.volume)
        });
      }

      if (event.type === "btc_dominance_shift") {
        msg =
          `₿ <b>BTC Dominance Shift</b>\n\n` +
          `📊 Score: <b>${score}/100</b>\n` +
          `🧪 Quality: <b>${escapeHTML(getSignalQuality(score))}</b>\n` +
          `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
          `↕ Previous: <b>${safe(lastBroadcastState.btcDom).toFixed(2)}%</b>\n` +
          `📉 Market Move: <b>${formatPercent(change)}</b>\n\n` +
          `⚡ Bitcoin dominance is moving fast. Rotation risk is rising.` +
          buildSignalQualityBlock(score, change) +
          `\n\n🌐 wojakmeter.com`;
      }

      if (msg) {
        await sendMessageToChannel(msg);
        await sleep(1200);
      }
    }

    const scoreJump = Math.abs(score - safe(lastBroadcastState.score));
    if (scoreJump >= BREAKING_SCORE_SHIFT_THRESHOLD) {
      await sendMessageToChannel(
        buildBreakingAlert({ emotion, score, change, btcDom, volume })
      );
      await sleep(1200);
    }

    const strongest = getStrongestMover(markets);
    if (strongest) {
      const coinAlertType = getCoinAlertType(strongest.price_change_percentage_24h);

      if (coinAlertType && strongest.id !== lastBroadcastState.spotlightCoinId) {
        await sendMessageToChannel(buildCoinExtremeAlert(strongest));

        await sendPersonalAlert(
          strongest,
          coinAlertType === "coin_euphoria"
            ? "FOMO Watch / Strong Mover"
            : "Capitulation Watch / Heavy Drop"
        );

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
  } catch (err) {
    console.error("Broadcast loop error:", err.message);
  }
}

// ===============================
// COMMANDS
// ===============================
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name ? escapeHTML(ctx.from.first_name) : "trader";

  const text =
    `🤖 <b>Welcome to WojakMeter Bot</b>\n\n` +
    `Hi, <b>${firstName}</b>.\n` +
    `Use the buttons or commands to read the market mood.\n\n` +
    `<b>Main:</b>\n` +
    `🧠 Signal\n` +
    `📊 Market\n` +
    `🔥 Trending\n` +
    `🌟 Spotlight\n` +
    `⚠️ Risk\n` +
    `₿ BTC Mood\n` +
    `🚀 Top Gainers\n` +
    `💥 Top Losers\n` +
    `🧪 Radar\n` +
    `🧠 Discipline\n` +
    `📋 My Plan private\n` +
    `🪙 /coin btc\n` +
    `🧾 /daily\n` +
    `🧪 /scan private Binance scanner`;

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.help(async (ctx) => {
  const text =
    `🛠 <b>WojakMeter Bot Help</b>\n\n` +
    `<b>Main:</b>\n` +
    `🧠 Signal → live emotional market signal\n` +
    `📊 Market → full global market overview\n` +
    `🔥 Trending → trending coins + mood\n` +
    `🌟 Spotlight → strongest coin move\n` +
    `⚠️ Risk → current risk tone\n` +
    `₿ BTC Mood → Bitcoin emotional read\n` +
    `🚀 Top Gainers → strongest coins in 24h\n` +
    `💥 Top Losers → weakest coins in 24h\n` +
    `🧪 Radar → public market radar with trade links\n` +
    `🧠 Discipline → trading discipline checklist\n` +
    `📋 My Plan → private owner plan\n` +
    `🪙 /coin btc → signal by coin\n` +
    `🧾 /daily → premium daily wrap\n\n` +
    `<b>Commands:</b>\n` +
    `/signal\n` +
    `/market\n` +
    `/trending\n` +
    `/spotlight\n` +
    `/risk\n` +
    `/moodbtc\n` +
    `/gainers\n` +
    `/losers\n` +
    `/radar\n` +
    `/discipline\n` +
    `/coin btc\n` +
    `/daily\n\n` +
    `<b>Private Owner Commands:</b>\n` +
    `/myplan\n` +
    `/trade win 1.25\n` +
    `/trade loss 0.75\n` +
    `/cooldown\n` +
    `/resetday\n` +
    `/scan\n\n` +
    `<b>Watchlist:</b>\n` +
    `/watch btc\n/unwatch btc\n/mywatchlist\n\n` +
    `<b>Emotions:</b>\n` +
    `🤩 😌 🙂 😐 🤔 😟 😡`;

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("signal", sendSignal);
bot.command("market", sendMarketOverview);
bot.command("trending", sendTrending);
bot.command("spotlight", sendSpotlight);
bot.command("risk", sendRisk);
bot.command("moodbtc", sendBtcMood);
bot.command("daily", sendDaily);
bot.command("gainers", sendTopGainers);
bot.command("losers", sendTopLosers);
bot.command("radar", sendRadar);
bot.command("discipline", sendDiscipline);

bot.command("scan", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  await ctx.reply("🧪 Running Binance personal scanner now...", {
    reply_markup: buildMainKeyboard().reply_markup
  });

  await scanBinancePersonalSignals();

  return ctx.reply("✅ Scan complete.", {
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("myplan", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  return ctx.reply(buildMyPlanMessage(), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("trade", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  resetPersonalStateIfNewDay();

  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const result = (parts[1] || "").toLowerCase();
  const amount = Number(parts[2] || 0);

  if (!["win", "loss"].includes(result) || !Number.isFinite(amount) || amount <= 0) {
    return ctx.reply(
      `Usage:\n` +
      `/trade win 1.25\n` +
      `/trade loss 0.75`,
      {
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }

  personalTradingState.tradesToday += 1;

  if (result === "win") {
    personalTradingState.pnlToday += amount;
  } else {
    personalTradingState.pnlToday -= amount;
  }

  let status = `✅ Trade logged.\n\n`;

  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
    personalTradingState.coolingDown = true;
    status += `🔒 Daily profit lock reached. Stop trading for today.\n\n`;
  }

  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) {
    personalTradingState.coolingDown = true;
    status += `🛑 Max daily loss reached. Stop trading for today.\n\n`;
  }

  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) {
    personalTradingState.coolingDown = true;
    status += `📌 Max trades reached. Stop trading for today.\n\n`;
  }

  return ctx.reply(status + buildMyPlanMessage(), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("cooldown", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  resetPersonalStateIfNewDay();
  personalTradingState.coolingDown = true;

  return ctx.reply(
    `🧊 Cooling down activated.\n\n` + buildMyPlanMessage(),
    {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

bot.command("resetday", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  personalTradingState = {
    date: new Date().toISOString().slice(0, 10),
    tradesToday: 0,
    pnlToday: 0,
    coolingDown: false
  };

  return ctx.reply(
    `🔄 Day reset.\n\n` + buildMyPlanMessage(),
    {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

bot.command("coin", async (ctx) => {
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const query = parts.slice(1).join(" ");

  if (!query) {
    return ctx.reply("Usage: /coin btc", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  return sendCoinSignal(ctx, query);
});

bot.command("watch", async (ctx) => {
  const userId = ctx.from?.id;
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const query = normalizeCoinKey(parts[1]);

  if (!userId || !query) {
    return ctx.reply("Usage: /watch btc", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  const list = getUserWatchlist(userId);
  list.add(query);

  return ctx.reply(`👁 Added <b>${escapeHTML(query.toUpperCase())}</b> to your watchlist.`, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("unwatch", async (ctx) => {
  const userId = ctx.from?.id;
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const query = normalizeCoinKey(parts[1]);

  if (!userId || !query) {
    return ctx.reply("Usage: /unwatch btc", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  const list = getUserWatchlist(userId);
  list.delete(query);

  return ctx.reply(`🗑 Removed <b>${escapeHTML(query.toUpperCase())}</b> from your watchlist.`, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("mywatchlist", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const list = [...getUserWatchlist(userId)];

  if (!list.length) {
    return ctx.reply("Your watchlist is empty.", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  return ctx.reply(
    `👁 <b>Your Watchlist</b>\n\n${list.map((x, i) => `${i + 1}. ${escapeHTML(x.toUpperCase())}`).join("\n")}`,
    {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>\nUser ID: <code>${ctx.from?.id}</code>`, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("teststicker", async (ctx) => {
  try {
    await ctx.replyWithSticker(STICKERS.neutral, {
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("Test sticker error:", err.message);
    await ctx.reply("⚠️ Could not send test sticker.", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }
});

bot.command("testchannel", async (ctx) => {
  try {
    await bot.telegram.sendMessage(
      process.env.TELEGRAM_CHANNEL_ID,
      "✅ WojakMeter connected to channel"
    );

    await ctx.reply("Sent to channel 🚀", {
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("testchannel error:", err);
    await ctx.reply(`Channel error: ${err.message}`, {
      reply_markup: buildMainKeyboard().reply_markup
    });
  }
});

// ===============================
// OPTIONAL STICKER FILE_ID CAPTURE
// ===============================
bot.on("sticker", async (ctx) => {
  const fileId = ctx.message.sticker.file_id;

  console.log("Sticker file_id:", fileId);

  await ctx.reply(
    `📌 Sticker guardado:\n\n<code>${fileId}</code>`,
    {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

// ===============================
// TEXT / BUTTON HANDLERS
// ===============================
bot.on("text", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId && isUserCoolingDown(userId)) return;

  const text = (ctx.message?.text || "").trim();

  if (text.startsWith("/")) return;

  if (text.includes("Signal")) return sendSignal(ctx);
  if (text.includes("Market")) return sendMarketOverview(ctx);
  if (text.includes("Trending")) return sendTrending(ctx);
  if (text.includes("Spotlight")) return sendSpotlight(ctx);
  if (text.includes("Risk")) return sendRisk(ctx);
  if (text.includes("BTC Mood")) return sendBtcMood(ctx);
  if (text.includes("Top Gainers")) return sendTopGainers(ctx);
  if (text.includes("Top Losers")) return sendTopLosers(ctx);
  if (text.includes("Radar")) return sendRadar(ctx);
  if (text.includes("Discipline")) return sendDiscipline(ctx);

  if (text.includes("My Plan")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

    return ctx.reply(buildMyPlanMessage(), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  if (EMOJI_SET.has(text)) {
    const emotion = matchEmotionByEmoji(text);
    await sendEmotionSticker(ctx, emotion.key);
    return sendEmotionCoins(ctx, text);
  }

  return ctx.reply("Send an emotion or use the buttons.", {
    reply_markup: buildMainKeyboard().reply_markup
  });
});

// ===============================
// SAFETY
// ===============================
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err);
  try {
    ctx.reply("⚠️ Unexpected bot error.");
  } catch (_) {}
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
setInterval(scanBinancePersonalSignals, BINANCE_SCAN_INTERVAL_MS);

// ===============================
// HEALTHCHECK SERVER FOR RAILWAY
// ===============================
app.get("/", (req, res) => {
  res.status(200).send("WojakMeter bot is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "wojakmeter-bot",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// ===============================
// START
// ===============================
(async () => {
  await bot.launch();
  console.log("WojakMeter bot running...");

  await warmUpCache().catch(console.error);
  await runChannelBroadcast().catch(console.error);
  await scanBinancePersonalSignals().catch(console.error);
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));