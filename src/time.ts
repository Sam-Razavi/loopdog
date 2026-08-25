import { config } from "./config";
import { ToolError } from "./errors";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The 4am rule.
 *
 * Loopdog's "day" runs from LOOPDOG_DAY_CUTOFF_HOUR to the same hour the next
 * morning, so a gym session logged at 01:30 counts for the night it actually
 * happened rather than silently starting a new day. We shift the absolute
 * instant backwards and then format it in the configured zone, which keeps DST
 * handling in the platform's hands.
 */
export function localDay(instant: Date = new Date()): string {
  const shifted = new Date(instant.getTime() - config.dayCutoffHour * HOUR_MS);
  return dayFormatter.format(shifted);
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const stampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.timezone,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Human-readable local timestamp, for the prompt and for reminder listings. */
export function formatLocal(instant: Date = new Date()): string {
  return stampFormatter.format(instant);
}

/** Shift a YYYY-MM-DD string by whole days. Pure string arithmetic, no zone. */
export function addDays(day: string, delta: number): string {
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

export function previousDay(day: string): string {
  return addDays(day, -1);
}

/** Whole days between two YYYY-MM-DD strings (later minus earlier). */
export function daysBetween(earlier: string, later: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS,
  );
}

export function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

/**
 * Normalise a timestamp from Claude into UTC. We ask for an explicit offset in
 * the tool description; a bare local timestamp would be ambiguous, so it is
 * rejected rather than guessed at.
 */
export function toUtcIso(value: string): string {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
    throw new ToolError(
      `due_at must include a UTC offset (e.g. 2026-08-12T09:00:00+02:00), got "${value}"`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ToolError(`due_at is not a valid ISO-8601 timestamp: "${value}"`);
  }
  return parsed.toISOString();
}

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.timezone,
  hour: "2-digit",
  hourCycle: "h23",
});

/** The local hour (0-23) in the configured zone, for the at-risk nudge gate. */
export function localHour(instant: Date = new Date()): number {
  const part = hourFormatter.formatToParts(instant).find((p) => p.type === "hour");
  return Number(part?.value ?? "0");
}

/** The offset string the configured zone is currently observing, e.g. "+02:00". */
export function currentOffset(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "") || "+00:00";
}

const timeOfDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The calendar day and wall-clock time an instant falls on, in the configured zone. */
export function localTimeOfDay(instant: Date = new Date()): {
  day: string;
  hour: number;
  minute: number;
} {
  const parts = timeOfDayFormatter.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/**
 * The UTC instant for a specific local day + wall-clock time, correcting for
 * whatever offset that date observes. Naive "+24h in UTC" arithmetic drifts
 * the local time-of-day across a DST transition; this instead re-derives the
 * correct offset for the target date, the same reasoning toUtcIso() already
 * asks Claude to apply manually when it creates a reminder, done here in
 * code for anything computed server-side (a recurring reminder's rollover,
 * the morning brief's "due today" cutoff).
 */
export function localInstant(day: string, hour: number, minute: number): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Guess the instant as if the local wall-clock time were UTC, then correct
  // by whatever offset is in effect on that date.
  const guess = new Date(`${day}T${pad(hour)}:${pad(minute)}:00Z`);
  const offset = currentOffset(guess);
  const sign = offset.startsWith("-") ? 1 : -1;
  const [offHour, offMinute] = offset.slice(1).split(":").map(Number) as [number, number];
  const offsetMs = (offHour * 60 + offMinute) * 60_000;
  return new Date(guess.getTime() + sign * offsetMs);
}

/**
 * Advances an instant by whole calendar days while preserving its local
 * wall-clock time — used to roll a recurring reminder's due_at forward.
 */
export function advanceLocalInstant(instant: Date, days: number): Date {
  const { day, hour, minute } = localTimeOfDay(instant);
  return localInstant(addDays(day, days), hour, minute);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD day string. */
export function dayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * Whether `instant` falls inside the quiet-hours window (local time) — used
 * to hold a reminder push until morning instead of firing the moment it
 * falls due. Handles a window spanning midnight (the default, 23-7). Equal
 * start/end disables the feature entirely. start/end default to config but
 * take explicit overrides so this is testable without depending on
 * process-wide env state.
 */
export function inQuietHours(
  instant: Date = new Date(),
  start: number = config.quietHoursStart,
  end: number = config.quietHoursEnd,
): boolean {
  if (start === end) return false;
  const hour = localHour(instant);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
