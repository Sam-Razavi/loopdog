import { getDb } from "./index";
import { advanceLocalInstant, formatLocal, nowUtcIso } from "../time";

export type Recurrence = "daily" | "weekly";

export interface ReminderRow {
  id: number;
  text: string;
  due_at: string;
  created_at: string;
  completed_at: string | null;
  notified_at: string | null;
  recurrence: Recurrence | null;
}

/** The shape handed back to Claude — absolute time plus a readable local one. */
export interface ReminderView {
  id: number;
  text: string;
  due_at: string;
  due_local: string;
  overdue: boolean;
  completed_at: string | null;
  recurrence: Recurrence | null;
}

export type ReminderStatus = "pending" | "completed" | "all";

function view(row: ReminderRow, now = nowUtcIso()): ReminderView {
  return {
    id: row.id,
    text: row.text,
    due_at: row.due_at,
    due_local: formatLocal(new Date(row.due_at)),
    overdue: row.completed_at === null && row.due_at <= now,
    completed_at: row.completed_at,
    recurrence: row.recurrence,
  };
}

export function createReminder(
  text: string,
  dueAtUtc: string,
  recurrence: Recurrence | null = null,
): ReminderView {
  const now = nowUtcIso();
  const result = getDb()
    .prepare(
      `INSERT INTO reminders (text, due_at, created_at, recurrence) VALUES (?, ?, ?, ?)`,
    )
    .run(text, dueAtUtc, now, recurrence);
  return view(getReminder(Number(result.lastInsertRowid))!, now);
}

export function getReminder(id: number): ReminderRow | undefined {
  return getDb().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as
    | ReminderRow
    | undefined;
}

export function listReminders(options: {
  status?: ReminderStatus;
  dueBefore?: string;
  limit?: number;
}): ReminderView[] {
  const status = options.status ?? "pending";
  const limit = options.limit ?? 20;

  const where: string[] = [];
  const params: unknown[] = [];

  if (status === "pending") where.push("completed_at IS NULL");
  if (status === "completed") where.push("completed_at IS NOT NULL");
  if (options.dueBefore) {
    where.push("due_at <= ?");
    params.push(options.dueBefore);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM reminders ${clause} ORDER BY due_at ASC LIMIT ?`)
    .all(...params, limit) as ReminderRow[];

  const now = nowUtcIso();
  return rows.map((row) => view(row, now));
}

/**
 * Pending reminders whose time has passed — the "surface on next message" feed
 * injected into the system prompt. Independent of push notifications: this
 * keeps returning a reminder every time, regardless of notified_at, until it's
 * actually completed or deleted.
 */
export function listOverdue(limit = 5): ReminderView[] {
  const now = nowUtcIso();
  const rows = getDb()
    .prepare(
      `SELECT * FROM reminders
       WHERE completed_at IS NULL AND due_at <= ?
       ORDER BY due_at ASC LIMIT ?`,
    )
    .all(now, limit) as ReminderRow[];
  return rows.map((row) => view(row, now));
}

/**
 * Overdue reminders that haven't been pushed yet — the feed the background
 * pusher polls. Separate from listOverdue() on purpose: a push fires once,
 * but the conversational nudge above keeps surfacing until resolved.
 */
export function listUnnotifiedOverdue(limit = 20): ReminderView[] {
  const now = nowUtcIso();
  const rows = getDb()
    .prepare(
      `SELECT * FROM reminders
       WHERE completed_at IS NULL AND notified_at IS NULL AND due_at <= ?
       ORDER BY due_at ASC LIMIT ?`,
    )
    .all(now, limit) as ReminderRow[];
  return rows.map((row) => view(row, now));
}

/** Stamp a reminder as pushed. Call only after the DM actually sends. */
export function markNotified(id: number): void {
  getDb()
    .prepare(`UPDATE reminders SET notified_at = ? WHERE id = ?`)
    .run(nowUtcIso(), id);
}

export interface CompletionResult {
  reminder: ReminderView;
  /** True when this was a recurring reminder that rolled forward rather than finishing. */
  rolled_forward: boolean;
}

/**
 * Marks a reminder done.
 *
 * A one-shot reminder completes and leaves the pending list, as before. A
 * *recurring* one instead rolls forward to its next occurrence and stays
 * pending — because every query in this file filters on
 * `completed_at IS NULL`, setting it on a recurring reminder used to kill
 * the recurrence permanently and silently: "remind me to stretch every day"
 * survived exactly one "done". Stopping a recurring reminder for good is
 * what deleteReminder is for.
 *
 * Either way a row lands in reminder_completions, so the weekly digest's
 * count stays accurate for both kinds.
 */
export function completeReminder(id: number): CompletionResult | null {
  const existing = getReminder(id);
  if (!existing) return null;

  const now = nowUtcIso();
  recordCompletion(id, now);

  if (existing.recurrence) {
    return { reminder: rollForward(existing), rolled_forward: true };
  }

  if (existing.completed_at === null) {
    getDb().prepare(`UPDATE reminders SET completed_at = ? WHERE id = ?`).run(now, id);
  }
  return { reminder: view(getReminder(id)!), rolled_forward: false };
}

function recordCompletion(reminderId: number, completedAt: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO reminder_completions (reminder_id, completed_at) VALUES (?, ?)`,
    )
    .run(reminderId, completedAt);
}

