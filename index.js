import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const API_BASE = process.env.API_BASE_URL || "https://wojakmeter.com/api";

bot.start((ctx) => {
  ctx.reply(`🔥 Welcome to WojakMeter

Use:
/mood → Market mood
/btc → BTC stats`);
});

bot.command("mood", async (ctx) => {
  try {
    const res = await fetch(`${API_BASE}/global`);
    const data = await res.json();

    const change = data.data.market_cap_change_percentage_24h_usd || 0;
    const score = Math.round(50 + change * 10);

    let mood = "Neutral";
    if (score >= 70) mood = "Optimism";
    if (score >= 85) mood = "Euphoria";
    if (score < 45) mood = "Doubt";
    if (score < 35) mood = "Concern";
    if (score < 20) mood = "Frustration";

    ctx.reply(`📊 Market Mood: ${mood} (${score}/100)

📉 Change: ${change.toFixed(2)}%`);
  } catch {
    ctx.reply("⚠️ Error fetching mood");
  }
});

bot.command("btc", async (ctx) => {
  try {
    const res = await fetch(`${API_BASE}/top-coins`);
    const data = await res.json();

    const btc = data.coins.find(c => c.symbol === "btc");

    ctx.reply(`₿ BTC

💰 Price: $${btc.current_price}
📊 24h: ${btc.price_change_percentage_24h_in_currency.toFixed(2)}%`);
  } catch {
    ctx.reply("⚠️ Error fetching BTC");
  }
});

bot.launch();

console.log("🚀 Bot running...");