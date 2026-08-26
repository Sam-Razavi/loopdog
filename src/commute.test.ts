import assert from "node:assert/strict";
import { test } from "node:test";
import { departureToUtc, leaveByUtc } from "./commute";

test("departureToUtc: a timestamp with an explicit UTC offset is used as-is", () => {
  const result = departureToUtc("2026-08-26T14:32:00+02:00");
  assert.equal(result, new Date("2026-08-26T14:32:00+02:00").toISOString());
});

test("departureToUtc: a timestamp with a Z suffix is used as-is", () => {
  const result = departureToUtc("2026-08-26T12:32:00Z");
  assert.equal(result, "2026-08-26T12:32:00.000Z");
});

test("departureToUtc: a bare local timestamp (no offset) is treated as Europe/Stockholm wall-clock time", () => {
  // August is summer time in Sweden (UTC+2), so 14:32 local is 12:32 UTC.
  const result = departureToUtc("2026-08-26T14:32:00");
  assert.equal(result, "2026-08-26T12:32:00.000Z");
});

test("departureToUtc: rejects an unrecognisable timestamp", () => {
  assert.throws(() => departureToUtc("not a timestamp"), /unrecognised departure timestamp/);
});

test("leaveByUtc: subtracts the lead time in minutes", () => {
  const result = leaveByUtc("2026-08-26T12:32:00.000Z", 10);
  assert.equal(result, "2026-08-26T12:22:00.000Z");
});

test("leaveByUtc: handles a lead time that crosses a day boundary", () => {
  const result = leaveByUtc("2026-08-26T00:05:00.000Z", 10);
  assert.equal(result, "2026-08-25T23:55:00.000Z");
});
