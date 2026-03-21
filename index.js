import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("Missing BOT_TOKEN");
}

const bot = new TelegramBot(token, { polling: true });

const COIN_MAP = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  xrp: "ripple",
  bnb: "binancecoin",
  ada: "cardano",
  doge: "dogecoin",
  ton: "the-open-network",
  avax: "avalanche-2",
  trx: "tron",
  pepe: "pepe",
  shib: "shiba-inu",
  wif: "dogwifcoin",
  bonk: "bonk",
  floki: "floki"
};

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
  const json = await fetchJson("https://api.coingecko.com/api/v3/global");
  const data = json?.data;

  if (!data) {
    throw new Error("Invalid CoinGecko response");
  }

  const change = Number(data.market_cap_change_percentage_24h_usd ?? 0);
  const volume = Number(data.total_volume?.usd ?? 0);

  let mood = "Neutral 😐";
  let description = "Market waiting... no conviction.";

  if (change > 3) {
    mood = "Euphoria 🚀";
    description = "Everyone is a genius.";
  } else if (change > 1) {
    mood = "Optimism 🙂";
    description = "Dip buyers winning.";
  } else if (change > -1) {
    mood = "Neutral 😐";
    description = "No clear direction.";
  } else if (change > -3) {
    mood = "Concern ⚠️";
    description = "People getting nervous.";
  } else {
    mood = "Frustration 😡";
    description = "Pain everywhere.";
  }

  return { mood, change, volume, description };
}

async function getCoinData(input) {
  const normalized = String(input || "").trim().toLowerCase();
  const coinId = COIN_MAP[normalized] || normalized;

  const url =
    `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&ids=${encodeURIComponent(coinId)}` +
    `&price_change_percentage=1h,24h,7d`;

  const data = await fetchJson(url);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Coin not found");
  }

  return data[0];
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2
  }).format(value);
}

function formatCompactUsd(value) {
  if (value == null || Number.isNaN(value)) return "--";
  const abs = Math.abs(value);

  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${Number(value).toFixed(2)}`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "--";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `WojakMeter Bot Activated 🚀

Use:
 /mood
 /btc
 /eth
 /sol
 /coin btc
 /coin ethereum
 /coin pepe`
  );
});

bot.onText(/^\/mood$/, async (msg) => {
  try {
    const market = await getMarketMood();

    await bot.sendMessage(
      msg.chat.id,
      `🧠 ${market.mood}
📉 Change: ${formatPercent(market.change)}
💰 Volume: ${formatCompactUsd(market.volume)}

"${market.description}"`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Error fetching market data: ${error.message}`
    );
  }
});

bot.onText(/^\/btc$/, async (msg) => {
  try {
    const coin = await getCoinData("btc");

    await bot.sendMessage(
      msg.chat.id,
      `₿ BTC
💰 Price: ${formatUsd(coin.current_price)}
📈 24h: ${formatPercent(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h)}`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Error fetching BTC price: ${error.message}`
    );
  }
});

bot.onText(/^\/eth$/, async (msg) => {
  try {
    const coin = await getCoinData("eth");

    await bot.sendMessage(
      msg.chat.id,
      `🟦 ETH
💰 Price: ${formatUsd(coin.current_price)}
📈 24h: ${formatPercent(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h)}`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Error fetching ETH price: ${error.message}`
    );
  }
});

bot.onText(/^\/sol$/, async (msg) => {
  try {
    const coin = await getCoinData("sol");

    await bot.sendMessage(
      msg.chat.id,
      `🟣 SOL
💰 Price: ${formatUsd(coin.current_price)}
📈 24h: ${formatPercent(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h)}`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Error fetching SOL price: ${error.message}`
    );
  }
});

bot.onText(/^\/coin(?:\s+(.+))?$/, async (msg, match) => {
  const query = match?.[1]?.trim();

  if (!query) {
    await bot.sendMessage(
      msg.chat.id,
      "Use it like this:\n/coin btc\n/coin ethereum\n/coin pepe"
    );
    return;
  }

  try {
    const coin = await getCoinData(query);

    await bot.sendMessage(
      msg.chat.id,
      `🪙 ${coin.symbol.toUpperCase()} — ${coin.name}
💰 Price: ${formatUsd(coin.current_price)}
📈 1h: ${formatPercent(coin.price_change_percentage_1h_in_currency)}
📊 24h: ${formatPercent(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h)}
🗓 7d: ${formatPercent(coin.price_change_percentage_7d_in_currency)}
🏦 Market Cap: ${formatCompactUsd(coin.market_cap)}
💧 Volume: ${formatCompactUsd(coin.total_volume)}`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ Coin not found: ${query}`
    );
  }
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

console.log("WojakMeter bot running...");

