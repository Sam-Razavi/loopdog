import { getDb } from "./index";
import { nowUtcIso } from "../time";

/** Same day-level dedup shape as db/nudges.ts's at-risk nudge — one entry per local day. */
export function hasElectricityNudgedToday(day: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM electricity_nudges WHERE day = ?`).get(day);
  return row !== undefined;
}

export function markElectricityNudged(day: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO electricity_nudges (day, sent_at) VALUES (?, ?)`)
    .run(day, nowUtcIso());
}
