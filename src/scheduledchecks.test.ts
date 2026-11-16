import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { json, restoreFetch, stubFetch } from "./testutil/fetchstub";

/**
 * Scheduled checks ("check my calendar every morning") when the thing they
 * check can't be reached.
 *
 * The bug these pin: a recurring check that couldn't run explained itself and
 * then rolled forward to tomorrow, where it explained itself again — so a
 * daily calendar check with a lapsed connection complained every single
 * morning. DB-backed; Discord is a stub that records what would have been sent.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");
process.env.GOOGLE_CLIENT_ID = "g-id";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";
process.env.HOTMAIL_CLIENT_ID = "ms-id";
// start === end means "no quiet hours", so these don't depend on the time of day.
process.env.LOOPDOG_QUIET_HOURS_START = "0";
process.env.LOOPDOG_QUIET_HOURS_END = "0";

type Mods = {
  pusher: typeof import("./pusher");
  reminders: typeof import("./db/reminders");
  tools: typeof import("./tools");
  db: typeof import("./db");
};

let loaded: Promise<Mods> | null = null;
function mods(): Promise<Mods> {
  loaded ??= (async () => {
    const db = await import("./db");
    db.migrate();
    return {
      db,
      pusher: await import("./pusher"),
      reminders: await import("./db/reminders"),
      tools: await import("./tools"),
    };
  })();
  return loaded;
}

beforeEach(async () => {
  const { db } = await mods();
  for (const table of ["reminders", "google_auth", "hotmail_auth"]) {
    db.getDb().prepare(`DELETE FROM ${table}`).run();
  }
});
afterEach(restoreFetch);

/** A Discord stand-in that records every DM it would have sent. */
function fakeClient(): { sent: string[]; client: never } {
  const sent: string[] = [];
  const client = {
    users: { fetch: async () => ({ send: async (message: string) => void sent.push(message) }) },
  } as never;
  return { sent, client };
}

type Kind = "calendar" | "inbox" | "canvas";
const overdue = (): string => new Date(Date.now() - 60_000).toISOString();

async function makeCheck(kind: Kind, recurrence: "daily" | "weekly" | null) {
  const { reminders } = await mods();
  return reminders.createReminder(`morning ${kind} check`, overdue(), recurrence, kind);
}

/** Make an already-rolled-forward reminder due again — i.e. "the next morning has arrived". */
async function nextMorning(id: number): Promise<void> {
  const { db } = await mods();
  db.getDb().prepare(`UPDATE reminders SET due_at = ?, notified_at = NULL WHERE id = ?`).run(overdue(), id);
}

async function setGoogle(status: "connected" | "expired"): Promise<void> {
  const { db } = await mods();
  const now = new Date().toISOString();
  const live = status === "connected";
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO google_auth (id, status, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(status, live ? "acc" : null, live ? "ref" : null, live ? new Date(Date.now() + 3_600_000).toISOString() : null, now, now);
}

async function setHotmailExpired(): Promise<void> {
  const { db } = await mods();
  const now = new Date().toISOString();
  db.getDb()
    .prepare(`INSERT OR REPLACE INTO hotmail_auth (id, status, created_at, updated_at) VALUES (1, 'expired', ?, ?)`)
    .run(now, now);
}

async function state(id: number) {
  const { reminders } = await mods();
  return reminders.getReminder(id)!;
}

// --- the reported bug --------------------------------------------------------------

test("REPORTED BUG: a daily calendar check with a lapsed connection does not complain every morning", async () => {
  const { pusher } = await mods();
  await setGoogle("expired");
  const check = await makeCheck("calendar", "daily");
  const { sent, client } = fakeClient();

  for (let day = 1; day <= 5; day++) {
    await pusher.checkScheduledChecks(client);
    await nextMorning(check.id);
  }

  assert.deepEqual(sent, [], "five mornings, zero messages — the lapse itself is announced once, elsewhere");
});

test("a recurring check that can't run still rolls forward, so it resumes the day it can", async () => {
  const { pusher } = await mods();
  await setGoogle("expired");
  const check = await makeCheck("calendar", "daily");
  const { client } = fakeClient();

  await pusher.checkScheduledChecks(client);

  const after = await state(check.id);
  assert.ok(Date.parse(after.due_at) > Date.parse(check.due_at), "moved to the next occurrence");
  assert.equal(after.notified_at, null, "and stays eligible");
  assert.equal(after.completed_at, null, "not tombstoned");
});

test("the same holds when the calendar was never connected, and for canvas and inbox", async () => {
  const { pusher } = await mods();
  await setHotmailExpired();
  const calendar = await makeCheck("calendar", "daily"); // no google row at all
  const canvas = await makeCheck("canvas", "weekly"); // canvas unconfigured
  const inbox = await makeCheck("inbox", "daily"); // only a lapsed hotmail
  const { sent, client } = fakeClient();

  await pusher.checkScheduledChecks(client);

  assert.deepEqual(sent, []);
  for (const check of [calendar, canvas, inbox]) {
    assert.ok(Date.parse((await state(check.id)).due_at) > Date.parse(check.due_at), `${check.kind} rolled forward`);
  }
});

// --- a one-shot has only one chance to speak ----------------------------------------------

test("a one-shot check that can't run explains itself exactly once", async () => {
  const { pusher } = await mods();
  await setGoogle("expired");
  const check = await makeCheck("calendar", null);
  const { sent, client } = fakeClient();

  await pusher.checkScheduledChecks(client);
  await pusher.checkScheduledChecks(client); // a second tick must not repeat it

  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /morning calendar check: the Google Calendar connection has expired/);
  assert.ok((await state(check.id)).notified_at, "marked, so it isn't sent again");
});

