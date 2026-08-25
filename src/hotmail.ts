import { getDb } from "./db";
import { config } from "./config";
import { nowUtcIso } from "./time";
import { ToolError } from "./errors";

/**
 * Hotmail/Outlook/Live (a Microsoft personal account) via the OAuth device
 * flow — same RFC 8628 pattern as google.ts, different identity provider.
 * A separate account, a separate connection, a separate module: Microsoft's
 * stack (identity platform + Graph) shares nothing with Google's under the
 * hood, so mirroring google.ts's shape here beats trying to unify the two
 * into one generic "OAuth provider" abstraction for what is, so far, two
 * providers total.
 *
 * Scope is read + draft only, same policy as Gmail — but here it's actually
 * enforced one layer deeper: Mail.ReadWrite genuinely cannot send mail at
 * the Graph API level (sending needs the separate Mail.Send scope, which is
 * simply never requested). Gmail's gmail.compose scope alone would still
 * technically permit sending if a send-capable call were ever made, so
 * Gmail's safety boundary is "no send tool exists in the code." Here it's
 * both that *and* the API itself refusing. Still never add a send function
 * here regardless — belt AND suspenders, not an excuse to relax either one.
 */

const SCOPE =
  "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite";
const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

function requireCredentials(): { clientId: string } {
  if (!config.hotmailClientId) {
    throw new ToolError("Hotmail isn't set up yet — HOTMAIL_CLIENT_ID isn't configured.");
  }
  return { clientId: config.hotmailClientId };
}

interface AuthRow {
  status: "pending" | "connected";
  device_code: string | null;
  user_code: string | null;
  verification_url: string | null;
  poll_interval: number | null;
  expires_at: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

function getAuthRow(): AuthRow | undefined {
  return getDb().prepare(`SELECT * FROM hotmail_auth WHERE id = 1`).get() as AuthRow | undefined;
}

export function isConnected(): boolean {
  return getAuthRow()?.status === "connected";
}

/** For the system prompt's live-state block — omits itself entirely when never set up. */
export function getStatus(): "not_connected" | "pending" | "connected" {
  return getAuthRow()?.status ?? "not_connected";
}

export function disconnect(): boolean {
  const row = getAuthRow();
  if (!row) return false;
  // Unlike Google, Microsoft has no simple public REST endpoint to revoke a
  // refresh token for a personal account — clearing our own state is the
  // whole of what's doable here. account.live.com/consent/Manage is where
  // the user would go to revoke Loopdog's access on Microsoft's side too.
  getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
  return true;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const { clientId } = requireCredentials();
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ToolError(`couldn't start the Hotmail connection (HTTP ${response.status})`);
  }
  return (await response.json()) as DeviceCodeResponse;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function pollToken(deviceCode: string): Promise<TokenResponse> {
  const { clientId } = requireCredentials();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json()) as TokenResponse;
}

