import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAtRiskNudge, formatDigest, formatPushMessage } from "./pusher";
import type { ReminderView } from "./db/reminders";
import type { HabitSummary } from "./db/habits";

function reminder(overrides: Partial<ReminderView> = {}): ReminderView {
  return {
    id: 1,
    text: "stretch",
    due_at: "2026-08-12T07:00:00.000Z",
    due_local: "Wednesday, 12 August 2026 at 09:00",
    overdue: true,
    completed_at: null,
    ...overrides,
  };
}

function habit(overrides: Partial<HabitSummary> = {}): HabitSummary {
  return {
    name: "reading",
    current_streak: 12,
    longest_streak: 12,
    at_risk: true,
    last_logged: "2026-08-10",
    ...overrides,
  };
}

test("zero reminders is a programming error, not a message", () => {
  assert.throws(() => formatPushMessage([]), /no reminders/);
});

test("a single reminder is one plain sentence", () => {
  const message = formatPushMessage([reminder()]);
  assert.equal(
    message,
    "stretch — was due Wednesday, 12 August 2026 at 09:00.",
  );
  assert.ok(!message.includes("\n"), "single reminder should not wrap into a list");
});

test("several reminders in one tick become a short list", () => {
  const message = formatPushMessage([
    reminder({ id: 1, text: "stretch", due_local: "09:00" }),
    reminder({ id: 2, text: "call the dentist", due_local: "10:30" }),
  ]);
  const lines = message.split("\n");
  assert.equal(lines.length, 3, "one header line plus one line per reminder");
  assert.match(lines[0]!, /came due/);
  assert.match(lines[1]!, /stretch \(09:00\)/);
  assert.match(lines[2]!, /call the dentist \(10:30\)/);
});

test("zero habits is a programming error, not a message", () => {
  assert.throws(() => formatAtRiskNudge([]), /no habits/);
});

test("a single at-risk habit is one plain sentence", () => {
  const message = formatAtRiskNudge([habit()]);
  assert.equal(message, "reading's at 12, nothing logged yet today.");
  assert.ok(!message.includes("\n"), "single habit should not wrap into a list");
});

test("several at-risk habits become a short list", () => {
  const message = formatAtRiskNudge([
    habit({ name: "reading", current_streak: 12 }),
    habit({ name: "meditation", current_streak: 5 }),
  ]);
  const lines = message.split("\n");
  assert.equal(lines.length, 3, "one header line plus one line per habit");
  assert.match(lines[0]!, /still open tonight/);
  assert.match(lines[1]!, /reading \(12 days\)/);
  assert.match(lines[2]!, /meditation \(5 days\)/);
});

test("digest with habits and reminders lists a line per habit plus a reminder summary", () => {
  const message = formatDigest(
    [
      habit({ name: "reading", current_streak: 12, at_risk: false }),
      habit({ name: "gym", current_streak: 0, at_risk: false }),
    ],
    new Map([
      ["reading", 6],
      ["gym", 2],
    ]),
    3,
    1,
  );
  const lines = message.split("\n");
  assert.equal(lines[0], "Week in review:");
  assert.equal(lines[1], "  - reading: 6/7, streak at 12");
  assert.equal(lines[2], "  - gym: 2/7, streak at 0");
  assert.equal(lines[3], "3 reminders done this week, 1 still open.");
});

test("digest with a single completed reminder uses the singular", () => {
  const message = formatDigest([], new Map(), 1, 0);
  assert.match(message, /1 reminder done this week, 0 still open\./);
});

test("digest with nothing tracked and a quiet week still sends", () => {
  const message = formatDigest([], new Map(), 0, 0);
  assert.match(message, /nothing tracked yet/);
  assert.match(message, /0 reminders done this week, 0 still open\./);
});

test("digest omits a habit's weekly count as 0 when it has no logs in the window", () => {
  const message = formatDigest([habit({ name: "meditation", current_streak: 0 })], new Map(), 0, 0);
  assert.match(message, /meditation: 0\/7, streak at 0/);
});
