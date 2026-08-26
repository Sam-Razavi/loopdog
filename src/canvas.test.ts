import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnnouncements, parseAssignments, parseCourses, parseGrades, withinWindow } from "./canvas";

test("parseCourses: keeps well-formed courses, drops malformed entries", () => {
  const raw = [
    { id: 101, name: "Algorithms", course_code: "DD2440" },
    { id: 102, name: "no course_code" },
    { name: "missing id" },
    { id: 103 }, // missing name
    "not an object",
    null,
  ];
  const courses = parseCourses(raw);
  assert.deepEqual(courses, [
    { id: 101, name: "Algorithms", code: "DD2440" },
    { id: 102, name: "no course_code", code: "" },
  ]);
});

test("parseAssignments: drops assignments with no due date", () => {
  const raw = [
    { id: 1, name: "Lab 1", due_at: "2026-09-01T23:59:00Z", html_url: "https://x/1" },
    { id: 2, name: "Undated survey" }, // no due_at
    { id: 3, name: "Lab 2", due_at: "2026-09-05T23:59:00Z" }, // no html_url, still valid
  ];
  const assignments = parseAssignments(raw, "Algorithms");
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0]!.course, "Algorithms");
  assert.equal(assignments[1]!.url, null);
});

test("withinWindow: sorts soonest-first and excludes anything outside the day window", () => {
  const assignments = [
    { id: 1, name: "Far off", course: "A", dueAt: "2026-10-01T00:00:00Z", url: null },
    { id: 2, name: "Tomorrow", course: "A", dueAt: "2026-08-27T00:00:00Z", url: null },
    { id: 3, name: "Yesterday", course: "A", dueAt: "2026-08-25T00:00:00Z", url: null },
    { id: 4, name: "Today", course: "A", dueAt: "2026-08-26T12:00:00Z", url: null },
  ];
  const result = withinWindow(assignments, 7, "2026-08-26");
  assert.deepEqual(
    result.map((a) => a.name),
    ["Today", "Tomorrow"],
  );
});

test("parseAnnouncements: resolves course names via context code, sorts newest first, strips HTML from message", () => {
  const raw = [
    {
      id: 1,
      title: "Old post",
      message: "<p>See you <b>Monday</b>.</p>",
      context_code: "course_101",
      posted_at: "2026-08-01T10:00:00Z",
      html_url: "https://x/old",
    },
    {
      id: 2,
      title: "New post",
      message: "<p>Exam moved.</p>",
      context_code: "course_102",
      posted_at: "2026-08-20T10:00:00Z",
      html_url: "https://x/new",
    },
    { id: 3, title: "no context code at all", posted_at: "2026-08-15T10:00:00Z" },
  ];
  const byContext = new Map([
    ["course_101", "Algorithms"],
    ["course_102", "Databases"],
  ]);
  const announcements = parseAnnouncements(raw, byContext);
  assert.deepEqual(
    announcements.map((a) => a.title),
    ["New post", "no context code at all", "Old post"],
  );
  assert.equal(announcements[0]!.course, "Databases");
  assert.equal(announcements[0]!.message, "Exam moved.");
  assert.equal(announcements[2]!.course, "Algorithms");
  // extractReadableText replaces tags with a space, so the closing </b> before
  // the period leaves a space — same behavior as every other HTML source it parses.
  assert.equal(announcements[2]!.message, "See you Monday .");
});

test("parseGrades: resolves course names, drops entries with no grades object or an unknown course", () => {
  const raw = [
    { course_id: 101, grades: { current_score: 87.5, current_grade: "B+" } },
    { course_id: 102 }, // no grades object at all
    { course_id: 999, grades: { current_score: 50, current_grade: "F" } }, // unknown course id
    { course_id: 101, grades: { current_grade: "A" } }, // score not a number, stays null
  ];
  const courseById = new Map([
    [101, "Algorithms"],
    [102, "Databases"],
  ]);
  const grades = parseGrades(raw, courseById);
  assert.deepEqual(grades, [
    { course: "Algorithms", currentScore: 87.5, currentGrade: "B+" },
    { course: "Algorithms", currentScore: null, currentGrade: "A" },
  ]);
});
