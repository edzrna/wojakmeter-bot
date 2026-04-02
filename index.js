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
// WATCHLISTS (IN-MEMORY)
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
    "CAACAgEAAyEFAATmxqKVAAMOacqfUf3DRg38M5qkF5xEj7Yfy9wAApsHAALr6vlFgB1nkRz_pCE6BA",
  doubt:
    "CAACAgEAAyEFAATmxqKVAAMRacszmrKnW5boElS5jTdyqyyXYg4AAsUIAAJR3QFGLjvJYqtHGhs6BA",
  concern:
    "CAACAgEAAxkBAAO6acwnkAR8NX71iBqA8bAMpA9urO8AAogFAAJjiAFGAq6TbPTFdlk6BA",
  frustration:
    "CAACAgEAAxkBAAO8acwnksdZ-MrbFXq4D00oMo7UATgAAgYHAAIDbvhFuGNc3FD6Lp06BA",
  optimism:
    "CAACAgEAAyEFAATmxqKVAAMMacoQtkrNsG_LbVCu8mCwBMXUGg8AAuwIAAJu1PhFv1J4NpRaVTw6BA",
  content:
    "CAACAgEAAxkBAAPAacwnmJisGL8Y0D5VsjFwAWyAbZ4AAkoHAAIS0fhFDFuW0lJ-yoA6BA",
  euphoria:
    "CAACAgEAAxkBAAPCacwnmnVuXSZUWgrr8k_bMQuzqgIAAigHAALfhPlFr0lV7KnXvGE6BA"
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

