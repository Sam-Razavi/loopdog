import { getDb } from "./index";
import { addDays, localDay, nowUtcIso } from "../time";
import { ToolError } from "../errors";

export interface JournalEntry {
  id: number;
  day: string;
  text: string;
  created_at: string;
}

export function addEntry(day: string, text: string): JournalEntry {
  const now = nowUtcIso();
  const result = getDb()
    .prepare(`INSERT INTO journal_entries (day, text, created_at) VALUES (?, ?, ?)`)
    .run(day, text.trim(), now);
  return getDb()
    .prepare(`SELECT * FROM journal_entries WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as JournalEntry;
}

export interface GetEntriesOptions {
  /** A specific day, YYYY-MM-DD. Takes precedence over `days` if both are given. */
  day?: string;
  /** How many recent days (including today) to look back over. */
  days?: number;
  /** Plain substring match against entry text, case-insensitive. */
  query?: string;
}

/**
 * Newest first. A plain LIKE substring search rather than FTS5 — consistent
 * with this project's minimal-tooling preference (same spirit as the SL
 * stop resolver's substring matching) and plenty for one person's journal.
 *
 * Orders by `id DESC` after `created_at DESC`: two entries added back-to-back
 * can land in the same millisecond, and without a tiebreaker their relative
 * order would be unspecified. `id` is monotonic insertion order, so it's a
 * reliable secondary key.
 */
export function getEntries(options: GetEntriesOptions = {}): JournalEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.day) {
    where.push("day = ?");
    params.push(options.day);
  } else if (options.days) {
    where.push("day >= ?");
    params.push(addDays(localDay(), -(options.days - 1)));
  }

  if (options.query) {
    where.push("text LIKE ? COLLATE NOCASE");
    params.push(`%${options.query}%`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM journal_entries ${clause} ORDER BY created_at DESC, id DESC`)
    .all(...params) as JournalEntry[];
}

export function deleteEntry(id: number): JournalEntry {
  const existing = getDb().prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(id) as
    | JournalEntry
    | undefined;
  if (!existing) throw new ToolError(`no journal entry with id ${id}`);
  getDb().prepare(`DELETE FROM journal_entries WHERE id = ?`).run(id);
  return existing;
}
