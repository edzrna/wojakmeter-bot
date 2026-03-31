require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

// ===============================
// CONFIG
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("Falta BOT_TOKEN en .env");
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// CoinGecko demo/public
const API_BASE = "https://api.coingecko.com/api/v3";
const VS_CURRENCY = "usd";

// Cache general
const cache = {
  markets: { data: null, ts: 0 },
  trending: { data: null, ts: 0 },
  global: { data: null, ts: 0 },
};

// TTLs
const MARKET_CACHE_TTL = 60 * 1000;
const TRENDING_CACHE_TTL = 2 * 60 * 1000;
const GLOBAL_CACHE_TTL = 2 * 60 * 1000;

// Cooldown por usuario para evitar spam
const userCooldowns = new Map();
const USER_COOLDOWN_MS = 800;

// ===============================
// EMOTION MAP
// ===============================
const EMOTION_CONFIG = [
  { emoji: "🤯", key: "euphoria", label: "Euphoria", min: 12, max: 9999 },
  { emoji: "😎", key: "content", label: "Content", min: 6, max: 11.9999 },
  { emoji: "🙂", key: "optimism", label: "Optimism", min: 2, max: 5.9999 },
  { emoji: "🤔", key: "neutral", label: "Neutral", min: -1.9999, max: 1.9999 },
  { emoji: "😟", key: "doubt", label: "Doubt", min: -4.9999, max: -2 },
  { emoji: "😰", key: "concern", label: "Concern", min: -7.9999, max: -5 },
  { emoji: "😡", key: "frustration", label: "Frustration", min: -9999, max: -8 },
];

