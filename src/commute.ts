import { findDepartures, type Departure } from "./transit";
import { createReminder, type ReminderView } from "./db/reminders";
import { localInstant, toUtcIso } from "./time";
import { ToolError } from "./errors";

/**
 * Glues transit.ts's departure board to db/reminders.ts — "leave by X to
 * catch the Y bus" is something neither does alone. Inherits transit.ts's
 * own unverified-in-this-sandbox caveat: SL's departures endpoint is
 * proxy-blocked here, so the exact shape of `scheduled`/`expected` (a real
 * UTC/offset timestamp, or bare local wall-clock time the way ResRobot's
 * combineDateTime already had to handle) couldn't be confirmed against a
 * live response. departureToUtc() below handles both possibilities
 * defensively for that reason.
 */

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Pure. Converts a departure timestamp into a real UTC instant, regardless
 * of which of the two shapes above it turns out to be.
 */
export function departureToUtc(raw: string): string {
  const trimmed = raw.trim();
  if (OFFSET_SUFFIX.test(trimmed)) return toUtcIso(trimmed);

  const [day, time] = trimmed.split("T");
  const [hourStr, minuteStr] = (time ?? "").split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new ToolError(`unrecognised departure timestamp: "${raw}"`);
  }
  return localInstant(day, hour, minute).toISOString();
}

/** Pure arithmetic — `departureUtc` minus `leadMinutes`, in real UTC ms. */
export function leaveByUtc(departureUtc: string, leadMinutes: number): string {
  return new Date(Date.parse(departureUtc) - leadMinutes * 60_000).toISOString();
}

export interface CommuteReminderResult {
  reminder: ReminderView;
  departure: Departure;
  stop: string;
}

export async function createCommuteReminder(
  stopQuery: string,
  leadMinutes: number,
  transportFilter?: string,
): Promise<CommuteReminderResult> {
  const { stop, departures } = await findDepartures(stopQuery, 1, transportFilter);
  const next = departures[0];
  if (!next) throw new ToolError(`no upcoming departures found for "${stop}"`);

  const rawTime = next.expected ?? next.scheduled;
  if (!rawTime) {
    throw new ToolError(`SL didn't give a departure time for the next ${next.line} — try again in a moment`);
  }

  const departureUtc = departureToUtc(rawTime);
  const dueAtUtc = leaveByUtc(departureUtc, leadMinutes);
  if (Date.parse(dueAtUtc) <= Date.now()) {
    throw new ToolError(
      `the next ${next.line} towards ${next.destination} is too close to catch with ${leadMinutes} minutes' lead time — try a shorter lead time or check again in a moment`,
    );
  }

  const text = `Leave now for the ${next.line} towards ${next.destination} at ${stop} (${next.display}).`;
  const reminder = createReminder(text, dueAtUtc, null);
  return { reminder, departure: next, stop };
}
