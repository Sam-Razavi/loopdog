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
export function appendTurn(role: StoredTurn["role"], content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  getDb().prepare(`INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)`).run(
    role,
    trimmed,
    nowUtcIso(),
  );
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
