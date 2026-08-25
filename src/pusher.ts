import type { Client } from "discord.js";
import { config } from "./config";
import {
  advanceRecurrence,
  countCompletedSince,
  listReminders,
  listUnnotifiedOverdue,
  markNotified,
  type ReminderView,
} from "./db/reminders";
import { habitsAtRisk, listHabits, weeklyLogCounts, type HabitSummary } from "./db/habits";
import { hasNudgedToday, markNudged } from "./db/nudges";
import { hasDigestedThisWeek, markDigested } from "./db/digest";
import { hasBriefedToday, markBriefed } from "./db/morning";
import { getMuteUntil } from "./db/mute";
import { addDays, dayOfWeek, inQuietHours, localDay, localHour, localInstant } from "./time";

/**
 * Composed server-side, deliberately, not through Claude — same reasoning as
 * milestone being computed in SQL rather than left to the model: determinism
 * matters more than flourish for a notification firing unattended.
 */
export function formatPushMessage(reminders: ReminderView[]): string {
  if (reminders.length === 0) {
    throw new Error("formatPushMessage called with no reminders");
  }
  if (reminders.length === 1) {
    const [reminder] = reminders;
    return `${reminder!.text} — was due ${reminder!.due_local}.`;
  }
  return [
    `A few of these came due:`,
    ...reminders.map((r) => `  - ${r.text} (${r.due_local})`),
  ].join("\n");
}

/** Same composition philosophy as formatPushMessage — deterministic, no LLM call. */
export function formatAtRiskNudge(habits: HabitSummary[]): string {
  if (habits.length === 0) {
    throw new Error("formatAtRiskNudge called with no habits");
  }
  if (habits.length === 1) {
    const [habit] = habits;
    return `${habit!.name}'s at ${habit!.current_streak}, nothing logged yet today.`;
  }
  return [
    `A few streaks still open tonight:`,
    ...habits.map((h) => `  - ${h.name} (${h.current_streak} days)`),
  ].join("\n");
}

async function checkAndPush(client: Client): Promise<void> {
  // Holds until quiet hours end; nothing is marked notified in the meantime,
  // so the same reminders push on the first tick after the window closes —
  // the same retry-on-next-tick behavior already used for a failed send.
  if (inQuietHours()) return;

  const overdue = listUnnotifiedOverdue();
  if (overdue.length === 0) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatPushMessage(overdue));
    // Only mark as pushed once the send actually succeeds, so a failed
    // attempt (bad ID, no shared server, a network blip) retries next tick
    // instead of being silently dropped.
    for (const reminder of overdue) {
      // A recurring reminder rolls its due_at forward to the next occurrence
      // instead of just being marked notified — no "complete" step needed
      // for it to keep firing. One-shot reminders keep the old behavior.
      if (reminder.recurrence) advanceRecurrence(reminder.id);
      else markNotified(reminder.id);
    }
  } catch (error) {
    console.error("[pusher] failed to send reminder push:", error);
  }
}

async function checkAtRiskNudge(client: Client): Promise<void> {
  if (localHour() < config.atRiskNudgeHour) return;

  const today = localDay();
  if (hasNudgedToday(today)) return;

  const atRisk = habitsAtRisk();
  if (atRisk.length === 0) {
    // Nothing to say tonight. at_risk state only shrinks over a day (as
    // things get logged), never grows, so this result is valid for the rest
    // of today — mark it so we don't re-query every tick until midnight.
    markNudged(today);
    return;
  }

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatAtRiskNudge(atRisk));
    markNudged(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send at-risk nudge:", error);
    // not marked — retried next tick, same semantics as the reminder push
  }
}

export interface WeeklyHabitStat extends HabitSummary {
  /** Days logged in the last 7. */
  days_logged: number;
}

/**
 * Gathers the same week-in-review data both the automatic Sunday digest and
 * the on-demand week_summary tool need. Kept separate from formatting: the
 * digest DM composes this deterministically (below), while the tool hands
 * the raw numbers to Claude to phrase in voice — same split already used
 * throughout (list_habits/get_habit_streak return raw data; the push/nudge
 * formatters exist only because there's no live Claude turn to phrase an
 * unattended message).
 */
