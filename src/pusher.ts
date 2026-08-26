import { createHash } from "node:crypto";
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
import { listWatches, updateWatchAfterCheck } from "./db/watches";
import { fetchReadableText } from "./webfetch";
import * as googleCalendar from "./google";
import * as hotmail from "./hotmail";
import { addDays, dayOfWeek, formatLocal, inQuietHours, localDay, localHour, localInstant } from "./time";
import { sweepOldTempFilesIfDue } from "./tmpfiles";
import { getPrices, isCurrentlyCheap } from "./electricity";
import { hasElectricityNudgedToday, markElectricityNudged } from "./db/electricity";
import { getActiveWarnings } from "./smhiwarnings";
import { hasSeenWarning, markWarningSeen } from "./db/smhiwarnings";
import {
  hasNudgedForOccurrence,
  listDates,
  markNudgedForOccurrence,
  type ImportantDateView,
  type NudgeKind,
} from "./db/importantdates";

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

/**
 * Opt-in (LOOPDOG_ELECTRICITY_NUDGE, default off) — a price nudge is a more
 * opinionated proactive DM than the on-demand tool, so it doesn't turn on
 * just because get_electricity_price works out of the box.
 *
 * Unlike checkAtRiskNudge, "cheap" is not monotonic across a day — the
 * price now says nothing about the price in three hours — so a tick where
 * it's *not* currently cheap does NOT mark the day handled the way an
 * empty at-risk list does. The day is only marked once the nudge actually
 * fires, so a genuinely cheap window later today still gets caught by a
 * subsequent tick.
 */
async function checkElectricityNudge(client: Client): Promise<void> {
  if (!config.electricityNudgeEnabled) return;

  const today = localDay();
  if (hasElectricityNudgedToday(today)) return;

  let points: Awaited<ReturnType<typeof getPrices>>;
  try {
    points = await getPrices();
  } catch (error) {
    console.error("[pusher] failed to fetch electricity prices:", error);
    return; // retried next tick — not marked, nothing was decided either way
  }

  if (!isCurrentlyCheap(points)) return; // not cheap right now — try again next tick

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send("Electricity's cheap right now — good window for the dishwasher/laundry/charging.");
    markElectricityNudged(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send electricity nudge:", error);
    // not marked — retried next tick, same semantics as the other checks
  }
}

/**
 * Opt-in via LOOPDOG_SMHI_COUNTY (no default region to watch otherwise).
 * Dedup is per warning id, not per day — a warning can span several days
 * and several can be active on the same day, unlike the once-a-day shape
 * everything else here uses. Runs even during a vacation mute: a severe
 * weather warning is exactly the kind of thing muting proactive DMs
 * shouldn't swallow, same reasoning as the Google/Hotmail auth-poller
 * exception, just for a different reason (safety, not "you asked for
 * this").
 */
async function checkWeatherWarnings(client: Client): Promise<void> {
  if (!config.smhiCounty) return;

  let warnings: Awaited<ReturnType<typeof getActiveWarnings>>;
  try {
    warnings = await getActiveWarnings(config.smhiCounty);
  } catch (error) {
    console.error("[pusher] failed to fetch weather warnings:", error);
    return;
  }

  const unseen = warnings.filter((w) => !hasSeenWarning(w.id));
  if (unseen.length === 0) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    for (const warning of unseen) {
      await owner.send(
        `Weather warning (${warning.level}): ${warning.event} — ${warning.areas.join(", ")}. ${warning.description}`,
      );
      markWarningSeen(warning.id); // only after the send actually succeeds, same as every other check
    }
  } catch (error) {
    console.error("[pusher] failed to send weather warning:", error);
    // whichever warnings didn't get marked are retried next tick
  }
}

/** Same composition philosophy as the other formatters — deterministic, no LLM call. */
export function formatImportantDateNudge(
  pending: { date: Pick<ImportantDateView, "name" | "note">; kind: NudgeKind }[],
): string {
  if (pending.length === 0) {
    throw new Error("formatImportantDateNudge called with nothing to say");
  }
  return pending
    .map(({ date, kind }) => {
      const suffix = date.note ? ` — ${date.note}` : "";
      return kind === "today" ? `Today: ${date.name}${suffix}.` : `In 7 days: ${date.name}${suffix}.`;
    })
    .join("\n");
}

/**
 * Once a day (reuses the morning-brief hour — a birthday heads-up is
 * exactly the kind of thing worth knowing first thing, same as calendar
 * events/reminders, without adding a fifth LOOPDOG_*_HOUR config var just
 * for this). Dedup is per date per occurrence-year per kind, not per day —
 * see important_date_nudges' schema comment for why. Multiple dates due on
 * the same tick are batched into one DM, same "don't spam one message per
 * item" reasoning as checkAndPush/checkAtRiskNudge.
 */