const EMOJI_SET = new Set(EMOTION_CONFIG.map((x) => x.emoji));

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
    "CAACAgEAAxkBAAPCacwnmnVuXSZUWgrr8k_bMQuzqgIAAigHAALfhPlFr0lV7KnXvGE6BA",
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

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getEmotionByChange(change24h) {
  const n = safeNumber(change24h, 0);
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

function buildMainKeyboard() {
  return Markup.keyboard([
    ["📊 Market", "🔥 Trending"],
    ["🚀 Top Gainers", "💥 Top Losers"],
    ["🤯", "😎", "🙂", "🤔"],
    ["😟", "😰", "😡"],
    ["/start", "/help"]
  ]).resize();
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

// ===============================
// FETCH WITH RETRY / ANTI-429
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
// FORMATTERS
// ===============================
function formatCoinLine(coin, index) {
  const symbol = (coin.symbol || "").toUpperCase();
  const name = coin.name || "Unknown";
  const price = formatUsd(coin.current_price);
  const change = safeNumber(coin.price_change_percentage_24h, 0);
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

function formatMarketOverview(globalData) {
  const data = globalData?.data || {};
  const totalMcap = data.total_market_cap?.usd ?? 0;
  const totalVol = data.total_volume?.usd ?? 0;
  const btcDom = data.market_cap_percentage?.btc ?? 0;
  const active = data.active_cryptocurrencies ?? 0;
  const markets = data.markets ?? 0;
  const change = data.market_cap_change_percentage_24h_usd ?? 0;

  const emotion = getEmotionByChange(change);

  return (
    `🧠 <b>WojakMeter Market Mood</b>\n\n` +
    `${emotion.emoji} <b>${emotion.label}</b>\n\n` +
    `📊 24h Change: <b>${formatPercent(change)}</b>\n` +
    `💰 Market Cap: <b>${formatUsd(totalMcap)}</b>\n` +
    `💸 Volume 24h: <b>${formatUsd(totalVol)}</b>\n` +
    `₿ BTC Dominance: <b>${btcDom.toFixed(2)}%</b>\n` +
    `🪙 Active Coins: <b>${active}</b>\n` +
    `🏦 Markets: <b>${markets}</b>\n\n` +
    `⚡ The market is feeling <b>${emotion.label.toLowerCase()}</b>.`
  );
}

function formatTrendingBlock(trendingData, marketMap) {
  const coins = trendingData?.coins || [];
  if (!coins.length) {
    return "⚠️ No trending coins found right now.";
  }

  const lines = coins.slice(0, 10).map((entry, i) => {
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
  });

  return `🔥 <b>Trending Coins</b>\n\n${lines.join("\n")}`;
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
        const change = safeNumber(coin.price_change_percentage_24h, 0);
        return change >= emotion.min && change <= emotion.max;
      })
      .sort((a, b) => safeNumber(b.market_cap, 0) - safeNumber(a.market_cap, 0))
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
      .sort((a, b) => safeNumber(b.price_change_percentage_24h, 0) - safeNumber(a.price_change_percentage_24h, 0))
      .slice(0, 10);

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
      .sort((a, b) => safeNumber(a.price_change_percentage_24h, 0) - safeNumber(b.price_change_percentage_24h, 0))
      .slice(0, 10);

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
    const [trending, markets] = await Promise.all([
      getTrending(),
      getMarkets()
    ]);

    const marketMap = new Map(
      markets.map((coin) => [(coin.id || "").toLowerCase(), coin])
    );

    // 🔥 calcular emoción promedio del trending
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

    // 🔥 STICKER PRIMERO
    await sendEmotionSticker(ctx, emotion.key);

    // 🔥 TEXTO
    const text =
      `🔥 <b>Trending Coins</b>\n\n` +
      `🧠 Mood: <b>${emotion.label}</b>\n\n` +
      formatTrendingBlock(trending, marketMap);

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

    // Sticker primero
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
// COMMANDS
// ===============================
bot.start(async (ctx) => {
  const firstName = ctx.from?.first_name ? escapeHTML(ctx.from.first_name) : "trader";

  const text =
    `🤖 <b>Welcome to WojakMeter Bot</b>\n\n` +
    `Hi, <b>${firstName}</b>.\n` +
    `Use the buttons or send an emotion emoji to filter coins by market mood.\n\n` +
    `<b>Supported emotions:</b>\n` +
    `🤯 Euphoria\n` +
    `😎 Content\n` +
    `🙂 Optimism\n` +
    `🤔 Neutral\n` +
    `😟 Doubt\n` +
    `😰 Concern\n` +
    `😡 Frustration\n\n` +
    `<b>Quick actions:</b>\n` +
    `📊 Market\n` +
    `🔥 Trending\n` +
    `🚀 Top Gainers\n` +
    `💥 Top Losers`;

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.help(async (ctx) => {
  const text =
    `🛠 <b>WojakMeter Bot Help</b>\n\n` +
    `Send one of these emojis to filter coins by mood:\n` +
    `🤯 😎 🙂 🤔 😟 😰 😡\n\n` +
    `<b>Buttons:</b>\n` +
    `📊 Market → global market overview\n` +
    `🔥 Trending → trending coins\n` +
    `🚀 Top Gainers → strongest coins in 24h\n` +
    `💥 Top Losers → weakest coins in 24h\n\n` +
    `The bot uses cache to reduce API calls and avoid 429 errors.`;

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

bot.command("market", sendMarketOverview);
bot.command("trending", sendTrending);
bot.command("gainers", sendTopGainers);
bot.command("losers", sendTopLosers);
bot.command("id", async (ctx) => {
  await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, {
    parse_mode: "HTML",
    reply_markup: buildMainKeyboard().reply_markup
  });
});

// ===============================
// TEMP: STICKER FILE_ID CAPTURE
// Puedes quitar esto después si ya no lo necesitas
// ===============================
bot.on("sticker", async (ctx) => {
  const fileId = ctx.message.sticker.file_id;

  console.log("Sticker file_id:", fileId);

  await ctx.reply(
    `📌 Sticker guardado:\n\n<code>${fileId}</code>`,
    { parse_mode: "HTML" }
  );
});

// ===============================
// TEXT / BUTTON HANDLERS
// ===============================
bot.on("text", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId && isUserCoolingDown(userId)) return;

  const text = (ctx.message?.text || "").trim();

  if (text.includes("Market")) return sendMarketOverview(ctx);
  if (text.includes("Trending")) return sendTrending(ctx);
  if (text.includes("Top Gainers")) return sendTopGainers(ctx);
  if (text.includes("Top Losers")) return sendTopLosers(ctx);

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
// OPTIONAL WARM CACHE
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

  warmUpCache().catch(console.error);
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));