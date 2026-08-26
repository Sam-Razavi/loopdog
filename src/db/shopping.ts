import { getDb } from "./index";
import { nowUtcIso } from "../time";
import { ToolError } from "../errors";

export interface ShoppingItem {
  id: number;
  item: string;
  note: string | null;
  checked_at: string | null;
  created_at: string;
}

export type ShoppingStatus = "needed" | "checked" | "all";

export function addItems(items: string[], note?: string): ShoppingItem[] {
  const now = nowUtcIso();
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO shopping_items (item, note, created_at) VALUES (?, ?, ?)`,
  );
  const ids = items.map((item) => Number(insert.run(item.trim(), note ?? null, now).lastInsertRowid));
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM shopping_items WHERE id IN (${placeholders})`).all(...ids) as ShoppingItem[];
}

export function listItems(status: ShoppingStatus = "needed"): ShoppingItem[] {
  const where =
    status === "needed" ? "WHERE checked_at IS NULL" : status === "checked" ? "WHERE checked_at IS NOT NULL" : "";
  return getDb()
    .prepare(`SELECT * FROM shopping_items ${where} ORDER BY created_at ASC`)
    .all() as ShoppingItem[];
}

function getItem(id: number): ShoppingItem | undefined {
  return getDb().prepare(`SELECT * FROM shopping_items WHERE id = ?`).get(id) as ShoppingItem | undefined;
}

export function setChecked(id: number, checked: boolean): ShoppingItem {
  const existing = getItem(id);
  if (!existing) throw new ToolError(`no shopping item with id ${id}`);
  getDb()
    .prepare(`UPDATE shopping_items SET checked_at = ? WHERE id = ?`)
    .run(checked ? nowUtcIso() : null, id);
  return getItem(id)!;
}

export function removeItem(id: number): ShoppingItem {
  const existing = getItem(id);
  if (!existing) throw new ToolError(`no shopping item with id ${id}`);
  getDb().prepare(`DELETE FROM shopping_items WHERE id = ?`).run(id);
  return existing;
}

/** Bulk-clears everything already checked off — the "done with this trip" moment. */
export function clearChecked(): number {
  const result = getDb().prepare(`DELETE FROM shopping_items WHERE checked_at IS NOT NULL`).run();
  return result.changes;
}
