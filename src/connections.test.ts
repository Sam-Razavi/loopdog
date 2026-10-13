import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { json, restoreFetch, stubFetch, type Call } from "./testutil/fetchstub";

/**
 * The scheduler-facing half of the stale-connection work: finding dead
 * connections without waiting for someone to trip over one, and announcing
 * each lapse exactly once. DB-backed, fetch stubbed to documented responses.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");
process.env.GOOGLE_CLIENT_ID = "g-id";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";
process.env.HOTMAIL_CLIENT_ID = "ms-id";

type Modules = {
  connections: typeof import("./connections");
  google: typeof import("./google");
  hotmail: typeof import("./hotmail");
  db: typeof import("./db");
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const db = await import("./db");
    db.migrate();
    return {
      db,
      connections: await import("./connections"),
      google: await import("./google"),
      hotmail: await import("./hotmail"),
    };
  })();
  return loaded;
}

beforeEach(async () => {
  const { connections, db } = await modules();
  connections._resetConnectionsForTests();
  db.getDb().prepare(`DELETE FROM google_auth`).run();
  db.getDb().prepare(`DELETE FROM hotmail_auth`).run();
});
afterEach(restoreFetch);

const GOOGLE_TOKEN = "oauth2.googleapis.com/token";
const MS_TOKEN = "login.microsoftonline.com";
const INVALID_GRANT = { error: "invalid_grant", error_description: "Token has been expired or revoked." };

type Table = "google_auth" | "hotmail_auth";

async function seed(table: Table, status: "connected" | "expired" | "pending", notified = false): Promise<void> {
  const { db } = await modules();
  const now = new Date().toISOString();
  const tokens = status === "connected" ? (["acc", "ref", new Date(Date.now() + 3_600_000).toISOString()] as const) : ([null, null, null] as const);
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO ${table}
       (id, status, access_token, refresh_token, token_expires_at, expiry_notified_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(status, tokens[0], tokens[1], tokens[2], notified ? now : null, now, now);
}

async function row(table: Table): Promise<{ status: string; expiry_notified_at: string | null } | undefined> {
  const { db } = await modules();
  return db.getDb().prepare(`SELECT * FROM ${table} WHERE id = 1`).get() as never;
}

const googleCalls = (calls: Call[]): number => calls.filter((c) => c.url.includes(GOOGLE_TOKEN)).length;
const msCalls = (calls: Call[]): number => calls.filter((c) => c.url.includes(MS_TOKEN)).length;
const okToken = () => json(200, { access_token: "a", expires_in: 3600 });

const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

// --- notices: once per lapse ---------------------------------------------------

test("no notice for a connection that is healthy, mid-setup, or was never made", async () => {
  const { connections } = await modules();
  assert.deepEqual(connections.pendingExpiryNotices(), [], "nothing stored");
  await seed("google_auth", "connected");
  await seed("hotmail_auth", "pending");
  assert.deepEqual(connections.pendingExpiryNotices(), []);
});

// Parametrized over both providers: these used to cover Google alone, which let
// Hotmail announce on every tick without a single test failing.
for (const [provider, table] of [
  ["google", "google_auth"],
  ["hotmail", "hotmail_auth"],
] as const) {
  test(`${provider}: a lapsed connection is announced once, then never again for that lapse`, async () => {
    const { connections } = await modules();
    await seed(table, "expired");

    const first = connections.pendingExpiryNotices();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.provider, provider);

    first[0]!.markNotified();
    assert.deepEqual(connections.pendingExpiryNotices(), [], "announcing it twice is nagging");
    assert.ok((await row(table))?.expiry_notified_at, "the marker is what suppresses it");
  });

  test(`${provider}: a notice that was never marked stays pending, so a failed send retries`, async () => {
    const { connections } = await modules();
    await seed(table, "expired");
    connections.pendingExpiryNotices(); // looked at, but the DM "failed" — not marked
    assert.equal(connections.pendingExpiryNotices().length, 1);
  });

  test(`${provider}: an already-announced lapse isn't re-announced after a restart`, async () => {
    const { connections } = await modules();
    await seed(table, "expired", true);
    connections._resetConnectionsForTests(); // the in-memory schedule is gone; the marker is in the DB
    assert.deepEqual(connections.pendingExpiryNotices(), []);
  });
}

test("a reconnect re-arms the notice, so a later lapse is announced too", async () => {
  const { connections, google } = await modules();
  await seed("google_auth", "expired", true); // already told about the first lapse

  stubFetch(() =>
    json(200, {
      device_code: "d",
      user_code: "U-1",
      verification_url: "https://www.google.com/device",
      expires_in: 1800,
      interval: 5,
    }),
  );
  await google.connect(); // the user reconnects: the row is replaced
  assert.equal((await row("google_auth"))?.expiry_notified_at, null, "the replaced row must not remember the old notice");

  // ...it completes (storeConnected omits the column too), and months later it lapses again:
  await seed("google_auth", "connected");
  stubFetch(() => json(400, INVALID_GRANT));
  await google.verifyConnection();

  assert.equal(connections.pendingExpiryNotices().length, 1, "the second lapse must be announced");
});

test("the messages say what happened and the exact words that fix it", async () => {
  const { connections } = await modules();
  await seed("google_auth", "expired");
  await seed("hotmail_auth", "expired");

  const byProvider = Object.fromEntries(connections.pendingExpiryNotices().map((n) => [n.provider, n.message]));
  assert.match(byProvider.google!, /connect my Google account/);
  assert.match(byProvider.google!, /Testing/, "the one cause a reconnect can't fix is named");
  assert.match(byProvider.hotmail!, /connect my Hotmail/);
  assert.match(byProvider.hotmail!, /usually/, "hedged: the personal-account inactivity rule wasn't confirmed");
  assert.doesNotMatch(byProvider.hotmail!, /90/, "an unverified number must not be asserted in an unattended message");
});

// --- verification: finding dead connections, cheaply ---------------------------------

test("a healthy connection is verified once a day, not every tick", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  const calls = stubFetch(okToken);

  await connections.verifyConnections(T0);
  assert.equal(googleCalls(calls), 1);

  await connections.verifyConnections(T0 + 5 * MIN);
  await connections.verifyConnections(T0 + 23 * HOUR);
  assert.equal(googleCalls(calls), 1, "a five-minute scheduler tick must not become a token POST each time");

  await connections.verifyConnections(T0 + 25 * HOUR);
  assert.equal(googleCalls(calls), 2, "but it does come round again");
});

test("a provider that isn't connected is skipped and doesn't start its clock", async () => {
  const { connections } = await modules();
  const calls = stubFetch(okToken);

  await connections.verifyConnections(T0);
  assert.equal(calls.length, 0, "nothing connected, nothing to verify");

  // Connecting a minute later must not be held back by a 24h timer started while it wasn't connected.
  await seed("hotmail_auth", "connected");
  await connections.verifyConnections(T0 + MIN);
  assert.equal(msCalls(calls), 1);
});

test("when Google/Microsoft can't be reached, it retries within the hour — not in 5 minutes, not in a day", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  const calls = stubFetch(() => json(503, {}));

  await connections.verifyConnections(T0);
  assert.equal(googleCalls(calls), 1);

  await connections.verifyConnections(T0 + 5 * MIN);
  assert.equal(googleCalls(calls), 1, "a persistent failure mustn't hammer the endpoint every tick");

  await connections.verifyConnections(T0 + 61 * MIN);
  assert.equal(googleCalls(calls), 2, "but one bad moment mustn't hide a dead connection for 24 hours");
  assert.equal((await row("google_auth"))?.status, "connected", "and none of it touches the row");
});

test("a dead connection found by verification is expired, announced, and not verified again", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  const calls = stubFetch(() => json(400, INVALID_GRANT));

  await connections.verifyConnections(T0);
  assert.equal((await row("google_auth"))?.status, "expired");
  assert.equal(connections.pendingExpiryNotices().length, 1);

  await connections.verifyConnections(T0 + 25 * HOUR);
  assert.equal(googleCalls(calls), 1, "once expired it's no longer connected, so there's nothing left to verify");
});

test("rejected client credentials never produce an 'expired' notice and leave the login alone", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  stubFetch(() => json(401, { error: "invalid_client" }));

  await connections.verifyConnections(T0);
  assert.equal((await row("google_auth"))?.status, "connected", "a config problem is not a dead token");
  assert.deepEqual(connections.pendingExpiryNotices(), []);
});

test("verification never rejects, even when the network throws", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  await seed("hotmail_auth", "connected");
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.doesNotReject(() => connections.verifyConnections(T0));
});

test("each provider is verified independently — one dying doesn't skip the other", async () => {
  const { connections } = await modules();
  await seed("google_auth", "connected");
  await seed("hotmail_auth", "connected");
  stubFetch((call) => (call.url.includes(GOOGLE_TOKEN) ? json(400, INVALID_GRANT) : okToken()));

  await connections.verifyConnections(T0);
  assert.equal((await row("google_auth"))?.status, "expired");
  assert.equal((await row("hotmail_auth"))?.status, "connected");
  assert.deepEqual(connections.pendingExpiryNotices().map((n) => n.provider), ["google"]);
});

// --- the live database --------------------------------------------------------------------

test("migrate() upgrades a database shaped like the live one, keeping its connection", () => {
  // The deployed database has google_auth/hotmail_auth with no expiry_notified_at.
  // CREATE TABLE IF NOT EXISTS won't touch an existing table, so only
  // ensureColumn gets the column there — and getAuthRow's SELECT * must keep
  // working on the migrated rows. Run in a fresh process: config freezes
  // LOOPDOG_DB at import, and the old-shaped file has to exist before then.
  const script = `
    const Database = require("better-sqlite3");
    const old = new Database(process.env.LOOPDOG_DB);
    for (const t of ["google_auth", "hotmail_auth"]) {
      old.exec(\`CREATE TABLE \${t} (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL,
        device_code TEXT, user_code TEXT, verification_url TEXT, poll_interval INTEGER, expires_at TEXT,
        access_token TEXT, refresh_token TEXT, token_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)\`);
    }
    old.prepare("INSERT INTO google_auth (id,status,access_token,refresh_token,token_expires_at,created_at,updated_at) VALUES (1,'connected','a','r','2030-01-01','t','t')").run();
    old.close();

    const { migrate, getDb } = require("./src/db");
    migrate(); migrate(); // and it must be safe to run on every boot
    const has = (t) => getDb().prepare("PRAGMA table_info(" + t + ")").all().some((c) => c.name === "expiry_notified_at");
    const g = require("./src/google");
    const before = g.expiryNoticePending();
    getDb().prepare("UPDATE google_auth SET status = 'expired'").run();
    console.log(JSON.stringify({
      google: has("google_auth"), hotmail: has("hotmail_auth"),
      kept: getDb().prepare("SELECT refresh_token FROM google_auth").get().refresh_token,
      pendingWhileConnected: before, pendingOnceExpired: g.expiryNoticePending(),
    }));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, LOOPDOG_DB: join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "old.sqlite") },
    encoding: "utf-8",
  });
  const result = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(result.google, true, "google_auth gains the column");
  assert.equal(result.hotmail, true, "hotmail_auth gains the column");
  assert.equal(result.kept, "r", "the existing connection survives the migration");
  assert.equal(result.pendingWhileConnected, false);
  assert.equal(result.pendingOnceExpired, true, "a NULL column on a migrated row reads as 'not announced yet'");
});

// --- the wording a lapsed connection gets elsewhere ------------------------------------

/** A scheduled check, shaped just enough for fetchScheduledCheck. */
const check = (kind: "calendar" | "inbox"): never =>
  ({ id: 1, text: "morning check", kind, recurrence: null }) as never;

