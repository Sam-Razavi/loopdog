import { unlink } from "node:fs/promises";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { assertDiscordConfigured, config } from "./config";
import { respond, type ImageInput, type SupportedImageType } from "./agent";
import { migrate } from "./db";
import { startScheduler } from "./pusher";

const DISCORD_LIMIT = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isSupportedImageType(value: string): value is SupportedImageType {
  return SUPPORTED_IMAGE_TYPES.has(value);
}

/**
 * Downloads any image attachments on a message and base64-encodes them for
 * Claude's vision input. Best-effort per attachment: an unsupported type, an
 * oversized file, or a failed download is skipped rather than failing the
 * whole message — one bad attachment shouldn't block a reply.
 */
async function extractImages(message: Message): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  for (const attachment of message.attachments.values()) {
    if (images.length >= MAX_IMAGES) break;
    const contentType = attachment.contentType?.split(";")[0]?.trim();
    if (!contentType || !isSupportedImageType(contentType)) continue;
    if (attachment.size > MAX_IMAGE_BYTES) continue;
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      images.push({ mediaType: contentType, data: buffer.toString("base64") });
    } catch (error) {
      console.error("[loopdog] failed to fetch image attachment:", error);
    }
  }
  return images;
}

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

/**
 * Null means "not applicable" (a guild message with no mention) — ignore
 * entirely, regardless of attachments. An empty string means "applicable,
 * but no text" — still worth responding to if there's an image attached.
 */
function extractPrompt(message: Message, botId: string): string | null {
  const isDirect = message.channel.type === ChannelType.DM;

  // In a server, only respond when actually mentioned.
  if (!isDirect && !message.mentions.users.has(botId)) return null;

  return message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/**
 * Best-effort DM before crashing out. Only ever called from an actual
 * uncaught exception or rejection — a graceful redeploy sends SIGTERM, not
 * one of these, so this never fires on an ordinary Railway push, only on a
 * genuine unexpected failure. The 5s race stops a hung send from blocking
 * the exit; Railway's restartPolicy (railway.json) brings the process back.
 */
async function handleFatal(client: Client, error: unknown): Promise<void> {
  console.error("[loopdog] fatal:", error);
  try {
    if (client.isReady()) {
      const owner = await client.users.fetch(config.ownerId);
      const message = `Crashed: ${error instanceof Error ? error.message : String(error)}. Restarting.`;
      await Promise.race([
        owner.send(message),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
    }
  } catch (sendError) {
    console.error("[loopdog] failed to send crash alert:", sendError);
  } finally {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertDiscordConfigured();
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

  process.on("uncaughtException", (error) => void handleFatal(client, error));
  process.on("unhandledRejection", (reason) => void handleFatal(client, reason));

  client.once(Events.ClientReady, (ready) => {
    console.log(
      `Loopdog is up as ${ready.user.tag} — ` +
        `${config.timezone}, day rolls over at ${config.dayCutoffHour}:00, ` +
        `listening to ${config.ownerId} only.`,
    );
    console.log(
      `Checking for overdue reminders every ${config.pushIntervalMinutes} minute(s) ` +
        `(quiet hours ${String(config.quietHoursStart).padStart(2, "0")}:00-` +
        `${String(config.quietHoursEnd).padStart(2, "0")}:00), ` +
        `at-risk nudge around ${String(config.atRiskNudgeHour).padStart(2, "0")}:00, ` +
        `digest Sundays around ${String(config.digestHour).padStart(2, "0")}:00, ` +
        `morning brief around ${String(config.morningBriefHour).padStart(2, "0")}:00, ` +
        `page watches every ${config.watchIntervalMinutes} minute(s).`,
    );
    startScheduler(client);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Single-user gate: everyone else is ignored in silence.
    if (message.author.id !== config.ownerId) return;
    if (message.author.bot) return;

    const botId = client.user?.id;
    if (!botId) return;

    const prompt = extractPrompt(message, botId);
    if (prompt === null) return;

    const images = await extractImages(message);
    if (!prompt && images.length === 0) return;

    try {
      if (message.channel.isSendable()) await message.channel.sendTyping();
      const { text, attachment } = await respond(prompt || "(no caption)", images);
      const parts = chunk(text);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isLast = i === parts.length - 1;
        await message.reply(
          isLast && attachment ? { content: part, files: [attachment] } : part,
        );
      }
      if (attachment) {
        // Fire-and-forget: avoid accumulating backup files in temp storage.
        unlink(attachment).catch(() => undefined);
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
