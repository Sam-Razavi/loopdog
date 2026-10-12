import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";

/**
 * Google OAuth connection health. DB-backed, with global fetch stubbed to
 * return Google's documented token-endpoint responses — there is no real
 * Google reachable from here and no genuinely revoked token to test with, so
 * these prove the state machine against the *documented error shapes*, not
 * against Google itself.
 *
 * config.ts reads env at import time and tsx compiles to CJS (imports hoist,
 * no top-level await), so env is set first and the modules load through a
 * memoised dynamic import — same shape as reminders.test.ts.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GMAIL_CLIENT_ID = "gmail-client-id";
process.env.GMAIL_CLIENT_SECRET = "gmail-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "gmail-refresh";

type GoogleModule = typeof import("./google");
type DbModule = typeof import("./db");

let loaded: Promise<{ google: GoogleModule; db: DbModule }> | null = null;

function modules(): Promise<{ google: GoogleModule; db: DbModule }> {
  loaded ??= (async () => {
    const db = await import("./db");
    db.migrate();
    return { google: await import("./google"), db };
  })();
  return loaded;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  body: URLSearchParams | null;
}

/** Replaces fetch with a responder; returns the list of calls it saw. */
function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: init?.body instanceof URLSearchParams ? init.body : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TOKEN = "oauth2.googleapis.com/token";
const DEVICE = "oauth2.googleapis.com/device/code";

const INVALID_GRANT = { error: "invalid_grant", error_description: "Token has been expired or revoked." };
const DEVICE_CODE = {
  device_code: "dev-123",
  user_code: "ABCD-EFGH",
  verification_url: "https://www.google.com/device",
  expires_in: 1800,
  interval: 5,
};

async function seedConnected(opts: { refresh?: string; accessLapsed?: boolean } = {}): Promise<void> {
  const { db } = await modules();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (opts.accessLapsed === false ? 3_600_000 : -3_600_000)).toISOString();
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO google_auth
       (id, status, device_code, user_code, verification_url, poll_interval, expires_at,
        access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'connected', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run("old-access", opts.refresh ?? "old-refresh", expiresAt, now, now);
}

test("REPORTED BUG: a dead refresh token must not leave connect_google answering 'already connected'", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: true });

  stubFetch((call) => {
    if (call.url.includes(TOKEN)) return json(400, INVALID_GRANT);
    if (call.url.includes(DEVICE)) return json(200, DEVICE_CODE);
    return json(500, {});
  });

  // The write the user saw fail.
  await assert.rejects(
    () => google.createEvent("Dentist", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"),
    /expired/i,
  );

  // The error tells the model to call connect_google. It used to answer
  // {status:"connected", already:true} here — a dead end, since nothing had
  // ever cleared the dead row. It must now hand back a way forward.
  const result = await google.connect();
  assert.notEqual(
    result.status === "connected" ? "already connected" : result.status,
    "already connected",
    "connect_google must not claim a connection that just failed to refresh",
  );
  assert.equal(result.status, "pending");
  assert.equal(result.status === "pending" && result.user_code, "ABCD-EFGH");
});


// --- helpers for the rest ------------------------------------------------

