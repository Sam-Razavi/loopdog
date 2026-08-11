import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStreak } from "./streak";

const TODAY = "2026-08-11";

/** Consecutive days ending on `end`, oldest first. */
function run(end: string, count: number): string[] {
  const days: string[] = [];
  const cursor = new Date(`${end}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    days.unshift(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days;
}

test("no logs at all", () => {
  const streak = computeStreak([], TODAY);
  assert.equal(streak.current_streak, 0);
  assert.equal(streak.longest_streak, 0);
  assert.equal(streak.at_risk, false);
  assert.equal(streak.last_logged, null);
});

test("logged today counts today", () => {
  const streak = computeStreak(run(TODAY, 4), TODAY);
  assert.equal(streak.current_streak, 4);
  assert.equal(streak.at_risk, false);
  assert.equal(streak.last_logged, TODAY);
});

test("grace day: today blank, yesterday logged, streak holds and flags", () => {
  const streak = computeStreak(run("2026-08-10", 9), TODAY);
  assert.equal(streak.current_streak, 9, "streak survives the first missed day");
  assert.equal(streak.at_risk, true);
});

test("two blank days resets to zero", () => {
  const streak = computeStreak(run("2026-08-09", 9), TODAY);
  assert.equal(streak.current_streak, 0);
  assert.equal(streak.at_risk, false);
  assert.equal(streak.longest_streak, 9, "the best run is remembered");
});

test("longest streak survives a lapse", () => {
  const days = [...run("2026-07-20", 12), ...run(TODAY, 3)];
  const streak = computeStreak(days, TODAY);
  assert.equal(streak.current_streak, 3);
  assert.equal(streak.longest_streak, 12);
});

test("a gap inside history does not join two runs", () => {
  const days = [...run("2026-08-05", 3), ...run(TODAY, 2)];
  const streak = computeStreak(days, TODAY);
  assert.equal(streak.current_streak, 2);
  assert.equal(streak.longest_streak, 3);
});

test("duplicate days are counted once", () => {
  const streak = computeStreak([TODAY, TODAY, "2026-08-10"], TODAY);
  assert.equal(streak.current_streak, 2);
});

test("streak walks correctly across a month boundary", () => {
  const streak = computeStreak(run("2026-09-02", 5), "2026-09-02");
  assert.equal(streak.current_streak, 5);
  assert.equal(streak.longest_streak, 5);
});

test("milestone boundaries land on exact counts", () => {
  assert.equal(computeStreak(run(TODAY, 7), TODAY).current_streak, 7);
  assert.equal(computeStreak(run(TODAY, 30), TODAY).current_streak, 30);
  assert.equal(computeStreak(run(TODAY, 100), TODAY).current_streak, 100);
});
