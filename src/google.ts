import { getDb } from "./db";
import { config } from "./config";
import { nowUtcIso } from "./time";
import { ToolError } from "./errors";
import { buildRfc822Message } from "./email";
import { postRefresh as postRefreshRequest, type RefreshOutcome, type TokenResponse } from "./oauthrefresh";

/**
 * Google Calendar access via the OAuth device flow (RFC 8628) — the same
 * pattern CLI tools and smart TVs use: no redirect URI, no callback server,
 * just a short code the user enters at a URL in any browser while Loopdog
 * polls in the background. Fits how Loopdog already works (a chat bot with
 * no public HTTP surface) far better than the standard authorization-code
 * flow would.
 *
 * The device flow covers Calendar only, not Gmail — this file originally
 * requested Gmail scopes too, on the assumption "one device-flow
 * connection covers both products." That assumption was wrong: Google's
 * device flow flatly rejects Gmail scopes with invalid_scope, confirmed
 * against a real connect attempt and matching a long-standing report
 * elsewhere (googleapis/oauth2client#88) — not a consent-screen
 * misconfiguration, a genuine platform limitation.
 *
 * Gmail therefore lives on its own credentials in this same file, further
 * down: a *separate* "Desktop app" OAuth client, authorized once through
 * the redirect-based flow by `npm run gmail-login` (see gmail-login.ts),
 * which hands back a refresh token that lives in GMAIL_REFRESH_TOKEN.
 * Two clients, two connection stories, one file — because they're both
 * Google and the Gmail request/parse code was already written here. The
 * two never share a token: getAccessToken() below serves Calendar from
 * the device-flow row in SQLite, getGmailAccessToken() serves Gmail from
 * the env-var refresh token.
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
const CALENDAR_LIST_API = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const calendarEventsUrl = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
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
  /**
   * 'expired' means we *proved* the refresh token is dead (Google answered
   * invalid_grant) — as opposed to merely failing to reach Google, which
   * leaves a connected row alone. See classifyRefreshFailure.
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
  return getDb().prepare(`SELECT * FROM google_auth WHERE id = 1`).get() as AuthRow | undefined;
}

/**
 * A local read only — it reports what we *last knew*, and never contacts
 * Google. That is deliberate for the callers that use it as a cheap gate
 * (the scheduler, the system prompt rebuilt on every message), but it means
 * "true" is not a promise the token still works: a refresh token can die at
 * any moment without us hearing about it. connect() is the one function that
 * verifies against Google; a failed refresh anywhere flips this to false by
 * marking the row 'expired'.
 */
export function isConnected(): boolean {
  return getAuthRow()?.status === "connected";
}

/**
 * Whether Gmail can actually be used right now. Deliberately independent of
 * isConnected() above: Gmail rides its own OAuth client and its own refresh
 * token, so a connected Calendar says nothing about Gmail and vice versa.
 * "Usable" here means configured — there's no runtime connect step to be
 * pending on, since the one-time login happens in `npm run gmail-login`.
 */
export function isGmailUsable(): boolean {
  return Boolean(config.gmailClientId && config.gmailClientSecret && config.gmailRefreshToken);
}