interface Row {
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

async function readRow(): Promise<Row | undefined> {
  const { db } = await modules();
  return db.getDb().prepare(`SELECT * FROM google_auth WHERE id = 1`).get() as Row | undefined;
}

async function seedExpired(): Promise<void> {
  const { db } = await modules();
  const now = new Date().toISOString();
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO google_auth
       (id, status, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, 'expired', NULL, NULL, NULL, ?, ?)`,
    )
    .run(now, now);
}

const tokenCalls = (calls: Call[]): Call[] => calls.filter((c) => c.url.includes(TOKEN));

const EVENT_OK = { summary: "Dentist", start: { dateTime: "2030-01-01T09:00:00Z" }, end: { dateTime: "2030-01-01T10:00:00Z" } };

// --- the classifier: the table that decides dead vs. just unlucky ----------

test("classifyRefreshFailure: only invalid_grant is proof of death", async () => {
  const { google } = await modules();
  const c = google.classifyRefreshFailure;

  assert.equal(c(400, { error: "invalid_grant" }), "dead");
  assert.equal(c(401, { error: "invalid_grant" }), "dead");

  // Our credentials were refused — the token may be fine, so it must not be wiped.
  assert.equal(c(401, { error: "invalid_client" }), "client_rejected");
  assert.equal(c(400, { error: "unauthorized_client" }), "client_rejected");

  // Everything else is "we don't know," and unknown must never destroy a login.
  assert.equal(c(null, null), "transient", "no response at all");
  assert.equal(c(503, null), "transient");
  assert.equal(c(429, { error: "rate_limit_exceeded" }), "transient");
  assert.equal(c(500, { error: "invalid_grant" }), "transient", "invalid_grant on a 500 isn't Google's real answer");
  assert.equal(c(400, { error: "something_new" }), "transient", "an unrecognised code stays conservative");
  assert.equal(c(400, null), "transient", "an unparseable body");
  assert.equal(c(200, {}), "transient");
});

// --- detection: a dead token is found and recorded -------------------------

test("invalid_grant marks the connection expired and clears the dead tokens", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: true });
  stubFetch(() => json(400, INVALID_GRANT));

  await assert.rejects(() => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"), /expired/i);

  const row = await readRow();
  assert.equal(row?.status, "expired");
  assert.equal(row?.refresh_token, null, "a dead refresh token has no reason to stay on disk");
  assert.equal(row?.access_token, null);
  assert.equal(google.isConnected(), false, "every gate keyed on isConnected() now stops trusting it");
  assert.equal(google.getStatus(), "expired");
});

test("an already-expired row fails fast with no network call", async () => {
  const { google } = await modules();
  await seedExpired();
  const calls = stubFetch(() => json(200, {}));

  await assert.rejects(() => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"), /expired/i);
  assert.equal(calls.length, 0, "nothing to refresh, so nothing to ask Google");
});

// --- the guard: never wipe a good token because Google had a bad moment -----

for (const [name, respond] of [
  ["a 503 from Google", () => json(503, { error: "backend_error" })],
  ["a 429 rate limit", () => json(429, { error: "rate_limit_exceeded" })],
  ["a gateway page that isn't JSON", () => new Response("<html>Bad Gateway</html>", { status: 502 })],
  [
    "a network failure",
    () => {
      throw new TypeError("fetch failed");
    },
  ],
  ["an error code nobody recognises", () => json(400, { error: "something_new" })],
] as [string, () => Response][]) {
  test(`${name} leaves a good connection untouched and doesn't call it expired`, async () => {
    const { google } = await modules();
    await seedConnected({ accessLapsed: true, refresh: "precious-refresh" });
    stubFetch(respond);

    await assert.rejects(
      () => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"),
      (error: Error) => {
        assert.match(error.message, /couldn't reach Google/i);
        assert.doesNotMatch(error.message, /expired/i, "telling someone to re-auth over a blip is the bug");
        return true;
      },
    );

    const row = await readRow();
    assert.equal(row?.status, "connected");
    assert.equal(row?.refresh_token, "precious-refresh", "the live token must survive");
  });
}

test("invalid_client names the credentials and leaves the saved login alone", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: true, refresh: "still-good" });
  stubFetch(() => json(401, { error: "invalid_client" }));

  await assert.rejects(
    () => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"),
    /GOOGLE_CLIENT_ID/,
  );
  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "still-good");
});

// --- connect(): "connected" must be a checked fact --------------------------