/**
 * Moves a recurring reminder to its next occurrence and makes it
 * push-eligible again. Shared by advanceRecurrence (the pusher's automatic
 * roll after a push) and completeReminder (the user saying they did it) so
 * the two can't drift apart.
 */
function rollForward(existing: ReminderRow): ReminderView {
  const days = existing.recurrence === "daily" ? 1 : 7;
  const nextDueAt = advanceLocalInstant(new Date(existing.due_at), days).toISOString();
  getDb()
    .prepare(`UPDATE reminders SET due_at = ?, notified_at = NULL WHERE id = ?`)
    .run(nextDueAt, existing.id);
  return view(getReminder(existing.id)!);
}

export function deleteReminder(id: number): ReminderView | null {
  const existing = getReminder(id);
  if (!existing) return null;
  getDb().prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
  return view(existing);
}

/**
 * Rolls a recurring reminder's due_at forward to its next occurrence and
 * clears notified_at, so the fresh occurrence is push-eligible again.
 * completed_at is untouched — recurrence only governs what happens
 * automatically once a reminder is pushed, not completion. Call only on a
 * reminder that actually has recurrence set.
 */
export function advanceRecurrence(id: number): ReminderView {
  const existing = getReminder(id);
  if (!existing || !existing.recurrence) {
    throw new Error(`advanceRecurrence called on reminder ${id} with no recurrence set`);
  }
  return rollForward(existing);
}

/**
 * Update a pending reminder's text and/or due time in place — for "actually
 * push that back to 6pm" rather than delete-and-recreate. If due_at changes,
 * notified_at resets: the old push doesn't apply to the new time.
 */
export function updateReminder(
  id: number,
  changes: { text?: string; dueAtUtc?: string },
): ReminderView | null {
  const existing = getReminder(id);
  if (!existing) return null;

  const text = changes.text ?? existing.text;
  const dueAt = changes.dueAtUtc ?? existing.due_at;
  const notifiedAt = changes.dueAtUtc !== undefined ? null : existing.notified_at;

  getDb()
    .prepare(`UPDATE reminders SET text = ?, due_at = ?, notified_at = ? WHERE id = ?`)
    .run(text, dueAt, notifiedAt, id);
  return view(getReminder(id)!);
}

/** How many reminders were completed since a given UTC instant — for the weekly digest. */
export function countCompletedSince(cutoffUtc: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM reminder_completions WHERE completed_at >= ?`)
    .get(cutoffUtc) as { n: number };
  return row.n;
}
