import { listGoals } from "./db/goals";
import { getMetricHistory } from "./db/metrics";
import { projectGoal, type GoalProgress } from "./goals";
import { localDay } from "./time";

/** How far back to look when fitting a trend. */
const TREND_DAYS = 90;

export interface GoalWithProgress extends GoalProgress {
  metric_name: string;
  unit: string | null;
}

/**
 * Every goal with its projection filled in. Shared by the list_goals tool
 * and the Sunday digest — same gather-once-format-twice split as
 * gatherWeekSummary, so the number the digest quotes and the number the
 * tool returns can't drift apart.
 */
export function goalsWithProgress(today = localDay()): GoalWithProgress[] {
  return listGoals().map((goal) => {
    const metric = getMetricHistory(goal.metric_name, TREND_DAYS);
    return {
      metric_name: goal.metric_name,
      unit: metric?.unit ?? null,
      ...projectGoal(metric?.history ?? [], goal.target_value, goal.deadline_day, today),
    };
  });
}
