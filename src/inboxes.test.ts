import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type Module = typeof import("./inboxes");

let loaded: Promise<Module> | null = null;

/** hotmail.isConnected() reads the DB, so the schema has to exist first. */
function inboxes(): Promise<Module> {
  loaded ??= (async () => {
    const { migrate } = await import("./db");
    migrate();
    return import("./inboxes");
  })();
  return loaded;
}

/**
 * Guards the extraction of this fan-out out of check_all_inboxes's dispatch
 * case: with nothing configured, the behaviour that mattered was a clear
 * "nothing is usable" error rather than an empty success, and that's the
 * part a refactor could silently invert.
 */
test("with nothing configured, gathering reports nothing usable rather than succeeding empty", async () => {
  const { gatherAllInboxes, anyInboxUsable } = await inboxes();
  assert.equal(anyInboxUsable(), false);
  await assert.rejects(() => gatherAllInboxes(5), /no inbox is usable yet/);
});

test("the not-usable message points at the real setup paths, not at connect_google", async () => {
  const { gatherAllInboxes } = await inboxes();
  await assert.rejects(
    () => gatherAllInboxes(5),
    (error: Error) => {
      assert.match(error.message, /connect_hotmail/);
      assert.match(error.message, /gmail-login/);
      // connect_google is calendar-only — suggesting it for email was a real
      // bug once, so it stays pinned.
      assert.match(error.message, /connect_google does NOT grant email/);
      return true;
    },
  );
});
