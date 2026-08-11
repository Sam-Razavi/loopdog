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

/** The offset string the configured zone is currently observing, e.g. "+02:00". */
export function currentOffset(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "") || "+00:00";
}
