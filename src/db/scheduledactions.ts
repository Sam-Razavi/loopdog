import { getDb } from "./index";
import { advanceLocalInstant, formatLocal, nowUtcIso } from "../time";
import type { Recurrence } from "./reminders";

export type DeviceAction = "plug_on" | "plug_off" | "vacuum_start";

export const DEVICE_ACTIONS: DeviceAction[] = ["plug_on", "plug_off", "vacuum_start"];

/** Actions loud enough that quiet hours should hold them. A plug is silent; a vacuum is not. */
export const NOISY_ACTIONS: DeviceAction[] = ["vacuum_start"];

export interface ScheduledActionRow {
  id: number;
  action: DeviceAction;
  target: string | null;
  run_at: string;
  reason: string | null;
  recurrence: Recurrence | null;
  created_at: string;
  fired_at: string | null;
}

export interface ScheduledActionView extends ScheduledActionRow {
  run_local: string;
}

function view(row: ScheduledActionRow): ScheduledActionView {
  return { ...row, run_local: formatLocal(new Date(row.run_at)) };
}

export function createScheduledAction(
  action: DeviceAction,
  target: string | null,
  runAtUtc: string,
  reason: string | null,
  recurrence: Recurrence | null,
): ScheduledActionView {
  const result = getDb()
    .prepare(
      `INSERT INTO scheduled_actions (action, target, run_at, reason, recurrence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(action, target, runAtUtc, reason, recurrence, nowUtcIso());
  return view(getScheduledAction(Number(result.lastInsertRowid))!);
}

export function getScheduledAction(id: number): ScheduledActionRow | undefined {
  return getDb().prepare(`SELECT * FROM scheduled_actions WHERE id = ?`).get(id) as
    | ScheduledActionRow
    | undefined;
}

/** Everything still pending, soonest first. A fired one-shot drops out. */
export function listScheduledActions(): ScheduledActionView[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scheduled_actions WHERE fired_at IS NULL ORDER BY run_at ASC`)
    .all() as ScheduledActionRow[];
  return rows.map(view);
}

/** Due and not yet fired — the feed the scheduler polls. */
export function listDueActions(): ScheduledActionView[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scheduled_actions WHERE fired_at IS NULL AND run_at <= ? ORDER BY run_at ASC`)
    .all(nowUtcIso()) as ScheduledActionRow[];
  return rows.map(view);
}

/**
 * Call only after the action actually succeeded. A recurring action rolls
 * forward to its next occurrence and stays pending, mirroring how a
 * recurring reminder behaves; a one-shot is stamped and drops out.
 */
export function markFired(id: number): void {
  const existing = getScheduledAction(id);
  if (!existing) return;
  if (existing.recurrence) {
    const days = existing.recurrence === "daily" ? 1 : 7;
    getDb()
      .prepare(`UPDATE scheduled_actions SET run_at = ? WHERE id = ?`)
      .run(advanceLocalInstant(new Date(existing.run_at), days).toISOString(), id);
    return;
  }
  getDb().prepare(`UPDATE scheduled_actions SET fired_at = ? WHERE id = ?`).run(nowUtcIso(), id);
}

export function cancelScheduledAction(id: number): ScheduledActionView | null {
  const existing = getScheduledAction(id);
  if (!existing) return null;
  getDb().prepare(`DELETE FROM scheduled_actions WHERE id = ?`).run(id);
  return view(existing);
}
