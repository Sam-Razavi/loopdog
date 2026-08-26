import { getDb } from "./index";
import { nowUtcIso } from "../time";

export function hasSeenWarning(id: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM smhi_warnings_seen WHERE id = ?`).get(id);
  return row !== undefined;
}

export function markWarningSeen(id: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO smhi_warnings_seen (id, seen_at) VALUES (?, ?)`).run(id, nowUtcIso());
}
