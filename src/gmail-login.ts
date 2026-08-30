/**
 * One-time interactive Gmail login — not part of the bot's runtime, and
 * deliberately can't be, for a different reason than Telegram's or
 * Roborock's: Google's OAuth *device* flow (the one `connect_google` uses,
 * where you type a short code at google.com/device) flatly refuses Gmail
 * scopes with invalid_scope. That's a platform limitation, confirmed by a
 * live connect attempt and by an independent report of the same thing
 * (googleapis/oauth2client#88) — not a consent-screen misconfiguration.
 *
 * So Gmail needs the *redirect*-based authorization-code flow instead, and
 * a redirect needs somewhere to land. Loopdog on Railway has no HTTP
 * server, so this script stands one up on your own machine for the ~30
 * seconds the login takes: a loopback redirect (http://127.0.0.1:<port>),
 * which Google supports for the "Desktop app" client type without the
 * port ever being registered in the console.
 *
 * Run with `npm run gmail-login`. Prints a refresh token at the end — copy
 * it into GMAIL_REFRESH_TOKEN (.env locally, or Railway's Variables tab).
 *
 * Needs its OWN OAuth client, separate from GOOGLE_CLIENT_ID: that one is
 * a "TVs and Limited Input devices" client, and a device-flow client
 * cannot do loopback redirects. Create a second client of type "Desktop
 * app" and use its id/secret here. Google requires the client secret on
 * the token exchange even though we also use PKCE.
 *
 * IMPORTANT — publish your app first. While the OAuth consent screen's
 * publishing status is "Testing", Google expires every refresh token after
 * 7 days, so this login would need redoing weekly (and your Calendar
 * connection would silently die on the same clock). OAuth consent screen →
 * "Publish app" fixes it. The app stays *unverified*, which is fine for
 * personal use — you click through one "Google hasn't verified this app"
 * warning during login and never see it again.
 *
 * Deliberately standalone (no ./config import) so this can be run with
 * nothing else set up — no need for ANTHROPIC_API_KEY or a Discord token
 * just to log into Gmail once.
 */
import "dotenv/config";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHash, randomBytes } from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Read + draft only, matching what src/google.ts's Gmail functions actually
 * do. There is deliberately no gmail.send: the safety boundary is that no
 * send function exists in the code at all (gmail.compose alone would
 * technically permit sending, so the scope isn't the guarantee — the
 * absent function is). Don't add one.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

/** How long to wait for the user to finish in the browser before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * PKCE (RFC 7636) S256: base64url(SHA256(verifier)), unpadded. Exported
 * for the test that checks it against the RFC's own published vector —
 * getting this subtly wrong (padding, base64 vs base64url) fails only at
 * the final token exchange, long after the browser dance looks fine.
 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Exported for testing. `access_type=offline` is what makes Google issue a
 * refresh token at all, and `prompt=consent` is what makes it issue one
 * *again* on a re-login — without it, a second run of this script returns
 * only an access token and the script would have nothing to print.
 */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>${title}</h1><p>${detail}</p></body>`;
}

/**
 * Runs the loopback server for exactly one callback, then shuts down.
 * Resolves with the authorization code. The server is bound to 127.0.0.1
 * (not 0.0.0.0) on an OS-assigned port, so it's reachable only from this
 * machine and never needs a firewall hole or a registered port.
 *
 * Exported for the end-to-end test, which drives it with a simulated
 * browser rather than a real one.
 */
export function awaitCallback(
  expectedState: string,
  onReady: (redirectUri: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      const fail = (message: string): void => {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Login failed", message));
        server.close();
        reject(new Error(message));
      };

      if (error) return fail(`Google returned an error: ${error}`);
      if (!code) return fail("No authorization code in the redirect.");
      // Guards against a stray/forged callback hitting the local port
      // mid-login — cheap, and the whole reason `state` exists.
      if (state !== expectedState) return fail("State mismatch — ignoring this callback.");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Gmail connected", "You can close this tab and go back to the terminal."));
      server.close();
      resolve(code);
    });

    server.on("error", reject);
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes waiting for the browser`));
    }, LOGIN_TIMEOUT_MS);
    timer.unref();

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      onReady(`http://127.0.0.1:${port}`);
    });
  });
}

interface TokenResponse {
  refresh_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Exported, and takes its endpoint as a parameter, so the end-to-end test
 * can point it at a mock Google instead of the real one. Production callers
 * just omit `tokenUrl` and get the real endpoint.
 */
export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<TokenResponse> {
  const response = await fetch(params.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      code_verifier: params.verifier,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await response.json()) as TokenResponse;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const clientId =
      process.env.GMAIL_CLIENT_ID?.trim() ||
      (await rl.question('GMAIL_CLIENT_ID (a "Desktop app" OAuth client, NOT the Calendar one): '));
    const clientSecret =
      process.env.GMAIL_CLIENT_SECRET?.trim() || (await rl.question("GMAIL_CLIENT_SECRET: "));

    const verifier = randomBytes(32).toString("base64url");
    const challenge = pkceChallenge(verifier);
    const state = randomBytes(16).toString("base64url");

    let redirectUri = "";
    const codePromise = awaitCallback(state, (uri) => {
      redirectUri = uri;
      console.log("\nOpen this URL in your browser and sign in:\n");
      console.log(buildAuthUrl({ clientId, redirectUri: uri, challenge, state }));
      console.log(
        '\nIf you see "Google hasn\'t verified this app", that\'s expected for a personal' +
          '\napp — click Advanced, then "Go to ... (unsafe)". Waiting for the redirect...\n',
      );
    });

    const code = await codePromise;
    console.log("Got the authorization code — exchanging it for a refresh token...\n");

    const tokens = await exchangeCode({ clientId, clientSecret, code, verifier, redirectUri });
    if (tokens.error || !tokens.refresh_token) {
      console.error(
        `Token exchange failed: ${tokens.error ?? "no refresh_token returned"}` +
          `${tokens.error_description ? ` — ${tokens.error_description}` : ""}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log("Done. Set these three in .env (or Railway's Variables tab):\n");
    console.log(`GMAIL_CLIENT_ID=${clientId}`);
    console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log(
      "If your OAuth consent screen is still in \"Testing\", publish it now —\n" +
        "otherwise Google expires this token in 7 days (and your Calendar one too).",
    );
  } finally {
    rl.close();
  }
}

// Guarded so importing this file for its pure helpers (the tests do) doesn't
// start a login — same reason nothing else here runs at import time.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
