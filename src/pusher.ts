import type { Client } from "discord.js";
import { config } from "./config";
import { listUnnotifiedOverdue, markNotified, type ReminderView } from "./db/reminders";

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

async function checkAndPush(client: Client): Promise<void> {
  const overdue = listUnnotifiedOverdue();
  if (overdue.length === 0) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatPushMessage(overdue));
    // Only mark as pushed once the send actually succeeds, so a failed
    // attempt (bad ID, no shared server, a network blip) retries next tick
    // instead of being silently dropped.
    for (const reminder of overdue) markNotified(reminder.id);
  } catch (error) {
    console.error("[pusher] failed to send reminder push:", error);
  }
}

/**
 * Starts the background poll for overdue, unpushed reminders. Runs once
 * immediately (so a restart doesn't wait a full interval to catch anything
 * that fell due while the bot was down), then on a timer.
 */
export function startReminderPusher(client: Client): void {
  const intervalMs = config.pushIntervalMinutes * 60_000;
  void checkAndPush(client);
  setInterval(() => void checkAndPush(client), intervalMs);
}