test("a scheduled calendar check says 'expired', not 'isn't set up', when the connection lapsed", async () => {
  const { fetchScheduledCheck } = await import("./pusher");
  await seed("google_auth", "expired");
  assert.match((await fetchScheduledCheck(check("calendar")))!, /Google Calendar connection has expired/);
});

test("a scheduled calendar check with nothing ever connected still reports not-set-up (null)", async () => {
  const { fetchScheduledCheck } = await import("./pusher");
  assert.equal(await fetchScheduledCheck(check("calendar")), null);
});

test("a scheduled inbox check names a lapsed Hotmail rather than claiming nothing is set up", async () => {
  const { fetchScheduledCheck } = await import("./pusher");
  await seed("hotmail_auth", "expired");
  assert.match((await fetchScheduledCheck(check("inbox")))!, /Hotmail connection has expired/);
});

test("a scheduled inbox check with no inbox at all still reports not-set-up (null)", async () => {
  const { fetchScheduledCheck } = await import("./pusher");
  assert.equal(await fetchScheduledCheck(check("inbox")), null);
});

test("check_all_inboxes' error distinguishes a lapsed Hotmail from one never connected", async () => {
  const { gatherAllInboxes, expiredInboxProviders } = await import("./inboxes");

  assert.deepEqual(expiredInboxProviders(), []);
  await assert.rejects(
    () => gatherAllInboxes(5),
    (error: Error) => {
      assert.match(error.message, /no inbox is usable yet/);
      assert.doesNotMatch(error.message, /has expired/, "nothing lapsed, so it mustn't say so");
      return true;
    },
  );

  await seed("hotmail_auth", "expired");
  assert.deepEqual(expiredInboxProviders(), ["Hotmail"]);
  await assert.rejects(() => gatherAllInboxes(5), /Hotmail's connection has expired/);
});
