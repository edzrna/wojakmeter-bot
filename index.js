import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 🔥 Fetch global crypto data
async function getMarketMood() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global");
    const data = await res.json();

    const change = data.data.market_cap_change_percentage_24h_usd || 0;

    let mood = "Neutral";

    if (change > 3) mood = "Euphoria 🚀";
    else if (change > 1) mood = "Optimism 🙂";
    else if (change > -1) mood = "Neutral 😐";
    else if (change > -3) mood = "Concern ⚠️";
    else mood = "Frustration 😡";

    return {
      mood,
      change,
      volume: data.data.total_volume.usd
    };
  } catch (err) {
    console.error(err);
    return null;
  }
}

// 🚀 COMMANDS

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "WojakMeter Bot Activated 🚀");
});

bot.onText(/\/mood/, async (msg) => {
  const chatId = msg.chat.id;

  const market = await getMarketMood();

  if (!market) {
    return bot.sendMessage(chatId, "⚠️ Error fetching market data");
  }

  bot.sendMessage(
    chatId,
    `🧠 Market Mood: ${market.mood}
📉 Change: ${market.change.toFixed(2)}%
💰 Volume: $${(market.volume / 1e9).toFixed(2)}B`
  );
});

bot.onText(/\/btc/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );
    const data = await res.json();

    bot.sendMessage(chatId, `₿ BTC Price: $${data.bitcoin.usd}`);
  } catch {
    bot.sendMessage(chatId, "Error fetching BTC price");
  }
});