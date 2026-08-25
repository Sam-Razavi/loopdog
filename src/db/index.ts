import Database from "better-sqlite3";
import { config } from "../config";
import { SCHEMA } from "./schema";

let connection: Database.Database | null = null;

/**
 * Opened on first use rather than at import time, so a boot that fails config
 * validation doesn't leave an empty database file behind.
 */
export function getDb(): Database.Database {
  if (connection) return connection;
  connection = new Database(config.dbPath);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  return connection;
}

/**
 * Adds a column to an existing table if it isn't there yet. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS` in SCHEMA is a
 * no-op against a table that already exists — so a database created before a
 * column was added to the schema never picks it up on its own. This is how
 * that database catches up. Idempotent: safe to call on every boot.
 */
function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = getDb().prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Single-user app, so there is no migration framework here — SCHEMA covers
 * fresh installs, and ensureColumn() catches up any additive column a
 * pre-existing database is missing. Both converge on the same shape, and
 * running this twice is always a safe no-op.
 */
export function migrate(): void {
  getDb().exec(SCHEMA);
  ensureColumn("reminders", "notified_at", "notified_at TEXT");
  ensureColumn("reminders", "recurrence", "recurrence TEXT");
}

/**
 * Safely snapshots the live database — including in-progress WAL contents —
 * to a separate file, for the on-demand "back up my data" tool. better-
 * sqlite3's .backup() is built for exactly this: copying a database that's
 * actively being written to, without locking it.
 */
export async function backupDatabase(destPath: string): Promise<void> {
  await getDb().backup(destPath);
}