test("connect() on a live token verifies with Google and stores the fresh access token", async () => {
  const { google } = await modules();
  // Access token NOT lapsed: the old code (and a naive check) would trust the cache and never ask.
  await seedConnected({ accessLapsed: false });
  const calls = stubFetch((call) =>
    call.url.includes(TOKEN) ? json(200, { access_token: "fresh-access", expires_in: 3600 }) : json(500, {}),
  );

  const result = await google.connect();

  assert.deepEqual(result, { status: "connected", already: true });
  assert.equal(tokenCalls(calls).length, 1, "it must actually ask Google, cached token or not");
  assert.equal(tokenCalls(calls)[0]!.body?.get("grant_type"), "refresh_token");
  assert.equal((await readRow())?.access_token, "fresh-access");
});

test("connect() on a dead token starts a fresh connection in the same call and says it replaced one", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: false }); // cache looks fine; only Google knows it's dead
  stubFetch((call) => (call.url.includes(TOKEN) ? json(400, INVALID_GRANT) : json(200, DEVICE_CODE)));

  const result = await google.connect();

  assert.equal(result.status, "pending");
  assert.ok(result.status === "pending" && result.replaced_expired === true, "the model needs to say it had lapsed");
  assert.equal(result.status === "pending" && result.user_code, "ABCD-EFGH");
  const row = await readRow();
  assert.equal(row?.status, "pending", "the dead row is replaced by the new pending connection");
});

test("connect() when Google can't be reached refuses to claim connected and destroys nothing", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: false, refresh: "keep-me" });
  stubFetch(() => json(503, {}));

  await assert.rejects(() => google.connect(), /couldn't reach Google/i);
  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "keep-me");
});

test("connect() on an already-expired row starts a fresh connection", async () => {
  const { google } = await modules();
  await seedExpired();
  stubFetch((call) => (call.url.includes(DEVICE) ? json(200, DEVICE_CODE) : json(500, {})));

  const result = await google.connect();
  assert.equal(result.status, "pending");
  assert.ok(result.status === "pending" && result.replaced_expired === true);
});

test("a connect() with nothing stored is a plain new connection, not a 'replacement'", async () => {
  const { google, db } = await modules();
  db.getDb().prepare(`DELETE FROM google_auth WHERE id = 1`).run();
  stubFetch((call) => (call.url.includes(DEVICE) ? json(200, DEVICE_CODE) : json(500, {})));

  const result = await google.connect();
  assert.equal(result.status, "pending");
  assert.ok(result.status === "pending" && result.replaced_expired === undefined);
});

// --- the race: a slow failure must not kill a freshly re-authorised login ---

test("a stale refresh failing late can't expire a connection that was re-authorised meanwhile", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: true, refresh: "old-refresh" });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  stubFetch(async (call) => {
    if (call.url.includes(TOKEN)) {
      await gate; // the background refresh is in flight...
      return json(400, INVALID_GRANT); // ...and will come back "dead"
    }
    return json(500, {});
  });

  const inFlight = google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z");
  const settled = inFlight.catch(() => undefined);

  // Meanwhile the user finishes re-authorising: the row now holds a new token.
  await seedConnected({ accessLapsed: false, refresh: "brand-new-refresh" });
  release();
  await settled;

  const row = await readRow();
  assert.equal(row?.status, "connected", "the old token's failure must not take down the new login");
  assert.equal(row?.refresh_token, "brand-new-refresh");
});

// --- reads stay cheap; a 401 points somewhere useful ------------------------

test("a still-fresh cached access token makes no call to the token endpoint", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: false });
  const calls = stubFetch((call) => (call.url.includes("/events") ? json(200, EVENT_OK) : json(500, {})));

  await google.createEvent("Dentist", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z");
  assert.equal(tokenCalls(calls).length, 0, "ordinary use must not pay a refresh round trip each time");
});

test("a Calendar 401 points at connect_google and does NOT mark the connection expired", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: false, refresh: "maybe-fine" });
  stubFetch(() => json(401, { error: { code: 401 } }));

  await assert.rejects(
    () => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"),
    /call connect_google/,
  );
  // A 401 says the *access* token was rejected — nothing about the refresh
  // token — so it's not grounds to discard a login that may be perfectly fine.
  const row = await readRow();
  assert.equal(row?.status, "connected");
  assert.equal(row?.refresh_token, "maybe-fine");
});