test("a one-shot check for a never-connected calendar says it isn't connected, not 'expired'", async () => {
  const { pusher } = await mods();
  await makeCheck("calendar", null);
  const { sent, client } = fakeClient();
  await pusher.checkScheduledChecks(client);
  assert.match(sent[0]!, /Google Calendar isn't connected/);
  assert.doesNotMatch(sent[0]!, /expired/);
});

// --- and the normal path is untouched -----------------------------------------------------

test("a recurring check that CAN run still delivers, and still rolls forward", async () => {
  const { pusher } = await mods();
  await setGoogle("connected");
  const check = await makeCheck("calendar", "daily");
  stubFetch((call) =>
    call.url.includes("/calendarList")
      ? json(200, { items: [{ id: "primary", summary: "Me" }] })
      : json(200, {
          items: [{ summary: "Dentist", start: { dateTime: "2030-01-01T09:00:00Z" }, end: { dateTime: "2030-01-01T10:00:00Z" } }],
        }),
  );
  const { sent, client } = fakeClient();

  await pusher.checkScheduledChecks(client);

  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /morning calendar check:\n {2}- Dentist/);
  assert.ok(Date.parse((await state(check.id)).due_at) > Date.parse(check.due_at));
});

test("a transient fetch failure is retried next tick rather than skipped or announced", async () => {
  const { pusher } = await mods();
  await setGoogle("connected");
  const check = await makeCheck("calendar", "daily");
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const { sent, client } = fakeClient();

  await pusher.checkScheduledChecks(client);

  // listEvents -> calendarList throws; the per-calendar guard doesn't apply to that call.
  assert.deepEqual(sent, []);
  assert.equal((await state(check.id)).due_at, check.due_at, "not advanced — it should be tried again");
});

// --- the shared "why can't it run" answer ------------------------------------------------

test("scheduledCheckBlocker tells never-set-up apart from lapsed, and returns null when it can run", async () => {
  const { pusher } = await mods();
  const blocker = pusher.scheduledCheckBlocker;

  assert.equal(blocker("text"), null, "a plain reminder has nothing to check");
  assert.equal(blocker("canvas"), "Canvas isn't set up");
  assert.equal(blocker("calendar"), "Google Calendar isn't connected");
  assert.equal(blocker("inbox"), "no inbox is set up");

  await setGoogle("expired");
  assert.match(blocker("calendar")!, /has expired/);
  await setGoogle("connected");
  assert.equal(blocker("calendar"), null);

  await setHotmailExpired();
  assert.match(blocker("inbox")!, /Hotmail connection has expired/);
});

// --- creation time: the one moment the user can still act on it -----------------------------

test("create_reminder warns when a check can't run yet — and still creates it", async () => {
  const { tools, reminders } = await mods();

  const result = (await tools.runTool("create_reminder", {
    text: "morning calendar check",
    due_at: "2030-01-01T08:00:00+01:00",
    recurrence: "daily",
    kind: "calendar",
  })) as { id: number; warning?: string };

  assert.match(result.warning ?? "", /can't run right now — Google Calendar isn't connected/);
  assert.match(result.warning ?? "", /tell the user/);
  assert.ok(reminders.getReminder(result.id), "it's saved: connecting later makes it work");
});

test("create_reminder is silent about it when the check can run, and for plain reminders", async () => {
  const { tools } = await mods();
  await setGoogle("connected");

  const ok = (await tools.runTool("create_reminder", {
    text: "morning calendar check",
    due_at: "2030-01-01T08:00:00+01:00",
    kind: "calendar",
  })) as { warning?: string };
  assert.equal(ok.warning, undefined);

  const plain = (await tools.runTool("create_reminder", {
    text: "stretch",
    due_at: "2030-01-01T08:00:00+01:00",
  })) as { warning?: string };
  assert.equal(plain.warning, undefined, "a plain reminder has no integration to be missing");
});
