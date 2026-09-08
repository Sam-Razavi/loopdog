import { getDb } from "./index";
import { nowUtcIso } from "../time";

/**
 * Dedup for Canvas deadline nudges — same shape and reasoning as
 * db/smhiwarnings.ts, keyed on Canvas's own assignment id plus which stage
 * of nudge it was. Two stages exist per assignment (a few days out, then the
 * due day), and each should fire once, so the key is the pair rather than
 * the id alone.
 */
export type CanvasNudgeKind = "advance" | "due_today";

export function hasNudgedForAssignment(assignmentId: number, kind: CanvasNudgeKind): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM canvas_assignment_nudges WHERE assignment_id = ? AND kind = ?`)
    .get(assignmentId, kind);
  return row !== undefined;
}

export function markNudgedForAssignment(assignmentId: number, kind: CanvasNudgeKind): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO canvas_assignment_nudges (assignment_id, kind, nudged_at) VALUES (?, ?, ?)`,
    )
    .run(assignmentId, kind, nowUtcIso());
}