function requireGmailUsable(): void {
  if (isGmailUsable()) return;
  throw new ToolError(
    "Gmail isn't set up yet — it needs its own OAuth client, separate from the calendar one. " +
      "Run `npm run gmail-login` once and set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN.",
  );
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

// The classifier and the refresh POST are shared with hotmail.ts — see
// oauthrefresh.ts for why they live in one place. Re-exported so anything that
// imported the classifier from here keeps working.
export { classifyRefreshFailure, type RefreshFailure } from "./oauthrefresh";

/** Google's refresh request: a confidential client, so it sends its secret. */
function postRefresh(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshOutcome> {
  return postRefreshRequest(
    TOKEN_URL,
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    }),
  );
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
 * idempotent by design: a pending code exists -> polls it once and reports
 * the outcome; nothing pending -> starts a fresh flow. This is the only tool
 * call in the whole loop, so it has to handle "did it work yet?" naturally on
 * a second call.
 *
 * "Already connected" is *verified*, not read off the table. This used to
 * return {already: true} the moment a row existed, which made it useless as
 * the recovery path its own error message advertises: a dead refresh token
 * left the row untouched, so "call connect_google to reconnect" got back
 * "already connected" forever. Now a connected row forces a real refresh
 * (bypassing the cached access token, which outlives the refresh token by up
 * to an hour) and acts on the answer:
 *   - works        -> connected, and this time the claim is true;
 *   - proven dead  -> falls through and starts a fresh connection in the same
 *                     call (the user just asked to connect — a second round
 *                     trip would only be friction), flagged replaced_expired;
 *   - can't tell   -> throws. Never claims connected on a guess, and never
 *                     discards a login because Google had a bad moment.
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
    ...(replacedExpired ? { replaced_expired: true as const } : {}),
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

const EXPIRED_MESSAGE = "Google connection expired — call connect_google to reconnect.";

/**
 * Marks the connection dead — but only if the row still holds the refresh
 * token we just watched fail. That guard matters: a slow background refresh
 * (the scheduler, the morning brief) can finish *after* the user re-authorised,
 * and without it that stale failure would mark their brand-new, healthy
 * connection expired. Tokens are cleared too; a dead refresh token has no
 * reason to stay on disk.
 */
function markExpired(deadRefreshToken: string): void {
  getDb()
    .prepare(
      `UPDATE google_auth
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
 * Attempts a real refresh against Google and records what it learned. The
 * single place Calendar's refresh token is exercised, so detection can't be
 * skipped by taking a different path: a dead token is marked expired here, a
 * live one has its fresh access token stored here, and anything ambiguous
 * changes nothing.
 */
async function tryRefresh(row: AuthRow & { refresh_token: string }): Promise<RefreshResult> {
  const { clientId, clientSecret } = requireCredentials();
  const outcome = await postRefresh({ clientId, clientSecret, refreshToken: row.refresh_token });

  if (outcome.ok) {
    // Same compare-and-set as markExpired: don't write an old connection's
    // access token onto a row that has since been re-authorised.
    getDb()
      .prepare(
        `UPDATE google_auth SET access_token = ?, token_expires_at = ?, updated_at = ?
         WHERE id = 1 AND refresh_token = ?`,
      )
      .run(
        outcome.accessToken,
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
        "Google rejected this app's OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — check " +
          "they're current. The saved login itself wasn't touched, and reconnecting won't help until this is fixed.",
      );
    default:
      return new ToolError(
        // Deliberately never uses the word "expired", even to deny it: a tool
        // result is read by a model, and a salient word survives its own
        // negation often enough to get relayed to the user as the diagnosis.
        `couldn't reach Google to refresh the calendar login (${result.detail}) — try again in a moment. ` +
          "The saved connection is fine and nothing was changed.",
      );
  }
}

async function getAccessToken(): Promise<string> {
  const row = getAuthRow();
  if (row?.status === "expired") throw new ToolError(EXPIRED_MESSAGE);
  if (!row || row.status !== "connected" || !row.access_token || !row.refresh_token) {
    throw new ToolError(
      `Google account isn't connected — call connect_google first, or ask the user to.`,
    );
  }
  if (row.token_expires_at && row.token_expires_at > nowUtcIso()) {
    return row.access_token;
  }

  const result = await tryRefresh({ ...row, refresh_token: row.refresh_token });
  if (result.kind === "ok") return result.token;
  throw refreshFailureError(result);
}

/**
 * Checks the connection against Google without throwing — for the scheduler's
 * daily health check, which has to tell "dead" from "couldn't tell" and must
 * never take the scheduler down. A dead token is marked expired as a side
 * effect, exactly as it would be by any other use.
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
    return "unverified"; // e.g. client credentials unset — not something that proves the token dead
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
    .prepare(`UPDATE google_auth SET expiry_notified_at = ? WHERE id = 1 AND status = 'expired'`)
    .run(nowUtcIso());
}

export interface CalendarEvent {
  summary: string;
  start: string; // ISO, whatever Google returns (dateTime or date-only for all-day)
  end: string;
  calendar: string; // which calendar this came from, e.g. "primary" or a calendar's own name
}

interface GoogleEventsResponse {
  items?: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
}

/**
 * A 401 from the Calendar API means Google rejected an access token we
 * believed was fresh — typically the grant was revoked a moment ago, while
 * the cached access token still had life in it. It says nothing about the
 * *refresh* token, so it is not proof of death and must not mark anything
 * expired. It points at connect_google instead, which force-refreshes: that
 * both repairs this case (a live refresh token yields a new access token) and
 * handles a dead one. Any other status keeps the plain message.
 */
function calendarHttpError(action: string, status: number): ToolError {
  if (status === 401) {
    return new ToolError(
      `couldn't ${action}: Google rejected the saved login (HTTP 401) — call connect_google, ` +
        "which re-checks the connection and reconnects if it has lapsed.",
    );
  }
  return new ToolError(`couldn't ${action} (HTTP ${status})`);
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  selected?: boolean;
  accessRole?: string;
  primary?: boolean;
}

