import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The first DB-backed test in the project — everything else here is pure
 * enough to test without one. It earns the exception: completing a recurring
 * reminder used to tombstone it permanently, and that regression is only
 * visible through real inserts and the queries that filter on completed_at.
 *
 * config.ts reads env at import time, and tsx compiles these files to CJS
 * (no "type": "module"), where static imports hoist above every other
 * statement — so a top-level `import` of ./index here would open the real
 * database before LOOPDOG_DB could be set. Hence the assignment below runs
 * first and the db modules load via dynamic import inside the tests.
 * Top-level await isn't available under CJS either, so the load is memoised
 * rather than awaited once at module scope.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type RemindersModule = typeof import("./reminders");

let loaded: Promise<RemindersModule> | null = null;

function reminders(): Promise<RemindersModule> {
  loaded ??= (async () => {
    const { migrate } = await import("./index");
    migrate();
    return import("./reminders");
  })();
  return loaded;
}

/** Due a minute ago, so it lands in the overdue/push feeds immediately. */
function overdueIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

test("completing a one-shot reminder finishes it and clears the push queue", async () => {
  const { createReminder, completeReminder, listReminders, listUnnotifiedOverdue } =
    await reminders();

  const created = createReminder("call the dentist", overdueIso());
  assert.equal(
    listUnnotifiedOverdue().some((r) => r.id === created.id),
    true,
    "should start out push-eligible",
  );

  const result = completeReminder(created.id);
  assert.ok(result);
  assert.equal(result.rolled_forward, false);
  assert.notEqual(result.reminder.completed_at, null);
  assert.equal(
    listReminders({ status: "pending" }).some((r) => r.id === created.id),
    false,
    "a finished one-shot leaves the pending list",
  );
});

test("completing a recurring reminder rolls it forward instead of killing it", async () => {
  const { createReminder, completeReminder, getReminder, listReminders, markNotified } =
    await reminders();

  const created = createReminder("stretch", overdueIso(), "daily");
  markNotified(created.id); // simulate the push that already went out

  const result = completeReminder(created.id);
  assert.ok(result);
  assert.equal(result.rolled_forward, true, "a daily reminder rolls rather than finishes");

  const after = getReminder(created.id)!;
  assert.equal(after.completed_at, null, "recurrence must not be tombstoned");
  assert.equal(after.notified_at, null, "the next occurrence is push-eligible again");
  assert.ok(
    Date.parse(after.due_at) > Date.parse(created.due_at),
    "due_at moves to the next occurrence",
  );
  assert.equal(
    listReminders({ status: "pending" }).some((r) => r.id === created.id),
    true,
    "it stays pending so it can fire again",
  );
});

test("a weekly reminder rolls forward seven days, a daily one one day", async () => {
  const { createReminder, completeReminder, getReminder } = await reminders();

  const start = overdueIso();
  const daily = createReminder("stretch daily", start, "daily");
  const weekly = createReminder("water the plants", start, "weekly");

  completeReminder(daily.id);
  completeReminder(weekly.id);

  const dayMs = 24 * 60 * 60 * 1000;
  const dailyDelta = Date.parse(getReminder(daily.id)!.due_at) - Date.parse(start);
  const weeklyDelta = Date.parse(getReminder(weekly.id)!.due_at) - Date.parse(start);

  // Whole-day deltas, but DST can shift the absolute gap by an hour either
  // way — advanceLocalInstant preserves wall-clock time, not elapsed ms.
  assert.ok(Math.abs(dailyDelta - dayMs) <= 60 * 60 * 1000, `daily moved ${dailyDelta}ms`);
  assert.ok(Math.abs(weeklyDelta - 7 * dayMs) <= 60 * 60 * 1000, `weekly moved ${weeklyDelta}ms`);
});

test("the digest counts completions of both kinds", async () => {
  const { createReminder, completeReminder, countCompletedSince } = await reminders();

  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const before = countCompletedSince(cutoff);

  const oneShot = createReminder("post the letter", overdueIso());
  const recurring = createReminder("take the bins out", overdueIso(), "weekly");

  completeReminder(oneShot.id);
  completeReminder(recurring.id);

  assert.equal(
    countCompletedSince(cutoff),
    before + 2,
    "both a one-shot and a recurring completion count toward the weekly digest",
  );
});
