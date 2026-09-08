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
import { respond, type DocumentInput, type ImageInput } from "./agent";
import { migrate } from "./db";
import { sniffImageType, sniffPdf } from "./imagetype";
import { startScheduler } from "./pusher";
import { sweepOldTempFiles } from "./tmpfiles";

const DISCORD_LIMIT = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
/**
 * PDFs get their own, larger cap: base64 inflates by ~33%, so 10 MB encodes
 * to ~13 MB and stays comfortably inside the API's 32 MB request limit even
 * with two of them plus images. Pages cost tokens, so this is the guard
 * against a 300-page document quietly becoming an expensive message — the
 * [usage] log line then shows what one actually cost.
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDFS = 2;

/**
 * Downloads any image attachments on a message and base64-encodes them for
 * Claude's vision input. Best-effort per attachment: an unsupported type, an
 * oversized file, or a failed download is skipped rather than failing the
 * whole message — one bad attachment shouldn't block a reply.
 *
 * The real format is sniffed from the downloaded bytes, not trusted from
 * Discord's declared contentType — Discord's CDN can serve different bytes
 * than the attachment metadata claims (observed live: a photo whose
 * metadata and actual bytes disagreed), and Anthropic's API hard-rejects a
 * media_type that doesn't match the real content.
 */
async function extractAttachments(
  message: Message,
): Promise<{ images: ImageInput[]; documents: DocumentInput[] }> {
  const images: ImageInput[] = [];
  const documents: DocumentInput[] = [];

  for (const attachment of message.attachments.values()) {
    const isImage = attachment.contentType?.startsWith("image/") ?? false;
    const isPdf = attachment.contentType?.startsWith("application/pdf") ?? false;
    if (!isImage && !isPdf) continue; // cheap pre-filter only — bytes decide below
    if (isImage && (images.length >= MAX_IMAGES || attachment.size > MAX_IMAGE_BYTES)) continue;
    if (isPdf && (documents.length >= MAX_PDFS || attachment.size > MAX_PDF_BYTES)) continue;

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());

      if (sniffPdf(buffer)) {
        // toString("base64") never wraps lines, which matters: the API
        // rejects base64 containing newlines.
        documents.push({ filename: attachment.name, data: buffer.toString("base64") });
        continue;
      }
      const mediaType = sniffImageType(buffer);
      if (!mediaType) continue; // Claude doesn't accept whatever this actually is
      images.push({ mediaType, data: buffer.toString("base64") });
    } catch (error) {
      console.error("[loopdog] failed to fetch attachment:", error);
    }
  }
  return { images, documents };
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
    // Clears anything a previous run left behind before it died.
    void sweepOldTempFiles();
  });

  client.on(Events.MessageCreate, async (message) => {
    // Single-user gate: everyone else is ignored in silence.
    if (message.author.id !== config.ownerId) return;
    if (message.author.bot) return;

    const botId = client.user?.id;
    if (!botId) return;

    const prompt = extractPrompt(message, botId);
    if (prompt === null) return;

    const { images, documents } = await extractAttachments(message);
    if (!prompt && images.length === 0 && documents.length === 0) return;

    let attachments: string[] = [];
    try {
      if (message.channel.isSendable()) await message.channel.sendTyping();
      const reply = await respond(prompt || "(no caption)", images, documents);
      attachments = reply.attachments;
      const parts = chunk(reply.text);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isLast = i === parts.length - 1;
        await message.reply(
          isLast && attachments.length ? { content: part, files: attachments } : part,
        );
      }
    } catch (error) {
      console.error("[loopdog]", error);
      await message
        .reply("Something broke on my end. Check the logs.")
        .catch(() => undefined);
    } finally {
      // Always, not just on the happy path: a failed send used to leave the
      // file behind forever. sweepOldTempFiles() covers the rest — anything
      // written by a turn that threw before we ever learned its path.
      for (const path of attachments) unlink(path).catch(() => undefined);
    }
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