test("a non-401 Calendar failure keeps its plain message", async () => {
  const { google } = await modules();
  await seedConnected({ accessLapsed: false });
  stubFetch(() => json(500, {}));
  await assert.rejects(
    () => google.createEvent("x", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"),
    /couldn't create the event \(HTTP 500\)/,
  );
});

// --- Gmail shares the classifier: a blip must not send you to re-run the login ---

test("Gmail: a transient Google error doesn't tell you to re-run gmail-login", async () => {
  const { google } = await modules();
  google._resetGmailTokenCacheForTests();
  stubFetch(() => json(503, {}));

  await assert.rejects(
    () => google.listEmails(undefined, 5),
    (error: Error) => {
      assert.match(error.message, /couldn't reach Google/i);
      assert.doesNotMatch(error.message, /gmail-login/, "the saved login is fine — don't send them off to redo it");
      assert.doesNotMatch(error.message, /expire/i, "the word itself gets relayed as the diagnosis");
      return true;
    },
  );
});

test("Gmail: invalid_grant does tell you to re-run gmail-login", async () => {
  const { google } = await modules();
  google._resetGmailTokenCacheForTests();
  stubFetch(() => json(400, INVALID_GRANT));
  await assert.rejects(() => google.listEmails(undefined, 5), /gmail-login/);
});

// --- the system prompt: what the model is told about the connection ----------

async function liveStateText(): Promise<string> {
  const { buildSystemPrompt } = await import("./prompt");
  const blocks = buildSystemPrompt();
  return blocks[1]!.text; // block 0 is the cached static prefix; block 1 is the live state
}

test("prompt: a connected Google no longer tells the model not to verify", async () => {
  await seedConnected({ accessLapsed: false });
  const text = await liveStateText();
  assert.match(text, /Google Calendar is connected/);
  assert.doesNotMatch(text, /no need to check first/i, "that line told the model to skip the only check there is");
  assert.match(text, /connect_google/, "and it says what to do if an expiry is reported");
});

test("prompt: an expired Google is surfaced, with the way out", async () => {
  await seedExpired();
  const text = await liveStateText();
  assert.match(text, /connection has expired/);
  assert.match(text, /connect_google/);
  assert.doesNotMatch(text, /Google Calendar is connected/, "must not also claim it's live");
});

test("prompt: Gmail is described as its own login, not as part of the Calendar connection", async () => {
  await seedConnected({ accessLapsed: false });
  const text = await liveStateText();
  assert.match(text, /Gmail is set up/);
  assert.match(text, /separate login from Google Calendar/);
});

test("prompt: with Calendar connected but Gmail NOT configured, Gmail isn't claimed at all", () => {
  // config freezes env at import time, so "Gmail unset" needs a fresh process.
  // This is the exact stale claim being fixed: the old line said Gmail was
  // usable whenever Calendar was connected.
  const script = `
    const { migrate, getDb } = require("./src/db");
    migrate();
    const now = new Date().toISOString();
    getDb().prepare("INSERT OR REPLACE INTO google_auth (id,status,access_token,refresh_token,token_expires_at,created_at,updated_at) VALUES (1,'connected','a','r',?,?,?)")
      .run(new Date(Date.now() + 3600000).toISOString(), now, now);
    console.log(JSON.stringify(require("./src/prompt").buildSystemPrompt()[1].text));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    env: {
      ...process.env,
      LOOPDOG_DB: join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "fresh.sqlite"),
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GMAIL_CLIENT_ID: "",
      GMAIL_CLIENT_SECRET: "",
      GMAIL_REFRESH_TOKEN: "",
    },
    encoding: "utf-8",
  });
  const text = JSON.parse(out.trim().split("\n").pop()!) as string;
  assert.match(text, /Google Calendar is connected/);
  assert.doesNotMatch(text, /Gmail/, "Calendar being connected says nothing about Gmail");
});
