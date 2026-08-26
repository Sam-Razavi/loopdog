import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapestWindow, isCurrentlyCheap, type PricePoint } from "./electricity";

/** 6 hourly points, midnight to 06:00, prices 10,9,8,20,20,20 SEK/kWh (scaled up for readable arithmetic). */
function hourlyPoints(prices: number[]): PricePoint[] {
  return prices.map((price, i) => ({
    sek_per_kwh: price,
    time_start: `2026-08-26T${String(i).padStart(2, "0")}:00:00+02:00`,
    time_end: `2026-08-26T${String(i + 1).padStart(2, "0")}:00:00+02:00`,
  }));
}

test("cheapestWindow: a single-hour window picks the single cheapest hour", () => {
  const points = hourlyPoints([10, 9, 8, 20, 20, 20]);
  const window = cheapestWindow(points, 1);
  assert.ok(window);
  assert.equal(window.avg_sek_per_kwh, 8);
  assert.equal(window.start, points[2]!.time_start);
  assert.equal(window.end, points[2]!.time_end);
});

test("cheapestWindow: a multi-hour window picks the cheapest contiguous block, not just low individual hours", () => {
  // Hours 1-3 (9,8,20) average higher than hours 3-5 aren't contiguous-cheap;
  // the true cheapest 3h block is hours 0-2 (10,9,8 -> avg 9).
  const points = hourlyPoints([10, 9, 8, 20, 20, 20]);
  const window = cheapestWindow(points, 3);
  assert.ok(window);
  assert.equal(window.avg_sek_per_kwh, 9);
  assert.equal(window.start, points[0]!.time_start);
  assert.equal(window.end, points[2]!.time_end);
});

test("cheapestWindow: ties break toward the earliest start", () => {
  const points = hourlyPoints([5, 5, 5, 5]);
  const window = cheapestWindow(points, 2);
  assert.ok(window);
  assert.equal(window.start, points[0]!.time_start);
});

test("cheapestWindow: a window longer than the available data returns null, not a wrong average", () => {
  const points = hourlyPoints([10, 9, 8]);
  assert.equal(cheapestWindow(points, 5), null);
});

test("cheapestWindow: rejects a non-integer or non-positive window size", () => {
  const points = hourlyPoints([10, 9, 8]);
  assert.equal(cheapestWindow(points, 0), null);
  assert.equal(cheapestWindow(points, 1.5), null);
});

test("isCurrentlyCheap: true when the current hour is in the bottom quarter", () => {
  const points = hourlyPoints([1, 1, 20, 20, 20, 20, 20, 20]); // bottom 25% of 8 = 2 hours
  const now = new Date("2026-08-26T00:30:00+02:00"); // inside hour 0, price 1
  assert.equal(isCurrentlyCheap(points, now), true);
});

test("isCurrentlyCheap: false when the current hour is expensive", () => {
  const points = hourlyPoints([1, 1, 20, 20, 20, 20, 20, 20]);
  const now = new Date("2026-08-26T04:30:00+02:00"); // inside hour 4, price 20
  assert.equal(isCurrentlyCheap(points, now), false);
});

test("isCurrentlyCheap: false when `now` falls outside every point (no matching hour)", () => {
  const points = hourlyPoints([1, 1, 20]);
  const now = new Date("2026-08-27T00:30:00+02:00"); // a whole day later
  assert.equal(isCurrentlyCheap(points, now), false);
});

test("isCurrentlyCheap: false on an empty series", () => {
  assert.equal(isCurrentlyCheap([], new Date()), false);
});
