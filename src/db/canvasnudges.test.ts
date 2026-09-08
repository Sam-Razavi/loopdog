import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * DB-backed for the same reason reminders.test.ts is: the whole point of
 * this table is that a second nudge for the same assignment is suppressed,
 * and that's only observable through real inserts. Same env-before-import
 * dance as the other DB tests — config.ts reads env at import time.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type Module = typeof import("./canvasnudges");

let loaded: Promise<Module> | null = null;

function nudges(): Promise<Module> {
  loaded ??= (async () => {
    const { migrate } = await import("./index");
    migrate();
    return import("./canvasnudges");
  })();
  return loaded;
}

test("an assignment is nudged once per stage, not once per tick", async () => {
  const { hasNudgedForAssignment, markNudgedForAssignment } = await nudges();

  assert.equal(hasNudgedForAssignment(101, "advance"), false, "nothing nudged yet");
  markNudgedForAssignment(101, "advance");
  assert.equal(hasNudgedForAssignment(101, "advance"), true, "the same stage must not fire twice");

  // The due-day nudge is a separate stage of the same assignment, so it is
  // still owed even though the advance one already went out.
  assert.equal(hasNudgedForAssignment(101, "due_today"), false);
  markNudgedForAssignment(101, "due_today");
  assert.equal(hasNudgedForAssignment(101, "due_today"), true);
});

test("marking one assignment doesn't suppress a different one", async () => {
  const { hasNudgedForAssignment, markNudgedForAssignment } = await nudges();
  markNudgedForAssignment(202, "advance");
  assert.equal(hasNudgedForAssignment(303, "advance"), false);
});

test("marking twice is a no-op rather than a constraint error", async () => {
  const { markNudgedForAssignment, hasNudgedForAssignment } = await nudges();
  markNudgedForAssignment(404, "due_today");
  markNudgedForAssignment(404, "due_today"); // INSERT OR IGNORE — must not throw
  assert.equal(hasNudgedForAssignment(404, "due_today"), true);
});
