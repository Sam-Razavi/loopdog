import * as googleCalendar from "./google";
import * as hotmail from "./hotmail";

/**
 * Background upkeep for the OAuth connections: notice when one has died, and
 * say so once.
 *
 * Detection used to be accidental. A connection is only proven dead when
 * something tries to use its token, so a lapse stayed invisible until the user
 * next asked for their calendar or inbox — and Hotmail has no daily user at
 * all, so nothing would ever have noticed. The system worked, but only if
 * someone happened to trip over it.
 *
 * Kept out of pusher.ts so the decisions (what to verify, when, what to say)
 * are testable without a Discord client; pusher.ts only does the sending.
 */

export type Provider = "google" | "hotmail";

/** A healthy connection is checked this often. The cost is one token POST per provider. */
export const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * When Google/Microsoft couldn't be reached (or answered something we don't
 * recognise), try again sooner than a day — otherwise one bad moment at the
 * wrong time would delay finding a dead connection by 24 hours — but not
 * every five-minute tick, which for a persistent cause (rejected client
 * credentials) would hammer the token endpoint all day.
 */
export const RETRY_AFTER_UNVERIFIED_MS = 60 * 60 * 1000;

const PROVIDERS = [
  { name: "google" as const, isConnected: googleCalendar.isConnected, verify: googleCalendar.verifyConnection },
  { name: "hotmail" as const, isConnected: hotmail.isConnected, verify: hotmail.verifyConnection },
];

/**
 * In memory on purpose, same shape as pusher.ts's lastAuthPollAt. A restart
 * re-checks once, which is a feature: a deploy finds a dead connection
 * immediately instead of up to a day later.
 */
const nextVerifyAt = new Map<Provider, number>();

/** Exported only so tests can start from a clean slate. */
export function _resetConnectionsForTests(): void {
  nextVerifyAt.clear();
}

/**
 * Verifies each *connected* provider that's due. A provider that isn't
 * connected is skipped without touching its schedule — there's nothing to
 * verify, and it shouldn't start a 24-hour clock that delays the first check
 * after the user does connect it.
 *
 * A dead connection is marked expired by verify() itself, as a side effect;
 * pendingExpiryNotices() then picks it up.
 */
export async function verifyConnections(now = Date.now()): Promise<void> {
  for (const provider of PROVIDERS) {
    if (!provider.isConnected()) continue;
    if (now < (nextVerifyAt.get(provider.name) ?? 0)) continue;

    const result = await provider.verify();
    nextVerifyAt.set(
      provider.name,
      now + (result === "unverified" ? RETRY_AFTER_UNVERIFIED_MS : VERIFY_INTERVAL_MS),
    );
    if (result === "unverified") {
      console.error(`[connections] couldn't verify ${provider.name} just now — left as is, retrying within the hour`);
    }
  }
}

export interface ConnectionNotice {
  provider: Provider;
  message: string;
  /** Call only after the message actually sent, so a failed send retries next tick. */
  markNotified: () => void;
}

/**
 * Deterministic, no LLM call — same composition philosophy as every other
 * unattended message here. Each says what happened and the exact words that
 * fix it.
 *
 * The Google one names the likely recurring cause because it's the one thing a
 * reconnect can't fix: while the OAuth consent screen is in "Testing", Google
 * expires every refresh token after 7 days. Hotmail's hedges its cause —
 * "usually" — because whether a personal Microsoft account follows the 90-day
 * inactivity rule wasn't confirmed, and an unattended message shouldn't
 * assert what hasn't been checked.
 */
const MESSAGES: Record<Provider, string> = {
  google:
    'Your Google Calendar connection has expired — Google stopped honouring the saved login. ' +
    'Say "connect my Google account" and I\'ll start a new one. ' +
    "(If this keeps happening about weekly, the OAuth app is probably still in Testing mode — publishing it stops that.)",
  hotmail:
    "Your Hotmail/Outlook connection has expired — Microsoft stopped honouring the saved login " +
    '(usually a long stretch unused, or a password change). Say "connect my Hotmail" and I\'ll start a new one.',
};

/** Connections that have lapsed and haven't been announced yet. Each is announced once per lapse. */
export function pendingExpiryNotices(): ConnectionNotice[] {
  const notices: ConnectionNotice[] = [];
  if (googleCalendar.expiryNoticePending()) {
    notices.push({ provider: "google", message: MESSAGES.google, markNotified: googleCalendar.markExpiryNotified });
  }
  if (hotmail.expiryNoticePending()) {
    notices.push({ provider: "hotmail", message: MESSAGES.hotmail, markNotified: hotmail.markExpiryNotified });
  }
  return notices;
}
