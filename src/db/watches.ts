import { getDb } from "./index";
import { nowUtcIso } from "../time";

export interface WatchRow {
  id: number;
  url: string;
  note: string | null;
  content_hash: string;
  created_at: string;
  last_checked_at: string | null;
}

export function createWatch(url: string, note: string | null, contentHash: string): WatchRow {
  const now = nowUtcIso();
  const result = getDb()
    .prepare(
      `INSERT INTO watches (url, note, content_hash, created_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(url, note, contentHash, now, now);
  return getWatch(Number(result.lastInsertRowid))!;
}

export function getWatch(id: number): WatchRow | undefined {
  return getDb().prepare(`SELECT * FROM watches WHERE id = ?`).get(id) as WatchRow | undefined;
}

export function listWatches(): WatchRow[] {
  return getDb().prepare(`SELECT * FROM watches ORDER BY created_at ASC`).all() as WatchRow[];
}

export function deleteWatch(id: number): WatchRow | null {
  const existing = getWatch(id);
  if (!existing) return null;
  getDb().prepare(`DELETE FROM watches WHERE id = ?`).run(id);
  return existing;
}

/** Stamps a watch as checked, with its latest content hash. */
export function updateWatchAfterCheck(id: number, contentHash: string): void {
  getDb()
    .prepare(`UPDATE watches SET content_hash = ?, last_checked_at = ? WHERE id = ?`)
    .run(contentHash, nowUtcIso(), id);
}
