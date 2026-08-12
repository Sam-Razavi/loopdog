/**
 * Kept as a TypeScript string rather than a .sql file so the compiled bundle in
 * dist/ has no runtime file dependency to resolve.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,
  due_at       TEXT NOT NULL,          -- UTC ISO-8601
  created_at   TEXT NOT NULL,
  completed_at TEXT,                   -- NULL while pending
  notified_at  TEXT                    -- NULL until the reminder has been pushed
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending
  ON reminders(completed_at, due_at);

CREATE TABLE IF NOT EXISTS habits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,            -- YYYY-MM-DD, already 4am-adjusted
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(habit_id, day)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_lookup
  ON habit_logs(habit_id, day DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,            -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per day the at-risk nudge has already fired (or been evaluated with
-- nothing to say) for. Brand new table, so unlike notified_at on reminders
-- this needs no retroactive column patch — CREATE TABLE IF NOT EXISTS covers
-- both fresh and pre-existing databases.
CREATE TABLE IF NOT EXISTS at_risk_nudges (
  day     TEXT PRIMARY KEY,            -- YYYY-MM-DD, 4am-adjusted local day
  sent_at TEXT NOT NULL
);
`;
