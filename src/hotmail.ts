import { getDb } from "./db";
import { config } from "./config";
import { nowUtcIso } from "./time";
import { ToolError } from "./errors";
import { postRefresh as postRefreshRequest, type RefreshOutcome, type TokenResponse } from "./oauthrefresh";

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
  /**
   * 'expired' means we *proved* the refresh token is dead (Microsoft answered
   * invalid_grant) — as opposed to merely failing to reach Microsoft, which
   * leaves a connected row alone. Not to be confused with connect()'s
   * {status: "expired"} result, which means a *pending device code* timed out.
   */
  status: "pending" | "connected" | "expired";
  device_code: string | null;
  user_code: string | null;
  verification_url: string | null;
  poll_interval: number | null;
  expires_at: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  /** Set once the user has been told this connection lapsed; reset by a reconnect. */
  expiry_notified_at: string | null;
}

function getAuthRow(): AuthRow | undefined {
  return getDb().prepare(`SELECT * FROM hotmail_auth WHERE id = 1`).get() as AuthRow | undefined;
}

/**
 * A local read only — it reports what we *last knew*, and never contacts
 * Microsoft. Cheap on purpose, since it gates the scheduler and the system
 * prompt; but "true" is not a promise the token still works. connect() and
 * verifyConnection() are the functions that ask Microsoft, and a failed
 * refresh anywhere flips this to false by marking the row 'expired'.
 */
export function isConnected(): boolean {
  return getAuthRow()?.status === "connected";
}

/** For the system prompt's live-state block — omits itself entirely when never set up. */
export function getStatus(): "not_connected" | "pending" | "connected" | "expired" {
  return getAuthRow()?.status ?? "not_connected";
}

/**
 * The poll_interval the provider asked us to use, in seconds — null when no
 * connection is pending. Stored since the device flow was first built but
 * never read until the scheduler grew a dedicated auth poller.
 */
export function pendingPollInterval(): number | null {
  const row = getAuthRow();
  if (!row || row.status !== "pending") return null;
  return row.poll_interval ?? null;
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
  | {
      status: "pending";
      verification_url: string;
      user_code: string;
      /** The previous connection turned out to be dead, so this is a replacement — say so. */
      replaced_expired?: true;
    }
  | { status: "expired" | "denied" };

/**
 * Starts (or continues) the device-flow connection. Re-invokable and
 * idempotent by design, same as google.ts's connect(): a pending code exists
 * -> polls it once and reports the outcome; nothing pending -> starts a
 * fresh flow.
 *
 * "Already connected" is *verified* against Microsoft, not read off the
 * table — this used to return {already: true} the moment a row existed, so a
 * dead refresh token left "call connect_hotmail to reconnect" answering
 * "already connected" forever. A connected row now forces a real refresh:
 *   - works        -> connected, and the claim is true;
 *   - proven dead  -> starts a fresh connection in the same call, flagged
 *                     replaced_expired;
 *   - can't tell   -> throws. Never claims connected on a guess, never
 *                     discards a login over a bad moment.
 */
export async function connect(): Promise<ConnectResult> {
  let replacedExpired = false;
  const existing = getAuthRow();

  if (existing?.status === "connected") {
    if (existing.refresh_token) {
      const result = await tryRefresh({ ...existing, refresh_token: existing.refresh_token });
      if (result.kind === "ok") return { status: "connected", already: true };
      if (result.kind !== "dead") throw refreshFailureError(result);
      replacedExpired = true; // tryRefresh already marked the row expired
    } else {
      replacedExpired = true; // "connected" with no refresh token can't work; same as expired
    }
  } else if (existing?.status === "expired") {
    replacedExpired = true;
  }

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
    ...(replacedExpired ? { replaced_expired: true as const } : {}),
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

const EXPIRED_MESSAGE = "Hotmail connection expired — call connect_hotmail to reconnect.";

/** Microsoft's refresh request: a public client (no secret), scope restated, may rotate the token. */
function postRefresh(refreshToken: string): Promise<RefreshOutcome> {
  const { clientId } = requireCredentials();
  return postRefreshRequest(
    TOKEN_URL,
    new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPE,
    }),
  );
}

/**
 * Marks the connection dead — but only if the row still holds the refresh
 * token we just watched fail. Without that guard a slow background refresh
 * could finish *after* the user re-authorised and mark their brand-new, healthy
 * connection expired. Tokens are cleared too; a dead one has no reason to stay.
 */
function markExpired(deadRefreshToken: string): void {
  getDb()
    .prepare(
      `UPDATE hotmail_auth
       SET status = 'expired', access_token = NULL, refresh_token = NULL,
           token_expires_at = NULL, expiry_notified_at = NULL, updated_at = ?
       WHERE id = 1 AND status = 'connected' AND refresh_token = ?`,
    )
    .run(nowUtcIso(), deadRefreshToken);
}

type RefreshResult =
  | { kind: "ok"; token: string }
  | { kind: "dead" }
  | { kind: "client_rejected" }
  | { kind: "transient"; detail: string };

