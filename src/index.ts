import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { assertConfigured, config } from "./config";
import { respond } from "./agent";
import { migrate } from "./db";

const DISCORD_LIMIT = 2000;

/** Discord hard-caps messages at 2000 characters; split on paragraph or line. */
function chunk(text: string): string[] {
  if (text.length <= DISCORD_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_LIMIT) {
    const window = remaining.slice(0, DISCORD_LIMIT);
    let cut = window.lastIndexOf("\n\n");
    if (cut < DISCORD_LIMIT / 2) cut = window.lastIndexOf("\n");
    if (cut < DISCORD_LIMIT / 2) cut = window.lastIndexOf(" ");
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function extractPrompt(message: Message, botId: string): string | null {
  const isDirect = message.channel.type === ChannelType.DM;

  // In a server, only respond when actually mentioned.
  if (!isDirect && !message.mentions.users.has(botId)) return null;

  const text = message.content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();

  return text || null;
}

async function main(): Promise<void> {
  assertConfigured();
  migrate();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Without this, DM channels arrive uncached and message events never fire.
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(
      `Loopdog is up as ${ready.user.tag} — ` +
        `${config.timezone}, day rolls over at ${config.dayCutoffHour}:00, ` +
        `listening to ${config.ownerId} only.`,
    );
  });

  client.on(Events.MessageCreate, async (message) => {
    // Single-user gate: everyone else is ignored in silence.
    if (message.author.id !== config.ownerId) return;
    if (message.author.bot) return;

    const botId = client.user?.id;
    if (!botId) return;

    const prompt = extractPrompt(message, botId);
    if (!prompt) return;

    try {
      if (message.channel.isSendable()) await message.channel.sendTyping();
      const reply = await respond(prompt);
      for (const part of chunk(reply)) {
        await message.reply(part);
      }
    } catch (error) {
      console.error("[loopdog]", error);
      await message
        .reply("Something broke on my end. Check the logs.")
        .catch(() => undefined);
    }
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
