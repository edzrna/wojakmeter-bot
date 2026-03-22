import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("Missing BOT_TOKEN");
}

const bot = new TelegramBot(token, { polling: true });

const CACHE_TIME = 30000;
const ALERT_INTERVAL = 60000;

let cache = {
  mood: null,
  moodTimestamp: 0,
  top: null,
  topTimestamp: 0
};

const alertSubscribers = new Set();

let alertState = {
  lastMoodKey: null,
  lastScore: null
};

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function scoreFromChange(change) {
  return Math.round(clamp(50 + change * 10, 0, 100));
}

function getMoodKey(score) {
  if (score >= 85) return "euphoria";
  if (score >= 70) return "content";
  if (score >= 60) return "optimism";
  if (score >= 45) return "neutral";
  if (score >= 35) return "doubt";
  if (score >= 20) return "concern";
  return "frustration";
}

function getWojakMood(score) {
  if (score >= 85) return { name: "Euphoria", emoji: "🚀" };
  if (score >= 70) return { name: "Content", emoji: "😌" };
  if (score >= 60) return { name: "Optimism", emoji: "🙂" };
  if (score >= 45) return { name: "Neutral", emoji: "😐" };
  if (score >= 35) return { name: "Doubt", emoji: "🤨" };
  if (score >= 20) return { name: "Concern", emoji: "😰" };
  return { name: "Frustration", emoji: "😡" };
}

function buildBar(score) {
  const total = 10;
  const filled = Math.round((score / 100) * total);
  return `[${"█".repeat(filled)}${"░".repeat(total - filled)}] ${score}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "--";
  return `$${Number(value).toLocaleString()}`;
}

function formatVolume(v) {
  if (!Number.isFinite(v)) return "--";
  return `$${Math.round(v / 1e9)}B`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }

  return res.json();
}

async function getMarketMood() {
  const now = Date.now();

  if (cache.mood && now - cache.moodTimestamp < CACHE_TIME) {
    return cache.mood;
  }

  try {
    const json = await fetchJson("https://api.coingecko.com/api/v3/global");
    const data = json.data;

    const change = Number(data.market_cap_change_percentage_24h_usd || 0);
    const volume = Number(data.total_volume.usd || 0);

    const score = scoreFromChange(change);
    const mood = getWojakMood(score);

    const result = {
      ...mood,
      score,
      change,
      volume,
      description: "Market reacting to price + macro"
    };

    cache.mood = result;
    cache.moodTimestamp = now;

    return result;
  } catch (error) {
    if (cache.mood) return cache.mood;
    throw error;
  }
}

async function getTopCoins() {
  const now = Date.now();

  if (cache.top && now - cache.topTimestamp < CACHE_TIME) {
    return cache.top;
  }

  try {
    const coins = await fetchJson(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h"
    );

    cache.top = coins;
    cache.topTimestamp = now;

    return coins;
  } catch (error) {
    if (cache.top) return cache.top;
    throw error;
  }
}

bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🚀 WojakMeter Bot

/mood
/top
/alerts_on
/alerts_off

Or send:
🤔 😐 🙂 😰 😡 😌 🚀`
  );
});

bot.onText(/^\/mood$/, async (msg) => {
  try {
    const m = await getMarketMood();

    await bot.sendMessage(
      msg.chat.id,
      `🧠 ${m.name} ${m.emoji}
📉 ${formatPercent(m.change)}
💰 ${formatVolume(m.volume)}
${buildBar(m.score)}

"${m.description}"`
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `⚠️ Error fetching market mood: ${error.message}`);
  }
});

bot.onText(/^\/top$/, async (msg) => {
  try {
    const coins = await getTopCoins();

    let text = "🧠 WOJAKMETER TOP 10\n\n";

    coins.forEach((c, i) => {
      const change = Number(c.price_change_percentage_24h || 0);
      const score = scoreFromChange(change);
      const mood = getWojakMood(score);

      text += `${i + 1}. ${mood.emoji} ${c.symbol.toUpperCase()}
💰 ${formatUsd(c.current_price)} ${formatPercent(change)}
${buildBar(score)}\n\n`;
    });

    bot.sendMessage(msg.chat.id, text);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `⚠️ Error loading top coins: ${error.message}`);
  }
});

const EMOJI_MAP = {
  "🚀": "euphoria",
  "😌": "content",
  "🙂": "optimism",
  "😐": "neutral",
  "🤨": "doubt",
  "😰": "concern",
  "😡": "frustration"
};

bot.on("message", async (msg) => {
  const moodKey = EMOJI_MAP[msg.text];
  if (!moodKey) return;

  try {
    const coins = await getTopCoins();

    const filtered = coins.filter((c) => {
      const score = scoreFromChange(c.price_change_percentage_24h || 0);
      return getMoodKey(score) === moodKey;
    });

    if (!filtered.length) {
      return bot.sendMessage(msg.chat.id, `${msg.text} No coins in this mood`);
    }

    let text = `${msg.text} Coins\n\n`;

    filtered.forEach((c) => {
      const change = Number(c.price_change_percentage_24h || 0);
      const score = scoreFromChange(change);

      text += `${c.symbol.toUpperCase()} ${formatPercent(change)}
${buildBar(score)}\n\n`;
    });

    bot.sendMessage(msg.chat.id, text);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `⚠️ Error filtering coins: ${error.message}`);
  }
});

bot.onText(/^\/alerts_on$/, (msg) => {
  alertSubscribers.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🔔 Alerts ON");
});

bot.onText(/^\/alerts_off$/, (msg) => {
  alertSubscribers.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🔕 Alerts OFF");
});

async function checkAlerts() {
  try {
    if (alertSubscribers.size === 0) return;

    const m = await getMarketMood();
    const key = getMoodKey(m.score);

    if (!alertState.lastMoodKey) {
      alertState.lastMoodKey = key;
      alertState.lastScore = m.score;
      return;
    }

    if (key !== alertState.lastMoodKey) {
      const prev = getWojakMood(alertState.lastScore || 50);

      for (const chatId of alertSubscribers) {
        await bot.sendMessage(
          chatId,
          `🚨 Market Mood Change

${prev.name} → ${m.name} ${m.emoji}
${buildBar(m.score)}`
        );
      }

      alertState.lastMoodKey = key;
      alertState.lastScore = m.score;
    }
  } catch (error) {
    console.error("Alert error:", error.message);
  }
}

setInterval(checkAlerts, ALERT_INTERVAL);

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("🔥 WojakMeter bot running...");