async function checkImportantDates(client: Client): Promise<void> {
  if (localHour() < config.morningBriefHour) return;

  const pending: { date: ImportantDateView; kind: NudgeKind }[] = [];
  for (const date of listDates()) {
    if (date.days_until !== 0 && date.days_until !== 7) continue;
    const kind: NudgeKind = date.days_until === 0 ? "today" : "advance";
    const occurrenceYear = Number(date.next_occurrence.slice(0, 4));
    if (hasNudgedForOccurrence(date.id, occurrenceYear, kind)) continue;
    pending.push({ date, kind });
  }
  if (pending.length === 0) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatImportantDateNudge(pending));
    for (const { date, kind } of pending) {
      markNudgedForOccurrence(date.id, Number(date.next_occurrence.slice(0, 4)), kind); // only after the send actually succeeds
    }
  } catch (error) {
    console.error("[pusher] failed to send important-date nudge:", error);
    // not marked — retried next tick, same semantics as every other check
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
function formatEventTime(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "all day"; // date-only: an all-day event
  return formatLocal(new Date(iso));
}

export function formatMorningBrief(
  reminders: ReminderView[],
  atRisk: HabitSummary[],
  events: googleCalendar.CalendarEvent[] = [],
): string {
  if (reminders.length === 0 && atRisk.length === 0 && events.length === 0) {
    throw new Error("formatMorningBrief called with nothing to say");
  }
  const lines: string[] = [];
  if (events.length) {
    lines.push(`On the calendar today:`, ...events.map((e) => `  - ${e.summary} (${formatEventTime(e.start)})`));
  }
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

  let events: googleCalendar.CalendarEvent[] = [];
  if (googleCalendar.isConnected()) {
    try {
      events = await googleCalendar.listEvents(1);
    } catch (error) {
      console.error("[pusher] failed to fetch calendar events for morning brief:", error);
      // not fatal — the brief still goes out with whatever else there is to say
    }
  }

  if (dueToday.length === 0 && atRisk.length === 0 && events.length === 0) {
    // Nothing to say this morning — mark handled, same "stay quiet" pattern
    // the at-risk nudge already uses for an empty result.
    markBriefed(today);
    return;
  }

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatMorningBrief(dueToday, atRisk, events));
    markBriefed(today); // only after the send actually succeeds
  } catch (error) {
    console.error("[pusher] failed to send morning brief:", error);
    // not marked — retried next tick, same semantics as the other checks
  }
}

/** Same composition philosophy as the other formatters — deterministic, no LLM call. */
export function formatWatchAlert(changes: { url: string; note: string | null }[]): string {
  if (changes.length === 0) {
    throw new Error("formatWatchAlert called with no changes");
  }
  if (changes.length === 1) {
    const [change] = changes;
    return change!.note ? `${change!.note} — ${change!.url} changed.` : `${change!.url} changed.`;
  }
  return [
    `A few watched pages changed:`,
    ...changes.map((c) => `  - ${c.note ? c.note + " — " : ""}${c.url}`),
  ].join("\n");
}

/**
 * Checking a watched page shouldn't ride the same push-interval tick as
 * everything else — that's polite for polling our own database, not
 * someone else's server. Rather than a second timer, each watch just
 * decides for itself whether it's due, based on its own last_checked_at
 * and LOOPDOG_WATCH_INTERVAL_MINUTES — same shape checkAtRiskNudge/
 * checkWeeklyDigest/checkMorningBrief already use for their own hour/day
 * gates inside this one shared tick.
 */
async function checkPageWatches(client: Client): Promise<void> {
  const dueMs = config.watchIntervalMinutes * 60_000;
  const now = Date.now();
  const due = listWatches().filter(
    (w) => w.last_checked_at === null || now - Date.parse(w.last_checked_at) >= dueMs,
  );

  const changed: { url: string; note: string | null }[] = [];
  for (const watch of due) {
    try {
      const { text } = await fetchReadableText(watch.url);
      const hash = createHash("sha256").update(text).digest("hex");
      if (hash !== watch.content_hash) changed.push({ url: watch.url, note: watch.note });
      updateWatchAfterCheck(watch.id, hash); // always updates, whether changed or not
    } catch (error) {
      console.error(`[pusher] failed to check watch ${watch.id} (${watch.url}):`, error);
      // skip this one — retried once its interval is up again, same semantics as every other check
    }
  }
  if (changed.length === 0) return;

  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(formatWatchAlert(changed));
  } catch (error) {
    console.error("[pusher] failed to send watch alert:", error);
  }
}

/**
 * Finishes a Google device-flow connection in the background, so the user
 * doesn't have to remember to come back and ask "did it work?" — one poll
 * attempt per tick if a code is pending. Runs even while muted: this is a
 * direct completion of something the user explicitly asked to do
 * (connect_google), not an unprompted nudge, so vacation mode shouldn't
 * swallow it. See checkPendingHotmailAuth below for the same thing on the
 * separate Hotmail/Outlook connection.
 */
