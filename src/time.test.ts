import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceLocalInstant, dayOfWeek, inQuietHours, localHour, localTimeOfDay } from "./time";

// Stockholm: +02:00 in summer (CEST), +01:00 in winter (CET).
test("localHour resolves against the configured zone in summer (+02:00)", () => {
  // 19:30 UTC in August is 21:30 in Stockholm.
  assert.equal(localHour(new Date("2026-08-11T19:30:00Z")), 21);
});

test("localHour resolves against the configured zone in winter (+01:00)", () => {
  // 19:30 UTC in January is 20:30 in Stockholm.
  assert.equal(localHour(new Date("2026-01-11T19:30:00Z")), 20);
});

test("localHour rolls over at midnight local time", () => {
  // 22:15 UTC in August is 00:15 the next day in Stockholm.
  assert.equal(localHour(new Date("2026-08-11T22:15:00Z")), 0);
});

test("localHour is a whole number 0-23, not zero-padded or a string", () => {
  const hour = localHour(new Date("2026-08-11T05:00:00Z")); // 07:00 local
  assert.equal(typeof hour, "number");
  assert.equal(hour, 7);
});

test("advanceLocalInstant preserves local wall-clock time on an ordinary day", () => {
  const start = new Date("2026-08-11T05:00:00Z"); // 07:00 local (CEST, +02:00)
  const next = advanceLocalInstant(start, 1);
  assert.deepEqual(localTimeOfDay(next), { day: "2026-08-12", hour: 7, minute: 0 });
});

test("advanceLocalInstant preserves local wall-clock time across a DST transition", () => {
  // Stockholm springs forward 2026-03-29 02:00 -> 03:00 (CET +01:00 -> CEST +02:00).
  const start = new Date("2026-03-28T06:00:00Z"); // 07:00 local (CET)
  const next = advanceLocalInstant(start, 1);
  assert.deepEqual(localTimeOfDay(next), { day: "2026-03-29", hour: 7, minute: 0 });
  // The UTC instant itself shifts by only 23h, since the offset moved too.
  assert.equal(next.toISOString(), "2026-03-29T05:00:00.000Z");
});

test("advanceLocalInstant supports a weekly (7-day) advance", () => {
  const start = new Date("2026-08-11T05:00:00Z"); // 07:00 local
  const next = advanceLocalInstant(start, 7);
  assert.deepEqual(localTimeOfDay(next), { day: "2026-08-18", hour: 7, minute: 0 });
});

test("dayOfWeek: Sunday is 0", () => {
  assert.equal(dayOfWeek("2026-08-23"), 0);
});

test("dayOfWeek: Tuesday is 2", () => {
  assert.equal(dayOfWeek("2026-08-25"), 2);
});

test("dayOfWeek: Saturday is 6", () => {
  assert.equal(dayOfWeek("2026-08-29"), 6);
});

// inQuietHours with an explicit start/end, so these don't depend on
// whatever LOOPDOG_QUIET_HOURS_START/END happen to be set in the process.
test("inQuietHours: inside a window spanning midnight (23-7)", () => {
  assert.equal(inQuietHours(new Date("2026-08-11T22:15:00Z"), 23, 7), true); // 00:15 local
  assert.equal(inQuietHours(new Date("2026-08-11T03:00:00Z"), 23, 7), true); // 05:00 local
});

test("inQuietHours: outside a window spanning midnight (23-7)", () => {
  assert.equal(inQuietHours(new Date("2026-08-11T05:00:00Z"), 23, 7), false); // 07:00 local
  assert.equal(inQuietHours(new Date("2026-08-11T12:00:00Z"), 23, 7), false); // 14:00 local
});

test("inQuietHours: the start hour is inside, the end hour is not", () => {
  // 23:00 local (start) is inside; 07:00 local (end) is outside — a
  // half-open window, [start, end).
  assert.equal(inQuietHours(new Date("2026-08-11T21:00:00Z"), 23, 7), true); // 23:00 local
  assert.equal(inQuietHours(new Date("2026-08-11T05:00:00Z"), 23, 7), false); // 07:00 local
});

test("inQuietHours: a non-wrapping window (e.g. 1-5)", () => {
  assert.equal(inQuietHours(new Date("2026-08-11T00:30:00Z"), 1, 5), true); // 02:30 local
  assert.equal(inQuietHours(new Date("2026-08-11T05:00:00Z"), 1, 5), false); // 07:00 local
});

test("inQuietHours: equal start and end disables the feature", () => {
  assert.equal(inQuietHours(new Date("2026-08-11T22:15:00Z"), 23, 23), false);
});
