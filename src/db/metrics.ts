import { getDb } from "./index";
import { addDays, localDay, nowUtcIso } from "../time";

export type MetricMode = "latest" | "sum";

export interface MetricSummary {
  name: string;
  unit: string | null;
  mode: MetricMode;
  today_value: number | null;
  last_logged: string | null;
}

export interface MetricHistory {
  name: string;
  unit: string | null;
  mode: MetricMode;
  history: { day: string; value: number | null }[];
}

export interface LogMetricResult {
  name: string;
  unit: string | null;
  mode: MetricMode;
  day: string;
  value_logged: number;
  /** The day's aggregated value after this log — equal to value_logged for
   *  'latest' mode, or the running total for 'sum' mode. */
  day_total: number;
}

interface MetricRow {
  id: number;
  name: string;
  unit: string | null;
  mode: MetricMode;
}

function findMetric(name: string): MetricRow | undefined {
  return getDb()
    .prepare(`SELECT id, name, unit, mode FROM metrics WHERE name = ?`)
    .get(name.trim()) as MetricRow | undefined;
}

/** Metrics are implicit: the first log_metric call creates them, same as habits. */
function ensureMetric(
  name: string,
  unit: string | undefined,
  mode: MetricMode | undefined,
): MetricRow {
  const trimmed = name.trim();
  const existing = findMetric(trimmed);
  if (existing) return existing;
  getDb()
    .prepare(`INSERT INTO metrics (name, unit, mode, created_at) VALUES (?, ?, ?, ?)`)
    .run(trimmed, unit ?? null, mode ?? "latest", nowUtcIso());
  return findMetric(trimmed)!;
}

function dayValues(metricId: number, day: string): number[] {
  const rows = getDb()
    .prepare(`SELECT value FROM metric_logs WHERE metric_id = ? AND day = ? ORDER BY created_at ASC`)
    .all(metricId, day) as { value: number }[];
  return rows.map((r) => r.value);
}

/** 'latest': the most recently logged value that day. 'sum': all of them added up. */
function aggregate(values: number[], mode: MetricMode): number | null {
  if (values.length === 0) return null;
  return mode === "sum" ? values.reduce((sum, v) => sum + v, 0) : values[values.length - 1]!;
}

export function logMetric(
  name: string,
  day: string,
  value: number,
  opts: { unit?: string; mode?: MetricMode; note?: string } = {},
): LogMetricResult {
  const metric = ensureMetric(name, opts.unit, opts.mode);
  getDb()
    .prepare(
      `INSERT INTO metric_logs (metric_id, day, value, note, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(metric.id, day, value, opts.note ?? null, nowUtcIso());

  const dayTotal = aggregate(dayValues(metric.id, day), metric.mode)!;
  return {
    name: metric.name,
    unit: metric.unit,
    mode: metric.mode,
    day,
    value_logged: value,
    day_total: dayTotal,
  };
}

export function getMetricHistory(name: string, days: number): MetricHistory | null {
  const metric = findMetric(name);
  if (!metric) return null;

  const today = localDay();
  const startDay = addDays(today, -(days - 1));
  const rows = getDb()
    .prepare(
      `SELECT day, value FROM metric_logs WHERE metric_id = ? AND day >= ? ORDER BY day ASC, created_at ASC`,
    )
    .all(metric.id, startDay) as { day: string; value: number }[];

  const byDay = new Map<string, number[]>();
  for (const row of rows) {
    const list = byDay.get(row.day) ?? [];
    list.push(row.value);
    byDay.set(row.day, list);
  }

  const history: { day: string; value: number | null }[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = addDays(today, -offset);
    history.push({ day, value: aggregate(byDay.get(day) ?? [], metric.mode) });
  }

  return { name: metric.name, unit: metric.unit, mode: metric.mode, history };
}

export function listMetrics(): MetricSummary[] {
  const metrics = getDb()
    .prepare(`SELECT id, name, unit, mode FROM metrics ORDER BY name ASC`)
    .all() as MetricRow[];
  const today = localDay();

  return metrics.map((metric) => {
    const lastRow = getDb()
      .prepare(`SELECT day FROM metric_logs WHERE metric_id = ? ORDER BY day DESC LIMIT 1`)
      .get(metric.id) as { day: string } | undefined;
    return {
      name: metric.name,
      unit: metric.unit,
      mode: metric.mode,
      today_value: aggregate(dayValues(metric.id, today), metric.mode),
      last_logged: lastRow?.day ?? null,
    };
  });
}
