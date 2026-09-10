import { addDays } from "./time";

/**
 * Pace projection for a metric with a target and a deadline. Pure over an
 * already-fetched history, same split as correlations.ts: the maths is
 * testable without a database or a clock.
 *
 * The honesty rules here matter more than the arithmetic, and they mirror
 * how find_correlation already behaves. Three readings is not a trend; a
 * number drifting the wrong way has no arrival date worth printing; and a
 * flat line projected forward divides by ~zero and produces a confident
 * answer decades out. Each of those returns a named verdict instead of a
 * fabricated date — a projection is only useful if it isn't quietly making
 * things up.
 */

/** Below this, a "trend" is just noise. */
const MIN_POINTS = 4;

/**
 * Slope smaller than this (in metric units per day) counts as flat.
 * Deliberately absolute rather than relative: for a weight in kg, moving
 * less than 1g/day is not progress by any reading.
 */
const FLAT_SLOPE = 0.001;

export type GoalVerdict =
  | "on_track"
  | "behind"
  | "reached"
  | "wrong_way"
  | "flat"
  | "not_enough_data";

export interface GoalProgress {
  verdict: GoalVerdict;
  current: number | null;
  target: number;
  deadline: string;
  /** Metric units per day, from a least-squares fit. Null when not computable. */
  rate_per_day: number | null;
  /** When the trend says the target is actually reached. Null unless projectable. */
  projected_day: string | null;
  /** Days late (positive) or early (negative) versus the deadline. */
  days_off: number | null;
  /** The per-day rate needed from today to land exactly on the deadline. */
  needed_rate_per_day: number | null;
}

export interface HistoryPoint {
  day: string;
  value: number | null;
}

/** Pure. Least-squares slope and intercept over (index, value), skipping gaps. */
function fit(points: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return null; // every reading on the same day
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

/**
 * Pure. `history` is the shape getMetricHistory returns (a dense run of
 * days, gaps as null); `today` and `deadline` are YYYY-MM-DD.
 */
export function projectGoal(
  history: HistoryPoint[],
  target: number,
  deadline: string,
  today: string,
): GoalProgress {
  const logged = history.filter((p): p is { day: string; value: number } => p.value !== null);
  const current = logged.length ? logged[logged.length - 1]!.value : null;
  const daysLeft = daysBetween(today, deadline);

  const base: GoalProgress = {
    verdict: "not_enough_data",
    current,
    target,
    deadline,
    rate_per_day: null,
    projected_day: null,
    days_off: null,
    needed_rate_per_day: null,
  };

  if (current === null || logged.length < MIN_POINTS) return base;

  // Direction is inferred rather than stored — one less thing that can
  // drift out of sync. Inferred from where the metric *started* relative to
  // the target, not from where it is now: comparing against the current
  // value flips the moment you overshoot, so climbing to 75 and reaching 76
  // got reported as "moving the wrong way" instead of "reached".
  const goingUp = target > logged[0]!.value;
  const remaining = target - current;
  const needed = daysLeft > 0 ? remaining / daysLeft : null;

  if ((goingUp && current >= target) || (!goingUp && current <= target)) {
    return { ...base, verdict: "reached", needed_rate_per_day: needed };
  }

  const fitted = fit(logged.map((p) => ({ x: daysBetween(logged[0]!.day, p.day), y: p.value })));
  if (!fitted) return { ...base, needed_rate_per_day: needed };

  const { slope } = fitted;
  const withRate = { ...base, rate_per_day: slope, needed_rate_per_day: needed };

  if (Math.abs(slope) < FLAT_SLOPE) return { ...withRate, verdict: "flat" };
  if (goingUp !== slope > 0) return { ...withRate, verdict: "wrong_way" };

  const daysToTarget = Math.ceil(remaining / slope);
  const projectedDay = addDays(today, daysToTarget);
  const daysOff = daysBetween(deadline, projectedDay);

  return {
    ...withRate,
    verdict: daysOff <= 0 ? "on_track" : "behind",
    projected_day: projectedDay,
    days_off: daysOff,
  };
}
