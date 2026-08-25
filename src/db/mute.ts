import { getDb } from "./index";
import { nowUtcIso } from "../time";

/**
 * Returns the active mute's end time (UTC ISO), or null if not muted.
 * An expired mute is cleared as a side effect of checking — no separate
 * cleanup job needed; the very next check after `until` passes resumes
 * normal proactive DMs.
 */
export function getMuteUntil(): string | null {
  const row = getDb().prepare(`SELECT until FROM mute WHERE id = 1`).get() as
    | { until: string }
    | undefined;
  if (!row) return null;
  if (row.until <= nowUtcIso()) {
    getDb().prepare(`DELETE FROM mute WHERE id = 1`).run();
    return null;
  }
  return row.until;
}

/** Sets (or replaces) the mute end time. */
export function setMute(untilUtc: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO mute (id, until) VALUES (1, ?)`).run(untilUtc);
}

/** Clears an active mute early. Returns whether one was actually cleared. */
export function clearMute(): boolean {
  const result = getDb().prepare(`DELETE FROM mute WHERE id = 1`).run();
  return result.changes > 0;
}
