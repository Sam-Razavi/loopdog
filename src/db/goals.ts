import { getDb } from "./index";
import { nowUtcIso } from "../time";

export interface GoalRow {
  id: number;
  metric_name: string;
  target_value: number;
  deadline_day: string;
  created_at: string;
}

/**
 * Storage only — the projection maths lives in ../goals.ts, pure and
 * separately testable, the same split correlations.ts uses.
 *
 * Upsert rather than insert: "actually make it 73 by March" is a correction
 * to the existing goal, not a second competing target for the same metric.
 */
export function setGoal(metricName: string, targetValue: number, deadlineDay: string): GoalRow {
  getDb()
    .prepare(
      `INSERT INTO goals (metric_name, target_value, deadline_day, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(metric_name) DO UPDATE SET target_value = excluded.target_value,
                                              deadline_day = excluded.deadline_day`,
    )
    .run(metricName, targetValue, deadlineDay, nowUtcIso());
  return getGoal(metricName)!;
}

export function getGoal(metricName: string): GoalRow | undefined {
  return getDb().prepare(`SELECT * FROM goals WHERE metric_name = ?`).get(metricName) as GoalRow | undefined;
}

export function listGoals(): GoalRow[] {
  return getDb().prepare(`SELECT * FROM goals ORDER BY deadline_day ASC`).all() as GoalRow[];
}

export function deleteGoal(metricName: string): GoalRow | null {
  const existing = getGoal(metricName);
  if (!existing) return null;
  getDb().prepare(`DELETE FROM goals WHERE id = ?`).run(existing.id);
  return existing;
}