function buildMainKeyboard() {
  return Markup.keyboard([
    ["🧠 Signal", "📊 Market"],
    ["🔥 Trending", "🌟 Spotlight"],
    ["⚠️ Risk", "₿ BTC Mood"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["/coin btc", "/daily"],
    ["/mywatchlist"],
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

  return `${index}. ${emotion.emoji} <b>${escapeHTML(name)}</b> (${escapeHTML(symbol)})\n` +
         `   ${trendArrow(change)} ${formatPercent(change)} · ${price}`;
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
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${narrative}\n\n` +
    `🌐 wojakmeter.com`
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
    `📉 Market: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(nextEmotion.key)}\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildPanicAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🔴 <b>Panic Alert</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score collapsed to <b>${score}/100</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ Risk-off conditions are taking control.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildEuphoriaAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🟢 <b>Euphoria Alert</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score reached <b>${score}/100</b>\n` +
    `📈 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ Momentum is overheating. Traders are chasing hard.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildVolumeSpikeAlert({ emotion, score, change, btcDom, volume, prevVolume }) {
  const jump = prevVolume > 0 ? ((volume - prevVolume) / prevVolume) * 100 : 0;

  return (
    `💥 <b>Volume Spike</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n` +
    `📈 Spike: <b>${formatPercent(jump)}</b>\n\n` +
    `⚡ Activity just accelerated. Something is moving.\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildBreakingAlert({ emotion, score, change, btcDom, volume }) {
  return (
    `🚨 <b>BREAKING SIGNAL</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `📉 Move: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}\n\n` +
    `🌐 wojakmeter.com`
  );
}

function buildCoinSpotlight(title, coin) {
  if (!coin) return null;

  const change = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);

  return (
    `🌟 <b>${title}</b>\n\n` +
    `${emotion.emoji} <b>${escapeHTML(coin.name)}</b> (${escapeHTML((coin.symbol || "").toUpperCase())})\n` +
    `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
    `📉 24h: <b>${formatPercent(change)}</b>\n` +
    `💰 MCap: <b>${formatUsd(coin.market_cap)}</b>\n` +
    `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}`
  );
}

function buildCoinExtremeAlert(coin) {
  const change = safe(coin.price_change_percentage_24h);
  const emotion = getEmotionByChange(change);
  const score = scoreFromChange(change);

  const title = score >= 85 ? "Coin Euphoria" : "Coin Panic";

  return (
    `🚨 <b>${title}</b>\n\n` +
    `${emotion.emoji} <b>${escapeHTML(coin.name)}</b> (${escapeHTML((coin.symbol || "").toUpperCase())})\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
    `📉 24h: <b>${formatPercent(change)}</b>\n` +
    `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}`
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

  return (
    `🧾 <b>WojakMeter Daily Wrap</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n` +
    `📊 Score: <b>${score}/100</b>\n` +
    `📉 Market: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC.D: <b>${safe(data.market_cap_percentage?.btc).toFixed(2)}%</b>\n` +
    `💸 Volume: <b>${formatUsd(safe(data.total_volume?.usd))}</b>\n\n` +
    `🚀 <b>Top Gainers</b>\n${gainers.map((c) => `• ${(c.symbol || "").toUpperCase()} ${formatPercent(safe(c.price_change_percentage_24h))}`).join("\n")}\n\n` +
    `💥 <b>Top Losers</b>\n${losers.map((c) => `• ${(c.symbol || "").toUpperCase()} ${formatPercent(safe(c.price_change_percentage_24h))}`).join("\n")}\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}`
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
    `📉 24h Change: <b>${formatPercent(change)}</b>\n` +
    `₿ BTC Dominance: <b>${btcDom.toFixed(2)}%</b>\n` +
    `💰 Market Cap: <b>${formatUsd(totalMcap)}</b>\n` +
    `💸 Volume 24h: <b>${formatUsd(totalVol)}</b>\n` +
    `🪙 Active Coins: <b>${active}</b>\n` +
    `🏦 Markets: <b>${markets}</b>\n\n` +
    `⚡ ${getEmotionNarrative(emotion.key)}`
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

    let extra = "";
    if (price !== undefined) {
      extra = ` · ${formatUsd(price)} · ${formatPercent(change)}`;
    }

    return `${i + 1}. ${emotion.emoji} <b>${escapeHTML(item.name || "Unknown")}</b> (${escapeHTML(symbol)})${extra}`;
  }).join("\n");
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
      `🧠 Tone: <b>${label}</b>\n` +
      `📉 Move: <b>${formatPercent(change)}</b>`,
      {
        parse_mode: "HTML",
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

    return ctx.reply(
      `₿ <b>BTC Mood</b>\n\n` +
      `${emotion.emoji} <b>${emotion.label}</b>\n` +
      `📊 Score: <b>${score}/100</b>\n` +
      `💵 Price: <b>${formatUsd(btc.current_price)}</b>\n` +
      `📉 24h: <b>${formatPercent(change)}</b>\n\n` +
      `⚡ ${getEmotionNarrative(emotion.key)}`,
      {
        parse_mode: "HTML",
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

    const text =
      `🪙 <b>${escapeHTML(coin.name)}</b> (${escapeHTML((coin.symbol || "").toUpperCase())})\n\n` +
      `${emotion.emoji} <b>${emotion.label}</b>\n` +
      `📊 Score: <b>${score}/100</b>\n` +
      `💵 Price: <b>${formatUsd(coin.current_price)}</b>\n` +
      `📉 24h: <b>${formatPercent(change)}</b>\n` +
      `💰 MCap: <b>${formatUsd(coin.market_cap)}</b>\n` +
      `💸 Volume: <b>${formatUsd(coin.total_volume)}</b>\n\n` +
      `⚡ ${getEmotionNarrative(emotion.key)}`;

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

    const text = formatCoinsBlock("Top Gainers (24h)", gainers);
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

    const text = formatCoinsBlock("Top Losers (24h)", losers);
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

    await sendEmotionSticker(ctx, emotion.key);

    const text =
      `🔥 <b>Trending Coins</b>\n\n` +
      `🧠 Mood: <b>${emotion.label}</b>\n\n` +
      `${formatTrendingLines(trending, marketMap)}`;

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
          `₿ BTC.D: <b>${btcDom.toFixed(2)}%</b>\n` +
          `↕ Previous: <b>${safe(lastBroadcastState.btcDom).toFixed(2)}%</b>\n` +
          `📉 Market Move: <b>${formatPercent(change)}</b>\n\n` +
          `⚡ Bitcoin dominance is moving fast. Rotation risk is rising.\n\n` +
          `🌐 wojakmeter.com`;
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
        lastBroadcastState.spotlightCoinId = strongest.id;
        await sleep(1200);
      }
    }

    const spotlights = getSpotlights(markets);

    if (score <= 20 && spotlights.topLoser) {
      await sendMessageToChannel(buildCoinSpotlight("Stress Spotlight", spotlights.topLoser));
    } else if (score >= 85 && spotlights.topGainer) {
      await sendMessageToChannel(buildCoinSpotlight("Momentum Spotlight", spotlights.topGainer));
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
    `🧠 Signal\n📊 Market\n🔥 Trending\n🌟 Spotlight\n⚠️ Risk\n₿ BTC Mood\n🪙 /coin btc\n🧾 /daily`;

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
    `🪙 /coin btc → signal by coin\n` +
    `🧾 /daily → premium daily wrap\n` +
    `🚀 Top Gainers → strongest coins in 24h\n` +
    `💥 Top Losers → weakest coins in 24h\n\n` +
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
  await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, {
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
// OPTIONAL: STICKER FILE_ID CAPTURE
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
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));