import { getDb } from "./index";
import { nowUtcIso } from "../time";

export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Only plain text turns are persisted — not the intermediate tool_use /
 * tool_result rounds. A sliding window over raw tool blocks can slice a
 * tool_use away from its result, which the API rejects outright; the final
 * assistant reply carries the substance anyway, so "complete the second one"
 * still resolves after a restart.
 */
/**
 * How many turns to keep on disk. Only the most recent ~20 are ever read
 * back into a prompt; the rest of this is headroom so a restart or a manual
 * poke at the database still has recent context to look at. Without a cap
 * the table grew forever and rode along inside every export_backup.
 */
const RETAINED_TURNS = 500;

export function appendTurn(role: StoredTurn["role"], content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const db = getDb();
  db.prepare(`INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)`).run(
    role,
    trimmed,
    nowUtcIso(),
  );
  // Cheap at this size, and keeps the table from being unbounded. Runs on
  // every append rather than on a timer so there's no growth window at all.
  db.prepare(
    `DELETE FROM messages
     WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
  ).run(RETAINED_TURNS);
}

export function recentTurns(limit = 20): StoredTurn[] {
  const rows = getDb()
    .prepare(`SELECT role, content FROM messages ORDER BY id DESC LIMIT ?`)
    .all(limit) as StoredTurn[];
  const chronological = rows.reverse();

  // The API requires the first message to be a user turn.
  while (chronological.length && chronological[0]!.role !== "user") {
    chronological.shift();
  }
  return chronological;
}

export function clearHistory(): void {
  getDb().prepare(`DELETE FROM messages`).run();
}