/**
 * Every calendar the account can see events on — not just the account's
 * own default calendar. `calendars/primary/events` (the single endpoint
 * this used to call) only covers that one default calendar; it misses any
 * calendar the user created themselves or was given access to, which
 * Google's own apps merge in visually. Filtered to entries the user
 * hasn't explicitly hidden (`selected !== false`, matching what they'd
 * see in their own Calendar UI) and that can actually return event
 * details (`accessRole !== "freeBusyReader"`, which only ever returns
 * busy/free blocks and would just 403 on an events fetch). The account's
 * own calendar is one of these entries already (flagged `primary: true`),
 * so it needs no special-casing.
 */
async function listCalendars(token: string): Promise<CalendarListEntry[]> {
  const response = await fetch(CALENDAR_LIST_API, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw calendarHttpError("list calendars", response.status);
  const data = (await response.json()) as { items?: CalendarListEntry[] };
  return (data.items ?? []).filter((cal) => cal.selected !== false && cal.accessRole !== "freeBusyReader");
}

async function listEventsForCalendar(
  token: string,
  cal: CalendarListEntry,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const url = new URL(calendarEventsUrl(cal.id));
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as GoogleEventsResponse;
  const calendarName = cal.summary ?? cal.id;

  return (data.items ?? []).map((item) => ({
    summary: item.summary ?? "(no title)",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
    calendar: calendarName,
  }));
}

export async function listEvents(withinDays: number): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  const now = new Date();
  const until = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const timeMin = now.toISOString();
  const timeMax = until.toISOString();

  const calendars = await listCalendars(token);
  // One calendar failing to fetch doesn't sink the rest — same "contained
  // per-source failure" pattern as check_all_inboxes in tools.ts.
  const perCalendar = await Promise.all(
    calendars.map((cal) =>
      listEventsForCalendar(token, cal, timeMin, timeMax).catch(() => [] as CalendarEvent[]),
    ),
  );

  return perCalendar
    .flat()
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 20);
}

export async function createEvent(
  summary: string,
  startIso: string,
  endIso: string,
): Promise<CalendarEvent> {
  const token = await getAccessToken();
  const response = await fetch(calendarEventsUrl("primary"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw calendarHttpError("create the event", response.status);
  const item = (await response.json()) as {
    summary?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  };
  return {
    summary: item.summary ?? summary,
    start: item.start?.dateTime ?? startIso,
    end: item.end?.dateTime ?? endIso,
    calendar: "primary",
  };
}

// --- Gmail (read + draft only — see the top-of-file note on why there is
// deliberately no send function here) ---------------------------------

/**
 * Gmail's access token, cached in memory until it expires. Nothing is
 * persisted: the long-lived credential is GMAIL_REFRESH_TOKEN in the
 * environment, and an access token is cheap to re-mint from it, so a
 * process restart just re-mints rather than needing a DB row. Same
 * module-level cache shape as tuya.ts's token.
 *
 * Note this never touches google_auth — that table is Calendar's
 * device-flow connection, on a different OAuth client entirely.
 */
let gmailToken: { value: string; expiresAt: number } | null = null;

/** Exported only so tests can reset the module-level cache between cases. */
export function _resetGmailTokenCacheForTests(): void {
  gmailToken = null;
}

async function getGmailAccessToken(): Promise<string> {
  requireGmailUsable();
  // 60s of slack so a token that's about to lapse mid-request gets renewed
  // now rather than 401-ing halfway through a multi-message list call.
  if (gmailToken && gmailToken.expiresAt > Date.now() + 60_000) return gmailToken.value;

  const outcome = await postRefresh({
    clientId: config.gmailClientId,
    clientSecret: config.gmailClientSecret,
    refreshToken: config.gmailRefreshToken,
  });
  if (!outcome.ok) {
    // Unlike Calendar there is no row to mark: the token lives in an env var,
    // so the classification only chooses which message to give. That still
    // matters — a transient Google error used to tell the user to re-run
    // `npm run gmail-login` for a login that was perfectly fine.
    if (outcome.kind === "dead") {
      throw new ToolError(
        "Gmail's saved login is no longer valid — re-run `npm run gmail-login` and update " +
          "GMAIL_REFRESH_TOKEN. (Google expires these after 7 days while the OAuth consent " +
          'screen is still in "Testing" — publishing the app stops that.)',
      );
    }
    if (outcome.kind === "client_rejected") {
      throw new ToolError(
        "Google rejected the Gmail OAuth client credentials (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) — " +
          "check they match the Desktop-app client. The saved login itself wasn't the problem.",
      );
    }
    throw new ToolError(
      `couldn't reach Google to refresh the Gmail login (${outcome.detail}) — try again in a moment. ` +
        "The saved login is fine and nothing was changed.",
    );
  }
  gmailToken = {
    value: outcome.accessToken,
    expiresAt: Date.now() + outcome.expiresIn * 1000,
  };
  return outcome.accessToken;
}

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
  const token = await getGmailAccessToken();
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
  const token = await getGmailAccessToken();
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
  const token = await getGmailAccessToken();
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