/**
 * Attempts a real refresh against Microsoft and records what it learned — the
 * single place Hotmail's refresh token is exercised, so detection can't be
 * skipped by taking a different path.
 *
 * Microsoft ROTATES the refresh token: a success may hand back a new one, which
 * must be stored (and the old one is not revoked). The write is a
 * compare-and-set on the token we used. That matters under rotation: two
 * concurrent refreshes can both succeed on the same old token, and the CAS
 * turns the slower one into a harmless no-op instead of letting it overwrite
 * the winner's newer token with an older one.
 */
async function tryRefresh(row: AuthRow & { refresh_token: string }): Promise<RefreshResult> {
  const outcome = await postRefresh(row.refresh_token);

  if (outcome.ok) {
    getDb()
      .prepare(
        `UPDATE hotmail_auth
         SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ?
         WHERE id = 1 AND refresh_token = ?`,
      )
      .run(
        outcome.accessToken,
        outcome.refreshToken ?? null,
        new Date(Date.now() + outcome.expiresIn * 1000).toISOString(),
        nowUtcIso(),
        row.refresh_token,
      );
    return { kind: "ok", token: outcome.accessToken };
  }

  if (outcome.kind === "dead") {
    markExpired(row.refresh_token);
    return { kind: "dead" };
  }
  if (outcome.kind === "client_rejected") return { kind: "client_rejected" };
  return { kind: "transient", detail: outcome.detail };
}

/** Maps a non-ok refresh to the error the model sees — each says what to do next, and they differ. */
function refreshFailureError(result: Exclude<RefreshResult, { kind: "ok" }>): ToolError {
  switch (result.kind) {
    case "dead":
      return new ToolError(EXPIRED_MESSAGE);
    case "client_rejected":
      return new ToolError(
        "Microsoft rejected this app's client id (HOTMAIL_CLIENT_ID) — check it's current. The saved " +
          "login itself wasn't touched, and reconnecting won't help until this is fixed.",
      );
    default:
      // Deliberately never uses the word "expired", even to deny it: a tool
      // result is read by a model, and a salient word survives its own
      // negation often enough to be relayed to the user as the diagnosis.
      return new ToolError(
        `couldn't reach Microsoft to refresh the Hotmail login (${result.detail}) — try again in a moment. ` +
          "The saved connection is fine and nothing was changed.",
      );
  }
}

async function getAccessToken(): Promise<string> {
  const row = getAuthRow();
  if (row?.status === "expired") throw new ToolError(EXPIRED_MESSAGE);
  if (!row || row.status !== "connected" || !row.access_token || !row.refresh_token) {
    throw new ToolError(`Hotmail isn't connected — call connect_hotmail first, or ask the user to.`);
  }
  if (row.token_expires_at && row.token_expires_at > nowUtcIso()) {
    return row.access_token;
  }

  const result = await tryRefresh({ ...row, refresh_token: row.refresh_token });
  if (result.kind === "ok") return result.token;
  throw refreshFailureError(result);
}

/**
 * Checks the connection against Microsoft without throwing — for the
 * scheduler's daily health check, which has to tell "dead" from "couldn't
 * tell" and must never take the scheduler down. A dead token is marked expired
 * as a side effect, exactly as it would be by any other use.
 */
export async function verifyConnection(): Promise<"ok" | "expired" | "unverified" | "not_connected"> {
  const row = getAuthRow();
  if (row?.status === "expired") return "expired";
  if (row?.status !== "connected" || !row.refresh_token) return "not_connected";
  try {
    const result = await tryRefresh({ ...row, refresh_token: row.refresh_token });
    if (result.kind === "ok") return "ok";
    return result.kind === "dead" ? "expired" : "unverified";
  } catch {
    return "unverified"; // e.g. HOTMAIL_CLIENT_ID unset — not something that proves the token dead
  }
}

/** True when the connection has lapsed and the user hasn't been told yet. */
export function expiryNoticePending(): boolean {
  const row = getAuthRow();
  return row?.status === "expired" && row.expiry_notified_at == null;
}

/** Call only after the notice actually sent. A reconnect resets it (the row is replaced). */
export function markExpiryNotified(): void {
  getDb()
    .prepare(`UPDATE hotmail_auth SET expiry_notified_at = ? WHERE id = 1 AND status = 'expired'`)
    .run(nowUtcIso());
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

/**
 * A 401 from Graph means Microsoft rejected an access token we believed was
 * fresh. It says nothing about the *refresh* token, so it isn't proof of
 * death and must not mark anything expired; it points at connect_hotmail,
 * whose forced refresh repairs this case and handles a dead token too.
 */
function graphHttpError(action: string, status: number): ToolError {
  if (status === 401) {
    return new ToolError(
      `couldn't ${action}: Microsoft rejected the saved login (HTTP 401) — call connect_hotmail, ` +
        "which re-checks the connection and reconnects if it has lapsed.",
    );
  }
  return new ToolError(`couldn't ${action} (HTTP ${status})`);
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
  if (!response.ok) throw graphHttpError("list emails", response.status);
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
  if (!response.ok) throw graphHttpError("read that email", response.status);
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
  if (!response.ok) throw graphHttpError("create the draft", response.status);
  const data = (await response.json()) as { id: string };
  return { id: data.id };
}
