import { getDb } from "./index";
import { formatLocal, nowUtcIso } from "../time";

export interface ReminderRow {
  id: number;
  text: string;
  due_at: string;
  created_at: string;
  completed_at: string | null;
}

/** The shape handed back to Claude — absolute time plus a readable local one. */
export interface ReminderView {
  id: number;
  text: string;
  due_at: string;
  due_local: string;
  overdue: boolean;
  completed_at: string | null;
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
  };
}

export function createReminder(text: string, dueAtUtc: string): ReminderView {
  const now = nowUtcIso();
  const result = getDb()
    .prepare(`INSERT INTO reminders (text, due_at, created_at) VALUES (?, ?, ?)`)
    .run(text, dueAtUtc, now);
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

/** Pending reminders whose time has passed — the "surface on next message" feed. */
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

export function completeReminder(id: number): ReminderView | null {
  const existing = getReminder(id);
  if (!existing) return null;
  if (existing.completed_at === null) {
    getDb().prepare(`UPDATE reminders SET completed_at = ? WHERE id = ?`).run(
      nowUtcIso(),
      id,
    );
  }
  return view(getReminder(id)!);
}

export function deleteReminder(id: number): ReminderView | null {
  const existing = getReminder(id);
  if (!existing) return null;
  getDb().prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
  return view(existing);
}
