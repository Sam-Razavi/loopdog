import { getDb } from "./index";
import { daysBetween, isValidDay, localDay, nowUtcIso } from "../time";
import { ToolError } from "../errors";

export interface ImportantDate {
  id: number;
  name: string;
  month: number;
  day: number;
  note: string | null;
  created_at: string;
}

export interface ImportantDateView extends ImportantDate {
  next_occurrence: string; // YYYY-MM-DD
  days_until: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 2024 is a leap year, so this also accepts Feb 29 as a valid month/day combination. */
function isValidMonthDay(month: number, day: number): boolean {
  return isValidDay(`2024-${pad(month)}-${pad(day)}`);
}

/** Feb 29 in a non-leap year falls back to Feb 28 that year — a common, simple convention. */
function dateInYear(month: number, day: number, year: number): string {
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  if (isValidDay(candidate)) return candidate;
  return `${year}-${pad(month)}-${pad(day - 1)}`;
}

/**
 * The next real calendar date a month/day combination falls on, relative to
 * `today` — this year if it hasn't passed yet, next year otherwise. Pure,
 * so it's testable without a database, same reasoning as every other date
 * helper in this project (streak.ts, electricity.ts's cheapestWindow).
 */
export function nextOccurrence(month: number, day: number, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = dateInYear(month, day, year);
  return thisYear >= today ? thisYear : dateInYear(month, day, year + 1);
}

function getRow(id: number): ImportantDate | undefined {
  return getDb().prepare(`SELECT * FROM important_dates WHERE id = ?`).get(id) as ImportantDate | undefined;
}

/**
 * Case-insensitive match on name + month + day. Unlike habits/metrics
 * (ensureHabit/ensureMetric — implicitly reused by name, never duplicated),
 * this table had no such guard, and it showed: a live agent run asking to
 * add a second date in the same turn as an already-added one re-added the
 * first, silently duplicating it. Same "implicit, idempotent by name"
 * pattern as the rest of this codebase, applied here for the same reason.
 */
function findExisting(name: string, month: number, day: number): ImportantDate | undefined {
  return getDb()
    .prepare(`SELECT * FROM important_dates WHERE name = ? COLLATE NOCASE AND month = ? AND day = ?`)
    .get(name.trim(), month, day) as ImportantDate | undefined;
}

function view(row: ImportantDate): ImportantDateView {
  const today = localDay();
  const next = nextOccurrence(row.month, row.day, today);
  return { ...row, next_occurrence: next, days_until: daysBetween(today, next) };
}

export function addDate(name: string, month: number, day: number, note?: string): ImportantDateView {
  if (!isValidMonthDay(month, day)) {
    throw new ToolError(`"${month}/${day}" isn't a valid month/day`);
  }
  const existing = findExisting(name, month, day);
  if (existing) return view(existing);

  const now = nowUtcIso();
  const result = getDb()
    .prepare(`INSERT INTO important_dates (name, month, day, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(name.trim(), month, day, note ?? null, now);
  return view(getRow(Number(result.lastInsertRowid))!);
}

/** Sorted soonest-first. */
export function listDates(): ImportantDateView[] {
  const rows = getDb().prepare(`SELECT * FROM important_dates`).all() as ImportantDate[];
  return rows.map(view).sort((a, b) => a.days_until - b.days_until);
}

export function removeDate(id: number): ImportantDate {
  const existing = getRow(id);
  if (!existing) throw new ToolError(`no important date with id ${id}`);
  getDb().prepare(`DELETE FROM important_dates WHERE id = ?`).run(id);
  return existing;
}

// --- Proactive-nudge dedup ------------------------------------------------

export type NudgeKind = "advance" | "today";

export function hasNudgedForOccurrence(dateId: number, year: number, kind: NudgeKind): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM important_date_nudges WHERE date_id = ? AND year = ? AND kind = ?`)
    .get(dateId, year, kind);
  return row !== undefined;
}

export function markNudgedForOccurrence(dateId: number, year: number, kind: NudgeKind): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO important_date_nudges (date_id, year, kind, sent_at) VALUES (?, ?, ?, ?)`)
    .run(dateId, year, kind, nowUtcIso());
}
