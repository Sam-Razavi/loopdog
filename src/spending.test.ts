import assert from "node:assert/strict";
import { test } from "node:test";
import { monthlyTotals } from "./spending";

test("monthlyTotals: groups by calendar month and sums", () => {
  const history = [
    { day: "2026-06-30", value: 100 },
    { day: "2026-07-01", value: 50 },
    { day: "2026-07-15", value: 25 },
    { day: "2026-07-20", value: null }, // no log that day
  ];
  const totals = monthlyTotals(history);
  assert.deepEqual(totals, [
    { month: "2026-06", total: 100 },
    { month: "2026-07", total: 75 },
  ]);
});

test("monthlyTotals: a month with no logs at all doesn't appear as a zero entry", () => {
  const history = [
    { day: "2026-06-01", value: null },
    { day: "2026-06-02", value: null },
    { day: "2026-07-01", value: 10 },
  ];
  const totals = monthlyTotals(history);
  assert.deepEqual(totals, [{ month: "2026-07", total: 10 }]);
});

test("monthlyTotals: sorts chronologically across a year boundary", () => {
  const history = [
    { day: "2027-01-05", value: 40 },
    { day: "2026-12-20", value: 30 },
    { day: "2026-12-28", value: 10 },
  ];
  const totals = monthlyTotals(history);
  assert.deepEqual(totals, [
    { month: "2026-12", total: 40 },
    { month: "2027-01", total: 40 },
  ]);
});

test("monthlyTotals: empty history returns an empty list", () => {
  assert.deepEqual(monthlyTotals([]), []);
});
