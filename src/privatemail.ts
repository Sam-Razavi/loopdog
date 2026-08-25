import { ImapFlow, type MessageStructureObject } from "imapflow";
import { config } from "./config";
import { ToolError } from "./errors";
import { buildRfc822Message } from "./email";
import { extractReadableText } from "./webfetch";

/**
 * A third, independent email account — a custom domain hosted on Namecheap
 * Private Email (mail.privateemail.com), reached over plain IMAP rather
 * than an OAuth API. No device flow, no token exchange, no DB table: the
 * only credential is the mailbox's own username/password, read straight
 * from env vars and checked fresh on every use. isConfigured() is this
 * provider's entire "connection state" — there's no pending/connected
 * distinction the way there is for google.ts/hotmail.ts, because there's
 * no handshake to be pending on.
 *
 * Read + draft only, same policy as Gmail and Hotmail — enforced the same
 * way (no send-capable function exists here, ever) plus one more layer:
 * IMAP itself has no "send" operation. Sending mail needs a separate SMTP
 * connection, which this file never opens. A leaked password is a bigger
 * risk than a leaked OAuth token (nothing here can be scoped or revoked
 * from Loopdog's side — only by changing the password on Namecheap's own
 * side), which is exactly the trade-off that was confirmed with the user
 * before building this.
 */

const HOST = "mail.privateemail.com";
const PORT = 993;

function requireCredentials(): { email: string; password: string } {
  if (!config.privatemailEmail || !config.privatemailPassword) {
    throw new ToolError(
      "PrivateMail isn't set up yet — PRIVATEMAIL_EMAIL and PRIVATEMAIL_PASSWORD aren't configured.",
    );
  }
  return { email: config.privatemailEmail, password: config.privatemailPassword };
}

export function isConfigured(): boolean {
  return Boolean(config.privatemailEmail && config.privatemailPassword);
}

/** For the system prompt's live-state block. No "pending" state — it's configured or it isn't. */
export function getStatus(): "not_configured" | "configured" {
  return isConfigured() ? "configured" : "not_configured";
}

/**
 * Opens a connection, runs `fn`, always closes it after — request-scoped,
 * no long-lived session kept between tool calls, same spirit as
 * google.ts/hotmail.ts never holding a connection open between requests.
 */
async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { email, password } = requireCredentials();
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    // Without explicit timeouts a blocked/unreachable server just hangs the
    // TCP connect forever — caught by testing against a network that drops
    // port 993 silently rather than refusing it. Same 10s budget the other
    // two providers' fetch() calls already use.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new ToolError(
      `couldn't connect to PrivateMail: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return await fn(client);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`PrivateMail request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
}

function addressOf(envelope: { from?: { name?: string; address?: string }[] } | undefined): string {
  const first = envelope?.from?.[0];
  return first?.address ?? first?.name ?? "";
}

/**
 * Lists/searches the inbox. Without a query, the most recent `maxResults`
 * messages, newest first — sequence numbers 1..exists have no gaps, so a
 * plain range fetch is enough, no need to page through UIDs. With a query,
 * IMAP's own text SEARCH (subject/body/sender), fetched by UID so results
 * stay addressable by get_email afterward.
 *
 * Deliberately no snippet field, unlike Gmail/Hotmail's bodyPreview — IMAP
 * has no equivalent for free, and fetching body content for every listed
 * message is unneeded cost for a v1. get_email covers full content.
 */
export async function listEmails(query: string | undefined, maxResults: number): Promise<EmailSummary[]> {
  return withClient(async (client) => {
    const mailbox = await client.mailboxOpen("INBOX");

    if (query && query.trim()) {
      const uids = await client.search({ text: query.trim() }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const recent = uids.slice(-maxResults).reverse();
      const messages = await client.fetchAll(recent, { uid: true, envelope: true }, { uid: true });
      return messages.map((m) => ({
        id: String(m.uid),
        from: addressOf(m.envelope),
        subject: m.envelope?.subject ?? "(no subject)",
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "",
      }));
    }

    if (mailbox.exists === 0) return [];
    const start = Math.max(1, mailbox.exists - maxResults + 1);
    const messages = await client.fetchAll(`${start}:${mailbox.exists}`, { uid: true, envelope: true });
    return messages
      .map((m) => ({
        id: String(m.uid),
        from: addressOf(m.envelope),
        subject: m.envelope?.subject ?? "(no subject)",
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "",
      }))
      .reverse(); // newest first, matching Gmail/Hotmail's default ordering
  });
}

/** Walks a bodyStructure tree for the first text/plain part, falling back to text/html. */
function findTextPart(node: MessageStructureObject | undefined): { part: string; html: boolean } | null {
  if (!node) return null;
  if (node.type === "text/plain" && node.part) return { part: node.part, html: false };
  let htmlFallback: { part: string; html: boolean } | null = null;
  if (node.type === "text/html" && node.part) htmlFallback = { part: node.part, html: true };
  for (const child of node.childNodes ?? []) {
    const found = findTextPart(child);
    if (found && !found.html) return found;
    if (found && !htmlFallback) htmlFallback = found;
  }
  return htmlFallback;
}

export async function getEmail(id: string): Promise<EmailSummary & { body: string }> {
  return withClient(async (client) => {
    await client.mailboxOpen("INBOX");
    const message = await client.fetchOne(id, { uid: true, envelope: true, bodyStructure: true }, { uid: true });
    if (!message) throw new ToolError(`no email with id ${id}`);

    const summary: EmailSummary = {
      id: String(message.uid),
      from: addressOf(message.envelope),
      subject: message.envelope?.subject ?? "(no subject)",
      date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : "",
    };

    const textPart = findTextPart(message.bodyStructure);
    if (!textPart) return { ...summary, body: "" };

    const { content } = await client.download(id, textPart.part, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of content) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    const body = textPart.html ? extractReadableText(raw).text : raw;
    return { ...summary, body };
  });
}

export interface DraftResult {
  id: string;
}

/** Appends a draft to the account's Drafts mailbox. Never sends — IMAP has no send operation, and no SMTP client exists in this file, deliberately. */
export async function createDraft(to: string, subject: string, body: string): Promise<DraftResult> {
  return withClient(async (client) => {
    const mailboxes = await client.list();
    const draftsMailbox = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "Drafts";
    const message = buildRfc822Message(to, subject, body);
    const result = await client.append(draftsMailbox, message, ["\\Draft"]);
    if (!result) throw new ToolError("couldn't create the draft");
    return { id: result.uid !== undefined ? String(result.uid) : draftsMailbox };
  });
}
