import { getDb } from "./db";
import { config } from "./config";
import { nowUtcIso } from "./time";
import { ToolError } from "./errors";
import { buildRfc822Message } from "./email";

/**
 * Google Calendar access via the OAuth device flow (RFC 8628) — the same
 * pattern CLI tools and smart TVs use: no redirect URI, no callback server,
 * just a short code the user enters at a URL in any browser while Loopdog
 * polls in the background. Fits how Loopdog already works (a chat bot with
 * no public HTTP surface) far better than the standard authorization-code
 * flow would.
 *
 * Calendar only, not Gmail — this file originally requested Gmail scopes
 * too, on the assumption "one device-flow connection covers both products."
 * That assumption was wrong: Google's device flow flatly rejects Gmail
 * scopes with invalid_scope, confirmed against a real connect attempt and
 * matching a long-standing report elsewhere (googleapis/oauth2client#88) —
 * not a consent-screen misconfiguration, a genuine platform limitation.
 * Gmail access would need the standard redirect-based OAuth flow instead,
 * which needs a public callback URL Loopdog doesn't have; tracked as a
 * separate follow-up (see isGmailUsable() below and issue #13) rather
 * than blocking Calendar on it.
 *
 * Second scope surprise, same shape as the Gmail one: `calendar.events`
 * (the narrow "read/write events only" scope) *also* gets invalid_scope
 * from the device flow, even after Gmail was dropped and even with the
 * scope explicitly declared on the OAuth consent screen. Google's
 * device/limited-input-device flow only accepts scopes off a fixed
 * allowlist, and that allowlist doesn't include every scope string a
 * given API supports — it's evidently per-scope, not per-API. Confirmed
 * by cross-checking a real, large, production device-flow integration:
 * Home Assistant's Google Calendar component requests
 * `https://www.googleapis.com/auth/calendar` (the broad, whole-calendar
 * scope) for read-write access, never `calendar.events`
 * (homeassistant/components/google/const.py). Switched to that broader
 * scope here for the same reason — it's the one Google's device flow
 * actually allows. It grants more than Loopdog uses (calendar list/
 * settings management, not just events), which is a real trade-off, but
 * there's no narrower alternative that works with this flow.
 */

const SCOPE = "https://www.googleapis.com/auth/calendar";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function requireCredentials(): { clientId: string; clientSecret: string } {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new ToolError(
      "Google isn't set up yet — GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET aren't configured.",
    );
  }
  return { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
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
  return getDb().prepare(`SELECT * FROM google_auth WHERE id = 1`).get() as AuthRow | undefined;
}

export function isConnected(): boolean {
  return getAuthRow()?.status === "connected";
}

/**
 * Always false, deliberately — Gmail scopes can't be carried by this
 * connection's OAuth device flow at all (see this file's top comment and
 * issue #13), so a connected Calendar session never implies Gmail is
 * usable the way it originally did. Kept as a named function rather than
 * inlining `false` at each call site so the reason is documented in one
 * place and this flips cleanly if #13 ever ships.
 */
export function isGmailUsable(): boolean {
  return false;
}

function requireGmailUsable(): void {
  throw new ToolError(
    "Gmail isn't available via the Google connection yet — Google's device-flow login doesn't support Gmail scopes. See issue #13.",
  );
}

/** For the system prompt's live-state block — omits itself entirely when never set up. */
export function getStatus(): "not_connected" | "pending" | "connected" {
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
  if (row.status === "connected" && row.refresh_token) {
    // Best-effort revoke — don't let a failed revoke block clearing our own state.
    fetch(`${REVOKE_URL}?token=${encodeURIComponent(row.refresh_token)}`, { method: "POST" }).catch(
      () => undefined,
    );
  }
  getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
  return true;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
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
    const body = await response.text().catch(() => "");
    throw new ToolError(`couldn't start the Google connection (HTTP ${response.status}): ${body || "no error detail returned"}`);
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
  const { clientId, clientSecret } = requireCredentials();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
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
      `INSERT OR REPLACE INTO google_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'connected', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, COALESCE((SELECT created_at FROM google_auth WHERE id = 1), ?), ?)`,
    )
    .run(access, refresh, tokenExpiresAt, now, now);
}

