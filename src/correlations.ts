import { getHabitDetail } from "./db/habits";
import { getMetricHistory } from "./db/metrics";
import { ToolError } from "./errors";

/**
 * Pure statistics over two day-aligned series — no database access, so these
 * are testable the same way streak.ts is. Deliberately simple math (a rate
 * difference for two booleans, a difference of averages for a habit against
 * a number, a Pearson coefficient for two numbers) rather than anything that
 * would read as more rigorous than it is: this is a personal habit tracker
 * comparing a few dozen days, not a study. The prompt-level rule (prompt.ts)
 * is what keeps small samples from being reported as if they were solid —
 * these functions just return the numbers and the counts behind them.
 */

export interface HabitHabitAssociation {
  /** How often B was also logged on days A was. Null if A was never logged in the window. */
  rate_b_when_a: number | null;
  /** How often B was logged on days A was NOT. Null if A was logged every day in the window. */
  rate_b_when_not_a: number | null;
  n_a_days: number;
  n_not_a_days: number;
  /** Percentage points, rate_b_when_a minus rate_b_when_not_a. Null unless both rates exist. */
  delta_percentage_points: number | null;
}

export function habitHabitAssociation(a: boolean[], b: boolean[]): HabitHabitAssociation {
  if (a.length !== b.length) throw new Error("series must be the same length");

  let aTrueBTrue = 0;
  let aTrue = 0;
  let aFalseBTrue = 0;
  let aFalse = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) {
      aTrue += 1;
      if (b[i]) aTrueBTrue += 1;
    } else {
      aFalse += 1;
      if (b[i]) aFalseBTrue += 1;
    }
  }

  const rateWhenA = aTrue > 0 ? aTrueBTrue / aTrue : null;
  const rateWhenNotA = aFalse > 0 ? aFalseBTrue / aFalse : null;
  return {
    rate_b_when_a: rateWhenA,
    rate_b_when_not_a: rateWhenNotA,
    n_a_days: aTrue,
    n_not_a_days: aFalse,
    delta_percentage_points:
      rateWhenA !== null && rateWhenNotA !== null ? (rateWhenA - rateWhenNotA) * 100 : null,
  };
}

export interface HabitMetricAssociation {
  avg_when_logged: number | null;
  avg_when_not_logged: number | null;
  n_when_logged: number;
  n_when_not_logged: number;
  delta: number | null;
}

/** `metric` may have gaps (no reading that day) — those days are excluded, not treated as zero. */
export function habitMetricAssociation(
  habit: boolean[],
  metric: (number | null)[],
): HabitMetricAssociation {
  if (habit.length !== metric.length) throw new Error("series must be the same length");

  const whenLogged: number[] = [];
  const whenNotLogged: number[] = [];
  for (let i = 0; i < habit.length; i++) {
    const value = metric[i]!;
    if (value === null) continue;
    (habit[i]! ? whenLogged : whenNotLogged).push(value);
  }

  const average = (values: number[]): number | null =>
    values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

  const avgLogged = average(whenLogged);
  const avgNotLogged = average(whenNotLogged);
  return {
    avg_when_logged: avgLogged,
    avg_when_not_logged: avgNotLogged,
    n_when_logged: whenLogged.length,
    n_when_not_logged: whenNotLogged.length,
    delta: avgLogged !== null && avgNotLogged !== null ? avgLogged - avgNotLogged : null,
  };
}

export interface MetricMetricCorrelation {
  /** Pearson correlation coefficient, -1 to 1. Null if fewer than 2 paired days, or either series has zero variation. */
  r: number | null;
  n_pairs: number;
}

export function metricMetricCorrelation(
  a: (number | null)[],
  b: (number | null)[],
): MetricMetricCorrelation {
  if (a.length !== b.length) throw new Error("series must be the same length");

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === null || y === null) continue;
    xs.push(x);
    ys.push(y);
  }

  const n = xs.length;
  if (n < 2) return { r: null, n_pairs: n };

  const meanX = xs.reduce((sum, v) => sum + v, 0) / n;
  const meanY = ys.reduce((sum, v) => sum + v, 0) / n;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return { r: null, n_pairs: n }; // no variation in one series
  return { r: numerator / Math.sqrt(denomX * denomY), n_pairs: n };
}

// --- Orchestration: resolves names against the database, then calls the
// pure functions above. Kept separate so the math stays testable without a
// database and this stays simple. ---------------------------------------

type ResolvedSeries =
  | { kind: "habit"; name: string; values: boolean[] }
  | { kind: "metric"; name: string; unit: string | null; values: (number | null)[] };

/** Habits and metrics are looked up in separate tables and could theoretically share a name; habit wins, same as everywhere else names get resolved in this codebase. */
function resolveSeries(name: string, days: number): ResolvedSeries {
  const habit = getHabitDetail(name, days);
  if (habit) return { kind: "habit", name: habit.name, values: habit.history.map((h) => h.logged) };

  const metric = getMetricHistory(name, days);
  if (metric) {
    return {
      kind: "metric",
      name: metric.name,
      unit: metric.unit,
      values: metric.history.map((h) => h.value),
    };
  }

  throw new ToolError(`no habit or metric called "${name}"`);
}

export type AssociationResult =
  | ({ kind: "habit_habit"; days: number; habit_a: string; habit_b: string } & HabitHabitAssociation)
  | ({
      kind: "habit_metric";
      days: number;
      habit: string;
      metric: string;
      metric_unit: string | null;
    } & HabitMetricAssociation)
  | ({
      kind: "metric_metric";
      days: number;
      metric_a: string;
      metric_b: string;
      metric_a_unit: string | null;
      metric_b_unit: string | null;
    } & MetricMetricCorrelation);

/** Resolves both names (either can be a habit or a metric) and computes whichever association applies. */
export function findAssociation(nameA: string, nameB: string, days: number): AssociationResult {
  const a = resolveSeries(nameA, days);
  const b = resolveSeries(nameB, days);

  if (a.kind === "habit") {
    if (b.kind === "habit") {
      return {
        kind: "habit_habit",
        days,
        habit_a: a.name,
        habit_b: b.name,
        ...habitHabitAssociation(a.values, b.values),
      };
    }
    return {
      kind: "habit_metric",
      days,
      habit: a.name,
      metric: b.name,
      metric_unit: b.unit,
      ...habitMetricAssociation(a.values, b.values),
    };
  }

  if (b.kind === "habit") {
    return {
      kind: "habit_metric",
      days,
      habit: b.name,
      metric: a.name,
      metric_unit: a.unit,
      ...habitMetricAssociation(b.values, a.values),
    };
  }

  return {
    kind: "metric_metric",
    days,
    metric_a: a.name,
    metric_b: b.name,
    metric_a_unit: a.unit,
    metric_b_unit: b.unit,
    ...metricMetricCorrelation(a.values, b.values),
  };
}
