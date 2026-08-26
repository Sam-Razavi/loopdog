/**
 * One-time interactive Roborock login — not part of the bot's runtime, and
 * deliberately can't be: logging in needs an email verification code that
 * arrives in your inbox and has to be typed back within its short expiry.
 * That can't happen through a Discord tool call the way Google/Hotmail's
 * OAuth device flow can — someone has to sit at a terminal and do it once,
 * the same way logging into the Roborock app's first time works.
 *
 * Run with `npm run roborock-login`. Prints a JSON blob at the end — copy
 * it into ROBOROCK_USER_DATA (.env locally, or Railway's Variables tab).
 * That blob is this integration's entire session from then on — an opaque
 * token, not a scoped credential, same posture as TELEGRAM_SESSION.
 *
 * Endpoints and request shapes below are transcribed from python-roborock's
 * RoborockApiClient (roborock/web_api.py), not guessed at — see
 * src/roborock.ts's top comment for the full verification story.
 *
 * Deliberately standalone (no ./config import) so this can be run with
 * nothing else set up — no need for ANTHROPIC_API_KEY or a Discord token
 * just to log into Roborock once.
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes, createHash } from "node:crypto";

const BASE_URLS = [
  "https://usiot.roborock.com",
  "https://euiot.roborock.com",
  "https://cniot.roborock.com",
  "https://ruiot.roborock.com",
];

const deviceIdentifier = randomBytes(16).toString("base64url");

function headerClientId(email: string): string {
  return createHash("md5").update(email).update(deviceIdentifier).digest("base64");
}

async function apiPost(baseUrl: string, path: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<{ code?: number; msg?: string; data?: unknown }> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
  return (await response.json()) as { code?: number; msg?: string; data?: unknown };
}

async function findBaseUrl(email: string): Promise<string> {
  for (const base of BASE_URLS) {
    const data = await apiPost(base, "/api/v1/getUrlByEmail", { email, needtwostepauth: "false" });
    if (data.code === 200 && data.data && typeof data.data === "object" && "url" in data.data) {
      return String((data.data as { url: unknown }).url);
    }
  }
  throw new Error("couldn't find a Roborock server for that email — check it's correct");
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const email = process.env.ROBOROCK_EMAIL?.trim() || (await rl.question("Roborock account email: "));
    console.log("\nLooking up your account's region...");
    const baseUrl = await findBaseUrl(email);
    const clientId = headerClientId(email);

    console.log("Requesting a login code — check your email for it.\n");
    const codeResponse = await apiPost(baseUrl, "/api/v1/sendEmailCode", { username: email, type: "auth" }, { header_clientid: clientId });
    if (codeResponse.code !== 200) {
      throw new Error(`couldn't request a login code: ${codeResponse.msg ?? `response code ${codeResponse.code}`}`);
    }

    const code = await rl.question("Login code (just arrived by email): ");
    console.log("\nLogging in...");
    const loginResponse = await apiPost(
      baseUrl,
      "/api/v1/loginWithCode",
      { username: email, verifycode: code, verifycodetype: "AUTH_EMAIL_CODE" },
      { header_clientid: clientId },
    );
    if (loginResponse.code !== 200 || !loginResponse.data || typeof loginResponse.data !== "object") {
      throw new Error(`login failed: ${loginResponse.msg ?? `response code ${loginResponse.code}`}`);
    }

    const userData = loginResponse.data as { token?: unknown; rriot?: unknown };
    if (!userData.token || !userData.rriot) {
      throw new Error("login response didn't include the expected token/rriot fields");
    }

    console.log("\nLogged in. Copy this into ROBOROCK_USER_DATA (.env locally, or Railway's Variables tab):\n");
    console.log(JSON.stringify({ token: userData.token, rriot: userData.rriot }));
    console.log("\nTreat it like a password — it's an opaque session, not a scope-limited token.\n");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
