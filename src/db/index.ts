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
 * Single-user app, so there is no migration framework here — just idempotent
 * DDL run on every boot.
 */
export function migrate(): void {
  getDb().exec(SCHEMA);
}
