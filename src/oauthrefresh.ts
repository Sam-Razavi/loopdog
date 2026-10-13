/**
 * The one place an OAuth refresh-token request is made and its failure read,
 * shared by Google (google.ts) and Microsoft (hotmail.ts).
 *
 * It exists because those two modules were copies of each other, and the copies
 * shared a bug: both answered every failed refresh with a blanket "expired" and
 * never changed any state, so "reconnect" got "already connected" forever.
 * Fixing one and leaving a duplicate to rot is how that happened; one
 * implementation can't drift.
 *
 * What it knows about each provider, and how it knows it:
 *  - Both signal a dead refresh token as HTTP 400 `invalid_grant` — RFC 6749
 *    §5.2, and Microsoft's AADSTS70008 / 700082 (inactivity) and 50173
 *    (revoked) all arrive under that code. Confirmed for both.
 *  - Microsoft *rotates*: a successful refresh may return a new refresh_token
 *    (and doesn't revoke the old one). Google never sends one. The outcome
 *    carries it when present and callers keep the old one when absent.
 *  - NOT encoded, deliberately: Microsoft's `interaction_required`. Whether it
 *    should count as dead couldn't be confirmed for personal accounts, so it
 *    falls to "transient" — the conservative default — and the provider's own
 *    error_description is surfaced so a real cause stays visible.
 */

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * What a failed refresh *means*, which is the whole difference between a
 * helpful reconnect prompt and destroying a perfectly good login.
 *
 *  - "dead": the provider answered invalid_grant — the refresh token is
 *    expired or revoked. The only proof of death there is.
 *  - "client_rejected": invalid_client / unauthorized_client — *our*
 *    credentials were refused (a rotated secret, a deleted OAuth client). The
 *    saved token may be perfectly fine, and reconnecting can't help until the
 *    env vars are fixed, so it must not be wiped.
 *  - "transient": everything else — no response, 5xx, 429, a body that isn't
 *    JSON, an error code we don't recognise. Unknown deliberately lands here:
 *    wrongly keeping a token a little longer is recoverable, wrongly
 *    discarding a live one forces a re-login nobody needed.
 *
 * Pure, so the table of cases is testable without a network.
 */
export type RefreshFailure = "dead" | "client_rejected" | "transient";

export function classifyRefreshFailure(
  httpStatus: number | null,
  body: { error?: unknown } | null,
): RefreshFailure {
  if (httpStatus === null) return "transient"; // never got an answer at all
  const error = typeof body?.error === "string" ? body.error : undefined;
  if (httpStatus === 400 || httpStatus === 401) {
    if (error === "invalid_grant") return "dead";
    if (error === "invalid_client" || error === "unauthorized_client") return "client_rejected";
  }
  return "transient";
}

export type RefreshOutcome =
  | {
      ok: true;
      accessToken: string;
      expiresIn: number;
      /** Only Microsoft sends one. Absent means "keep the one you have". */
      refreshToken?: string;
    }
  | { ok: false; kind: RefreshFailure; detail: string };

/**
 * POSTs a refresh_token grant and reads the answer. Never throws for an
 * expected outcome: a rejected fetch and an unparseable body both come back as
 * "transient" rather than escaping as a raw TypeError / SyntaxError.
 */
export async function postRefresh(tokenUrl: string, form: URLSearchParams): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, kind: "transient", detail: error instanceof Error ? error.message : String(error) };
  }

  const body = (await response.json().catch(() => null)) as TokenResponse | null;
  if (response.ok && body?.access_token) {
    return {
      ok: true,
      accessToken: body.access_token,
      expiresIn: body.expires_in ?? 3600,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    };
  }
  return {
    ok: false,
    kind: classifyRefreshFailure(response.status, body),
    detail: body?.error_description ?? body?.error ?? `HTTP ${response.status}`,
  };
}
