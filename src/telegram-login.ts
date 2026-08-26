/**
 * One-time interactive Telegram login — not part of the bot's runtime, and
 * deliberately can't be: logging in as a real Telegram account needs a
 * phone number, a login code that arrives on that phone in real time, and
 * (if set) a 2FA password, typed back within the code's short expiry. That
 * can't happen through a Discord tool call the way Google/Hotmail's OAuth
 * device flow can (there's no code to poll for from the outside) — someone
 * has to sit at a terminal and do it, once, exactly like logging into any
 * other Telegram client for the first time.
 *
 * Run with `npm run telegram-login`. Prints a session string at the end —
 * copy it into TELEGRAM_SESSION (in .env locally, or Railway's Variables
 * tab for the deployed bot). That string is this integration's entire
 * credential from then on; see src/telegram.ts's top comment for why it's
 * more sensitive than any other provider's — it is NOT scope-limited the
 * way an OAuth token is, so guard it like you would the account password
 * itself.
 *
 * Deliberately standalone (imports dotenv directly rather than going
 * through ./config's full validation) so this can be run with only
 * TELEGRAM_API_ID/TELEGRAM_API_HASH set — no need for ANTHROPIC_API_KEY or
 * a Discord token just to log into Telegram once.
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const apiIdRaw = process.env.TELEGRAM_API_ID?.trim() || (await rl.question("TELEGRAM_API_ID (from https://my.telegram.org/apps): "));
    const apiId = Number(apiIdRaw);
    if (!Number.isInteger(apiId)) {
      console.error(`TELEGRAM_API_ID must be an integer, got "${apiIdRaw}"`);
      process.exitCode = 1;
      return;
    }
    const apiHash = process.env.TELEGRAM_API_HASH?.trim() || (await rl.question("TELEGRAM_API_HASH (from https://my.telegram.org/apps): "));

    console.log("\nLogging in — this talks to Telegram directly, same as any other Telegram client's first-time login.\n");

    const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
    await client.start({
      phoneNumber: async () => await rl.question("Phone number (with country code, e.g. +15551234567): "),
      phoneCode: async () => await rl.question("Login code (just arrived on Telegram/SMS): "),
      password: async (hint) => await rl.question(`2FA password${hint ? ` (hint: ${hint})` : ""}: `),
      onError: async (error) => {
        console.error("Login error:", error.message);
        return false; // don't stop — let the caller's own retry/prompt loop continue where sensible
      },
    });

    const session = client.session.save();
    console.log("\nLogged in. Copy this into TELEGRAM_SESSION (.env locally, or Railway's Variables tab):\n");
    console.log(session);
    console.log("\nTreat it like a password — it grants full account access, not a scoped token.\n");

    await client.disconnect();
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
