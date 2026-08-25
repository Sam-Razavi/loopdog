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
import { addDays, dayOfWeek, localDay, localHour } from "./time";

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

/**
 * Same composition philosophy as the other two formatters — deterministic,
 * no LLM call, predictable over flourish for an unattended weekly message.
 * Unlike the push/nudge formatters, a fully quiet week (zero habits, zero
 * completions) still sends: worth naming, not skipping.
 */
export function formatDigest(
  habits: HabitSummary[],
  weekCounts: Map<string, number>,
  remindersCompleted: number,
  remindersPending: number,
): string {
  const lines: string[] = [`Week in review:`];
  if (habits.length === 0) {
    lines.push(`  - nothing tracked yet`);
  } else {
    for (const habit of habits) {
      const days = weekCounts.get(habit.name) ?? 0;
      lines.push(`  - ${habit.name}: ${days}/7, streak at ${habit.current_streak}`);
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
    const weekAgoUtc = new Date(`${addDays(today, -6)}T00:00:00Z`).toISOString();
    const message = formatDigest(
      listHabits(),
      weeklyLogCounts(),
      countCompletedSince(weekAgoUtc),
      listReminders({ status: "pending", limit: 1000 }).length,
    );
    await owner.send(message);
    markDigested(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send weekly digest:", error);
    // not marked — retried next tick, same semantics as the other two checks
  }
}

async function tick(client: Client): Promise<void> {
  await checkAndPush(client);
  await checkAtRiskNudge(client);
  await checkWeeklyDigest(client);
}

/**
 * Starts the background poll for every kind of proactive DM: overdue
 * reminders (including rolling recurring ones forward), the once-daily
 * at-risk habit nudge, and the once-a-week Sunday digest. Runs once
 * immediately (so a restart doesn't wait a full interval to catch anything
 * that fell due while the bot was down), then on a timer at
 * LOOPDOG_PUSH_INTERVAL_MINUTES — fine-grained enough to also catch "has the
 * nudge/digest hour arrived" without extra timers.
 */
export function startScheduler(client: Client): void {
  const intervalMs = config.pushIntervalMinutes * 60_000;
  void tick(client);
  setInterval(() => void tick(client), intervalMs);
}
