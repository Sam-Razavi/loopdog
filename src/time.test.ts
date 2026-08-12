import assert from "node:assert/strict";
import { test } from "node:test";
import { localHour } from "./time";

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
