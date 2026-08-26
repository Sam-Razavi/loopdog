import { getMetricHistory } from "./db/metrics";
import { ToolError } from "./errors";

/**
 * Reuses db/metrics.ts entirely — no new SQL. A 'sum'-mode metric (the
 * shape receipts already get logged into, same as calories) already has
 * everything needed to total up by month; this just groups the existing
 * daily history differently.
 */

export interface MonthTotal {
  month: string; // YYYY-MM
  total: number;
}

/**
 * Pure. Groups by calendar month and sums, skipping days with no log at
 * all — a month with zero activity simply doesn't appear, rather than
 * showing up as an explicit zero.
 */
export function monthlyTotals(history: { day: string; value: number | null }[]): MonthTotal[] {
  const byMonth = new Map<string, number>();
  for (const { day, value } of history) {
    if (value === null) continue;
    const month = day.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + value);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, total]) => ({ month, total }));
}

export interface MonthlySpending {
  metric: string;
  unit: string | null;
  months: MonthTotal[];
}

export function getMonthlySpending(metricName: string, months: number): MonthlySpending {
  // A generous overshoot — days rather than months, so an extra partial
  // month at the start of the window is harmless (still grouped correctly,
  // just not a full month's worth).
  const history = getMetricHistory(metricName, months * 31);
  if (!history) throw new ToolError(`no metric called "${metricName}" — check list_metrics for what's tracked`);
  return { metric: history.name, unit: history.unit, months: monthlyTotals(history.history) };
}
