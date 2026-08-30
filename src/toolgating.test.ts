import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Env must be set before any static import of ./config (tsx compiles to CJS,
 * where imports hoist), same pattern as the DB-backed tests. Each case needs a
 * different config, so the module is loaded in a child process per case.
 */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

import { execFileSync } from "node:child_process";

/** Runs buildTools() in a fresh process with the given env, returns tool names. */
function toolNamesWith(env: Record<string, string>): string[] {
  const script = `
    const { buildTools } = require(process.argv[1]);
    console.log(JSON.stringify(buildTools().map((t) => t.name)));
  `;
  const out = execFileSync(
    "npx",
    ["tsx", "-e", script, join(process.cwd(), "src/tools.ts")],
    { env: { ...process.env, ...env }, encoding: "utf-8" },
  );
  return JSON.parse(out.trim().split("\n").pop()!) as string[];
}

const GATED = [
  "list_canvas_courses",
  "list_smart_devices",
  "start_vacuum",
  "list_telegram_chats",
  "connect_google",
  "list_emails",
  "check_all_inboxes",
  "plan_transit_trip",
  "web_search",
];

test("buildTools: drops every unconfigured integration's tools", () => {
  const names = toolNamesWith({
    CANVAS_BASE_URL: "", CANVAS_API_TOKEN: "", TUYA_ACCESS_ID: "", TUYA_ACCESS_SECRET: "",
    TUYA_UID: "", ROBOROCK_USER_DATA: "", TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "",
    TELEGRAM_SESSION: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", HOTMAIL_CLIENT_ID: "",
    PRIVATEMAIL_EMAIL: "", PRIVATEMAIL_PASSWORD: "", TRAFIKLAB_API_KEY: "", TAVILY_API_KEY: "",
    GMAIL_CLIENT_ID: "", GMAIL_CLIENT_SECRET: "", GMAIL_REFRESH_TOKEN: "",
  });
  for (const gated of GATED) {
    assert.ok(!names.includes(gated), `${gated} should be dropped when unconfigured`);
  }
  // Keyless tools must survive — gating must never touch them.
  for (const keyless of ["log_habit", "create_reminder", "get_electricity_price", "get_transit_departures", "list_swedish_holidays"]) {
    assert.ok(names.includes(keyless), `${keyless} must always be present`);
  }
});

test("buildTools: a configured integration's tools come back", () => {
  const names = toolNamesWith({
    CANVAS_BASE_URL: "https://x.instructure.com", CANVAS_API_TOKEN: "tok",
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
    TAVILY_API_KEY: "tav",
  });
  for (const present of ["list_canvas_courses", "list_canvas_grades", "connect_google", "list_calendar_events", "web_search"]) {
    assert.ok(names.includes(present), `${present} should be present once configured`);
  }
  // Still-unconfigured ones stay dropped.
  assert.ok(!names.includes("start_vacuum"));
  assert.ok(!names.includes("list_telegram_chats"));
});

test("buildTools: gating is deterministic — identical output across calls (cache prefix stability)", () => {
  const env = { CANVAS_BASE_URL: "https://x.instructure.com", CANVAS_API_TOKEN: "tok" };
  assert.deepEqual(toolNamesWith(env), toolNamesWith(env));
});

/**
 * Gmail is the one email provider whose credentials are unrelated to its
 * sibling connection: it rides its own OAuth client, not the Calendar
 * device flow. So configuring *only* Gmail has to be enough to bring the
 * email tools back — before Gmail worked, the gate deliberately ignored it,
 * and forgetting to revisit that would leave the tools invisible no matter
 * how correctly the user set the login up.
 */
test("buildTools: Gmail alone unlocks the email tools, without any other provider", () => {
  const names = toolNamesWith({
    GMAIL_CLIENT_ID: "gid", GMAIL_CLIENT_SECRET: "gsecret", GMAIL_REFRESH_TOKEN: "grefresh",
    HOTMAIL_CLIENT_ID: "", PRIVATEMAIL_EMAIL: "", PRIVATEMAIL_PASSWORD: "",
    TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "", TELEGRAM_SESSION: "",
  });
  for (const present of ["list_emails", "get_email", "create_email_draft", "check_all_inboxes"]) {
    assert.ok(names.includes(present), `${present} should be present with only Gmail configured`);
  }
  // Gmail is not a calendar connection — it must not drag Calendar's tools in.
  assert.ok(!names.includes("connect_google"), "Gmail credentials must not imply Calendar");
  assert.ok(!names.includes("connect_hotmail"));
});

test("buildTools: partial Gmail credentials are treated as not configured", () => {
  const names = toolNamesWith({
    GMAIL_CLIENT_ID: "gid", GMAIL_CLIENT_SECRET: "gsecret", GMAIL_REFRESH_TOKEN: "",
    HOTMAIL_CLIENT_ID: "", PRIVATEMAIL_EMAIL: "", PRIVATEMAIL_PASSWORD: "",
    TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "", TELEGRAM_SESSION: "",
  });
  assert.ok(!names.includes("list_emails"), "a missing refresh token means Gmail cannot work");
});
