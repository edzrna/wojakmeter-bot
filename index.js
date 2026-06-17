require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const Binance = require("node-binance-api");
const emotionTrader = require("./emotion-trader");

// ===============================
// WOJAKMETER BOT — INDEX
// Personal Telegram control panel + market signals + safe-confirm AutoTrade
// ===============================

// ===============================
// CONFIG
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in environment");

const PORT = process.env.PORT || 3000;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || null;

const PERSONAL_ALERTS_ENABLED = process.env.PERSONAL_ALERTS_ENABLED === "true";
const PRIVATE_TELEGRAM_USER_ID = process.env.PRIVATE_TELEGRAM_USER_ID || null;

const PERSONAL_PLAN = {
  balance: Number(process.env.PERSONAL_BALANCE || 103),
  riskPerTrade: Number(process.env.PERSONAL_RISK_PER_TRADE || 1.0),
  maxDailyLoss: Number(process.env.PERSONAL_MAX_DAILY_LOSS || 2.5),
  dailyProfitLock: Number(process.env.PERSONAL_DAILY_PROFIT_LOCK || 4.0),
  maxTradesPerDay: Number(process.env.PERSONAL_MAX_TRADES_PER_DAY || 2),
  defaultLeverage: Number(process.env.PERSONAL_DEFAULT_LEVERAGE || 3),
  maxLeverage: Number(process.env.PERSONAL_MAX_LEVERAGE || 5),
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
  15 * 60 * 1000
);

let lastPersonalMarketAlerts = new Map();

// ===============================
// BINANCE AUTOTRADE CONFIG
// ===============================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || "";
const USE_TESTNET = process.env.BINANCE_TESTNET !== "false";

const AUTO_TRADE_ENABLED_ENV = process.env.AUTO_TRADE_ENABLED === "true";
const AUTO_TRADE_CONFIRM = process.env.AUTO_TRADE_CONFIRM !== "false";

const SL_PCT = Number(process.env.AUTO_TRADE_SL_PCT || 1.5);
const TP_PCT = Number(process.env.AUTO_TRADE_TP_PCT || 3.0);
const AT_LEVERAGE = Number(process.env.AUTO_TRADE_LEVERAGE || 3);
const SCORE_LONG_MIN = Number(process.env.AUTO_TRADE_SCORE_LONG || 80);
const SCORE_SHORT_MAX = Number(process.env.AUTO_TRADE_SCORE_SHORT || 20);

let autoTradeActive = AUTO_TRADE_ENABLED_ENV;
let pendingConfirm = null;
let openPosition = null;
let pendingDangerAction = null;
let lastTradeSignalTs = 0;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;


// ===============================
// APP / BOT
// ===============================
const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// ===============================
// TELEGRAM UPDATE DEBUG
// Confirms if Telegram commands are reaching the bot
// ===============================
bot.use(async (ctx, next) => {
  console.log(
    `[Telegram Update] type=${ctx.updateType} from=${ctx.from?.id || "unknown"} text=${ctx.message?.text || ""}`
  );

  return next();
});

// ===============================
// EMERGENCY COMMAND TEST
// Put this immediately after TELEGRAM UPDATE DEBUG
// ===============================
bot.command("ping", async (ctx) => {
  console.log("[PING] command received");

  return ctx.reply("🏓 Pong. Bot commands are working.");
});

