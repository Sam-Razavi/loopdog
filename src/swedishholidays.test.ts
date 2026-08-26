import assert from "node:assert/strict";
import { test } from "node:test";
import { easterSunday, listSwedishHolidays } from "./swedishholidays";

test("easterSunday matches independently-known real Easter dates", () => {
  assert.equal(easterSunday(2024), "2024-03-31");
  assert.equal(easterSunday(2025), "2025-04-20");
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2023), "2023-04-09");
  assert.equal(easterSunday(2016), "2016-03-27"); // an unusually early Easter
  assert.equal(easterSunday(2000), "2000-04-23");
});

test("listSwedishHolidays: 2026 has all 13 official holidays, sorted, correct dates", () => {
  const holidays = listSwedishHolidays(2026);
  assert.equal(holidays.length, 13);

  // Sorted chronologically.
  for (let i = 1; i < holidays.length; i++) {
    assert.ok(holidays[i - 1]!.date < holidays[i]!.date, "holidays should be sorted by date");
  }

  const byName = Object.fromEntries(holidays.map((h) => [h.name, h.date]));
  assert.equal(byName["Nyårsdagen (New Year's Day)"], "2026-01-01");
  assert.equal(byName["Trettondedag jul (Epiphany)"], "2026-01-06");
  assert.equal(byName["Långfredagen (Good Friday)"], "2026-04-03");
  assert.equal(byName["Påskdagen (Easter Sunday)"], "2026-04-05");
  assert.equal(byName["Annandag påsk (Easter Monday)"], "2026-04-06");
  assert.equal(byName["Första maj (May Day)"], "2026-05-01");
  assert.equal(byName["Kristi himmelsfärdsdag (Ascension Day)"], "2026-05-14");
  assert.equal(byName["Pingstdagen (Whit Sunday)"], "2026-05-24");
  assert.equal(byName["Sveriges nationaldag (National Day)"], "2026-06-06");
  assert.equal(byName["Midsommardagen (Midsummer Day)"], "2026-06-20");
  assert.equal(byName["Alla helgons dag (All Saints' Day)"], "2026-10-31");
  assert.equal(byName["Juldagen (Christmas Day)"], "2026-12-25");
  assert.equal(byName["Annandag jul (Boxing Day)"], "2026-12-26");
});

test("listSwedishHolidays: 2025 exercises different Midsummer/All Saints' calendar dates", () => {
  const holidays = listSwedishHolidays(2025);
  assert.equal(holidays.length, 13);

  const byName = Object.fromEntries(holidays.map((h) => [h.name, h.date]));
  // Different calendar dates from 2026, confirming the range-search logic
  // (not just always landing on the same day-of-month).
  assert.equal(byName["Midsommardagen (Midsummer Day)"], "2025-06-21");
  assert.equal(byName["Alla helgons dag (All Saints' Day)"], "2025-11-01");
});

test("listSwedishHolidays: excludes non-official eve days", () => {
  const dates = listSwedishHolidays(2026).map((h) => h.date);
  assert.ok(!dates.includes("2026-12-24"), "Christmas Eve is not an official holiday");
  assert.ok(!dates.includes("2026-12-31"), "New Year's Eve is not an official holiday");
  assert.ok(!dates.includes("2026-06-19"), "Midsummer Eve is not an official holiday");
});
