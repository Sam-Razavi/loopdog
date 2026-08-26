import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { backupDatabase } from "./db";
import {
  createReminder,
  completeReminder,
  deleteReminder,
  listReminders,
  updateReminder,
  type Recurrence,
  type ReminderStatus,
} from "./db/reminders";
import { getHabitDetail, listHabits, logHabit, unlogHabit } from "./db/habits";
import { clearMute, setMute } from "./db/mute";
import { createWatch, deleteWatch, listWatches } from "./db/watches";
import { getMetricHistory, listMetrics, logMetric, type MetricMode } from "./db/metrics";
import { addMemory, forgetMemory, listMemories } from "./db/memories";
import { renderHabitChart } from "./chart";
import { renderMetricChart } from "./linechart";
import * as googleCalendar from "./google";
import * as hotmail from "./hotmail";
import * as privatemail from "./privatemail";
import * as telegram from "./telegram";
import { gatherWeekSummary } from "./pusher";
import { pickRandom, rollDice } from "./random";
import { formatLocal, isValidDay, localDay, nowUtcIso, toUtcIso } from "./time";
import { fetchReadableText } from "./webfetch";
import { getWeather } from "./weather";
import { ToolError } from "./errors";

export { ToolError };

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_reminder",
    description:
      "Create a reminder with a specific due time. Call this whenever the user " +
      "asks to be reminded of something, or mentions something they need to do " +
      "at a particular time. Resolve relative phrasing like 'tomorrow at 9am' or " +
      "'in two hours' against the current local time given in the system prompt. " +
      "For something that repeats — 'every day', 'every Monday' — set recurrence " +
      "instead of asking the user to recreate it each time.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "What to be reminded of, phrased as the user would recognise it. " +
            "Keep their wording where possible: 'stretch', not 'perform stretching'.",
        },
        due_at: {
          type: "string",
          description:
            "When it is first due, as ISO-8601 with an explicit UTC offset, " +
            "e.g. 2026-08-12T09:00:00+02:00. A timestamp without an offset is rejected.",
        },
        recurrence: {
          type: "string",
          enum: ["daily", "weekly"],
          description:
            "Omit for a one-shot reminder. 'daily' for 'every day', 'weekly' for " +
            "'every Monday' or similar. Once pushed, it rolls forward to its next " +
            "occurrence automatically — no need for the user to recreate it.",
        },
      },
      required: ["text", "due_at"],
    },
  },
  {
    name: "list_reminders",
    description:
      "List reminders. Call this for any question about what is due, what is " +
      "outstanding, or what the user has coming up — and before completing a " +
      "reminder the user described in words rather than by number, so you can " +
      "match their description to an id.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "completed", "all"],
          description: "Defaults to pending.",
        },
        due_before: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp with offset. Use for questions scoped " +
            "to a window, like 'what's due today?'.",
        },
        limit: {
          type: "integer",
          description: "Maximum number to return. Defaults to 20.",
        },
      },
      required: [],
    },
  },
  {
    name: "complete_reminder",
    description:
      "Mark a reminder done. Call this when the user says they have finished " +
      "something. If they describe it rather than giving an id, call " +
      "list_reminders first to find the right one.\n\n" +
      "A recurring reminder does not disappear when completed — it rolls " +
      "forward to its next occurrence and the result comes back with " +
      "rolled_forward: true and the new due time. Say so briefly (\"Done. " +
      "Back tomorrow at 09:00.\") rather than implying it is finished for " +
      "good. To actually stop a recurring reminder, use delete_reminder.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The reminder's id." },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_reminder",
    description:
      "Delete a reminder outright. Use this only when the user wants to cancel " +
      "or undo something — a reminder they no longer need, or one created by " +
      "mistake. Completing is the right call when they actually did the thing. " +
      "This is also how a recurring reminder is stopped for good, since " +
      "completing one only rolls it forward to its next occurrence.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The reminder's id." },
      },
      required: ["id"],
    },
  },
  {
    name: "log_habit",
    description:
      "Record that a habit was done on a given day. Call this whenever the user " +
      "reports doing something trackable — 'log gym', 'read today', 'did my " +
      "stretching'. The habit is created automatically the first time it is " +
      "named, so there is no setup step. Returns the resulting streak.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short habit name, lowercase, matched case-insensitively against " +
            "existing habits: 'gym', 'reading', 'meditation', 'side project'. " +
            "Reuse the existing name when the user clearly means an existing habit.",
        },
        day: {
          type: "string",
          description:
            "YYYY-MM-DD. Omit for today. Set it only when the user is explicitly " +
            "back-filling ('I read yesterday too').",
        },
        note: {
          type: "string",
          description: "Optional detail the user volunteered, e.g. '5km' or 'chapter 4'.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_habit_streak",
    description:
      "Get the current streak, best-ever streak and recent day-by-day history " +
      "for one habit. Call this for any question about how a specific habit is " +
      "going, or whether a particular day was logged.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The habit name." },
        history_days: {
          type: "integer",
          description: "How many recent days of history to return. Defaults to 14.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_habits",
    description:
      "List every tracked habit with its current streak. Call this for broad " +
      "questions — 'how am I doing?', 'what am I tracking?', 'what's slipping?' — " +
      "rather than calling get_habit_streak repeatedly.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "week_summary",
    description:
      "Get a summary of the last 7 days — each habit's days logged and " +
      "current streak, plus reminders completed and still pending. Call this " +
      "when the user asks how the week's going or wants a recap on demand — " +
      "separate from the automatic Sunday digest, which fires on its own schedule.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "undo_habit_log",
    description:
      "Undo a habit log. Call this when the user says they logged something by " +
      "mistake — 'undo that, I didn't actually go', 'remove yesterday's reading " +
      "log'. This is a plain correction, not a big deal — just fix the number.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The habit name." },
        day: {
          type: "string",
          description: "YYYY-MM-DD. Omit for today.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "edit_reminder",
    description:
      "Change an existing reminder's text and/or due time in place — 'actually " +
      "push that back to 6pm', 'change that to say pick up the dry cleaning'. " +
      "Use this instead of delete_reminder plus create_reminder. If the user " +
      "describes it rather than giving an id, call list_reminders first.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The reminder's id." },
        text: { type: "string", description: "New wording. Omit to leave unchanged." },
        due_at: {
          type: "string",
          description:
            "New due time, ISO-8601 with an explicit UTC offset, same format as " +
            "create_reminder. Omit to leave unchanged.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "export_backup",
    description:
      "Create a downloadable backup of the database and attach it to the reply. " +
      "Call this only when the user explicitly asks for a backup, an export, or " +
      "to download their data — not routinely.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_mute",
    description:
      "Pause every proactive DM Loopdog sends unprompted — reminder pushes, " +
      "habit nudges, the digest, the morning brief, watched-page alerts — until " +
      "a given time. Call this when the user asks not to be nudged or bothered " +
      "for a while: 'mute for a week', 'don't nudge me until Friday', 'I'm " +
      "traveling until the 30th, leave me alone till then'. Conversation still " +
      "works as normal while muted — this only stops proactive DMs.",
    input_schema: {
      type: "object",
      properties: {
        until: {
          type: "string",
          description:
            "When the mute lifts, as ISO-8601 with an explicit UTC offset, same " +
            "format as create_reminder's due_at.",
        },
      },
      required: ["until"],
    },
  },
  {
    name: "clear_mute",
    description:
      "Resume proactive DMs immediately. Call when the user says they're back, " +
      "or wants nudges again before a mute would naturally expire.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "fetch_url",
    description:
      "Fetch a web page and return its readable text, for summarizing or " +
      "answering questions about it. Call this when the user shares a link and " +
      "asks about it, or asks you to read or summarize a URL. Works well for " +
      "text-heavy pages; poorly for pages that need JavaScript to render.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to fetch, including http(s)://." },
      },
      required: ["url"],
    },
  },
  {
    name: "watch_page",
    description:
      "Start watching a web page for changes. Loopdog checks it periodically " +
      "and DMs when the content changes. Call this when the user asks to be " +
      "told when a page changes — a restock, a price drop, a status page.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to watch, including http(s)://." },
        note: {
          type: "string",
          description: "What to mention in the alert, e.g. 'restock' or 'price drop'. Optional.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_watches",
    description: "List every page currently being watched for changes.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "unwatch_page",
    description: "Stop watching a page. Call when the user no longer wants alerts for it.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The watch's id, from list_watches." },
      },
      required: ["id"],
    },
  },
  {
    name: "random_pick",
    description:
      "Pick one option at random for the user — 'coffee or tea', 'pick a " +
      "restaurant for me from these three'. Real randomness, not a guess.",
    input_schema: {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: { type: "string" },
          description: "At least two options to pick from.",
        },
      },
      required: ["options"],
    },
  },
  {
    name: "roll_dice",
    description: "Roll one or more dice, or flip a coin (sides: 2). Real randomness.",
    input_schema: {
      type: "object",
      properties: {
        sides: { type: "integer", description: "Sides per die. Defaults to 6." },
        count: { type: "integer", description: "How many to roll. Defaults to 1." },
      },
      required: [],
    },
  },
  {
    name: "convert_currency",
    description: "Convert an amount between two currencies using a live exchange rate.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "The amount to convert." },
        from: { type: "string", description: "Source currency code, e.g. 'USD'." },
        to: { type: "string", description: "Target currency code, e.g. 'SEK'." },
      },
      required: ["amount", "from", "to"],
    },
  },
  {
    name: "get_weather",
    description:
      "Get current weather conditions. Call this for any weather question — " +
      "'what's it like out', 'should I run today'. Defaults to the configured " +
      "city if none is given.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Optional. Defaults to the configured city." },
      },
      required: [],
    },
  },
  {
    name: "habit_chart",
    description:
      "Generate a calendar-heatmap image of a habit's recent history and " +
      "attach it to the reply. Call this when the user asks to see, show, or " +
      "visualize a streak or habit history, rather than just hear the numbers.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The habit name." },
        days: {
          type: "integer",
          description: "How many recent days to chart. Defaults to 84 (12 weeks).",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "log_metric",
    description:
      "Record a numeric reading — a body measurement (weight, waist, chest), " +
      "or a running total like calories. Call this for anything that's a " +
      "number over time, not a yes/no habit. The habit is created automatically " +
      "on first use, same as log_habit.\n\n" +
      "mode matters and is only set on the FIRST log of a new metric (later " +
      "calls ignore it, the metric keeps its original mode): " +
      "'latest' (the default) is for a point-in-time reading, like weight or a " +
      "measurement — each log replaces the day's value. 'sum' is for something " +
      "that accumulates across multiple entries in a day, like calories or " +
      "water — each log adds to the day's running total. Use 'sum' the first " +
      "time you log a habit like calories; a single weight reading should stay " +
      "'latest'.\n\n" +
      "If the user describes a meal or shares a photo of one without giving an " +
      "exact number, estimate the calories yourself from what you can see or " +
      "read, and say in the note that it's an estimate — don't ask them to " +
      "count calories themselves when a reasonable estimate is possible.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short metric name, lowercase: 'weight', 'waist', 'calories'.",
        },
        value: { type: "number", description: "The number to log." },
        unit: {
          type: "string",
          description: "e.g. 'kg', 'cm', 'kcal'. Only used the first time a metric is created.",
        },
        mode: {
          type: "string",
          enum: ["latest", "sum"],
          description: "Only used the first time a metric is created. See above for which to pick.",
        },
        day: { type: "string", description: "YYYY-MM-DD. Omit for today." },
        note: {
          type: "string",
          description: "Optional detail, e.g. 'lunch: chicken salad' or 'estimated from photo'.",
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "get_metric_history",
    description:
      "Get a metric's recent day-by-day values, current/latest reading, and " +
      "mode. Call this for any question about how a measurement or running " +
      "total has been trending.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The metric name." },
        history_days: {
          type: "integer",
          description: "How many recent days of history to return. Defaults to 30.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_metrics",
    description:
      "List every tracked metric with today's value. Call this for broad " +
      "questions — 'what am I tracking?', 'how am I doing on measurements?'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "metric_chart",
    description:
      "Generate a trend-line image of a metric's recent history and attach it " +
      "to the reply. Call this when the user asks to see, show, or visualize a " +
      "measurement or calorie trend, rather than just hear the numbers.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The metric name." },
        days: {
          type: "integer",
          description: "How many recent days to chart. Defaults to 30.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "connect_google",
    description:
      "Connect the user's Google account (Calendar + Gmail, one connection " +
      "covers both). Call this when the user asks to connect, set up, or link " +
      "their calendar or email, or asks 'did it connect?' / 'is it connected?' " +
      "after starting the process. Re-invokable and idempotent: if a " +
      "connection attempt is already in progress, this checks it instead of " +
      "starting a new one; if already connected, it says so. On first call it " +
      "returns a short code and a URL — tell the user to go there and enter " +
      "the code, then ask you to check again once they have.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "disconnect_google",
    description:
      "Disconnect the Google account. Call when the user asks to unlink or " +
      "disconnect calendar or email access — this removes both at once, " +
      "since they share one connection.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_calendar_events",
    description:
      "List upcoming Google Calendar events. Call this for any question about " +
      "what's on the calendar. Fails with a plain error if not connected yet — " +
      "tell the user to ask you to connect_google first.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "How many days ahead to look. Defaults to 7.",
        },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a Google Calendar event. Call this when the user asks to add, " +
      "schedule, or book something on their calendar. Fails with a plain " +
      "error if not connected yet.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        start: {
          type: "string",
          description: "Start time, ISO-8601 with an explicit UTC offset, same format as create_reminder's due_at.",
        },
        end: {
          type: "string",
          description: "End time, same format as start.",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "connect_hotmail",
    description:
      "Connect a Hotmail/Outlook/Live account (Microsoft) for email — a " +
      "separate account and connection from Gmail; both can be connected " +
      "at once. Call this when the user asks to connect, set up, or link " +
      "their Hotmail or Outlook, or asks 'did it connect?' / 'is it " +
      "connected?' after starting the process. Re-invokable and idempotent, " +
      "same pattern as connect_google: if a connection attempt is already " +
      "in progress, this checks it instead of starting a new one; if " +
      "already connected, it says so. On first call it returns a short " +
      "code and a URL — tell the user to go there and enter the code, then " +
      "ask you to check again once they have.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "disconnect_hotmail",
    description: "Disconnect the Hotmail/Outlook account. Doesn't affect a separate Gmail connection.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_emails",
    description:
      "List or search email — Gmail, Hotmail/Outlook, PrivateMail, or " +
      "whichever is set up. Call this for any question about what's in " +
      "the inbox, or to find a specific email. Fails with a plain error if " +
      "nothing's usable yet — tell the user to ask you to connect_google, " +
      "connect_hotmail, or set up PrivateMail's env vars first. If more " +
      "than one is usable and it's not clear which one the user means, " +
      "this fails asking you to specify 'provider' — ask the user, or " +
      "infer it from context (an address ending in " +
      "@hotmail.com/@outlook.com/@live.com clearly means Hotmail; the " +
      "user's own domain clearly means PrivateMail). Returns sender, " +
      "subject, and date for each match (plus a short snippet for Gmail/" +
      "Hotmail — PrivateMail doesn't have one), not the full body — call " +
      "get_email with an id from these results if the full content is " +
      "actually needed.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["gmail", "hotmail", "privatemail"],
          description:
            "Which account to use. Omit if only one is usable — only needed " +
            "when more than one of Gmail/Hotmail/PrivateMail is usable at once.",
        },
        query: {
          type: "string",
          description:
            "Search terms. For Gmail this is Gmail's own search syntax, e.g. " +
            "'is:unread', 'from:someone@example.com', 'newer_than:7d', " +
            "'subject:invoice'. For Hotmail and PrivateMail this is a " +
            "plain-text search across subject/body/sender. Omit for the " +
            "most recent inbox messages.",
        },
        max_results: {
          type: "integer",
          description: "How many to return. Defaults to 10.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_email",
    description:
      "Get the full content of one email, including its body text. Call " +
      "this when the user asks about the actual content of a message found " +
      "via list_emails, not just its subject/snippet.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The email's id, from list_emails." },
        provider: {
          type: "string",
          enum: ["gmail", "hotmail", "privatemail"],
          description: "Which account the id came from. Omit if only one is usable.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_email_draft",
    description:
      "Create an email draft — in Gmail, Hotmail/Outlook, PrivateMail, or " +
      "whichever the user means. This is the only email tool that writes " +
      "anything — there is no send tool for any of the three, deliberately: " +
      "Loopdog can compose an email but the user always reviews and sends " +
      "it themselves. Call this when the user asks to draft, write, or " +
      "compose an email, and tell them it's sitting in Drafts once done.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Plain-text email body." },
        provider: {
          type: "string",
          enum: ["gmail", "hotmail", "privatemail"],
          description:
            "Which account to draft from. Omit if only one is usable — only " +
            "needed when more than one of Gmail/Hotmail/PrivateMail is usable at once.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "list_telegram_chats",
    description:
      "List recent Telegram chats (DMs, groups, channels) with unread " +
      "counts and a last-message preview. Call this for broad questions " +
      "about what's going on in Telegram, or to find a chat's id before " +
      "calling get_telegram_messages. Fails with a plain error if not set " +
      "up yet — Telegram has no in-conversation connect step (it needs a " +
      "one-time login run locally, see the README), so just say that " +
      "plainly rather than offering to connect it yourself.",
    input_schema: {
      type: "object",
      properties: {
        max_results: {
          type: "integer",
          description: "How many chats to return. Defaults to 15.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_telegram_messages",
    description:
      "Get recent messages from one Telegram chat, or search within it. " +
      "Call this when the user asks what someone said, or wants to check a " +
      "specific chat. Read only — there is no reply/send tool, deliberately.",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The chat's id, from list_telegram_chats." },
        query: {
          type: "string",
          description: "Optional text to search for within this chat. Omit for the most recent messages.",
        },
        max_results: {
          type: "integer",
          description: "How many messages to return. Defaults to 15.",
        },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "remember",
    description:
      "Store a fact permanently — a preference, an allergy, an important date, " +
      "an ongoing detail about the user's life. Distinct from ordinary " +
      "conversation, which only stays in the recent window: a memory is " +
      "injected into every future conversation, always known, not just " +
      "recalled if it happens to still be recent. Call this only when the " +
      "user explicitly says something like 'remember that...', or clearly " +
      "means something to stick around long-term — not for casual remarks or " +
      "anything already covered by a reminder/habit/metric tool.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact to remember, plainly stated." },
      },
      required: ["text"],
    },
  },
  {
    name: "list_memories",
    description: "List everything currently remembered. Call if the user asks what you know or remember about them.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "forget",
    description:
      "Delete a stored memory. Call when the user asks to forget something, " +
      "or says a remembered fact is no longer true. The id is already visible " +
      "in the live-state block below if it's currently listed there; call " +
      "list_memories first only if you don't already know the id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The memory's id." },
      },
      required: ["id"],
    },
  },
];

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalStr(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`);
  return value.trim();
}

function int(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolError(`"${key}" is required and must be an integer`);
  }
  return value;
}

function optionalInt(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolError(`"${key}" must be an integer`);
  }
  return value;
}

function optionalRecurrence(
  input: Record<string, unknown>,
  key: string,
): Recurrence | null {
  const value = optionalStr(input, key);
  if (value === undefined) return null;
  if (value !== "daily" && value !== "weekly") {
    throw new ToolError(`"${key}" must be "daily" or "weekly", got "${value}"`);
  }
  return value;
}

function num(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(`"${key}" is required and must be a number`);
  }
  return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new ToolError(`"${key}" is required and must be a non-empty array of strings`);
  }
  return value;
}

type EmailProvider = "gmail" | "hotmail" | "privatemail";
const EMAIL_PROVIDERS: EmailProvider[] = ["gmail", "hotmail", "privatemail"];

/**
 * Picks which usable email account an email tool call should use. Explicit
 * `provider` wins; otherwise exactly one usable account picks itself. Zero
 * usable, or more than one usable with no `provider` given, is a ToolError
 * telling the model what to do next rather than guessing — same "say what
 * went wrong, offer the obvious next step" pattern as every other tool
 * error. PrivateMail has no connect/disconnect step — "usable" for it just
 * means its env vars are set.
 */
function resolveEmailProvider(input: Record<string, unknown>): EmailProvider {
  const requested = optionalStr(input, "provider");
  if (requested !== undefined) {
    if (!EMAIL_PROVIDERS.includes(requested as EmailProvider)) {
      throw new ToolError(`"provider" must be one of ${EMAIL_PROVIDERS.join(", ")}, got "${requested}"`);
    }
    return requested as EmailProvider;
  }
  const usable = EMAIL_PROVIDERS.filter((provider) =>
    provider === "gmail"
      ? googleCalendar.isConnected()
      : provider === "hotmail"
        ? hotmail.isConnected()
        : privatemail.isConfigured(),
  );
  if (usable.length === 1) return usable[0]!;
  if (usable.length === 0) {
    throw new ToolError(
      `no email account usable yet — call connect_google, call connect_hotmail, or set up PrivateMail's env vars, or ask the user which they want.`,
    );
  }
  throw new ToolError(`more than one email account is usable (${usable.join(", ")}) — call again with "provider" set to whichever the user means.`);
}