export type ConnectResult =
  | { status: "connected"; already: boolean }
  | { status: "pending"; verification_url: string; user_code: string }
  | { status: "expired" | "denied" };

/**
 * Starts (or continues) the device-flow connection. Re-invokable and
 * idempotent by design: already connected -> reports so; a pending code
 * exists -> polls it once and reports the outcome; nothing pending ->
 * starts a fresh flow. This is the only tool call in the whole loop, so it
 * has to handle "did it work yet?" naturally on a second call.
 */
export async function connect(): Promise<ConnectResult> {
  if (isConnected()) return { status: "connected", already: true };

  const row = getAuthRow();
  if (row?.status === "pending" && row.device_code) {
    if (row.expires_at && row.expires_at <= nowUtcIso()) {
      getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
    } else {
      const result = await pollToken(row.device_code);
      if (result.access_token && result.refresh_token) {
        storeConnected(result.access_token, result.refresh_token, result.expires_in ?? 3600);
        return { status: "connected", already: false };
      }
      if (result.error === "authorization_pending" || result.error === "slow_down") {
        return {
          status: "pending",
          verification_url: row.verification_url ?? "https://www.google.com/device",
          user_code: row.user_code ?? "",
        };
      }
      // expired_token, access_denied, or anything else unexpected: clear and let the caller retry fresh.
      getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
      return { status: result.error === "access_denied" ? "denied" : "expired" };
    }
  }

  const device = await requestDeviceCode();
  const now = nowUtcIso();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO google_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      device.device_code,
      device.user_code,
      device.verification_url,
      device.interval,
      new Date(Date.now() + device.expires_in * 1000).toISOString(),
      now,
      now,
    );

  return {
    status: "pending",
    verification_url: device.verification_url,
    user_code: device.user_code,
  };
}

/** Called from the scheduler tick — one poll attempt if a code is pending, no tool call needed. */
export async function pollPendingConnection(): Promise<"connected" | "expired" | "denied" | null> {
  const row = getAuthRow();
  if (!row || row.status !== "pending" || !row.device_code) return null;
  if (row.expires_at && row.expires_at <= nowUtcIso()) {
    getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
    return "expired";
  }

  const result = await pollToken(row.device_code);
  if (result.access_token && result.refresh_token) {
    storeConnected(result.access_token, result.refresh_token, result.expires_in ?? 3600);
    return "connected";
  }
  if (result.error === "authorization_pending" || result.error === "slow_down") return null;

  getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
  return result.error === "access_denied" ? "denied" : "expired";
}

async function getAccessToken(): Promise<string> {
  const row = getAuthRow();
  if (!row || row.status !== "connected" || !row.access_token || !row.refresh_token) {
    throw new ToolError(
      `Google account isn't connected — call connect_google first, or ask the user to.`,
    );
  }
  if (row.token_expires_at && row.token_expires_at > nowUtcIso()) {
    return row.access_token;
  }

  const { clientId, clientSecret } = requireCredentials();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new ToolError("Google connection expired — call connect_google to reconnect.");
  }
  getDb()
    .prepare(`UPDATE google_auth SET access_token = ?, token_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(
      data.access_token,
      new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      nowUtcIso(),
    );
  return data.access_token;
}

export interface CalendarEvent {
  summary: string;
  start: string; // ISO, whatever Google returns (dateTime or date-only for all-day)
  end: string;
}

interface GoogleEventsResponse {
  items?: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
}

export async function listEvents(withinDays: number): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  const now = new Date();
  const until = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const url = new URL(CALENDAR_API);
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", until.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't read the calendar (HTTP ${response.status})`);
  const data = (await response.json()) as GoogleEventsResponse;

  return (data.items ?? []).map((item) => ({
    summary: item.summary ?? "(no title)",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
  }));
}

