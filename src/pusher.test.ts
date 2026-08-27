import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAtRiskNudge, formatDigest, formatImportantDateNudge, formatMorningBrief, formatPushMessage } from "./pusher";
import type { WeeklyHabitStat } from "./pusher";
import type { ReminderView, Recurrence } from "./db/reminders";
import type { HabitSummary } from "./db/habits";
import type { CalendarEvent } from "./google";
import type { CanvasAssignment } from "./canvas";
import type { SwedishHoliday } from "./swedishholidays";

function assignment(overrides: Partial<CanvasAssignment> = {}): CanvasAssignment {
  return { id: 1, name: "Problem set 3", course: "Algorithms", dueAt: "2026-08-12T23:59:00Z", url: null, ...overrides };
}

function holiday(overrides: Partial<SwedishHoliday> = {}): SwedishHoliday {
  return { name: "Midsommardagen (Midsummer Day)", date: "2026-06-20", ...overrides };
}

function reminder(overrides: Partial<ReminderView> = {}): ReminderView {
  return {
    id: 1,
    text: "stretch",
    due_at: "2026-08-12T07:00:00.000Z",
    due_local: "Wednesday, 12 August 2026 at 09:00",
    overdue: true,
    completed_at: null,
    recurrence: null as Recurrence | null,
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

function weeklyHabit(overrides: Partial<WeeklyHabitStat> = {}): WeeklyHabitStat {
  return { ...habit(), days_logged: 0, ...overrides };
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
      weeklyHabit({ name: "reading", current_streak: 12, at_risk: false, days_logged: 6 }),
      weeklyHabit({ name: "gym", current_streak: 0, at_risk: false, days_logged: 2 }),
    ],
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
  const message = formatDigest([], 1, 0);
  assert.match(message, /1 reminder done this week, 0 still open\./);
});

test("digest with nothing tracked and a quiet week still sends", () => {
  const message = formatDigest([], 0, 0);
  assert.match(message, /nothing tracked yet/);
  assert.match(message, /0 reminders done this week, 0 still open\./);
});

test("digest shows a habit's own days_logged, not a shared default", () => {
  const message = formatDigest(
    [weeklyHabit({ name: "meditation", current_streak: 0, days_logged: 0 })],
    0,
    0,
  );
  assert.match(message, /meditation: 0\/7, streak at 0/);
});

test("digest with upcoming Canvas assignments and holidays adds a 'Coming up this week' section", () => {
  const message = formatDigest([], 0, 0, [assignment({ name: "Problem set 3" })], [holiday()]);
  const lines = message.split("\n");
  assert.equal(lines[3], "Coming up this week:");
  assert.match(lines[4]!, /Problem set 3 \(Algorithms, due 2026-08-12\)/);
  assert.match(lines[5]!, /Midsommardagen \(Midsummer Day\) \(2026-06-20\)/);
});

test("digest with no upcoming assignments or holidays omits the 'Coming up' section entirely", () => {
  const message = formatDigest([], 0, 0, [], []);
  assert.ok(!message.includes("Coming up this week"));
});

test("morning brief with nothing due and nothing at risk is a programming error, not a message", () => {
  assert.throws(() => formatMorningBrief([], []), /nothing to say/);
});

test("morning brief with only reminders due lists them under 'Due today'", () => {
  const message = formatMorningBrief(
    [reminder({ text: "stretch", due_local: "09:00" })],
    [],
  );
  const lines = message.split("\n");
  assert.equal(lines[0], "Due today:");
  assert.equal(lines[1], "  - stretch (09:00)");
  assert.ok(!message.includes("At risk"), "no at-risk section when nothing is at risk");
});

test("morning brief with only at-risk habits lists them under 'At risk'", () => {
  const message = formatMorningBrief([], [habit({ name: "reading", current_streak: 12 })]);
  const lines = message.split("\n");
  assert.equal(lines[0], "At risk:");
  assert.equal(lines[1], "  - reading (12 days)");
  assert.ok(!message.includes("Due today"), "no due-today section when nothing is due");
});