export async function runTool(name: string, rawInput: unknown): Promise<unknown> {
  const input = asRecord(rawInput);

  switch (name) {
    case "create_reminder": {
      return createReminder(
        str(input, "text"),
        toUtcIso(str(input, "due_at")),
        optionalRecurrence(input, "recurrence"),
      );
    }

    case "list_reminders": {
      const status = optionalStr(input, "status") ?? "pending";
      if (!["pending", "completed", "all"].includes(status)) {
        throw new ToolError(`"status" must be pending, completed or all`);
      }
      const dueBefore = optionalStr(input, "due_before");
      return {
        reminders: listReminders({
          status: status as ReminderStatus,
          dueBefore: dueBefore ? toUtcIso(dueBefore) : undefined,
          limit: optionalInt(input, "limit", 20),
        }),
      };
    }

    case "complete_reminder": {
      const id = int(input, "id");
      const updated = completeReminder(id);
      if (!updated) throw new ToolError(`no reminder with id ${id}`);
      return updated;
    }

    case "delete_reminder": {
      const id = int(input, "id");
      const deleted = deleteReminder(id);
      if (!deleted) throw new ToolError(`no reminder with id ${id}`);
      return { deleted: true, reminder: deleted };
    }

    case "log_habit": {
      const day = optionalStr(input, "day") ?? localDay();
      if (!isValidDay(day)) {
        throw new ToolError(`"day" must be YYYY-MM-DD, got "${day}"`);
      }
      return logHabit(str(input, "name"), day, optionalStr(input, "note"));
    }

    case "get_habit_streak": {
      const name = str(input, "name");
      const detail = getHabitDetail(name, optionalInt(input, "history_days", 14));
      if (!detail) {
        const known = listHabits().map((h) => h.name);
        throw new ToolError(
          known.length
            ? `no habit called "${name}". Currently tracked: ${known.join(", ")}`
            : `no habit called "${name}", and nothing is being tracked yet`,
        );
      }
      return detail;
    }

    case "list_habits": {
      return { habits: listHabits() };
    }

    case "week_summary": {
      return gatherWeekSummary();
    }

    case "undo_habit_log": {
      const day = optionalStr(input, "day") ?? localDay();
      if (!isValidDay(day)) {
        throw new ToolError(`"day" must be YYYY-MM-DD, got "${day}"`);
      }
      return unlogHabit(str(input, "name"), day);
    }

    case "edit_reminder": {
      const id = int(input, "id");
      const text = optionalStr(input, "text");
      const dueAtRaw = optionalStr(input, "due_at");
      if (text === undefined && dueAtRaw === undefined) {
        throw new ToolError(`edit_reminder needs at least one of "text" or "due_at"`);
      }
      const updated = updateReminder(id, {
        text,
        dueAtUtc: dueAtRaw ? toUtcIso(dueAtRaw) : undefined,
      });
      if (!updated) throw new ToolError(`no reminder with id ${id}`);
      return updated;
    }

    case "export_backup": {
      const path = join(tmpdir(), `loopdog-backup-${nowUtcIso().replace(/[:.]/g, "-")}.sqlite`);
      await backupDatabase(path);
      return { ok: true, path };
    }

    case "set_mute": {
      const untilUtc = toUtcIso(str(input, "until"));
      setMute(untilUtc);
      return { until: untilUtc, until_local: formatLocal(new Date(untilUtc)) };
    }

    case "clear_mute": {
      return { cleared: clearMute() };
    }

    case "fetch_url": {
      return await fetchReadableText(str(input, "url"));
    }

    case "watch_page": {
      const url = str(input, "url");
      const note = optionalStr(input, "note") ?? null;
      const { text } = await fetchReadableText(url);
      const contentHash = createHash("sha256").update(text).digest("hex");
      return createWatch(url, note, contentHash);
    }

    case "list_watches": {
      return { watches: listWatches() };
    }

    case "unwatch_page": {
      const id = int(input, "id");
      const deleted = deleteWatch(id);
      if (!deleted) throw new ToolError(`no watch with id ${id}`);
      return { deleted: true, watch: deleted };
    }

    case "random_pick": {
      return { picked: pickRandom(stringArray(input, "options")) };
    }

    case "roll_dice": {
      const sides = optionalInt(input, "sides", 6);
      const count = optionalInt(input, "count", 1);
      const rolls = rollDice(sides, count);
      return { rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) };
    }

    case "convert_currency": {
      const amount = num(input, "amount");
      const from = str(input, "from").toUpperCase();
      const to = str(input, "to").toUpperCase();
      let response: Response;
      try {
        response = await fetch(
          `https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`,
          { signal: AbortSignal.timeout(10_000) },
        );
      } catch (error) {
        throw new ToolError(
          `couldn't reach the exchange rate service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new ToolError(`couldn't convert ${from} to ${to} — check the currency codes`);
      }
      const data = (await response.json()) as { amount: number; date: string; rates: Record<string, number> };
      const result = data.rates[to];
      if (result === undefined) throw new ToolError(`no rate available for ${to}`);
      return { amount, from, to, result, rate_date: data.date };
    }

    case "get_weather": {
      return await getWeather(optionalStr(input, "city"));
    }

    case "habit_chart": {
      const name = str(input, "name");
      const days = optionalInt(input, "days", 84);
      const png = renderHabitChart(name, days);
      const path = join(tmpdir(), `loopdog-chart-${nowUtcIso().replace(/[:.]/g, "-")}.png`);
      await writeFile(path, png);
      return { ok: true, path, name, days };
    }

    case "log_metric": {
      const day = optionalStr(input, "day") ?? localDay();
      if (!isValidDay(day)) {
        throw new ToolError(`"day" must be YYYY-MM-DD, got "${day}"`);
      }
      const mode = optionalStr(input, "mode");
      if (mode !== undefined && mode !== "latest" && mode !== "sum") {
        throw new ToolError(`"mode" must be "latest" or "sum", got "${mode}"`);
      }
      return logMetric(str(input, "name"), day, num(input, "value"), {
        unit: optionalStr(input, "unit"),
        mode: mode as MetricMode | undefined,
        note: optionalStr(input, "note"),
      });
    }

    case "get_metric_history": {
      const name = str(input, "name");
      const history = getMetricHistory(name, optionalInt(input, "history_days", 30));
      if (!history) {
        const known = listMetrics().map((m) => m.name);
        throw new ToolError(
          known.length
            ? `no metric called "${name}". Currently tracked: ${known.join(", ")}`
            : `no metric called "${name}", and nothing is being tracked yet`,
        );
      }
      return history;
    }

    case "list_metrics": {
      return { metrics: listMetrics() };
    }

    case "metric_chart": {
      const name = str(input, "name");
      const days = optionalInt(input, "days", 30);
      const png = renderMetricChart(name, days);
      const path = join(tmpdir(), `loopdog-metric-chart-${nowUtcIso().replace(/[:.]/g, "-")}.png`);
      await writeFile(path, png);
      return { ok: true, path, name, days };
    }

    case "connect_google": {
      return await googleCalendar.connect();
    }

    case "disconnect_google": {
      return { disconnected: googleCalendar.disconnect() };
    }

    case "list_calendar_events": {
      const days = optionalInt(input, "days", 7);
      return { events: await googleCalendar.listEvents(days) };
    }

    case "create_calendar_event": {
      return await googleCalendar.createEvent(
        str(input, "summary"),
        toUtcIso(str(input, "start")),
        toUtcIso(str(input, "end")),
      );
    }

    case "connect_hotmail": {
      return await hotmail.connect();
    }

    case "disconnect_hotmail": {
      return { disconnected: hotmail.disconnect() };
    }

    case "list_emails": {
      const provider = resolveEmailProvider(input);
      const maxResults = optionalInt(input, "max_results", 10);
      const query = optionalStr(input, "query");
      const emails =
        provider === "gmail"
          ? await googleCalendar.listEmails(query, maxResults)
          : provider === "hotmail"
            ? await hotmail.listEmails(query, maxResults)
            : await privatemail.listEmails(query, maxResults);
      return { provider, emails };
    }

    case "get_email": {
      const provider = resolveEmailProvider(input);
      const id = str(input, "id");
      const email =
        provider === "gmail"
          ? await googleCalendar.getEmail(id)
          : provider === "hotmail"
            ? await hotmail.getEmail(id)
            : await privatemail.getEmail(id);
      return { provider, ...email };
    }

    case "create_email_draft": {
      const provider = resolveEmailProvider(input);
      const to = str(input, "to");
      const subject = str(input, "subject");
      const body = str(input, "body");
      const draft =
        provider === "gmail"
          ? await googleCalendar.createDraft(to, subject, body)
          : provider === "hotmail"
            ? await hotmail.createDraft(to, subject, body)
            : await privatemail.createDraft(to, subject, body);
      return { provider, ...draft };
    }

    case "list_telegram_chats": {
      const maxResults = optionalInt(input, "max_results", 15);
      return { chats: await telegram.listChats(maxResults) };
    }

    case "get_telegram_messages": {
      const chatId = str(input, "chat_id");
      const query = optionalStr(input, "query");
      const maxResults = optionalInt(input, "max_results", 15);
      return { messages: await telegram.getMessages(chatId, query, maxResults) };
    }

    case "remember": {
      return addMemory(str(input, "text"));
    }

    case "list_memories": {
      return { memories: listMemories() };
    }

    case "forget": {
      return forgetMemory(int(input, "id"));
    }

    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}
