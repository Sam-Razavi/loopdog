import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { json, restoreFetch, stubFetch, type Call } from "./testutil/fetchstub";

/**
 * Hotmail connection health — the port of googleauth.test.ts, plus what is
 * specific to Microsoft: refresh tokens ROTATE, the client is public (no
 * secret), and the refresh restates its scope. DB-backed with fetch stubbed to
 * Microsoft's documented responses; nothing here talks to Microsoft.
 *
 * Same env-before-import loader as the other DB-backed suites (config freezes
 * env at import; tsx compiles to CJS, so no top-level await).
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");
process.env.HOTMAIL_CLIENT_ID = "ms-client-id";
// Gmail configured too, so "more than one usable email account" is reachable —
// that's the only way to test that a lapsed Hotmail is left out of the list.
process.env.GMAIL_CLIENT_ID = "gmail-client-id";
process.env.GMAIL_CLIENT_SECRET = "gmail-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "gmail-refresh";

type HotmailModule = typeof import("./hotmail");
type DbModule = typeof import("./db");

let loaded: Promise<{ hotmail: HotmailModule; db: DbModule }> | null = null;
function modules(): Promise<{ hotmail: HotmailModule; db: DbModule }> {
  loaded ??= (async () => {
    const db = await import("./db");
    db.migrate();
    return { hotmail: await import("./hotmail"), db };
  })();
  return loaded;
}

afterEach(restoreFetch);

const TOKEN = "login.microsoftonline.com/consumers/oauth2/v2.0/token";
const DEVICE = "login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";

const INVALID_GRANT = {
  error: "invalid_grant",
  error_description: "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.",
  error_codes: [70008],
};
const DEVICE_CODE = {
  device_code: "dev-123",
  user_code: "WXYZ-1234",
  verification_uri: "https://microsoft.com/devicelogin",
  expires_in: 900,
  interval: 5,
};

interface Row {
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  expiry_notified_at: string | null;
}

async function readRow(): Promise<Row | undefined> {
  const { db } = await modules();
  return db.getDb().prepare(`SELECT * FROM hotmail_auth WHERE id = 1`).get() as Row | undefined;
}

async function seedConnected(opts: { refresh?: string; accessLapsed?: boolean } = {}): Promise<void> {
  const { db } = await modules();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (opts.accessLapsed === false ? 3_600_000 : -3_600_000)).toISOString();
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO hotmail_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at,
        access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'connected', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run("old-access", opts.refresh ?? "old-refresh", expiresAt, now, now);
}

async function seedExpired(): Promise<void> {
  const { db } = await modules();
  const now = new Date().toISOString();
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO hotmail_auth (id, status, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'expired', NULL, NULL, NULL, ?, ?)`,
    )
    .run(now, now);
}

const tokenCalls = (calls: Call[]): Call[] => calls.filter((c) => c.url.includes(TOKEN));
const list = (): Promise<unknown> => modules().then(({ hotmail }) => hotmail.listEmails(undefined, 5));

// --- the reported bug, in its Hotmail form -----------------------------------

test("REPORTED BUG (Hotmail): a dead refresh token must not leave connect_hotmail answering 'already connected'", async () => {
  const { hotmail } = await modules();
  await seedConnected({ accessLapsed: true });
  stubFetch((call) => {
    if (call.url.includes(TOKEN)) return json(400, INVALID_GRANT);
    if (call.url.includes(DEVICE)) return json(200, DEVICE_CODE);
    return json(500, {});
  });

  await assert.rejects(list, /expired/i);

  const result = await hotmail.connect();
  assert.equal(result.status, "pending", "the recovery the error advertises must actually work");
  assert.equal(result.status === "pending" && result.user_code, "WXYZ-1234");
});

// --- detection ---------------------------------------------------------------

test("invalid_grant marks the connection expired and clears the dead tokens", async () => {
  const { hotmail } = await modules();
  await seedConnected({ accessLapsed: true });
  stubFetch(() => json(400, INVALID_GRANT));

  await assert.rejects(list, /expired/i);

  const row = await readRow();
  assert.equal(row?.status, "expired");
  assert.equal(row?.refresh_token, null);
  assert.equal(row?.access_token, null);
  assert.equal(hotmail.isConnected(), false);
  assert.equal(hotmail.getStatus(), "expired");
});

test("an already-expired row fails fast with no network call", async () => {
  await seedExpired();
  const calls = stubFetch(() => json(200, {}));
  await assert.rejects(list, /expired/i);
  assert.equal(calls.length, 0);
});

// --- the guard: never wipe a good token because Microsoft had a bad moment ----

for (const [name, respond] of [
  ["a 503", () => json(503, { error: "temporarily_unavailable" })],
  ["a 429 throttle", () => json(429, { error: "throttled" })],
  ["a gateway page that isn't JSON", () => new Response("<html>Bad Gateway</html>", { status: 502 })],
  [
    "a network failure",
    () => {
      throw new TypeError("fetch failed");
    },
  ],
  // Unconfirmed for personal accounts, so it must stay on the safe side.
  ["interaction_required (unconfirmed meaning)", () => json(400, { error: "interaction_required" })],
] as [string, () => Response][]) {
  test(`${name} leaves a good connection untouched and doesn't call it expired`, async () => {
    await seedConnected({ accessLapsed: true, refresh: "precious-refresh" });
    stubFetch(respond);

    await assert.rejects(list, (error: Error) => {
      assert.match(error.message, /couldn't reach Microsoft/i);
      assert.doesNotMatch(error.message, /expire/i, "the word itself gets relayed as the diagnosis");
      return true;
    });

    const row = await readRow();
    assert.equal(row?.status, "connected");
    assert.equal(row?.refresh_token, "precious-refresh");
  });
}

test("invalid_client names the client id and leaves the saved login alone", async () => {
  await seedConnected({ accessLapsed: true, refresh: "still-good" });
  stubFetch(() => json(401, { error: "invalid_client" }));
  await assert.rejects(list, /HOTMAIL_CLIENT_ID/);
  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "still-good");
});

// --- Microsoft-specific: rotation, public client, scope -----------------------

test("a rotated refresh token is stored", async () => {
  await seedConnected({ accessLapsed: true, refresh: "old-refresh" });
  stubFetch((call) =>
    call.url.includes(TOKEN)
      ? json(200, { access_token: "new-access", expires_in: 3600, refresh_token: "rotated-refresh" })
      : json(200, { value: [] }),
  );

  await list();

  const row = await readRow();
  assert.equal(row?.refresh_token, "rotated-refresh", "Microsoft hands back a new one; keeping the old risks losing the chain");
  assert.equal(row?.access_token, "new-access");
});

test("no new refresh token in the response keeps the existing one", async () => {
  await seedConnected({ accessLapsed: true, refresh: "keep-this" });
  stubFetch((call) =>
    call.url.includes(TOKEN) ? json(200, { access_token: "new-access", expires_in: 3600 }) : json(200, { value: [] }),
  );
  await list();
  assert.equal((await readRow())?.refresh_token, "keep-this", "COALESCE must not null it out");
});

test("the refresh is a public-client request: no client_secret, scope restated", async () => {
  await seedConnected({ accessLapsed: true, refresh: "r1" });
  const calls = stubFetch((call) =>
    call.url.includes(TOKEN) ? json(200, { access_token: "a", expires_in: 3600 }) : json(200, { value: [] }),
  );
  await list();

  const body = tokenCalls(calls)[0]!.body!;
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("client_id"), "ms-client-id");
  assert.equal(body.get("refresh_token"), "r1");
  assert.equal(body.has("client_secret"), false, "a public client never sends a secret");
  assert.match(body.get("scope") ?? "", /Mail\.ReadWrite/);
});

test("rotation race: a stale refresh finishing late can't overwrite a newer token", async () => {
  await seedConnected({ accessLapsed: true, refresh: "old-refresh" });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  stubFetch(async (call) => {
    if (call.url.includes(TOKEN)) {
      await gate;
      return json(200, { access_token: "stale-access", expires_in: 3600, refresh_token: "stale-rotated" });
    }
    return json(200, { value: [] });
  });

  const inFlight = list();
  // Meanwhile another refresh won and stored the newer token.
  await seedConnected({ accessLapsed: false, refresh: "newer-refresh" });
  release();
  await inFlight.catch(() => undefined);

  const row = await readRow();
  assert.equal(row?.refresh_token, "newer-refresh", "the loser of the race must be a no-op, not an overwrite");
});

test("a stale refresh failing late can't expire a connection that was re-authorised meanwhile", async () => {
  await seedConnected({ accessLapsed: true, refresh: "old-refresh" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  stubFetch(async (call) => {
    if (call.url.includes(TOKEN)) {
      await gate;
      return json(400, INVALID_GRANT);
    }
    return json(500, {});
  });

  const settled = list().catch(() => undefined);
  await seedConnected({ accessLapsed: false, refresh: "brand-new-refresh" });
  release();
  await settled;

  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "brand-new-refresh");
});

// --- connect(): "connected" must be a checked fact ------------------------------

test("connect() on a live token verifies with Microsoft and stores what it returned", async () => {
  const { hotmail } = await modules();
  await seedConnected({ accessLapsed: false }); // cache looks fine; only Microsoft can say
  const calls = stubFetch((call) =>
    call.url.includes(TOKEN)
      ? json(200, { access_token: "fresh", expires_in: 3600, refresh_token: "rotated" })
      : json(500, {}),
  );

  assert.deepEqual(await hotmail.connect(), { status: "connected", already: true });
  assert.equal(tokenCalls(calls).length, 1, "it must actually ask, cached token or not");
  const row = await readRow();
  assert.equal(row?.access_token, "fresh");
  assert.equal(row?.refresh_token, "rotated");
});

test("connect() on a dead token starts a fresh connection in the same call and says it replaced one", async () => {
  const { hotmail } = await modules();
  await seedConnected({ accessLapsed: false });
  stubFetch((call) => (call.url.includes(TOKEN) ? json(400, INVALID_GRANT) : json(200, DEVICE_CODE)));

  const result = await hotmail.connect();
  assert.equal(result.status, "pending");
  assert.ok(result.status === "pending" && result.replaced_expired === true);
  assert.equal((await readRow())?.status, "pending");
});

test("connect() when Microsoft can't be reached refuses to claim connected and destroys nothing", async () => {
  const { hotmail } = await modules();
  await seedConnected({ accessLapsed: false, refresh: "keep-me" });
  stubFetch(() => json(503, {}));

  await assert.rejects(() => hotmail.connect(), /couldn't reach Microsoft/i);
  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "keep-me");
});

test("connect() on an already-expired row starts a fresh connection; with nothing stored it's a plain one", async () => {
  const { hotmail, db } = await modules();
  await seedExpired();
  stubFetch((call) => (call.url.includes(DEVICE) ? json(200, DEVICE_CODE) : json(500, {})));
  const replaced = await hotmail.connect();
  assert.ok(replaced.status === "pending" && replaced.replaced_expired === true);

  db.getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
  const fresh = await hotmail.connect();
  assert.ok(fresh.status === "pending" && fresh.replaced_expired === undefined, "nothing was replaced");
});

// --- reads stay cheap; a 401 points somewhere useful -----------------------------

test("a still-fresh cached access token makes no call to the token endpoint", async () => {
  await seedConnected({ accessLapsed: false });
  const calls = stubFetch(() => json(200, { value: [] }));
  await list();
  assert.equal(tokenCalls(calls).length, 0);
});

test("a Graph 401 points at connect_hotmail and does NOT mark the connection expired", async () => {
  await seedConnected({ accessLapsed: false, refresh: "maybe-fine" });
  stubFetch(() => json(401, { error: { code: "InvalidAuthenticationToken" } }));

  await assert.rejects(list, /call connect_hotmail/);
  const row = await readRow();
  assert.equal(row?.status, "connected", "a 401 indicts the access token, not the refresh token");
  assert.equal(row?.refresh_token, "maybe-fine");
});

test("a non-401 Graph failure keeps its plain message", async () => {
  await seedConnected({ accessLapsed: false });
  stubFetch(() => json(500, {}));
  await assert.rejects(list, /couldn't list emails \(HTTP 500\)/);
});

// --- verifyConnection: what the daily health check relies on ------------------------

test("verifyConnection reports ok / expired / unverified / not_connected, and never throws", async () => {
  const { hotmail, db } = await modules();

  db.getDb().prepare(`DELETE FROM hotmail_auth WHERE id = 1`).run();
  assert.equal(await hotmail.verifyConnection(), "not_connected");

  await seedConnected({ accessLapsed: false });
  stubFetch((call) => (call.url.includes(TOKEN) ? json(200, { access_token: "a", expires_in: 3600 }) : json(500, {})));
  assert.equal(await hotmail.verifyConnection(), "ok");

  stubFetch(() => json(503, {}));
  assert.equal(await hotmail.verifyConnection(), "unverified");
  assert.equal((await readRow())?.status, "connected", "unverified must not touch the row");

  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(await hotmail.verifyConnection(), "unverified", "a network failure is not an exception");

  stubFetch(() => json(400, INVALID_GRANT));
  assert.equal(await hotmail.verifyConnection(), "expired");
  assert.equal((await readRow())?.status, "expired");
  assert.equal(await hotmail.verifyConnection(), "expired", "and it stays reported as expired");
});

// --- the system prompt ----------------------------------------------------------------

async function liveStateText(): Promise<string> {
  const { buildSystemPrompt } = await import("./prompt");
  return buildSystemPrompt()[1]!.text; // block 0 is the cached static prefix
}

test("prompt: an expired Hotmail is surfaced with the way out, and not also claimed as live", async () => {
  await seedExpired();
  const text = await liveStateText();
  assert.match(text, /Hotmail\/Outlook connection has expired/);
  assert.match(text, /connect_hotmail/);
  assert.doesNotMatch(text, /Hotmail\/Outlook is connected/);
});

test("prompt: a lapsed Hotmail is not counted as a usable email account", async () => {
  // With Gmail configured, a *connected* Hotmail makes two usable accounts and
  // the model is told to disambiguate. A lapsed one must drop out of that list
  // — otherwise the model is told to ask "Gmail or Hotmail?" about an inbox
  // that can't be read.
  await seedConnected({ accessLapsed: false });
  assert.match(await liveStateText(), /More than one email account is usable right now \(Gmail, Hotmail\)/);

  await seedExpired();
  assert.doesNotMatch(await liveStateText(), /More than one email account is usable/);
});

test("prompt: a connected Hotmail says what to do if an expiry is reported", async () => {
  await seedConnected({ accessLapsed: false });
  const text = await liveStateText();
  assert.match(text, /Hotmail\/Outlook is connected/);
  assert.match(text, /call connect_hotmail/);
});