export async function createEvent(
  summary: string,
  startIso: string,
  endIso: string,
): Promise<CalendarEvent> {
  const token = await getAccessToken();
  const response = await fetch(CALENDAR_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't create the event (HTTP ${response.status})`);
  const item = (await response.json()) as {
    summary?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  };
  return {
    summary: item.summary ?? summary,
    start: item.start?.dateTime ?? startIso,
    end: item.end?.dateTime ?? endIso,
  };
}

// --- Gmail (read + draft only — see the top-of-file note on why there is
// deliberately no send function here) ---------------------------------

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage extends GmailPart {
  id: string;
  threadId: string;
  snippet?: string;
  headers?: GmailHeader[];
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Walks a (possibly multipart) message body for the first text/plain part. */
function extractPlainText(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (found) return found;
  }
  return null;
}

/**
 * Lists/searches emails. `query` uses Gmail's own search syntax (e.g.
 * "is:unread", "from:someone@example.com", "newer_than:7d") — omit it for
 * the most recent inbox messages. One list call plus one metadata fetch per
 * message; fine at the maxResults this is ever called with for one person.
 */
export async function listEmails(query: string | undefined, maxResults: number): Promise<EmailSummary[]> {
  requireGmailUsable();
  const token = await getAccessToken();
  const listUrl = new URL(`${GMAIL_API}/messages`);
  listUrl.searchParams.set("q", query && query.trim() ? query.trim() : "in:inbox");
  listUrl.searchParams.set("maxResults", String(maxResults));
  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!listResponse.ok) throw new ToolError(`couldn't list emails (HTTP ${listResponse.status})`);
  const listData = (await listResponse.json()) as { messages?: { id: string }[] };
  const ids = listData.messages ?? [];

  const results: EmailSummary[] = [];
  for (const { id } of ids) {
    const detailUrl = new URL(`${GMAIL_API}/messages/${id}`);
    detailUrl.searchParams.set("format", "metadata");
    for (const header of ["From", "Subject", "Date"]) detailUrl.searchParams.append("metadataHeaders", header);
    const detailResponse = await fetch(detailUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!detailResponse.ok) continue; // skip a message that vanished/failed rather than failing the whole list
    const detail = (await detailResponse.json()) as GmailMessage;
    results.push({
      id: detail.id,
      threadId: detail.threadId,
      from: headerValue(detail.headers, "From"),
      subject: headerValue(detail.headers, "Subject"),
      date: headerValue(detail.headers, "Date"),
      snippet: detail.snippet ?? "",
    });
  }
  return results;
}

export async function getEmail(id: string): Promise<EmailSummary & { body: string }> {
  requireGmailUsable();
  const token = await getAccessToken();
  const url = new URL(`${GMAIL_API}/messages/${id}`);
  url.searchParams.set("format", "full");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't read that email (HTTP ${response.status})`);
  const detail = (await response.json()) as GmailMessage;
  return {
    id: detail.id,
    threadId: detail.threadId,
    from: headerValue(detail.headers, "From"),
    subject: headerValue(detail.headers, "Subject"),
    date: headerValue(detail.headers, "Date"),
    snippet: detail.snippet ?? "",
    body: extractPlainText(detail) ?? detail.snippet ?? "",
  };
}

export interface DraftResult {
  draftId: string;
  messageId: string;
}

/** Creates a Gmail draft. Never sends — there is no send function in this file, deliberately. */
export async function createDraft(to: string, subject: string, body: string): Promise<DraftResult> {
  requireGmailUsable();
  const token = await getAccessToken();
  const raw = Buffer.from(buildRfc822Message(to, subject, body), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const response = await fetch(`${GMAIL_API}/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ToolError(`couldn't create the draft (HTTP ${response.status})`);
  const data = (await response.json()) as { id: string; message?: { id?: string } };
  return { draftId: data.id, messageId: data.message?.id ?? "" };
}
