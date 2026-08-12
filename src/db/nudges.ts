import { getDb } from "./index";
import { nowUtcIso } from "../time";

/** Whether the at-risk nudge has already been evaluated for this local day. */
export function hasNudgedToday(day: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM at_risk_nudges WHERE day = ?`).get(day);
  return row !== undefined;
}

/**
 * Marks the day as handled — either a nudge went out, or the check ran and
 * found nothing at risk. INSERT OR IGNORE: safe to call more than once for
 * the same day without erroring.
 */
export function markNudged(day: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO at_risk_nudges (day, sent_at) VALUES (?, ?)`)
    .run(day, nowUtcIso());
}
