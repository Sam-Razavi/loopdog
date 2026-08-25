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
import { gatherWeekSummary } from "./pusher";
import { formatLocal, isValidDay, localDay, nowUtcIso, toUtcIso } from "./time";
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
      "list_reminders first to find the right one.",
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
      "mistake. Completing is the right call when they actually did the thing.",
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
      "Pause all proactive DMs — reminder pushes, the at-risk nudge, the Sunday " +
      "digest, the morning brief — until a given time. Call this when the user " +
      "asks not to be nudged or bothered for a while: 'mute for a week', 'don't " +
      "nudge me until Friday', 'I'm traveling until the 30th, leave me alone " +
      "till then'. Conversation still works as normal while muted — this only " +
      "stops proactive DMs.",
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

    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}
