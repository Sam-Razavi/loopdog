import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nextOccurrence } from "./importantdates";

/**
 * addDate's dedup guard needs a real database — same reasoning and same
 * dynamic-import-after-env-set pattern as db/reminders.test.ts, the first
 * DB-backed test in this project. config.ts reads LOOPDOG_DB at import
 * time, and tsx compiles to CJS where static imports hoist above every
 * other statement, so the env var has to be set before ./importantdates
 * (or ./index) ever loads.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type ImportantDatesModule = typeof import("./importantdates");
let loaded: Promise<ImportantDatesModule> | null = null;
function importantDates(): Promise<ImportantDatesModule> {
  loaded ??= (async () => {
    const { migrate } = await import("./index");
    migrate();
    return import("./importantdates");
  })();
  return loaded;
}

test("nextOccurrence: a date later this year stays in this year", () => {
  assert.equal(nextOccurrence(12, 25, "2026-08-26"), "2026-12-25");
});

test("nextOccurrence: a date already passed this year rolls to next year", () => {
  assert.equal(nextOccurrence(3, 3, "2026-08-26"), "2027-03-03");
});

test("nextOccurrence: today itself counts as the occurrence, not next year", () => {
  assert.equal(nextOccurrence(8, 26, "2026-08-26"), "2026-08-26");
});

test("nextOccurrence: Feb 29 in a non-leap target year falls back to Feb 28", () => {
  // 2026 is not a leap year.
  assert.equal(nextOccurrence(2, 29, "2026-01-01"), "2026-02-28");
});

test("nextOccurrence: Feb 29 in a leap target year lands on the real date", () => {
  // 2028 is a leap year.
  assert.equal(nextOccurrence(2, 29, "2027-06-01"), "2028-02-29");
});

test("nextOccurrence: an early-January date, asked about in late December, rolls into next year correctly", () => {
  assert.equal(nextOccurrence(1, 3, "2026-12-27"), "2027-01-03");
});

test("addDate: adding the same name/month/day twice reuses the existing entry, not a duplicate", async () => {
  const { addDate, listDates } = await importantDates();

  const first = addDate("Mom's birthday", 3, 3);
  const second = addDate("mom's birthday", 3, 3); // different case — still the same date

  assert.equal(second.id, first.id, "should return the same row, not create a new one");
  assert.equal(
    listDates().filter((d) => d.name.toLowerCase() === "mom's birthday").length,
    1,
    "only one entry should exist in the database",
  );
});

test("addDate: same name but a different date is a genuinely separate entry", async () => {
  const { addDate } = await importantDates();

  const birthday = addDate("Alex's celebration", 3, 3);
  const anniversary = addDate("Alex's celebration", 6, 6);

  assert.notEqual(birthday.id, anniversary.id);
});

test("addDate: rejects an invalid month/day", async () => {
  const { addDate } = await importantDates();
  assert.throws(() => addDate("Bad date", 2, 30), /valid month\/day/);
  assert.throws(() => addDate("Bad date", 13, 1), /valid month\/day/);
});