bot.start(async (ctx) => {
  console.log("[START] command received");

  const firstName = ctx.from?.first_name || "trader";

  return ctx.reply(
    `🤖 <b>Welcome to WojakMeter Bot</b>\n\n` +
      `Hi, <b>${escapeHTML(firstName)}</b>.\n\n` +
      `✅ Telegram updates are working.\n` +
      `✅ Bot command handlers are working.\n\n` +
      `Try:\n` +
      `/futures\n` +
      `/account\n` +
      `/positions\n` +
      `/riskstatus\n` +
      `/scandebug\n\n` +
      `🌐 wojakmeter.com`,
    {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

// ===============================
// EMERGENCY FUTURES / DEBUG COMMANDS
// Put this immediately after emergency /ping and /start
// ===============================
function emergencyTimeout(promise, ms, label = "Request timeout") {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

bot.command("futures", async (ctx) => {
  console.log("[FUTURES] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  await ctx.reply("⏳ Loading Futures panel...");

  try {
    const [account, positions] = await Promise.all([
      emergencyTimeout(atGetFuturesAccount(), 10000, "Binance account timeout after 10 seconds"),
      emergencyTimeout(atGetOpenPositions(), 10000, "Binance positions timeout after 10 seconds")
    ]);

    return ctx.reply(
      buildFuturesAccountMessage(account) +
        `\n\n━━━━━━━━━━━━━━\n\n` +
        buildPositionsMessage(positions) +
        `\n\n━━━━━━━━━━━━━━\n\n` +
        `📋 Orders are separate:\n` +
        `/orders_all\n\n` +
        `Commands:\n` +
        `/account\n` +
        `/positions\n` +
        `/riskstatus\n` +
        `/scandebug`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (err) {
    console.error("[FUTURES] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Futures error</b>\n\n` +
        `${escapeHTML(err.message)}\n\n` +
        `Possible causes:\n` +
        `• Binance API blocked from Railway location\n` +
        `• Futures API permission not enabled\n` +
        `• Wrong API key/secret\n` +
        `• Mainnet/Testnet mismatch`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

bot.command("account", async (ctx) => {
  console.log("[ACCOUNT] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  await ctx.reply("⏳ Checking Binance Futures account...");

  try {
    const account = await emergencyTimeout(
      atGetFuturesAccount(),
      10000,
      "Binance account timeout after 10 seconds"
    );

    return ctx.reply(buildFuturesAccountMessage(account), {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("[ACCOUNT] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Account error</b>\n\n${escapeHTML(err.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

bot.command("positions", async (ctx) => {
  console.log("[POSITIONS] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  await ctx.reply("⏳ Checking open futures positions...");

  try {
    const positions = await emergencyTimeout(
      atGetOpenPositions(),
      10000,
      "Binance positions timeout after 10 seconds"
    );

    return ctx.reply(buildPositionsMessage(positions), {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("[POSITIONS] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Positions error</b>\n\n${escapeHTML(err.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

bot.command("orders_all", async (ctx) => {
  console.log("[ORDERS_ALL] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  await ctx.reply("⏳ Checking open orders...");

  try {
    const orders = await emergencyTimeout(
      atGetAllOpenOrdersForTrackedSymbols(),
      15000,
      "Binance open orders timeout after 15 seconds"
    );

    return ctx.reply(buildAllOrdersMessage(orders), {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("[ORDERS_ALL] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Orders error</b>\n\n${escapeHTML(err.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

bot.command("riskstatus", async (ctx) => {
  console.log("[RISKSTATUS] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  try {
    return ctx.reply(buildRiskStatusMessage(), {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (err) {
    console.error("[RISKSTATUS] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Risk status error</b>\n\n${escapeHTML(err.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

bot.command("scandebug", async (ctx) => {
  console.log("[SCANDEBUG] command received");

  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  resetPersonalStateIfNewDay();

  await ctx.reply("🧪 Running scanner debug...");

  try {
    let checked = 0;
    let found = [];
    let blockedReasons = [];

    if (!MARKET_SCANNER_ENABLED) blockedReasons.push("MARKET_SCANNER_ENABLED is false");
    if (!PERSONAL_ALERTS_ENABLED) blockedReasons.push("PERSONAL_ALERTS_ENABLED is false");
    if (!PRIVATE_TELEGRAM_USER_ID) blockedReasons.push("PRIVATE_TELEGRAM_USER_ID is missing");
    if (personalTradingState.coolingDown) blockedReasons.push("Cooling down is active");
    if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) blockedReasons.push("Max trades reached");

    if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) {
      blockedReasons.push("Max daily loss reached");
    }

    if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
      blockedReasons.push("Daily profit lock reached");
    }

    const markets = await emergencyTimeout(
      getMarkets(true),
      15000,
      "CoinGecko market request timeout after 15 seconds"
    );

    const allowedBases = MARKET_SCAN_SYMBOLS.map((s) =>
      String(s).replace("USDT", "").toUpperCase()
    );

    const filtered = markets.filter((coin) =>
      allowedBases.includes((coin.symbol || "").toUpperCase())
    );

    checked = filtered.length;

    found = filtered
      .map(detectMarketSetup)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const topSignals = found
      .slice(0, 8)
      .map(
        (s, i) =>
          `${i + 1}. <b>${escapeHTML(s.symbol)}</b>\n` +
          `Type: <b>${escapeHTML(s.type)}</b>\n` +
          `Score: <b>${s.score}/100</b>\n` +
          `24h: <b>${formatPercent(s.move1)}</b>`
      )
      .join("\n\n");

    return ctx.reply(
      `✅ <b>Scan Debug Complete</b>\n\n` +
        `Coins checked: <b>${checked}</b>\n` +
        `Signals found: <b>${found.length}</b>\n\n` +
        `🚧 <b>Blocks</b>\n` +
        `${
          blockedReasons.length
            ? blockedReasons.map((r) => `• ${escapeHTML(r)}`).join("\n")
            : "• None"
        }\n\n` +
        (found.length
          ? `🔥 <b>Top Signals</b>\n${topSignals}`
          : `🧠 No signals found.`),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (err) {
    console.error("[SCANDEBUG] error:", err.message);

    return ctx.reply(
      `⚠️ <b>Scan debug error</b>\n\n${escapeHTML(err.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }
});

const binanceClient = new Binance().options({
  APIKEY: BINANCE_API_KEY,
  APISECRET: BINANCE_API_SECRET,
  useServerTime: true,
  recvWindow: 10000,
  urls: {
    base: USE_TESTNET
      ? "https://testnet.binancefuture.com/fapi/"
      : "https://fapi.binance.com/fapi/"
  }
});

// ===============================
// COINGECKO API + CACHE
// ===============================
const API_BASE = "https://api.coingecko.com/api/v3";
const VS_CURRENCY = "usd";

const cache = {
  markets: { data: null, ts: 0 },
  trending: { data: null, ts: 0 },
  global: { data: null, ts: 0 }
};

const MARKET_CACHE_TTL = 60 * 1000;
const TRENDING_CACHE_TTL = 2 * 60 * 1000;
const GLOBAL_CACHE_TTL = 2 * 60 * 1000;

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
  { emoji: "😡", key: "frustration", label: "Frustration", min: -9999, max: -8 }
];

const EMOJI_SET = new Set(EMOTION_CONFIG.map((e) => e.emoji));

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

const NARRATIVE_VARIANTS = {
  euphoria: [
    "Momentum is overheated. Traders are leaning aggressively risk-on.",
    "Market confidence is surging fast. Risk appetite is elevated."
  ],
  content: [
    "The market is constructive. Confidence is present without extreme euphoria.",
    "Conditions look stable and bullish without feeling stretched."
  ],
  optimism: [
    "Sentiment is improving. Buyers are gaining confidence.",
    "Momentum is recovering and optimism is building."
  ],
  neutral: [
    "The market is balanced. No strong emotional edge yet.",
    "Price action is undecided. Emotion is still centered."
  ],
  doubt: [
    "Confidence is weakening. Traders are becoming hesitant.",
    "The market is losing conviction and second-guessing itself."
  ],
  concern: [
    "Pressure is building. Sentiment is turning defensive.",
    "The market is getting uncomfortable and more reactive."
  ],
  frustration: [
    "The market is under stress. Emotion is clearly risk-off.",
    "Panic is rising and traders are losing patience."
  ]
};

// ===============================
// STATE
// ===============================
const userCooldowns = new Map();
const USER_COOLDOWN_MS = 800;
const userWatchlists = new Map();

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
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }

  const num = Number(value);
  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);

  if (abs >= 1_000_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000_000).toFixed(2)}T`;
  }

  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  }

  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }

  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  }

  if (abs >= 1) {
    return `${sign}$${abs.toFixed(2)}`;
  }

  return `${sign}$${abs.toFixed(6)}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }

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
    binanceFutures: `https://app.binance.com/en/futures/${futuresPair}`,
    binanceSpot: `https://app.binance.com/en/trade/${spotPair}`,
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

function getEmotionNarrative(emotionKey) {
  return (
    pickRandom(NARRATIVE_VARIANTS[emotionKey]) ||
    "The emotional state of the market is shifting."
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

function getAlertLevel(score) {
  if (score >= 85) {
    return {
      key: "extreme_bull",
      label: "Extreme Bullish",
      icon: "🟢"
    };
  }

  if (score >= 70) {
    return {
      key: "bullish",
      label: "Bullish",
      icon: "🟩"
    };
  }

  if (score >= 45) {
    return {
      key: "balanced",
      label: "Balanced",
      icon: "⚪"
    };
  }

  if (score >= 20) {
    return {
      key: "risk_off",
      label: "Risk-Off",
      icon: "🟧"
    };
  }

  return {
    key: "panic",
    label: "Panic",
    icon: "🔴"
  };
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

function isUserCoolingDown(userId) {
  const now = Date.now();
  const last = userCooldowns.get(userId) || 0;

  if (now - last < USER_COOLDOWN_MS) return true;

  userCooldowns.set(userId, now);

  return false;
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

  if (
    personalTradingState.pnlToday <=
    -Math.abs(PERSONAL_PLAN.maxDailyLoss)
  ) {
    return false;
  }

  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
    return false;
  }

  return true;
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
// TELEGRAM KEYBOARD
// ===============================
function buildMainKeyboard() {
  return Markup.keyboard([
    ["🧠 Signal", "📊 Market"],
    ["🔥 Trending", "🌟 Spotlight"],
    ["⚠️ Risk", "₿ BTC Mood"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["🧪 Radar", "🔍 Analyze"],
    ["💵 Futures", "📈 Positions"],
    ["📋 Orders", "🧠 Risk Status"],
    ["🧠 Discipline", "📋 My Plan"],
    ["🤖 AutoTrade ON", "🛑 AutoTrade OFF"],
    ["🧬 Emo Status", "📜 Emo History"],
    ["/coin btc", "/daily"],
    ["/mywatchlist", "/scan"],
    ["/scandebug", "/testsignal"],
    ["🤩", "😌", "🙂", "😐"],
    ["🤔", "😟", "😡"],
    ["/start", "/help", "/id"]
  ]).resize();
}

// ===============================
// FETCH + COINGECKO
// ===============================
async function fetchJSON(url, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        Accept: "application/json",
        "User-Agent": "WojakMeterBot/1.0"
      };

      if (process.env.COINGECKO_API_KEY) {
        headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
      }

      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });

      clearTimeout(t);

      if (res.status === 429) {
        if (attempt < maxRetries) {
          await sleep(1500 * attempt);
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

async function getMarkets(force = false) {
  const now = Date.now();

  if (!force && cache.markets.data && now - cache.markets.ts < MARKET_CACHE_TTL) {
    return cache.markets.data;
  }

  const url =
    `${API_BASE}/coins/markets?vs_currency=${VS_CURRENCY}` +
    `&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d`;

  const data = await fetchJSON(url, {
    maxRetries: 3,
    timeoutMs: 15000
  });

  cache.markets = {
    data: Array.isArray(data) ? data : [],
    ts: now
  };

  return cache.markets.data;
}

async function getTrending(force = false) {
  const now = Date.now();

  if (!force && cache.trending.data && now - cache.trending.ts < TRENDING_CACHE_TTL) {
    return cache.trending.data;
  }

  const data = await fetchJSON(`${API_BASE}/search/trending`, {
    maxRetries: 3,
    timeoutMs: 15000
  });

  cache.trending = {
    data,
    ts: now
  };

  return data;
}

async function getGlobal(force = false) {
  const now = Date.now();

  if (!force && cache.global.data && now - cache.global.ts < GLOBAL_CACHE_TTL) {
    return cache.global.data;
  }

  const data = await fetchJSON(`${API_BASE}/global`, {
    maxRetries: 3,
    timeoutMs: 15000
  });

  cache.global = {
    data,
    ts: now
  };

  return data;
}

// ===============================
// BINANCE FUTURES HELPERS
// ===============================
async function sendPrivate(text) {
  if (!PRIVATE_TELEGRAM_USER_ID) return;

  try {
    await bot.telegram.sendMessage(PRIVATE_TELEGRAM_USER_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("[Private] send error:", err.message);
  }
}

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

async function atSetLeverage(symbol, leverage = AT_LEVERAGE) {
  return promisifyBinance((cb) =>
    binanceClient.futuresLeverage(symbol, leverage, cb)
  );
}

async function atGetMarkPrice(symbol) {
  const res = await promisifyBinance((cb) =>
    binanceClient.futuresMarkPrice(symbol, cb)
  );

  return parseFloat(res?.markPrice || res?.price || 0);
}

async function atGetFuturesBalance() {
  const balances = await promisifyBinance((cb) =>
    binanceClient.futuresBalance(cb)
  );

  const usdt = (balances || []).find((b) => b.asset === "USDT");

  return parseFloat(usdt?.availableBalance || 0);
}

async function atGetFuturesAccount() {
  return promisifyBinance((cb) => binanceClient.futuresAccount(cb));
}

async function atGetExchangeInfo(symbol) {
  const info = await promisifyBinance((cb) =>
    binanceClient.futuresExchangeInfo(cb)
  );

  return (info?.symbols || []).find((s) => s.symbol === symbol) || null;
}

function atGetFilter(symbolInfo, filterType) {
  return (symbolInfo?.filters || []).find(
    (f) => f.filterType === filterType
  );
}

function atGetLotStepSize(symbolInfo) {
  const lotFilter = atGetFilter(symbolInfo, "LOT_SIZE");

  return parseFloat(lotFilter?.stepSize || "0.001");
}

function atGetMinQty(symbolInfo) {
  const lotFilter = atGetFilter(symbolInfo, "LOT_SIZE");

  return parseFloat(lotFilter?.minQty || "0");
}

function atGetMinNotional(symbolInfo) {
  const f =
    atGetFilter(symbolInfo, "MIN_NOTIONAL") ||
    atGetFilter(symbolInfo, "NOTIONAL");

  return parseFloat(f?.notional || f?.minNotional || "5");
}

function atGetTickSize(symbolInfo) {
  const f = atGetFilter(symbolInfo, "PRICE_FILTER");

  return parseFloat(f?.tickSize || "0.01");
}

function atRoundQty(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return qty;

  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));

  return parseFloat(
    (Math.floor(qty / stepSize) * stepSize).toFixed(precision)
  );
}

function atRoundPrice(price, tickSize) {
  if (!tickSize || tickSize <= 0) return price;

  const precision = Math.max(0, Math.round(-Math.log10(tickSize)));

  return parseFloat(
    (Math.round(price / tickSize) * tickSize).toFixed(precision)
  );
}

async function atPlaceMarketOrder(symbol, side, qty) {
  return promisifyBinance((cb) =>
    binanceClient.futuresOrder(
      side,
      symbol,
      qty,
      false,
      { type: "MARKET" },
      cb
    )
  );
}

async function atPlaceSlTpOrders(symbol, side, qty, entryPrice) {
  const oppositeSide = side === "BUY" ? "SELL" : "BUY";
  const symbolInfo = await atGetExchangeInfo(symbol);
  const tickSize = atGetTickSize(symbolInfo);

  let slPrice =
    side === "BUY"
      ? entryPrice * (1 - SL_PCT / 100)
      : entryPrice * (1 + SL_PCT / 100);

  let tpPrice =
    side === "BUY"
      ? entryPrice * (1 + TP_PCT / 100)
      : entryPrice * (1 - TP_PCT / 100);

  slPrice = atRoundPrice(slPrice, tickSize);
  tpPrice = atRoundPrice(tpPrice, tickSize);

  const slOrder = await promisifyBinance((cb) =>
    binanceClient.futuresOrder(
      oppositeSide,
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
    binanceClient.futuresOrder(
      oppositeSide,
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
      binanceClient.futuresCancel(symbol, { orderId }, cb)
    );
  } catch (err) {
    console.error("[Binance] cancel order error:", err.message);
    return null;
  }
}

async function atCancelAllOrders(symbol) {
  return promisifyBinance((cb) =>
    binanceClient.futuresCancelAll(symbol, cb)
  );
}

async function atGetOpenPositions() {
  const positions = await promisifyBinance((cb) =>
    binanceClient.futuresPositionRisk(cb)
  );

  return (positions || []).filter((p) => parseFloat(p.positionAmt) !== 0);
}

async function atGetOpenOrders(symbol) {
  return promisifyBinance((cb) =>
    binanceClient.futuresOpenOrders(symbol, cb)
  );
}

async function atGetAllOpenOrdersForTrackedSymbols() {
  const symbols = Array.from(
    new Set([
      ...MARKET_SCAN_SYMBOLS,
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "DOGEUSDT",
      "ADAUSDT",
      "AVAXUSDT",
      "LINKUSDT",
      "NEARUSDT",
      "PEPEUSDT",
      "WIFUSDT"
    ])
  );

  const all = [];

  for (const symbol of symbols) {
    try {
      const orders = await atGetOpenOrders(symbol);

      for (const order of orders) {
        all.push(order);
      }

      await sleep(150);
    } catch (_) {}
  }

  return all;
}

function calculateQtyByRisk({ markPrice, symbolInfo, riskUsd, slPct }) {
  const stopDistanceUsd = markPrice * (slPct / 100);
  const rawQty = riskUsd / stopDistanceUsd;
  const stepSize = atGetLotStepSize(symbolInfo);
  const minQty = atGetMinQty(symbolInfo);
  const minNotional = atGetMinNotional(symbolInfo);
  const qty = atRoundQty(rawQty, stepSize);
  const notional = qty * markPrice;

  if (qty <= 0) {
    throw new Error("Calculated qty is 0 — check riskPerTrade");
  }

  if (minQty && qty < minQty) {
    throw new Error(`Qty too small. Qty=${qty}, minQty=${minQty}`);
  }

  if (minNotional && notional < minNotional) {
    throw new Error(
      `Notional too small: ${formatUsd(notional)}. Minimum approx: ${formatUsd(
        minNotional
      )}`
    );
  }

  return {
    qty,
    notional,
    stepSize,
    minQty,
    minNotional
  };
}

// ===============================
// FUTURES CONTROL PANEL BUILDERS
// ===============================
function buildFuturesAccountMessage(account) {
  const totalWalletBalance = safe(account.totalWalletBalance);
  const totalUnrealizedProfit = safe(account.totalUnrealizedProfit);
  const totalMarginBalance = safe(account.totalMarginBalance);
  const availableBalance = safe(account.availableBalance);
  const totalInitialMargin = safe(account.totalInitialMargin);
  const totalMaintMargin = safe(account.totalMaintMargin);

  return (
    `📊 <b>Binance Futures Account</b>\n\n` +
    `💼 Wallet Balance: <b>${formatUsd(totalWalletBalance)}</b>\n` +
    `✅ Available Balance: <b>${formatUsd(availableBalance)}</b>\n` +
    `📈 Unrealized PnL: <b>${
      totalUnrealizedProfit >= 0 ? "+" : ""
    }${formatUsd(totalUnrealizedProfit)}</b>\n` +
    `💰 Margin Balance: <b>${formatUsd(totalMarginBalance)}</b>\n\n` +
    `🧱 <b>Margin</b>\n` +
    `Initial Margin: <b>${formatUsd(totalInitialMargin)}</b>\n` +
    `Maintenance Margin: <b>${formatUsd(totalMaintMargin)}</b>\n\n` +
    `🧠 <b>Your Risk Plan</b>\n` +
    `Risk/trade: <b>${formatUsd(PERSONAL_PLAN.riskPerTrade)}</b>\n` +
    `Max daily loss: <b>-${formatUsd(PERSONAL_PLAN.maxDailyLoss)}</b>\n` +
    `Profit lock: <b>+${formatUsd(PERSONAL_PLAN.dailyProfitLock)}</b>\n` +
    `Trades today: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `Cooling down: <b>${personalTradingState.coolingDown ? "Yes" : "No"}</b>\n\n` +
    `🤖 AutoTrade: <b>${autoTradeActive ? "ON ✅" : "OFF 🛑"}</b>\n` +
    `Manual confirmation: <b>${
      AUTO_TRADE_CONFIRM ? "Required ✅" : "Disabled ⚠️"
    }</b>\n` +
    `Testnet: <b>${USE_TESTNET ? "Yes" : "❗ REAL MONEY"}</b>`
  );
}

function buildPositionsMessage(positions) {
  if (!positions.length) {
    return (
      `📈 <b>Open Positions</b>\n\n` +
      `No open futures positions.\n\n` +
      `🌐 wojakmeter.com`
    );
  }

  const lines = positions.map((p, i) => {
    const amt = parseFloat(p.positionAmt);
    const side = amt > 0 ? "LONG" : "SHORT";
    const pnl = safe(p.unRealizedProfit);
    const entry = safe(p.entryPrice);
    const mark = safe(p.markPrice);
    const leverage = p.leverage || "—";

    return (
      `${i + 1}. ${amt > 0 ? "📈" : "📉"} <b>${escapeHTML(
        p.symbol
      )}</b> — <b>${side}</b>\n` +
      `Qty: <b>${Math.abs(amt)}</b>\n` +
      `Entry: <b>${formatUsd(entry)}</b>\n` +
      `Mark: <b>${formatUsd(mark)}</b>\n` +
      `PnL: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n` +
      `Leverage: <b>${leverage}x</b>\n` +
      `Close: <code>/closepos ${p.symbol}</code>`
    );
  });

  return (
    `📈 <b>Open Positions</b>\n\n` +
    lines.join("\n\n") +
    `\n\n⚠️ Closing a position requires confirmation.`
  );
}

function buildAllOrdersMessage(orders) {
  if (!orders.length) {
    return (
      `📋 <b>Open Orders</b>\n\n` +
      `No open futures orders.\n\n` +
      `🌐 wojakmeter.com`
    );
  }

  const lines = orders.slice(0, 20).map((o, i) => {
    return (
      `${i + 1}. <b>${escapeHTML(o.symbol)}</b>\n` +
      `Type: <b>${escapeHTML(o.type)}</b>\n` +
      `Side: <b>${escapeHTML(o.side)}</b>\n` +
      `Qty: <b>${o.origQty}</b>\n` +
      `Price: <b>${formatUsd(o.price || 0)}</b>\n` +
      `Stop: <b>${formatUsd(o.stopPrice || 0)}</b>\n` +
      `ID: <code>${o.orderId}</code>`
    );
  });

  return (
    `📋 <b>Open Futures Orders</b>\n\n` +
    lines.join("\n\n") +
    `\n\n⚠️ To cancel all orders for a pair:\n` +
    `<code>/cancelall BTCUSDT</code>`
  );
}

function buildRiskStatusMessage() {
  resetPersonalStateIfNewDay();

  let status = "Healthy ✅";

  if (personalTradingState.coolingDown) {
    status = "Cooling down 🧊";
  } else if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) {
    status = "Max trades reached 📌";
  } else if (
    personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)
  ) {
    status = "Max daily loss reached 🛑";
  } else if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
    status = "Profit lock reached 🔒";
  }

  return (
    `🧠 <b>Risk Status</b>\n\n` +
    `Status: <b>${status}</b>\n\n` +
    `💼 Balance: <b>${formatUsd(PERSONAL_PLAN.balance)}</b>\n` +
    `🎯 Risk per trade: <b>${formatUsd(PERSONAL_PLAN.riskPerTrade)}</b>\n` +
    `🛑 Max daily loss: <b>-${formatUsd(PERSONAL_PLAN.maxDailyLoss)}</b>\n` +
    `🔒 Daily profit lock: <b>+${formatUsd(PERSONAL_PLAN.dailyProfitLock)}</b>\n` +
    `📌 Trades today: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `📊 PnL today: <b>${
      personalTradingState.pnlToday >= 0 ? "+" : ""
    }${formatUsd(personalTradingState.pnlToday)}</b>\n` +
    `🧊 Cooling down: <b>${personalTradingState.coolingDown ? "Yes" : "No"}</b>\n\n` +
    `⚙️ Default leverage: <b>${PERSONAL_PLAN.defaultLeverage}x</b>\n` +
    `🚫 Max leverage: <b>${PERSONAL_PLAN.maxLeverage}x</b>\n\n` +
    `Rule: <b>No confirmation, no execution.</b>`
  );
}

// ===============================
// AUTOTRADE CORE
// ===============================
function canOpenTrade() {
  resetPersonalStateIfNewDay();

  if (!autoTradeActive) return false;
  if (openPosition) return false;
  if (pendingConfirm) return false;
  if (personalTradingState.coolingDown) return false;
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) return false;
  if (personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)) return false;
  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) return false;
  if (Date.now() - lastTradeSignalTs < SIGNAL_COOLDOWN_MS) return false;

  return true;
}

async function atExecuteTrade(side, symbol, score) {
  try {
    const safeLeverage = Math.max(
      1,
      Math.min(PERSONAL_PLAN.maxLeverage, AT_LEVERAGE)
    );

    await atSetLeverage(symbol, safeLeverage);

    const [markPrice, symbolInfo] = await Promise.all([
      atGetMarkPrice(symbol),
      atGetExchangeInfo(symbol)
    ]);

    if (!markPrice || markPrice <= 0) {
      throw new Error("Could not get mark price");
    }

    if (!symbolInfo) {
      throw new Error(`No exchange info for ${symbol}`);
    }

    const riskUsd = PERSONAL_PLAN.riskPerTrade;

    const { qty, notional } = calculateQtyByRisk({
      markPrice,
      symbolInfo,
      riskUsd,
      slPct: SL_PCT
    });

    const slEst =
      side === "BUY"
        ? markPrice * (1 - SL_PCT / 100)
        : markPrice * (1 + SL_PCT / 100);

    const tpEst =
      side === "BUY"
        ? markPrice * (1 + TP_PCT / 100)
        : markPrice * (1 - TP_PCT / 100);

    const potentialWin = (riskUsd * (TP_PCT / SL_PCT)).toFixed(2);
    const potentialLoss = riskUsd.toFixed(2);

    pendingConfirm = {
      side,
      symbol,
      qty,
      price: markPrice,
      score,
      leverage: safeLeverage,
      riskUsd,
      ts: Date.now()
    };

    await sendPrivate(
      `🚨 <b>AUTO-TRADE SIGNAL</b>\n\n` +
      `Pair: <b>${escapeHTML(symbol)}</b>\n` +
      `Direction: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `WojakMeter Score: <b>${score}/100</b>\n` +
      `Mark Price: <b>${formatUsd(markPrice)}</b>\n` +
      `Qty: <b>${qty}</b>\n` +
      `Leverage: <b>${safeLeverage}x</b>\n` +
      `Notional: <b>${formatUsd(notional)}</b>\n\n` +
      `🧠 <b>Risk Model</b>\n` +
      `Max Risk: <b>-$${potentialLoss}</b>\n` +
      `Stop Loss: <b>${formatUsd(slEst)}</b> (-${SL_PCT}%)\n` +
      `Take Profit: <b>${formatUsd(tpEst)}</b> (+${TP_PCT}%)\n` +
      `R/R Ratio: <b>1:${(TP_PCT / SL_PCT).toFixed(1)}</b>\n` +
      `Potential Win: <b>+$${potentialWin}</b>\n\n` +
      `⚠️ <b>Manual confirmation required.</b>\n` +
      `✅ /confirmar — execute now\n` +
      `❌ /cancelar — discard\n\n` +
      `⏱ Expires in 3 minutes.`
    );

    setTimeout(() => {
      if (pendingConfirm && Date.now() - pendingConfirm.ts >= 3 * 60 * 1000) {
        pendingConfirm = null;

        sendPrivate(
          "⏱ <b>Auto-trade expired</b>\nOrder was not executed."
        );
      }
    }, 3 * 60 * 1000);
  } catch (err) {
    console.error("[AutoTrader] executeTrade error:", err.message);

    await sendPrivate(
      `⚠️ <b>AutoTrade error</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

async function atExecuteConfirmed(symbol, side, qty, price, score, pendingData = null) {
  try {
    const leverage = pendingData?.leverage || AT_LEVERAGE;
    const riskUsd = pendingData?.riskUsd || PERSONAL_PLAN.riskPerTrade;

    await sendPrivate(
      `⏳ <b>Executing ${side} order...</b>\n` +
      `Pair: <b>${escapeHTML(symbol)}</b>\n` +
      `Qty: <b>${qty}</b>\n` +
      `Leverage: <b>${leverage}x</b>`
    );

    const order = await atPlaceMarketOrder(symbol, side, qty);
    const fillPrice = parseFloat(order.avgPrice || order.price || price);

    await sleep(500);

    const { slPrice, tpPrice, slOrderId, tpOrderId } =
      await atPlaceSlTpOrders(symbol, side, qty, fillPrice);

    openPosition = {
      side,
      symbol,
      entryPrice: fillPrice,
      qty,
      slOrderId,
      tpOrderId,
      score,
      leverage,
      riskUsd,
      ts: Date.now()
    };

    lastTradeSignalTs = Date.now();
    personalTradingState.tradesToday += 1;

    const potentialWin = (riskUsd * (TP_PCT / SL_PCT)).toFixed(2);

    await sendPrivate(
      `✅ <b>ORDER EXECUTED</b>\n\n` +
      `Pair: <b>${escapeHTML(symbol)}</b>\n` +
      `Direction: <b>${side === "BUY" ? "📈 LONG" : "📉 SHORT"}</b>\n` +
      `Entry Price: <b>${formatUsd(fillPrice)}</b>\n` +
      `Qty: <b>${qty}</b>\n` +
      `Leverage: <b>${leverage}x</b>\n\n` +
      `🛑 Stop Loss: <b>${formatUsd(slPrice)}</b> (-${SL_PCT}%)\n` +
      `✅ Take Profit: <b>${formatUsd(tpPrice)}</b> (+${TP_PCT}%)\n` +
      `📊 R/R: <b>1:${(TP_PCT / SL_PCT).toFixed(1)}</b>\n` +
      `Max Risk: <b>-$${Number(riskUsd).toFixed(2)}</b>\n` +
      `Target: <b>+$${potentialWin}</b>\n\n` +
      `Use /position to track.\n` +
      `Use /close to exit manually.\n\n` +
      `🌐 wojakmeter.com`
    );
  } catch (err) {
    console.error("[AutoTrader] executeConfirmed error:", err.message);

    await sendPrivate(
      `⚠️ <b>Execution error</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

async function atCloseTrackedPosition(reason = "Manual") {
  if (!openPosition) {
    await sendPrivate("⚠️ No tracked AutoTrade position to close.");
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
    } = openPosition;

    const closeSide = side === "BUY" ? "SELL" : "BUY";

    if (slOrderId) {
      await atCancelOrder(symbol, slOrderId).catch(() => {});
    }

    if (tpOrderId) {
      await atCancelOrder(symbol, tpOrderId).catch(() => {});
    }

    await sleep(300);

    const closeOrder = await atPlaceMarketOrder(symbol, closeSide, qty);
    const exitPrice = parseFloat(closeOrder.avgPrice || closeOrder.price || entryPrice);

    const pnlRaw =
      side === "BUY"
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

    const pnl = parseFloat(pnlRaw.toFixed(2));

    personalTradingState.pnlToday += pnl;
    PERSONAL_PLAN.balance += pnl;

    if (
      personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock ||
      personalTradingState.pnlToday <= -Math.abs(PERSONAL_PLAN.maxDailyLoss)
    ) {
      personalTradingState.coolingDown = true;
    }

    openPosition = null;

    await sendPrivate(
      `${pnl >= 0 ? "💚" : "💔"} <b>POSITION CLOSED</b>\n\n` +
      `Reason: <b>${escapeHTML(reason)}</b>\n` +
      `Pair: <b>${escapeHTML(symbol)}</b>\n` +
      `Side: <b>${side === "BUY" ? "LONG" : "SHORT"}</b>\n` +
      `Entry: <b>${formatUsd(entryPrice)}</b>\n` +
      `Exit: <b>${formatUsd(exitPrice)}</b>\n` +
      `PnL: <b>${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}</b>\n\n` +
      `Daily PnL: <b>${
        personalTradingState.pnlToday >= 0 ? "+" : ""
      }${formatUsd(personalTradingState.pnlToday)}</b>\n` +
      `Balance: <b>${formatUsd(PERSONAL_PLAN.balance)}</b>`
    );
  } catch (err) {
    await sendPrivate(
      `⚠️ <b>Error closing tracked position</b>\n\n${escapeHTML(err.message)}`
    );
  }
}

async function evaluateAndTrade(nextState) {
  try {
    if (!autoTradeActive || !canOpenTrade()) return;

    const { score, emotionKey } = nextState;

    let side = null;
    const symbol = "BTCUSDT";

    if (score >= SCORE_LONG_MIN) {
      side = "BUY";
    } else if (score <= SCORE_SHORT_MAX) {
      side = "SELL";
    }

    if (!side) return;

    console.log(
      `[AutoTrader] Signal: ${side} | Score: ${score} | Emotion: ${emotionKey}`
    );

    await atExecuteTrade(side, symbol, score);
  } catch (err) {
    console.error("[AutoTrader] evaluateAndTrade error:", err.message);
  }
}

// ===============================
// MARKET MESSAGES
// ===============================
function formatCoinLine(coin, index) {
  const symbol = (coin.symbol || "").toUpperCase();
  const change = safe(coin.price_change_percentage_24h, 0);
  const emotion = getEmotionByChange(change);
  const links = buildTradeLinksFromSymbol(symbol);

  return (
    `${index}. ${emotion.emoji} <b>${escapeHTML(coin.name || "Unknown")}</b> (${escapeHTML(symbol)})\n` +
    `   ${trendArrow(change)} ${formatPercent(change)} · ${formatUsd(coin.current_price)}\n` +
    `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`
  );
}

function formatCoinsBlock(title, coins) {
  if (!coins || !coins.length) {
    return `⚠️ <b>${escapeHTML(title)}</b>\nNo data found.`;
  }

  return (
    `📌 <b>${escapeHTML(title)}</b>\n\n` +
    coins.map((coin, i) => formatCoinLine(coin, i + 1)).join("\n\n")
  );
}

function buildPrettyAlert({
  title,
  emotion,
  score,
  change,
  btcDom,
  volume,
  narrative
}) {
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

function formatMarketOverview(globalData) {
  const data = globalData?.data || {};
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

function buildMyPlanMessage() {
  resetPersonalStateIfNewDay();

  return (
    `🧠 <b>My WojakMeter Trading Plan</b>\n\n` +
    `💼 Balance: <b>$${PERSONAL_PLAN.balance.toFixed(2)}</b>\n` +
    `🎯 Risk per trade: <b>$${PERSONAL_PLAN.riskPerTrade.toFixed(2)}</b>\n` +
    `🛑 Max daily loss: <b>-$${PERSONAL_PLAN.maxDailyLoss.toFixed(2)}</b>\n` +
    `🔒 Daily profit lock: <b>+$${PERSONAL_PLAN.dailyProfitLock.toFixed(2)}</b>\n` +
    `📌 Max trades/day: <b>${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `⚙️ Default leverage: <b>${PERSONAL_PLAN.defaultLeverage}x</b>\n` +
    `🚫 Max leverage: <b>${PERSONAL_PLAN.maxLeverage}x</b>\n` +
    `🧪 Min signal score: <b>${PERSONAL_PLAN.minSignalScore}/100</b>\n\n` +

    `📊 <b>Today</b>\n` +
    `Trades: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `PnL: <b>${personalTradingState.pnlToday >= 0 ? "+" : ""}$${personalTradingState.pnlToday.toFixed(2)}</b>\n` +
    `Cooling down: <b>${personalTradingState.coolingDown ? "Yes" : "No"}</b>\n\n` +

    `🤖 <b>AutoTrade</b>\n` +
    `Status: <b>${autoTradeActive ? "ON ✅" : "OFF 🛑"}</b>\n` +
    `Manual confirmation: <b>${AUTO_TRADE_CONFIRM ? "Required ✅" : "Disabled ⚠️"}</b>\n` +
    `Testnet: <b>${USE_TESTNET ? "Yes (safe)" : "❗ REAL MONEY"}</b>\n\n` +

    `🧠 <b>Rule</b>\n` +
    `No trade is valid without defined risk, stop loss and emotional control.\n\n` +
    `🌐 wojakmeter.com`
  );
}

// ===============================
// MARKET FUNCTIONS
// ===============================
async function replyWithError(ctx, error, prefix = "Error") {
  console.error(prefix, error);

  const msg =
    error?.status === 429
      ? "⚠️ Too many requests right now. Please try again in a moment."
      : "⚠️ Something went wrong while fetching market data.";

  try {
    await ctx.reply(msg, {
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (_) {}
}

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

async function sendMarketOverview(ctx) {
  try {
    const global = await getGlobal();
    const change = global?.data?.market_cap_change_percentage_24h_usd ?? 0;

    await sendEmotionSticker(ctx, getEmotionByChange(change).key);

    return ctx.reply(formatMarketOverview(global), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error market overview");
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

    await sendEmotionSticker(ctx, emotion.key);

    return ctx.reply(
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
        `\n\n🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (error) {
    return replyWithError(ctx, error, "Error coin signal");
  }
}

async function sendDaily(ctx) {
  try {
    const [global, markets] = await Promise.all([getGlobal(), getMarkets()]);
    const data = global?.data || {};
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

    const mini = (c) =>
      `• <b>${escapeHTML((c.symbol || "").toUpperCase())}</b> ${formatPercent(
        safe(c.price_change_percentage_24h)
      )}`;

    return ctx.reply(
      `🧾 <b>WojakMeter Daily Wrap</b>\n\n` +
        `${emotion.emoji} <b>${emotion.label}</b>\n` +
        `📊 Score: <b>${score}/100</b>\n` +
        `📉 Market: <b>${formatPercent(change)}</b>\n` +
        `₿ BTC.D: <b>${safe(data.market_cap_percentage?.btc).toFixed(2)}%</b>\n` +
        `💸 Volume: <b>${formatUsd(safe(data.total_volume?.usd))}</b>\n\n` +
        `🚀 <b>Top Gainers</b>\n${gainers.map(mini).join("\n")}\n\n` +
        `💥 <b>Top Losers</b>\n${losers.map(mini).join("\n")}\n\n` +
        `⚡ ${getEmotionNarrative(emotion.key)}\n\n` +
        `🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (error) {
    return replyWithError(ctx, error, "Error daily");
  }
}

async function sendListByType(ctx, type) {
  try {
    const markets = await getMarkets();

    let list = [...markets].filter((c) => c.price_change_percentage_24h != null);
    let title = "Coins";

    if (type === "gainers") {
      list.sort(
        (a, b) =>
          safe(b.price_change_percentage_24h) -
          safe(a.price_change_percentage_24h)
      );
      title = "Top Gainers (24h)";
    } else if (type === "losers") {
      list.sort(
        (a, b) =>
          safe(a.price_change_percentage_24h) -
          safe(b.price_change_percentage_24h)
      );
      title = "Top Losers (24h)";
    } else if (type === "volume") {
      list.sort((a, b) => safe(b.total_volume) - safe(a.total_volume));
      title = "Volume Leaders";
    }

    list = list.slice(0, 10);

    return ctx.reply(formatCoinsBlock(title, list), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, `Error ${type}`);
  }
}

async function sendTrending(ctx) {
  try {
    const [trending, markets] = await Promise.all([getTrending(), getMarkets()]);
    const marketMap = new Map(
      markets.map((coin) => [(coin.id || "").toLowerCase(), coin])
    );

    const coins = trending?.coins || [];

    const lines = coins
      .slice(0, 10)
      .map((entry, i) => {
        const item = entry.item || {};
        const symbol = (item.symbol || "").toUpperCase();
        const marketCoin = marketMap.get((item.id || "").toLowerCase());
        const change = marketCoin?.price_change_percentage_24h ?? 0;
        const price = marketCoin?.current_price;
        const emotion = getEmotionByChange(change);
        const links = buildTradeLinksFromSymbol(symbol);

        const extra =
          price !== undefined
            ? ` · ${formatUsd(price)} · ${formatPercent(change)}`
            : "";

        return (
          `${i + 1}. ${emotion.emoji} <b>${escapeHTML(
            item.name || "Unknown"
          )}</b> (${escapeHTML(symbol)})${extra}\n` +
          `   🔗 <a href="${links.binanceFutures}">Futures</a> · <a href="${links.tradingView}">Chart</a>`
        );
      })
      .join("\n\n");

    return ctx.reply(
      `🔥 <b>Trending Coins</b>\n\n` +
        `${lines || "No trending coins found."}\n\n` +
        `⚠️ Trending does not mean safe entry.\n\n` +
        `🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (error) {
    return replyWithError(ctx, error, "Error trending");
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
        const c = safe(coin.price_change_percentage_24h, 0);
        return c >= emotion.min && c <= emotion.max;
      })
      .sort((a, b) => safe(b.market_cap, 0) - safe(a.market_cap, 0))
      .slice(0, 12);

    if (!filtered.length) {
      return ctx.reply(
        `${emotion.emoji} No coins in <b>${emotion.label}</b> right now.`,
        {
          parse_mode: "HTML",
          reply_markup: buildMainKeyboard().reply_markup
        }
      );
    }

    return ctx.reply(formatCoinsBlock(`${emotion.label} Coins`, filtered), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    });
  } catch (error) {
    return replyWithError(ctx, error, "Error filtering coins");
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

async function sendDiscipline(ctx) {
  return ctx.reply(
    `🧠 <b>WojakMeter Discipline Check</b>\n\n` +
      `1. Do I have a clear entry?\n` +
      `2. Do I have a stop loss?\n` +
      `3. Is my risk defined?\n` +
      `4. Am I chasing a green candle?\n` +
      `5. Am I trying to recover a loss?\n` +
      `6. Can I accept this loss calmly?\n\n` +
      `⚠️ <b>Rule:</b>\n` +
      `If the trade is emotional, it is not a setup.\n\n` +
      `The market does not reward urgency. It rewards patience, risk control and clean execution.\n\n` +
      `🌐 wojakmeter.com`,
    {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
}

async function sendAnalysis(ctx) {
  await ctx.reply("🔍 Analyzing top pairs...", {
    reply_markup: buildMainKeyboard().reply_markup
  });

  try {
    const markets = await getMarkets();

    const valid = markets
      .filter((c) => c.current_price > 0 && c.total_volume > 0)
      .slice(0, 30);

    const analyzed = valid
      .map((c) => {
        const change1h = safe(c.price_change_percentage_1h_in_currency, 0);
        const change24h = safe(c.price_change_percentage_24h_in_currency, 0);
        const change7d = safe(c.price_change_percentage_7d_in_currency, 0);
        const volume = safe(c.total_volume, 0);
        const marketCap = safe(c.market_cap, 0);
        const volToMcap = marketCap > 0 ? (volume / marketCap) * 100 : 0;

        let score = 50 + change24h * 3.5 + change1h * 6 + change7d * 1.2;

        if (volToMcap > 10) score += 8;
        else if (volToMcap > 5) score += 4;
        else if (volToMcap < 1) score -= 4;

        score = Math.round(clamp(score, 0, 100));

        let action = "WAIT";

        if (score >= 75) action = "LONG WATCH";
        if (score <= 25) action = "SHORT WATCH";

        return {
          c,
          score,
          action,
          volToMcap,
          change1h,
          change24h,
          change7d
        };
      })
      .sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50))
      .slice(0, 10);

    const lines = analyzed
      .map((a, i) => {
        const sym = (a.c.symbol || "").toUpperCase();
        const links = buildTradeLinksFromSymbol(sym);

        return (
          `${i + 1}. <b>${sym}</b> — <b>${a.action}</b>\n` +
          `Score: <b>${a.score}/100</b> · ` +
          `1h:${formatPercent(a.change1h)} · ` +
          `24h:${formatPercent(a.change24h)} · ` +
          `Vol/MCap:${a.volToMcap.toFixed(1)}%\n` +
          `<a href="${links.binanceFutures}">Binance</a> · ` +
          `<a href="${links.tradingView}">Chart</a>`
        );
      })
      .join("\n\n");

    return ctx.reply(
      `🧠 <b>WojakMeter Analysis — Top 10</b>\n\n` +
        `${lines}\n\n` +
        `⚠️ Readings only. Confirm setup, stop and risk before trading.\n\n` +
        `🌐 wojakmeter.com`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  } catch (err) {
    return replyWithError(ctx, err, "Error analyze");
  }
}

// ===============================
// PERSONAL MARKET SCANNER
// ===============================
function detectMarketSetup(coin) {
  if (!coin) return null;

  const symbol = (coin.symbol || "").toUpperCase();
  const name = coin.name || symbol;
  const price = safe(coin.current_price);
  const change24h = safe(coin.price_change_percentage_24h);
  const volume = safe(coin.total_volume);
  const marketCap = safe(coin.market_cap);

  if (!symbol || !price || !volume) return null;

  const volumeToMcap = marketCap > 0 ? volume / marketCap : 0;

  let type = "Observation";
  let direction = "WAIT";
  let mood = "Neutral";
  let score = 50;
  let reason = [];
  let warning = "This is a scanner alert, not a direct entry.";

  if (change24h >= 3 && volumeToMcap >= 0.03) {
    type = "Momentum Watch / Strong Gainer";
    direction = "WAIT FOR PULLBACK";
    mood = "Optimism / Euphoria";
    score =
      65 +
      Math.min(20, change24h * 2) +
      Math.min(10, volumeToMcap * 100);

    reason.push(`Strong 24h move: ${formatPercent(change24h)}`);
    reason.push(
      `Healthy volume vs market cap: ${(volumeToMcap * 100).toFixed(2)}%`
    );

    warning =
      "Avoid chasing. Wait for pullback, retest, or clean confirmation.";
  }

  if (change24h <= -3 && volumeToMcap >= 0.03) {
    type = "Capitulation Watch / Heavy Loser";
    direction = "WAIT FOR STABILIZATION";
    mood = "Concern / Panic";
    score =
      65 +
      Math.min(20, Math.abs(change24h) * 2) +
      Math.min(10, volumeToMcap * 100);

    reason.push(`Heavy 24h drop: ${formatPercent(change24h)}`);
    reason.push(
      `High activity vs market cap: ${(volumeToMcap * 100).toFixed(2)}%`
    );

    warning =
      "Do not catch the knife. Wait for stabilization or reversal structure.";
  }

  if (Math.abs(change24h) >= 2 && volumeToMcap >= 0.06) {
    type = change24h > 0 ? "Volume Momentum Watch" : "Volume Stress Watch";
    direction = change24h > 0 ? "LONG WATCH" : "SHORT / REVERSAL WATCH";
    mood = change24h > 0 ? "Optimism / Activity" : "Concern / Activity";

    score =
      Math.max(score, 70) +
      Math.min(15, Math.abs(change24h) * 2) +
      Math.min(10, volumeToMcap * 80);

    reason.push(
      `Unusual volume activity: ${(volumeToMcap * 100).toFixed(
        2
      )}% of market cap`
    );
    reason.push(`24h move: ${formatPercent(change24h)}`);

    warning = "Volume is active. Wait for confirmation before entering.";
  }

  score = Math.round(clamp(score, 0, 100));

  if (score < MARKET_MIN_SIGNAL_SCORE) return null;

  return {
    symbol: `${symbol}USDT`,
    baseSymbol: symbol,
    name,
    interval: "24h",
    type,
    direction,
    mood,
    score,
    close: price,
    move1: change24h,
    volRatio: volumeToMcap * 100,
    volume,
    marketCap,
    reason,
    warning
  };
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
    `🧠 <b>Why it triggered</b>\n${reasonLines}\n\n` +
    `⚠️ <b>Execution Warning</b>\n${escapeHTML(signal.warning)}\n\n` +
    `🧠 <b>Your Plan</b>\n` +
    `Max risk: <b>$${PERSONAL_PLAN.riskPerTrade.toFixed(2)}</b>\n` +
    `Leverage: <b>${PERSONAL_PLAN.defaultLeverage}x (max ${PERSONAL_PLAN.maxLeverage}x)</b>\n` +
    `Trades today: <b>${personalTradingState.tradesToday}/${PERSONAL_PLAN.maxTradesPerDay}</b>\n` +
    `PnL today: <b>${
      personalTradingState.pnlToday >= 0 ? "+" : ""
    }$${personalTradingState.pnlToday.toFixed(2)}</b>\n\n` +
    `🔗 <b>Trade / Chart</b>\n` +
    `<a href="${links.binanceFutures}">Binance Futures</a> · ` +
    `<a href="${links.tradingView}">TradingView</a>\n\n` +
    `🚫 This is not financial advice. Wait for confirmation and define stop loss first.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function canSendMarketPersonalSignal(signal) {
  resetPersonalStateIfNewDay();

  if (!MARKET_SCANNER_ENABLED) return false;
  if (!PERSONAL_ALERTS_ENABLED) return false;
  if (!PRIVATE_TELEGRAM_USER_ID) return false;
  if (signal.score < MARKET_MIN_SIGNAL_SCORE) return false;
  if (personalTradingState.coolingDown) return false;
  if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) {
    return false;
  }

  if (
    personalTradingState.pnlToday <=
    -Math.abs(PERSONAL_PLAN.maxDailyLoss)
  ) {
    return false;
  }

  if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
    return false;
  }

  const key = `${signal.symbol}:${signal.type}`;
  const last = lastPersonalMarketAlerts.get(key) || 0;

  if (Date.now() - last < PERSONAL_MARKET_ALERT_COOLDOWN_MS) {
    return false;
  }

  lastPersonalMarketAlerts.set(key, Date.now());

  return true;
}

async function sendMarketPersonalSignal(signal) {
  try {
    if (!canSendMarketPersonalSignal(signal)) return;

    await bot.telegram.sendMessage(
      PRIVATE_TELEGRAM_USER_ID,
      buildMarketPersonalSignalMessage(signal),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

    console.log(
      `Market personal signal sent: ${signal.symbol} ${signal.type} score ${signal.score}`
    );
  } catch (err) {
    console.error("Send market personal signal error:", err.message);
  }
}

async function scanMarketPersonalSignals() {
  try {
    if (!MARKET_SCANNER_ENABLED) return;
    if (!PERSONAL_ALERTS_ENABLED) return;
    if (!PRIVATE_TELEGRAM_USER_ID) return;

    resetPersonalStateIfNewDay();

    if (personalTradingState.coolingDown) return;
    if (personalTradingState.tradesToday >= PERSONAL_PLAN.maxTradesPerDay) {
      return;
    }

    if (
      personalTradingState.pnlToday <=
      -Math.abs(PERSONAL_PLAN.maxDailyLoss)
    ) {
      return;
    }

    if (personalTradingState.pnlToday >= PERSONAL_PLAN.dailyProfitLock) {
      return;
    }

    const markets = await getMarkets(true);

    const allowedBases = MARKET_SCAN_SYMBOLS.map((s) =>
      String(s).replace("USDT", "").toUpperCase()
    );

    const filtered = markets.filter((coin) =>
      allowedBases.includes((coin.symbol || "").toUpperCase())
    );

    const signals = filtered
      .map(detectMarketSetup)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const signal of signals) {
      await sendMarketPersonalSignal(signal);
      await sleep(750);
    }
  } catch (err) {
    console.error("Market personal scanner error:", err.message);
  }
}

// ===============================
// BROADCAST + AUTOTRADE EVALUATION
// ===============================
function shouldBroadcast(nextState) {
  const now = Date.now();

  if (!lastBroadcastState.emotionKey) return true;

  const emotionChanged =
    nextState.emotionKey !== lastBroadcastState.emotionKey;

  const scoreShift =
    Math.abs(safe(nextState.score) - safe(lastBroadcastState.score)) >=
    SCORE_SHIFT_THRESHOLD;

  const panicEntered =
    nextState.score <= 20 && safe(lastBroadcastState.score) > 20;

  const euphoriaEntered =
    nextState.score >= 85 && safe(lastBroadcastState.score) < 85;

  const enoughTime =
    now - lastBroadcastState.ts >= MIN_BROADCAST_GAP_MS;

  return (
    emotionChanged ||
    panicEntered ||
    euphoriaEntered ||
    (scoreShift && enoughTime)
  );
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

async function runChannelBroadcast() {
  try {
    const global = await getGlobal();
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

    if (TELEGRAM_CHANNEL_ID && shouldBroadcast(nextState)) {
      const text = buildPrettyAlert({
        title: "WojakMeter Market Update",
        emotion,
        score,
        change,
        btcDom,
        volume,
        narrative: getEmotionNarrative(emotion.key)
      });

      await sendMessageToChannel(text);

      lastBroadcastState = nextState;
    }

    await evaluateAndTrade(nextState);
  } catch (err) {
    console.error("Broadcast loop error:", err.message);
  }
}

// ===============================
// WATCHLIST COMMANDS
// ===============================
bot.command("watch", async (ctx) => {
  const userId = ctx.from?.id;
  const query = normalizeCoinKey((ctx.message.text || "").split(" ")[1]);

  if (!userId || !query) {
    return ctx.reply("Usage: /watch btc");
  }

  getUserWatchlist(userId).add(query);

  return ctx.reply(
    `👁 Added <b>${escapeHTML(query.toUpperCase())}</b> to your watchlist.`,
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("unwatch", async (ctx) => {
  const userId = ctx.from?.id;
  const query = normalizeCoinKey((ctx.message.text || "").split(" ")[1]);

  if (!userId || !query) {
    return ctx.reply("Usage: /unwatch btc");
  }

  getUserWatchlist(userId).delete(query);

  return ctx.reply(
    `🗑 Removed <b>${escapeHTML(query.toUpperCase())}</b> from your watchlist.`,
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("mywatchlist", async (ctx) => {
  const userId = ctx.from?.id;

  if (!userId) return;

  const list = [...getUserWatchlist(userId)];

  if (!list.length) {
    return ctx.reply("Your watchlist is empty.");
  }

  return ctx.reply(
    `👁 <b>Your Watchlist</b>\n\n` +
      list.map((x, i) => `${i + 1}. ${escapeHTML(x.toUpperCase())}`).join("\n"),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(
    `Chat ID: <code>${ctx.chat.id}</code>\n` +
      `User ID: <code>${ctx.from?.id}</code>`,
    {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    }
  );
});

bot.command("testchannel", async (ctx) => {
  if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

  if (!TELEGRAM_CHANNEL_ID) {
    return ctx.reply("⚠️ TELEGRAM_CHANNEL_ID is missing.");
  }

  await sendMessageToChannel("✅ WojakMeter connected to channel");

  return ctx.reply("Sent to channel 🚀");
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

  if (text.includes("Spotlight")) {
    return bot.telegram.sendMessage(ctx.chat.id, "Use /spotlight");
  }

  if (text.includes("Risk Status")) {
    return ctx.reply(buildRiskStatusMessage(), {
      parse_mode: "HTML",
      reply_markup: buildMainKeyboard().reply_markup
    });
  }

  if (text.includes("Risk")) return sendRisk(ctx);
  if (text.includes("BTC Mood")) return sendCoinSignal(ctx, "btc");
  if (text.includes("Top Gainers")) return sendListByType(ctx, "gainers");
  if (text.includes("Top Losers")) return sendListByType(ctx, "losers");
  if (text.includes("Radar")) return sendListByType(ctx, "volume");
  if (text.includes("Analyze")) return sendAnalysis(ctx);
  if (text.includes("Discipline")) return sendDiscipline(ctx);

  if (text.includes("Futures")) {
    return bot
      .handleUpdate({
        update_id: Date.now(),
        message: { ...ctx.message, text: "/futures" }
      })
      .catch(() => {});
  }

  if (text.includes("Positions")) {
    return bot
      .handleUpdate({
        update_id: Date.now(),
        message: { ...ctx.message, text: "/positions" }
      })
      .catch(() => {});
  }

  if (text.includes("Orders")) {
    return bot
      .handleUpdate({
        update_id: Date.now(),
        message: { ...ctx.message, text: "/orders_all" }
      })
      .catch(() => {});
  }

  if (text.includes("My Plan")) {
    return bot
      .handleUpdate({
        update_id: Date.now(),
        message: { ...ctx.message, text: "/myplan" }
      })
      .catch(() => {});
  }

  if (text.includes("Emo Status")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    return emotionTrader.handleEmoStatus(ctx);
  }

  if (text.includes("Emo History")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);
    return emotionTrader.handleEmoHistory(ctx);
  }

  if (text.includes("AutoTrade ON")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

    autoTradeActive = true;

    return ctx.reply(
      `🤖 <b>AutoTrade ACTIVATED</b>\n\n` +
        `Mode: <b>Manual confirmation required ✅</b>\n` +
        `Score LONG: ≥${SCORE_LONG_MIN}/100\n` +
        `Score SHORT: ≤${SCORE_SHORT_MAX}/100\n` +
        `Leverage: <b>${AT_LEVERAGE}x</b>\n` +
        `SL: <b>${SL_PCT}%</b> | TP: <b>${TP_PCT}%</b>\n` +
        `Testnet: <b>${USE_TESTNET ? "Yes" : "❗ REAL MONEY"}</b>\n\n` +
        `The bot sends proposals only. Use /confirmar to execute.`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
  }

  if (text.includes("AutoTrade OFF")) {
    if (!isPrivateOwner(ctx)) return replyOwnerOnly(ctx);

    autoTradeActive = false;

    return ctx.reply(
      `🛑 <b>AutoTrade DEACTIVATED</b>\n\n` +
        `No new proposals will be generated.`,
      {
        parse_mode: "HTML",
        reply_markup: buildMainKeyboard().reply_markup
      }
    );
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
// STICKER CAPTURE
// ===============================
bot.on("sticker", async (ctx) => {
  const fileId = ctx.message.sticker.file_id;

  console.log("Sticker file_id:", fileId);

  await ctx.reply(`📌 Sticker captured:\n\n<code>${fileId}</code>`, {
    parse_mode: "HTML",
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
// GLOBAL ERROR DEBUG
// ===============================
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ===============================
// BOT SAFETY CATCH
// ===============================
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err);

  try {
    ctx.reply("⚠️ Unexpected bot error.");
  } catch (_) {}
});

// ===============================
// STARTUP
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
    await Promise.allSettled([
      getMarkets(true),
      getTrending(true),
      getGlobal(true)
    ]);

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
// EMOTION TRADER START
// ===============================
emotionTrader.start({
  bot,
  PERSONAL_PLAN,
  personalTradingState,
  resetPersonalStateIfNewDay,
  PRIVATE_TELEGRAM_USER_ID,
  binanceApiKey: BINANCE_API_KEY,
  binanceApiSecret: BINANCE_API_SECRET,
  useTestnet: USE_TESTNET
});

// ===============================
// BOT START
// ===============================
// ===============================
// BOT START
// ===============================
(async () => {
  try {
    console.log("Starting WojakMeter bot...");

    const me = await bot.telegram.getMe();

    console.log(`Bot connected as @${me.username} (${me.id})`);

    await bot.telegram.deleteWebhook({
      drop_pending_updates: true
    });

    console.log("Webhook deleted. Starting polling...");

    await bot.launch({
      dropPendingUpdates: true
    });

    console.log("✅ WojakMeter bot running with polling...");

    await warmUpCache().catch((err) => {
      console.error("WarmUp error:", err.message);
    });

    await runChannelBroadcast().catch((err) => {
      console.error("Initial broadcast error:", err.message);
    });

    await scanMarketPersonalSignals().catch((err) => {
      console.error("Initial scan error:", err.message);
    });
  } catch (err) {
    console.error("❌ BOT LAUNCH FAILED:", err);
  }
})();


process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));