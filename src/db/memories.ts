import { getDb } from "./index";
import { nowUtcIso } from "../time";
import { ToolError } from "../errors";

export interface Memory {
  id: number;
  text: string;
  created_at: string;
}

export function addMemory(text: string): Memory {
  const now = nowUtcIso();
  const result = getDb()
    .prepare(`INSERT INTO memories (text, created_at) VALUES (?, ?)`)
    .run(text, now);
  return getDb()
    .prepare(`SELECT * FROM memories WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as Memory;
}

export function listMemories(): Memory[] {
  return getDb().prepare(`SELECT * FROM memories ORDER BY created_at ASC`).all() as Memory[];
}

export function forgetMemory(id: number): Memory {
  const existing = getDb().prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | Memory
    | undefined;
  if (!existing) throw new ToolError(`no memory with id ${id}`);
  getDb().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return existing;
}
