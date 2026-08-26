import { config } from "./config";
import { listReminders, type ReminderView } from "./db/reminders";
import { listDates, type ImportantDateView } from "./db/importantdates";
import { listSwedishHolidays, type SwedishHoliday } from "./swedishholidays";
import { getAssignments, type CanvasAssignment } from "./canvas";
import { addDays, localDay, localInstant } from "./time";

/**
 * "What does my week look like" — pure synthesis over four things that
 * already exist on their own (reminders, important dates, Swedish
 * holidays, Canvas assignments). No new external calls, no new schema.
 */

export interface WeekOverview {
  reminders: ReminderView[];
  important_dates: ImportantDateView[];
  swedish_holidays: SwedishHoliday[];
  /** null when Canvas isn't configured or the fetch failed — never blocks the rest of the overview. */
  canvas_assignments: CanvasAssignment[] | null;
}

/**
 * Pure. `holidaysThisYear`/`holidaysNextYear` are both always passed in
 * (cheap to compute either way — locally derived, no network call) so this
 * function is the single source of truth for the date-range filtering,
 * rather than the caller having to decide whether the window crosses New
 * Year's before fetching.
 */
export function assembleWeekOverview(
  reminders: ReminderView[],
  allDates: ImportantDateView[],
  holidaysThisYear: SwedishHoliday[],
  holidaysNextYear: SwedishHoliday[],
  today: string,
  days: number,
  canvasAssignments: CanvasAssignment[] | null,
): WeekOverview {
  const cutoff = addDays(today, days);
  return {
    reminders,
    important_dates: allDates.filter((d) => d.days_until <= days),
    swedish_holidays: [...holidaysThisYear, ...holidaysNextYear]
      .filter((h) => h.date >= today && h.date <= cutoff)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    canvas_assignments: canvasAssignments,
  };
}

export async function getWeekOverview(days: number): Promise<WeekOverview> {
  const today = localDay();
  const cutoff = addDays(today, days);

  const reminders = listReminders({
    status: "pending",
    dueBefore: localInstant(cutoff, config.dayCutoffHour, 0).toISOString(),
    limit: 1000,
  });

  const thisYear = Number(today.slice(0, 4));
  const nextYear = Number(cutoff.slice(0, 4));

  let canvasAssignments: CanvasAssignment[] | null = null;
  if (config.canvasBaseUrl && config.canvasApiToken) {
    try {
      canvasAssignments = await getAssignments(days);
    } catch (error) {
      console.error("[overview] failed to fetch Canvas assignments:", error);
      // not fatal — the rest of the overview still comes back
    }
  }

  return assembleWeekOverview(
    reminders,
    listDates(),
    listSwedishHolidays(thisYear),
    thisYear === nextYear ? [] : listSwedishHolidays(nextYear),
    today,
    days,
    canvasAssignments,
  );
}
