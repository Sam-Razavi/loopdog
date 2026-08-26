import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleWeekOverview } from "./overview";
import type { ReminderView } from "./db/reminders";
import type { ImportantDateView } from "./db/importantdates";
import type { SwedishHoliday } from "./swedishholidays";
import type { CanvasAssignment } from "./canvas";

function reminder(overrides: Partial<ReminderView> = {}): ReminderView {
  return {
    id: 1,
    text: "water the plants",
    due_at: "2026-08-27T08:00:00.000Z",
    due_local: "Thursday, 27 August 2026 at 10:00",
    overdue: false,
    completed_at: null,
    recurrence: null,
    ...overrides,
  };
}

function importantDate(overrides: Partial<ImportantDateView> = {}): ImportantDateView {
  return {
    id: 1,
    name: "Mom's birthday",
    month: 3,
    day: 3,
    note: null,
    created_at: "2026-01-01T00:00:00.000Z",
    next_occurrence: "2027-03-03",
    days_until: 189,
    ...overrides,
  };
}

function assignment(overrides: Partial<CanvasAssignment> = {}): CanvasAssignment {
  return { id: 1, name: "Problem set 3", course: "Algorithms", dueAt: "2026-08-28T23:59:00Z", url: null, ...overrides };
}

test("assembleWeekOverview: filters important dates to the days window, passes reminders through unchanged", () => {
  const reminders = [reminder()];
  const dates = [
    importantDate({ name: "soon", days_until: 3 }),
    importantDate({ name: "just outside", days_until: 8 }),
    importantDate({ name: "far off", days_until: 200 }),
  ];
  const result = assembleWeekOverview(reminders, dates, [], [], "2026-08-26", 7, null);
  assert.deepEqual(result.reminders, reminders);
  assert.deepEqual(
    result.important_dates.map((d) => d.name),
    ["soon"],
  );
});

test("assembleWeekOverview: merges holidays from both years and filters to the date range, sorted", () => {
  const thisYear: SwedishHoliday[] = [
    { name: "Christmas Day", date: "2026-12-25" },
    { name: "Boxing Day", date: "2026-12-26" },
  ];
  const nextYear: SwedishHoliday[] = [{ name: "New Year's Day", date: "2027-01-01" }];
  // Window: 2026-12-24 through 2027-01-02 (crosses the year boundary).
  const result = assembleWeekOverview([], [], thisYear, nextYear, "2026-12-24", 9, null);
  assert.deepEqual(
    result.swedish_holidays.map((h) => h.date),
    ["2026-12-25", "2026-12-26", "2027-01-01"],
  );
});

test("assembleWeekOverview: excludes holidays outside the window even when both years are supplied", () => {
  const thisYear: SwedishHoliday[] = [{ name: "New Year's Day", date: "2026-01-01" }]; // long past
  const nextYear: SwedishHoliday[] = [{ name: "New Year's Day", date: "2027-01-01" }]; // far future
  const result = assembleWeekOverview([], [], thisYear, nextYear, "2026-08-26", 7, null);
  assert.equal(result.swedish_holidays.length, 0);
});

test("assembleWeekOverview: canvas_assignments passes through null unchanged", () => {
  const result = assembleWeekOverview([], [], [], [], "2026-08-26", 7, null);
  assert.equal(result.canvas_assignments, null);
});

test("assembleWeekOverview: canvas_assignments passes through a populated array unchanged", () => {
  const assignments = [assignment()];
  const result = assembleWeekOverview([], [], [], [], "2026-08-26", 7, assignments);
  assert.deepEqual(result.canvas_assignments, assignments);
});
