import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { config } from "./config";
import { ToolError } from "./errors";

/**
 * Telegram, read only — a personal account's own chats, not a bot's inbox.
 * Telegram's Bot API can't see this: a bot is a different kind of account
 * entirely. Reading the user's real DMs/channels needs a login as that
 * actual account via Telegram's client API (MTProto, here via `teleproto`
 * — an actively maintained fork of the archived `telegram`/GramJS package;
 * swapped in after `npm install telegram` printed a deprecation notice
 * pointing at this fork, same "don't ship a dead dependency" instinct that
 * ruled out @xenova/transformers during the voice-message research).
 *
 * That login is an interactive phone-number + code (+ 2FA password if set)
 * flow that can't happen through a Discord tool call — there's no code to
 * poll for the way OAuth device flow has one; the login code lands on the
 * user's phone in real time and has to be typed back immediately. So this
 * is a one-time local script (scripts/telegram-login.ts), not a
 * connect_telegram tool. Once logged in, the resulting session string is
 * this provider's entire "connection state" — same isConfigured()-only
 * shape as privatemail.ts, no DB table, no connect/disconnect tool.
 *
 * The one thing that makes this provider's credential different from
 * every other one here: it is NOT scoped. Gmail/Hotmail's OAuth tokens are
 * scope-limited by the provider (no Mail.Send granted, ever); PrivateMail's
 * password is protocol-limited (IMAP has no send operation at all). A
 * Telegram user session has neither kind of backstop — it's full, unscoped
 * account access. The "no send tool" boundary here rests entirely on this
 * file never calling a send-capable method (Dialog.send() exists on the
 * library's own Dialog objects and is simply never invoked). Said plainly
 * in the README's setup section, not just here.
 */

function requireCredentials(): { apiId: number; apiHash: string; session: string } {
  const apiId = Number(config.telegramApiId);
  if (!config.telegramApiId || !config.telegramApiHash || !config.telegramSession || !Number.isInteger(apiId)) {
    throw new ToolError(
      "Telegram isn't set up yet — run `npm run telegram-login` and set TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION.",
    );
  }
  return { apiId, apiHash: config.telegramApiHash, session: config.telegramSession };
}

export function isConfigured(): boolean {
  return Boolean(
    config.telegramApiId && config.telegramApiHash && config.telegramSession && Number.isInteger(Number(config.telegramApiId)),
  );
}

/** For the system prompt's live-state block. No "pending" state — it's configured or it isn't. */
export function getStatus(): "not_configured" | "configured" {
  return isConfigured() ? "configured" : "not_configured";
}

/**
 * Opens a connection, runs `fn`, always disconnects after — request-scoped,
 * same spirit as privatemail.ts never holding a session open between tool
 * calls. Can be revisited for a longer-lived connection later if per-call
 * MTProto handshake latency turns out to matter in practice.
 */
async function withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const { apiId, apiHash, session } = requireCredentials();

  let client: TelegramClient;
  try {
    // StringSession's own constructor validates the string synchronously
    // and throws if it's malformed — covered by this try along with
    // everything else here, not left to escape unwrapped the way it did
    // during testing (a stray TELEGRAM_SESSION value threw a raw,
    // un-wrapped error before this fix).
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 2,
      // Same lesson as privatemail.ts's ImapFlow fix: without an explicit
      // timeout, a broken/unreachable connection just hangs instead of
      // failing — caught by testing this against a network that drops the
      // connection silently rather than refusing it outright.
      timeout: 10,
      // No interactive fallback: a session that's missing/revoked should
      // fail cleanly, not sit there prompting for a phone number nobody can
      // answer from inside a Discord conversation.
    });
    await client.connect();
  } catch (error) {
    throw new ToolError(
      `couldn't connect to Telegram — TELEGRAM_SESSION may be malformed or expired: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new ToolError("Telegram's session has expired or been revoked — run `npm run telegram-login` again.");
    }
    return await fn(client);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Telegram request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export interface ChatSummary {
  id: string;
  name: string;
  kind: "user" | "group" | "channel";
  unreadCount: number;
  lastMessage: string;
  date: string;
}

export async function listChats(maxResults: number): Promise<ChatSummary[]> {
  return withClient(async (client) => {
    const dialogs = await client.getDialogs({ limit: maxResults });
    return dialogs.map((d) => ({
      id: d.id?.toString() ?? "",
      name: d.name ?? d.title ?? "(unknown)",
      kind: d.isChannel ? "channel" : d.isGroup ? "group" : "user",
      unreadCount: d.unreadCount,
      lastMessage: d.message?.message ?? "",
      date: d.date ? new Date(d.date * 1000).toISOString() : "",
    }));
  });
}

export interface MessageSummary {
  id: number;
  from: string;
  text: string;
  date: string;
}

/**
 * A message's sender can be a User, Chat, Channel, or the empty-chat
 * placeholder the library returns when a sender can't be resolved — each
 * with a different (or no) field for "the name a human would recognise."
 * Checked at runtime rather than typed structurally, since some of those
 * variants share no properties at all with the others.
 */
function senderName(sender: unknown): string {
  if (!sender || typeof sender !== "object") return "";
  const s = sender as Record<string, unknown>;
  const name = s.firstName ?? s.title ?? s.username;
  return typeof name === "string" ? name : "";
}

/**
 * Recent messages from one chat (id from listChats), or a text search
 * within it when `query` is given. Newest first, matching every other
 * provider's default ordering.
 */
export async function getMessages(chatId: string, query: string | undefined, maxResults: number): Promise<MessageSummary[]> {
  return withClient(async (client) => {
    const entity = await client.getEntity(chatId).catch(() => null);
    if (!entity) throw new ToolError(`no Telegram chat with id ${chatId}`);
    const messages = await client.getMessages(entity, {
      limit: maxResults,
      search: query && query.trim() ? query.trim() : undefined,
    });
    return messages.map((m) => ({
      id: m.id,
      from: senderName(m.sender),
      text: m.message ?? "",
      date: new Date(m.date * 1000).toISOString(),
    }));
  });
}
