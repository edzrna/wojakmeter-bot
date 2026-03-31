require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

// ===============================
// CONFIG
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN en .env");

const PORT = process.env.PORT || 3000;

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

const MARKET_CACHE_TTL = 60000;
const TRENDING_CACHE_TTL = 120000;
const GLOBAL_CACHE_TTL = 120000;

// ===============================
// EMOTIONS (NUEVO)
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

const EMOJI_SET = new Set(EMOTION_CONFIG.map(e => e.emoji));

// ===============================
// STICKERS
// ===============================
const STICKERS = {
  neutral: "CAACAgEAAyEFAATmxqKVAAMOacqfUf3DRg38M5qkF5xEj7Yfy9wAApsHAALr6vlFgB1nkRz_pCE6BA",
  doubt: "CAACAgEAAyEFAATmxqKVAAMRacszmrKnW5boElS5jTdyqyyXYg4AAsUIAAJR3QFGLjvJYqtHGhs6BA",
  concern: "CAACAgEAAxkBAAO6acwnkAR8NX71iBqA8bAMpA9urO8AAogFAAJjiAFGAq6TbPTFdlk6BA",
  frustration: "CAACAgEAAxkBAAO8acwnksdZ-MrbFXq4D00oMo7UATgAAgYHAAIDbvhFuGNc3FD6Lp06BA",
  optimism: "CAACAgEAAyEFAATmxqKVAAMMacoQtkrNsG_LbVCu8mCwBMXUGg8AAuwIAAJu1PhFv1J4NpRaVTw6BA",
  content: "CAACAgEAAxkBAAPAacwnmJisGL8Y0D5VsjFwAWyAbZ4AAkoHAAIS0fhFDFuW0lJ-yoA6BA",
  euphoria: "CAACAgEAAxkBAAPCacwnmnVuXSZUWgrr8k_bMQuzqgIAAigHAALfhPlFr0lV7KnXvGE6BA"
};

// ===============================
// HELPERS
// ===============================
const sleep = ms => new Promise(r => setTimeout(r, ms));

const formatUsd = v => {
  if (!v) return "N/A";
  if (v > 1e12) return `$${(v/1e12).toFixed(2)}T`;
  if (v > 1e9) return `$${(v/1e9).toFixed(2)}B`;
  if (v > 1e6) return `$${(v/1e6).toFixed(2)}M`;
  if (v > 1e3) return `$${(v/1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
};

const formatPercent = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const safe = v => Number.isFinite(Number(v)) ? Number(v) : 0;

const getEmotionByChange = change =>
  EMOTION_CONFIG.find(e => change >= e.min && change <= e.max) ||
  EMOTION_CONFIG[3];

// ===============================
// STICKER FUNCTION
// ===============================
async function sendEmotionSticker(ctx, key) {
  if (!STICKERS[key]) return;
  await ctx.replyWithSticker(STICKERS[key]);
}

// ===============================
// FETCH
// ===============================
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Fetch error");
  return res.json();
}

// ===============================
// API CALLS
// ===============================
async function getMarkets() {
  if (cache.markets.data && Date.now() - cache.markets.ts < MARKET_CACHE_TTL)
    return cache.markets.data;

  const data = await fetchJSON(`${API_BASE}/coins/markets?vs_currency=usd&per_page=100&price_change_percentage=24h`);
  cache.markets = { data, ts: Date.now() };
  return data;
}

async function getTrending() {
  if (cache.trending.data && Date.now() - cache.trending.ts < TRENDING_CACHE_TTL)
    return cache.trending.data;

  const data = await fetchJSON(`${API_BASE}/search/trending`);
  cache.trending = { data, ts: Date.now() };
  return data;
}

async function getGlobal() {
  if (cache.global.data && Date.now() - cache.global.ts < GLOBAL_CACHE_TTL)
    return cache.global.data;

  const data = await fetchJSON(`${API_BASE}/global`);
  cache.global = { data, ts: Date.now() };
  return data;
}

// ===============================
// KEYBOARD
// ===============================
function keyboard() {
  return Markup.keyboard([
    ["📊 Market", "🔥 Trending"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["🤩", "😌", "🙂", "😐"],
    ["🤔", "😟", "😡"]
  ]).resize();
}

// ===============================
// MARKET
// ===============================
async function sendMarket(ctx) {
  const g = await getGlobal();
  const d = g.data;
  const change = safe(d.market_cap_change_percentage_24h_usd);

  const emotion = getEmotionByChange(change);

  await sendEmotionSticker(ctx, emotion.key);

  return ctx.reply(
    `🧠 <b>WojakMeter</b>\n\n${emotion.emoji} <b>${emotion.label}</b>\n\n📊 ${formatPercent(change)}\n💰 ${formatUsd(d.total_market_cap.usd)}`,
    { parse_mode: "HTML", reply_markup: keyboard().reply_markup }
  );
}

// ===============================
// COMMANDS
// ===============================
bot.start(ctx =>
  ctx.reply(
    `🤖 <b>WojakMeter</b>\n\n🤩 😌 🙂 😐 🤔 😟 😡`,
    { parse_mode: "HTML", reply_markup: keyboard().reply_markup }
  )
);

bot.command("teststicker", ctx =>
  ctx.replyWithSticker(STICKERS.neutral)
);

// ===============================
// HANDLER
// ===============================
bot.on("text", async ctx => {
  const t = ctx.message.text;

  if (t.includes("Market")) return sendMarket(ctx);

  if (EMOJI_SET.has(t)) {
    const emotion = EMOTION_CONFIG.find(e => e.emoji === t);
    await sendEmotionSticker(ctx, emotion.key);
    return ctx.reply(`Showing ${emotion.label}`, { reply_markup: keyboard().reply_markup });
  }
});

// ===============================
app.listen(PORT);
bot.launch();