function storeConnected(access: string, refresh: string, expiresInSeconds: number): void {
  const now = nowUtcIso();
  const tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO hotmail_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'connected', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, COALESCE((SELECT created_at FROM hotmail_auth WHERE id = 1), ?), ?)`,
    )
    .run(access, refresh, tokenExpiresAt, now, now);
}

export type ConnectResult =
  | { status: "connected"; already: boolean }
  | { status: "pending"; verification_url: string; user_code: string }
  | { status: "expired" | "denied" };

/**
 * Starts (or continues) the device-flow connection. Re-invokable and
 * idempotent by design, same as google.ts's connect() — already connected
 * -> reports so; a pending code exists -> polls it once and reports the
 * outcome; nothing pending -> starts a fresh flow.
 */
export async function connect(): Promise<ConnectResult> {
  if (isConnected()) return { status: "connected", already: true };

  const row = getAuthRow();
  if (row?.status === "pending" && row.device_code) {
    if (row.expires_at && row.expires_at <= nowUtcIso()) {
      getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
    } else {
      const result = await pollToken(row.device_code);
      if (result.access_token && result.refresh_token) {
        storeConnected(result.access_token, result.refresh_token, result.expires_in ?? 3600);
        return { status: "connected", already: false };
      }
      if (result.error === "authorization_pending" || result.error === "slow_down") {
        return {
          status: "pending",
          verification_url: row.verification_url ?? "https://microsoft.com/devicelogin",
          user_code: row.user_code ?? "",
        };
      }
      // expired_token, authorization_declined, or anything else unexpected: clear and let the caller retry fresh.
      getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
      return { status: result.error === "authorization_declined" ? "denied" : "expired" };
    }
  }

  const device = await requestDeviceCode();
  const now = nowUtcIso();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO hotmail_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      device.device_code,
      device.user_code,
      device.verification_uri,
      device.interval,
      new Date(Date.now() + device.expires_in * 1000).toISOString(),
      now,
      now,
    );

  return {
    status: "pending",
    verification_url: device.verification_uri,
    user_code: device.user_code,
  };
}

/** Called from the scheduler tick — one poll attempt if a code is pending, no tool call needed. */
export async function pollPendingConnection(): Promise<"connected" | "expired" | "denied" | null> {
  const row = getAuthRow();
  if (!row || row.status !== "pending" || !row.device_code) return null;
  if (row.expires_at && row.expires_at <= nowUtcIso()) {
    getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
    return "expired";
  }

  const result = await pollToken(row.device_code);
  if (result.access_token && result.refresh_token) {
    storeConnected(result.access_token, result.refresh_token, result.expires_in ?? 3600);
    return "connected";
  }
  if (result.error === "authorization_pending" || result.error === "slow_down") return null;

  getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
  return result.error === "authorization_declined" ? "denied" : "expired";
}

async function getAccessToken(): Promise<string> {
  const row = getAuthRow();
  if (!row || row.status !== "connected" || !row.access_token || !row.refresh_token) {
    throw new ToolError(`Hotmail isn't connected — call connect_hotmail first, or ask the user to.`);
  }
  if (row.token_expires_at && row.token_expires_at > nowUtcIso()) {
    return row.access_token;
  }

  const { clientId } = requireCredentials();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new ToolError("Hotmail connection expired — call connect_hotmail to reconnect.");
  }
  getDb()
    .prepare(`UPDATE hotmail_auth SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(
      data.access_token,
      data.refresh_token ?? null,
      new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      nowUtcIso(),
    );
  return data.access_token;
}

// --- Mail, via Microsoft Graph (read + draft only — see the top-of-file
// note on why there is deliberately no send function here) -------------

export interface EmailSummary {
  id: string;
  conversationId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { content?: string; contentType?: string };
}

function toSummary(message: GraphMessage): EmailSummary {
  return {
    id: message.id,
    conversationId: message.conversationId ?? "",
    from: message.from?.emailAddress?.address ?? message.from?.emailAddress?.name ?? "",
    subject: message.subject ?? "(no subject)",
    date: message.receivedDateTime ?? "",
    snippet: message.bodyPreview ?? "",
  };
}

const SELECT_FIELDS = "id,conversationId,subject,from,receivedDateTime,bodyPreview";

/**
 * Lists/searches emails. `query` uses Graph's own full-text search (subject,
 * body, sender, etc.) — omit it for the most recent inbox messages, ordered
 * newest first. $search results come back relevance-ordered instead
 * (Graph doesn't allow combining $search with $orderby), which is the
 * expected trade-off for a search rather than a plain listing.
 */
export async function listEmails(query: string | undefined, maxResults: number): Promise<EmailSummary[]> {
  const token = await getAccessToken();
  const url =
    query && query.trim()
      ? new URL(`${GRAPH_API}/messages`)
      : new URL(`${GRAPH_API}/mailFolders/inbox/messages`);
  url.searchParams.set("$top", String(maxResults));
  url.searchParams.set("$select", SELECT_FIELDS);
  if (query && query.trim()) {
    url.searchParams.set("$search", `"${query.trim()}"`);
  } else {
    url.searchParams.set("$orderby", "receivedDateTime desc");
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't list emails (HTTP ${response.status})`);
  const data = (await response.json()) as { value?: GraphMessage[] };
  return (data.value ?? []).map(toSummary);
}

export async function getEmail(id: string): Promise<EmailSummary & { body: string }> {
  const token = await getAccessToken();
  const url = new URL(`${GRAPH_API}/messages/${id}`);
  url.searchParams.set("$select", `${SELECT_FIELDS},body`);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Asks Graph to return body.content as plain text instead of HTML,
      // so there's no markup to strip on this end.
      Prefer: 'outlook.body-content-type="text"',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't read that email (HTTP ${response.status})`);
  const message = (await response.json()) as GraphMessage;
  return { ...toSummary(message), body: message.body?.content ?? message.bodyPreview ?? "" };
}

export interface DraftResult {
  id: string;
}

/** Creates a Hotmail/Outlook draft. Never sends — there is no send function in this file, deliberately. */
export async function createDraft(to: string, subject: string, body: string): Promise<DraftResult> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_API}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't create the draft (HTTP ${response.status})`);
  const data = (await response.json()) as { id: string };
  return { id: data.id };
}
