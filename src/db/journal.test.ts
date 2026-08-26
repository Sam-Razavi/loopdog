import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** Same DB-backed pattern as reminders.test.ts/importantdates.test.ts. */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type JournalModule = typeof import("./journal");
let loaded: Promise<JournalModule> | null = null;
function journal(): Promise<JournalModule> {
  loaded ??= (async () => {
    const { migrate } = await import("./index");
    migrate();
    return import("./journal");
  })();
  return loaded;
}

test("getEntries: day takes precedence over days when both are given", async () => {
  const { addEntry, getEntries } = await journal();

  addEntry("2026-08-20", "an old entry");
  addEntry("2026-08-26", "today's entry");

  const entries = getEntries({ day: "2026-08-26", days: 30 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.text, "today's entry");
});

test("getEntries: query is a case-insensitive substring match", async () => {
  const { addEntry, getEntries } = await journal();

  addEntry("2026-08-21", "Went to Gothenburg for the weekend");
  addEntry("2026-08-22", "Quiet day at home");

  const found = getEntries({ query: "gothenburg" });
  assert.equal(found.length, 1);
  assert.match(found[0]!.text, /Gothenburg/);

  const notFound = getEntries({ query: "malmö" });
  assert.equal(notFound.length, 0);
});

test("getEntries: with no filters at all, returns everything, newest first", async () => {
  const { addEntry, getEntries } = await journal();

  addEntry("2026-01-01", "first");
  addEntry("2026-01-02", "second");

  const all = getEntries();
  assert.ok(all.length >= 2);
  const first = all.find((e) => e.text === "first")!;
  const second = all.find((e) => e.text === "second")!;
  assert.ok(all.indexOf(second) < all.indexOf(first), "newer entries should sort first");
});

test("deleteEntry: throws a clear error for an unknown id", async () => {
  const { deleteEntry } = await journal();
  assert.throws(() => deleteEntry(999_999), /no journal entry with id/);
});