async function checkPendingGoogleAuth(client: Client): Promise<void> {
  let outcome: "connected" | "expired" | "denied" | null;
  try {
    outcome = await googleCalendar.pollPendingConnection();
  } catch (error) {
    console.error("[pusher] failed to poll pending calendar connection:", error);
    return;
  }
  if (outcome === null) return; // nothing pending, or still waiting on the user

  const message =
    outcome === "connected"
      ? "Calendar connected."
      : outcome === "denied"
        ? "Calendar connection was declined."
        : "Calendar connection request expired before it was approved. Ask me to connect again.";
  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(message);
  } catch (error) {
    console.error("[pusher] failed to send calendar connection result:", error);
  }
}

/**
 * Same reasoning and shape as checkPendingGoogleAuth, for the separate
 * Hotmail/Outlook connection — direct completion of an explicit
 * connect_hotmail, not an unprompted nudge, so it runs even while muted.
 */
async function checkPendingHotmailAuth(client: Client): Promise<void> {
  let outcome: "connected" | "expired" | "denied" | null;
  try {
    outcome = await hotmail.pollPendingConnection();
  } catch (error) {
    console.error("[pusher] failed to poll pending Hotmail connection:", error);
    return;
  }
  if (outcome === null) return; // nothing pending, or still waiting on the user

  const message =
    outcome === "connected"
      ? "Hotmail connected."
      : outcome === "denied"
        ? "Hotmail connection was declined."
        : "Hotmail connection request expired before it was approved. Ask me to connect again.";
  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(message);
  } catch (error) {
    console.error("[pusher] failed to send Hotmail connection result:", error);
  }
}

/**
 * How often the auth poller wakes. Far tighter than the main push interval
 * because a device code expires in minutes and the user is standing there
 * waiting — riding the 5-minute tick meant "connected" could take five
 * minutes to land. When nothing is pending this is one indexed SQLite read
 * per provider and no network traffic at all.
 */
const AUTH_POLL_INTERVAL_MS = 15_000;

/** Floor for how often we'll actually hit a provider's token endpoint. */
const MIN_PROVIDER_POLL_SECONDS = 5;

const lastAuthPollAt = new Map<string, number>();

/**
 * Honours the poll_interval each provider hands back with its device code —
 * previously stored and never read, so we polled on whatever cadence the
 * scheduler happened to run at instead of the one we were asked for.
 */
function providerPollDue(provider: string, intervalSeconds: number | null): boolean {
  const spacing = Math.max(intervalSeconds ?? MIN_PROVIDER_POLL_SECONDS, MIN_PROVIDER_POLL_SECONDS) * 1000;
  const last = lastAuthPollAt.get(provider) ?? 0;
  if (Date.now() - last < spacing) return false;
  lastAuthPollAt.set(provider, Date.now());
  return true;
}

async function authTick(client: Client): Promise<void> {
  if (providerPollDue("google", googleCalendar.pendingPollInterval())) {
    await checkPendingGoogleAuth(client);
  }
  if (providerPollDue("hotmail", hotmail.pendingPollInterval())) {
    await checkPendingHotmailAuth(client);
  }
}

async function tick(client: Client): Promise<void> {
  void sweepOldTempFilesIfDue();
  // Bypasses the mute gate below, deliberately — see checkWeatherWarnings's
  // own doc comment for why a severe weather warning isn't the kind of
  // thing vacation mode should swallow.
  await checkWeatherWarnings(client);
  if (getMuteUntil()) return; // vacation mode: skip every other proactive DM this tick
  await checkAndPush(client);
  await checkAtRiskNudge(client);
  await checkElectricityNudge(client);
  await checkImportantDates(client);
  await checkWeeklyDigest(client);
  await checkMorningBrief(client);
  await checkPageWatches(client);
}

/**
 * Starts the background poll for every kind of proactive DM: overdue
 * reminders (including rolling recurring ones forward, and holding off
 * during quiet hours), the once-daily at-risk habit nudge, the opt-in
 * electricity cheap-hour nudge, the once-a-week Sunday digest, the
 * once-daily morning brief, and watched-page change alerts (each on its
 * own, slower LOOPDOG_WATCH_INTERVAL_MINUTES cadence) — all of it
 * suppressed entirely while a vacation mute is active. Two things bypass
 * the mute gate, each for its own reason: finishing a Google or Hotmail
 * connection the user explicitly started isn't an unprompted nudge (runs
 * on its own faster timer, see authTick, that the mute gate never
 * touches), and a new SMHI severe-weather warning (opt-in via
 * LOOPDOG_SMHI_COUNTY) is a safety matter mute shouldn't swallow either,
 * so checkWeatherWarnings runs ahead of the gate inside tick() itself.
 * Runs once immediately (so a restart doesn't wait a full interval to
 * catch anything that fell due while the bot was down), then on a timer
 * at LOOPDOG_PUSH_INTERVAL_MINUTES — fine-grained enough to also catch
 * "has the nudge/digest/brief/watch interval arrived" without extra
 * timers.
 */
export function startScheduler(client: Client): void {
  const intervalMs = config.pushIntervalMinutes * 60_000;
  void tick(client);
  setInterval(() => void tick(client), intervalMs);

  // Its own, much faster timer — see AUTH_POLL_INTERVAL_MS above.
  void authTick(client);
  setInterval(() => void authTick(client), AUTH_POLL_INTERVAL_MS);
}