export function gatherWeekSummary(): {
  habits: WeeklyHabitStat[];
  remindersCompleted: number;
  remindersPending: number;
} {
  const counts = weeklyLogCounts();
  const habits = listHabits().map((h) => ({ ...h, days_logged: counts.get(h.name) ?? 0 }));
  const today = localDay();
  const weekAgoUtc = new Date(`${addDays(today, -6)}T00:00:00Z`).toISOString();
  return {
    habits,
    remindersCompleted: countCompletedSince(weekAgoUtc),
    remindersPending: listReminders({ status: "pending", limit: 1000 }).length,
  };
}

/**
 * Same composition philosophy as the other formatters — deterministic, no
 * LLM call, predictable over flourish for an unattended weekly message.
 * Unlike the push/nudge formatters, a fully quiet week (zero habits, zero
 * completions) still sends: worth naming, not skipping.
 */
export function formatDigest(
  habits: WeeklyHabitStat[],
  remindersCompleted: number,
  remindersPending: number,
): string {
  const lines: string[] = [`Week in review:`];
  if (habits.length === 0) {
    lines.push(`  - nothing tracked yet`);
  } else {
    for (const habit of habits) {
      lines.push(`  - ${habit.name}: ${habit.days_logged}/7, streak at ${habit.current_streak}`);
    }
  }
  lines.push(
    `${remindersCompleted} reminder${remindersCompleted === 1 ? "" : "s"} done this week, ` +
      `${remindersPending} still open.`,
  );
  return lines.join("\n");
}

async function checkWeeklyDigest(client: Client): Promise<void> {
  const today = localDay();
  if (dayOfWeek(today) !== 0) return; // only Sundays
  if (localHour() < config.digestHour) return;
  if (hasDigestedThisWeek(today)) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    const data = gatherWeekSummary();
    const message = formatDigest(data.habits, data.remindersCompleted, data.remindersPending);
    await owner.send(message);
    markDigested(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send weekly digest:", error);
    // not marked — retried next tick, same semantics as the other checks
  }
}

/** Same composition philosophy as the other formatters — deterministic, no LLM call. */
export function formatMorningBrief(reminders: ReminderView[], atRisk: HabitSummary[]): string {
  if (reminders.length === 0 && atRisk.length === 0) {
    throw new Error("formatMorningBrief called with nothing to say");
  }
  const lines: string[] = [];
  if (reminders.length) {
    lines.push(`Due today:`, ...reminders.map((r) => `  - ${r.text} (${r.due_local})`));
  }
  if (atRisk.length) {
    lines.push(`At risk:`, ...atRisk.map((h) => `  - ${h.name} (${h.current_streak} days)`));
  }
  return lines.join("\n");
}

async function checkMorningBrief(client: Client): Promise<void> {
  const today = localDay();
  if (localHour() < config.morningBriefHour) return;
  if (hasBriefedToday(today)) return;

  const dueToday = listReminders({
    status: "pending",
    dueBefore: localInstant(addDays(today, 1), config.dayCutoffHour, 0).toISOString(),
  });
  const atRisk = habitsAtRisk();
  if (dueToday.length === 0 && atRisk.length === 0) {
    // Nothing to say this morning — mark handled, same "stay quiet" pattern
    // the at-risk nudge already uses for an empty result.
    markBriefed(today);
    return;
  }

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatMorningBrief(dueToday, atRisk));
    markBriefed(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send morning brief:", error);
    // not marked — retried next tick, same semantics as the other checks
  }
}

async function tick(client: Client): Promise<void> {
  if (getMuteUntil()) return; // vacation mode: skip every proactive DM this tick
  await checkAndPush(client);
  await checkAtRiskNudge(client);
  await checkWeeklyDigest(client);
  await checkMorningBrief(client);
}

/**
 * Starts the background poll for every kind of proactive DM: overdue
 * reminders (including rolling recurring ones forward, and holding off
 * during quiet hours), the once-daily at-risk habit nudge, the once-a-week
 * Sunday digest, and the once-daily morning brief — all of it suppressed
 * entirely while a vacation mute is active. Runs once immediately (so a
 * restart doesn't wait a full interval to catch anything that fell due
 * while the bot was down), then on a timer at LOOPDOG_PUSH_INTERVAL_MINUTES —
 * fine-grained enough to also catch "has the nudge/digest/brief hour
 * arrived" without extra timers.
 */
export function startScheduler(client: Client): void {
  const intervalMs = config.pushIntervalMinutes * 60_000;
  void tick(client);
  setInterval(() => void tick(client), intervalMs);
}