test("morning brief with both sections includes reminders first, then at-risk habits", () => {
  const message = formatMorningBrief(
    [reminder({ text: "stretch", due_local: "09:00" })],
    [habit({ name: "reading", current_streak: 12 })],
  );
  const lines = message.split("\n");
  assert.equal(lines[0], "Due today:");
  assert.equal(lines[1], "  - stretch (09:00)");
  assert.equal(lines[2], "At risk:");
  assert.equal(lines[3], "  - reading (12 days)");
});

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    summary: "Team sync",
    start: "2026-08-12T07:00:00.000Z",
    end: "2026-08-12T07:30:00.000Z",
    calendar: "primary",
    ...overrides,
  };
}

test("morning brief with only calendar events lists them under 'On the calendar today'", () => {
  const message = formatMorningBrief([], [], [calendarEvent()]);
  const lines = message.split("\n");
  assert.equal(lines[0], "On the calendar today:");
  assert.match(lines[1]!, /Team sync/);
});

test("morning brief puts calendar events first, ahead of reminders and at-risk habits", () => {
  const message = formatMorningBrief(
    [reminder({ text: "stretch", due_local: "09:00" })],
    [habit({ name: "reading", current_streak: 12 })],
    [calendarEvent({ summary: "Dentist" })],
  );
  const lines = message.split("\n");
  assert.equal(lines[0], "On the calendar today:");
  assert.match(lines[1]!, /Dentist/);
  assert.equal(lines[2], "Due today:");
  assert.equal(lines[4], "At risk:");
});

test("morning brief shows an all-day event distinctly from a timed one", () => {
  const message = formatMorningBrief([], [], [calendarEvent({ summary: "Public holiday", start: "2026-08-12" })]);
  assert.match(message, /Public holiday \(all day\)/);
});

test("morning brief with nothing at all — no reminders, habits, or events — is still a programming error", () => {
  assert.throws(() => formatMorningBrief([], [], []), /nothing to say/);
});

test("morning brief with only a Canvas assignment due today lists it under 'Due on Canvas today'", () => {
  const message = formatMorningBrief([], [], [], [assignment({ name: "Lab report" })]);
  const lines = message.split("\n");
  assert.equal(lines[0], "Due on Canvas today:");
  assert.match(lines[1]!, /Lab report \(Algorithms\)/);
});

test("morning brief with only a holiday today leads with it", () => {
  const message = formatMorningBrief([], [], [], [], "Midsommardagen (Midsummer Day)");
  assert.equal(message, "Today's a public holiday: Midsommardagen (Midsummer Day).");
});

test("morning brief with a holiday and other sections puts the holiday line first", () => {
  const message = formatMorningBrief(
    [reminder({ text: "stretch" })],
    [],
    [],
    [],
    "Midsommardagen (Midsummer Day)",
  );
  const lines = message.split("\n");
  assert.equal(lines[0], "Today's a public holiday: Midsommardagen (Midsummer Day).");
  assert.equal(lines[1], "Due today:");
});

test("morning brief with nothing at all, including no Canvas assignments or holiday, is still a programming error", () => {
  assert.throws(() => formatMorningBrief([], [], [], [], null), /nothing to say/);
});
test("important-date nudge: zero pending is a programming error, not a message", () => {
  assert.throws(() => formatImportantDateNudge([]), /nothing to say/);
});

test("important-date nudge: a single 'today' date is one plain sentence", () => {
  const message = formatImportantDateNudge([
    { date: { name: "Mom's birthday", note: null }, kind: "today" },
  ]);
  assert.equal(message, "Today: Mom's birthday.");
});

test("important-date nudge: a single advance date includes the note", () => {
  const message = formatImportantDateNudge([
    { date: { name: "Anniversary", note: "book the restaurant" }, kind: "advance" },
  ]);
  assert.equal(message, "In 7 days: Anniversary — book the restaurant.");
});

test("important-date nudge: multiple pending dates batch into one message, one line each", () => {
  const message = formatImportantDateNudge([
    { date: { name: "Mom's birthday", note: null }, kind: "today" },
    { date: { name: "Dad's birthday", note: null }, kind: "advance" },
  ]);
  const lines = message.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Today: Mom's birthday.");
  assert.equal(lines[1], "In 7 days: Dad's birthday.");
});
