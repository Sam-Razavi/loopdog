import { addDays, previousDay } from "./time";

export interface StreakInfo {
  current_streak: number;
  longest_streak: number;
  /** Yesterday is logged but today is not: the streak survives, for now. */
  at_risk: boolean;
  last_logged: string | null;
}

/**
 * Pure over a set of logged days so the grace-day rule can be tested without a
 * database. `today` is expected to be 4am-adjusted already.
 *
 * The rule: today logged -> streak includes today. Today blank but yesterday
 * logged -> streak holds at its existing length and is flagged at_risk. Two
 * consecutive blank days -> zero. longest_streak is never reset by a lapse.
 */
export function computeStreak(loggedDays: string[], today: string): StreakInfo {
  const days = new Set(loggedDays);
  const sorted = [...days].sort();
  const lastLogged = sorted.length ? sorted[sorted.length - 1]! : null;

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }

  const yesterday = previousDay(today);
  let anchor: string | null = null;
  let atRisk = false;
  if (days.has(today)) {
    anchor = today;
  } else if (days.has(yesterday)) {
    anchor = yesterday;
    atRisk = true;
  }

  let current = 0;
  let cursor = anchor;
  while (cursor !== null && days.has(cursor)) {
    current += 1;
    cursor = previousDay(cursor);
  }

  return {
    current_streak: current,
    longest_streak: longest,
    at_risk: atRisk,
    last_logged: lastLogged,
  };
}
