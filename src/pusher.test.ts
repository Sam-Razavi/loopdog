import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPushMessage } from "./pusher";
import type { ReminderView } from "./db/reminders";

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
