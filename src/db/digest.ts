import { getDb } from "./index";
import { nowUtcIso } from "../time";

/** Whether the Sunday digest has already fired for this week. */
export function hasDigestedThisWeek(week: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM digests WHERE week = ?`).get(week);
  return row !== undefined;
}

/** Marks the week as handled. INSERT OR IGNORE: safe to call more than once. */
export function markDigested(week: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO digests (week, sent_at) VALUES (?, ?)`).run(
    week,
    nowUtcIso(),
  );
}
