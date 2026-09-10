import assert from "node:assert/strict";
import { test } from "node:test";
import { projectGoal, type HistoryPoint } from "./goals";

/**
 * The interesting cases here are the refusals, not the happy path: a pace
 * projection is only worth printing if it declines to invent one when the
 * data can't support it. Same posture find_correlation already takes.
 */

/** A run of days starting at `from`, one value each, evenly spaced. */
function series(from: string, values: (number | null)[]): HistoryPoint[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return values.map((value, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
}

test("a steady trend projects a concrete arrival date", () => {
  // 80 kg dropping 0.1/day, target 75 — 50 days from the last reading.
  const history = series("2026-01-01", [80, 79.9, 79.8, 79.7, 79.6, 79.5]);
  const result = projectGoal(history, 75, "2026-06-01", "2026-01-06");

  assert.equal(result.current, 79.5);
  assert.ok(result.rate_per_day! < 0);
  assert.ok(Math.abs(result.rate_per_day! + 0.1) < 0.0001, "≈ -0.1/day");
  // 79.5 on Jan 6, 4.5 to lose at 0.1/day = 45 days.
  assert.equal(result.projected_day, "2026-02-20");
  assert.equal(result.verdict, "on_track", "arrives well before June");
  assert.ok(result.days_off! < 0, "negative days_off means early");
});

test("a trend too slow for the deadline reports behind, with how late", () => {
  const history = series("2026-01-01", [80, 79.99, 79.98, 79.97, 79.96, 79.95]);
  const result = projectGoal(history, 75, "2026-03-01", "2026-01-06");

  assert.equal(result.verdict, "behind");
  assert.ok(result.days_off! > 0, "positive days_off means late");
  assert.ok(result.projected_day! > "2026-03-01", "projected date is past the deadline");
});

test("moving the wrong way refuses to project a date at all", () => {
  // Gaining weight while the target is below — an arrival date here would
  // be a negative number dressed up as a prediction.
  const history = series("2026-01-01", [80, 80.1, 80.2, 80.3, 80.4]);
  const result = projectGoal(history, 75, "2026-06-01", "2026-01-05");

  assert.equal(result.verdict, "wrong_way");
  assert.equal(result.projected_day, null);
  assert.ok(result.rate_per_day! > 0, "the rate is still reported — it's the date that's withheld");
});

test("a flat line reports flat rather than a date decades away", () => {
  // Dividing by a near-zero slope is exactly how a confident nonsense
  // projection gets produced.
  const history = series("2026-01-01", [80, 80, 80, 80, 80, 80]);
  const result = projectGoal(history, 75, "2026-06-01", "2026-01-06");

  assert.equal(result.verdict, "flat");
  assert.equal(result.projected_day, null);
});

test("three readings is not a trend", () => {
  const result = projectGoal(series("2026-01-01", [80, 79, 78]), 75, "2026-06-01", "2026-01-03");
  assert.equal(result.verdict, "not_enough_data");
  assert.equal(result.rate_per_day, null);
  assert.equal(result.current, 78, "the current value is still reported");
});

test("an empty or all-gap history reports no current value rather than zero", () => {
  const result = projectGoal(series("2026-01-01", [null, null, null, null]), 75, "2026-06-01", "2026-01-04");
  assert.equal(result.verdict, "not_enough_data");
  assert.equal(result.current, null, "null, never 0 — a missing reading is not a reading of zero");
});

test("gaps between readings are skipped, not treated as zeroes", () => {
  const history = series("2026-01-01", [80, null, 79.8, null, 79.6, 79.5]);
  const result = projectGoal(history, 75, "2026-06-01", "2026-01-06");
  assert.equal(result.current, 79.5);
  assert.ok(result.rate_per_day! < 0 && result.rate_per_day! > -1, `slope ${result.rate_per_day} should be gentle`);
});

test("already at or past the target reports reached", () => {
  const down = projectGoal(series("2026-01-01", [76, 75.5, 75.2, 74.9]), 75, "2026-06-01", "2026-01-04");
  assert.equal(down.verdict, "reached");

  const up = projectGoal(series("2026-01-01", [60, 65, 70, 76]), 75, "2026-06-01", "2026-01-04");
  assert.equal(
    up.verdict,
    "reached",
    "overshooting upward is reached, not wrong_way — direction comes from where it started",
  );
});

test("the needed rate says what it would actually take from here", () => {
  const history = series("2026-01-01", [80, 79.9, 79.8, 79.7]);
  const result = projectGoal(history, 75, "2026-01-14", "2026-01-04");
  // 4.7 to lose over 10 days.
  assert.ok(Math.abs(result.needed_rate_per_day! + 0.47) < 0.0001, `got ${result.needed_rate_per_day}`);
});
