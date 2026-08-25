import { getDb } from "./index";
import { nowUtcIso } from "../time";

/** Whether the morning brief has already fired for this local day. */
export function hasBriefedToday(day: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM morning_briefs WHERE day = ?`).get(day);
  return row !== undefined;
}

/** Marks the day as handled. INSERT OR IGNORE: safe to call more than once. */
export function markBriefed(day: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO morning_briefs (day, sent_at) VALUES (?, ?)`).run(
    day,
    nowUtcIso(),
  );
}
