import { ToolError } from "./errors";
import * as googleCalendar from "./google";
import * as hotmail from "./hotmail";
import * as privatemail from "./privatemail";
import * as telegram from "./telegram";

/**
 * The "check everything at once" fan-out, shared by the check_all_inboxes
 * tool and the scheduled 'inbox' check in pusher.ts.
 *
 * Its own module rather than an export from tools.ts, for a concrete
 * reason: tools.ts already imports pusher.ts (gatherWeekSummary), so having
 * pusher.ts import tools.ts back would be a circular import. Same
 * gather-separate-from-format split gatherWeekSummary already uses, just
 * placed where both sides can reach it.
 */

export interface InboxResults {
  /** Provider name -> that provider's messages, or an { error } object. */
  bySource: Record<string, unknown>;
  /** Which sources were actually usable — for a caller that wants to say so. */
  sources: string[];
}

/**
 * Fetches every usable inbox in parallel. Each source's failure is
 * contained to its own entry rather than sinking the whole call — same
 * spirit as checkPageWatches' per-watch try/catch — so one dead connection
 * doesn't hide the others.
 *
 * Throws a ToolError only when nothing at all is usable, which is the one
 * case where there is genuinely nothing to report.
 */
export async function gatherAllInboxes(maxPerSource: number): Promise<InboxResults> {
  const sources: { name: string; usable: boolean; fetch: () => Promise<unknown> }[] = [
    {
      name: "gmail",
      usable: googleCalendar.isGmailUsable(),
      fetch: () => googleCalendar.listEmails(undefined, maxPerSource),
    },
    {
      name: "hotmail",
      usable: hotmail.isConnected(),
      fetch: () => hotmail.listEmails(undefined, maxPerSource),
    },
    {
      name: "privatemail",
      usable: privatemail.isConfigured(),
      fetch: () => privatemail.listEmails(undefined, maxPerSource),
    },
    {
      name: "telegram",
      usable: telegram.isConfigured(),
      fetch: () => telegram.listChats(maxPerSource),
    },
  ];

  const usableSources = sources.filter((s) => s.usable);
  if (usableSources.length === 0) {
    throw new ToolError(
      "no inbox is usable yet — call connect_hotmail, or set up Gmail (a one-time `npm run gmail-login` at a terminal), PrivateMail, or Telegram. connect_google does NOT grant email — it's calendar-only.",
    );
  }

  const results = await Promise.all(
    usableSources.map(async (s): Promise<[string, unknown]> => {
      try {
        return [s.name, await s.fetch()];
      } catch (error) {
        return [s.name, { error: error instanceof Error ? error.message : String(error) }];
      }
    }),
  );

  return { bySource: Object.fromEntries(results), sources: usableSources.map((s) => s.name) };
}

/** Whether any inbox is usable at all — for the scheduled check's "not set up" message. */
export function anyInboxUsable(): boolean {
  return (
    googleCalendar.isGmailUsable() ||
    hotmail.isConnected() ||
    privatemail.isConfigured() ||
    telegram.isConfigured()
  );
}
