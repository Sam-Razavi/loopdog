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
  notified_at  TEXT,                   -- NULL until the reminder has been pushed
  recurrence   TEXT                    -- NULL, 'daily', or 'weekly'
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending
  ON reminders(completed_at, due_at);

-- One row per completion event, for both one-shot and recurring reminders.
-- Recurring reminders never set reminders.completed_at (completing one rolls
-- it forward to its next occurrence instead of tombstoning it), so
-- completed_at alone would silently undercount the weekly digest's "N
-- reminders done this week". This table is the count's source of truth.
-- The unique index makes the one-time backfill in migrate() idempotent.
CREATE TABLE IF NOT EXISTS reminder_completions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id  INTEGER NOT NULL,       -- deliberately not a FK: the count
                                       -- should survive the reminder being
                                       -- deleted later
  completed_at TEXT NOT NULL           -- UTC ISO-8601
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_completions_unique
  ON reminder_completions(reminder_id, completed_at);

CREATE INDEX IF NOT EXISTS idx_reminder_completions_when
  ON reminder_completions(completed_at);

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

-- One row per week the Sunday digest has already fired for. Same reasoning
-- as at_risk_nudges: brand new table, so CREATE TABLE IF NOT EXISTS covers
-- both fresh and pre-existing databases with no retroactive column patch.
CREATE TABLE IF NOT EXISTS digests (
  week    TEXT PRIMARY KEY,            -- the local Sunday's date, YYYY-MM-DD
  sent_at TEXT NOT NULL
);

-- One row per day the morning brief has already fired for (or been
-- evaluated with nothing to say). Same brand-new-table reasoning as digests.
CREATE TABLE IF NOT EXISTS morning_briefs (
  day     TEXT PRIMARY KEY,            -- YYYY-MM-DD, 4am-adjusted local day
  sent_at TEXT NOT NULL
);

-- Vacation/mute mode: at most one row. Its presence (and until being in the
-- future) means every proactive DM is suppressed until that instant.
CREATE TABLE IF NOT EXISTS mute (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  until TEXT NOT NULL                  -- UTC ISO-8601; mute lifts here
);

-- Pages Loopdog is watching for changes. One background check per watch,
-- gated by its own last_checked_at, not the shared push interval.
CREATE TABLE IF NOT EXISTS watches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,
  note            TEXT,                 -- optional, what to mention when it changes
  content_hash    TEXT NOT NULL,        -- sha256 of the extracted text at last check
  created_at      TEXT NOT NULL,
  last_checked_at TEXT
);

-- Numeric tracking, alongside boolean habits: body measurements, calories,
-- anything that's "a number over time" rather than "did I do this." mode
-- decides how same-day entries combine — 'latest' (a weight reading
-- replaces the last one) or 'sum' (a calorie entry adds to the day's
-- total). metric_logs is append-only either way; the mode only affects how
-- a day's rows get aggregated when reading, not how they're written.
CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  unit       TEXT,                     -- e.g. "kg", "cm", "kcal" — optional, for display
  mode       TEXT NOT NULL DEFAULT 'latest',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id  INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,            -- YYYY-MM-DD, already 4am-adjusted
  value      REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metric_logs_lookup
  ON metric_logs(metric_id, day DESC);

-- Google OAuth (Calendar + Gmail, one connection covers both): at most one
-- row, same single-row shape as mute. 'pending' while waiting on the user
-- to approve the device-flow code in a browser; 'connected' once real
-- tokens are stored. GOOGLE_CLIENT_ID/SECRET are optional env vars — this
-- table simply stays empty for anyone who never sets them up, no impact on
-- the rest of the app.
CREATE TABLE IF NOT EXISTS google_auth (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  status           TEXT NOT NULL,        -- 'pending' | 'connected'
  device_code      TEXT,                 -- set while pending
  user_code        TEXT,                 -- set while pending — shown to the user, re-shown on a re-check
  verification_url TEXT,                 -- set while pending
  poll_interval    INTEGER,              -- seconds, from Google's device response
  expires_at       TEXT,                 -- when the pending device code expires
  access_token     TEXT,                 -- set once connected
  refresh_token    TEXT,                 -- set once connected
  token_expires_at TEXT,                 -- access_token's own expiry
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Microsoft OAuth (Hotmail/Outlook/Live, mail only): at most one row, same
-- single-row shape as google_auth — but no client-secret column, since the
-- device flow's public-client token exchange never sends one. 'pending'
-- while waiting on the user to approve the device-flow code in a browser;
-- 'connected' once real tokens are stored. HOTMAIL_CLIENT_ID is an optional
-- env var — this table simply stays empty for anyone who never sets it up.
CREATE TABLE IF NOT EXISTS hotmail_auth (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  status           TEXT NOT NULL,        -- 'pending' | 'connected'
  device_code      TEXT,                 -- set while pending
  user_code        TEXT,                 -- set while pending — shown to the user, re-shown on a re-check
  verification_url TEXT,                 -- set while pending
  poll_interval    INTEGER,              -- seconds, from Microsoft's device response
  expires_at       TEXT,                 -- when the pending device code expires
  access_token     TEXT,                 -- set once connected
  refresh_token    TEXT,                 -- set once connected
  token_expires_at TEXT,                 -- access_token's own expiry
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Once per day the electricity-price nudge (opt-in via
-- LOOPDOG_ELECTRICITY_NUDGE) has fired, or been evaluated with nothing to
-- say. Same brand-new-table reasoning and shape as at_risk_nudges/digests.
CREATE TABLE IF NOT EXISTS electricity_nudges (
  day     TEXT PRIMARY KEY,            -- YYYY-MM-DD, 4am-adjusted local day
  sent_at TEXT NOT NULL
);

-- Weather warnings already DMed, so a still-active one doesn't re-fire every
-- tick — keyed by the warning's own id (real or synthesized, see
-- smhiwarnings.ts) rather than a day, since a warning can span multiple
-- days and multiple warnings can be active on the same day. Only relevant
-- when LOOPDOG_SMHI_COUNTY is set; stays empty otherwise.
CREATE TABLE IF NOT EXISTS smhi_warnings_seen (
  id      TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

-- A running, checkable shopping/grocery list — distinct from reminders,
-- which are timed and one-shot/recurring, not "things to pick up whenever."
-- checked_at NULL means still needed; append-only history otherwise (a
-- checked item isn't deleted, just marked, so clear_checked can bulk-clear
-- a finished trip in one step).
CREATE TABLE IF NOT EXISTS shopping_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item       TEXT NOT NULL,
  note       TEXT,
  checked_at TEXT,              -- NULL while still needed
  created_at TEXT NOT NULL
);

-- Standing facts the user explicitly asked Loopdog to remember — distinct
-- from conversation history, which only feeds the last ~20 turns into each
-- response. Every memory here is injected into every system prompt, so
-- it's always known, not just recalled if it happens to still be in the
-- recent window.
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
