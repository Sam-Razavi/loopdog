import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { awaitCallback, exchangeCode, pkceChallenge } from "./gmail-login";

/**
 * End-to-end exercise of the login script's moving parts against a mock
 * Google, in the same spirit as the local-broker test that shook out a real
 * bug in the Roborock work: unit-testing the pure helpers proves the maths,
 * but only actually running the loopback server and the code exchange
 * proves they're *wired together*. Everything real is real here — a real
 * HTTP server on a real OS-assigned port, a real fetch playing the part of
 * the browser, a real token POST — with only Google's endpoint swapped for
 * a local stand-in.
 */

interface MockGoogle {
  url: string;
  /** The form body the token endpoint actually received, for assertions. */
  received: URLSearchParams | null;
  close: () => Promise<void>;
}

function startMockGoogle(respond: (form: URLSearchParams) => { status: number; body: unknown }): Promise<MockGoogle> {
  return new Promise((resolve) => {
    const state: { received: URLSearchParams | null } = { received: null };
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        state.received = form;
        const { status, body } = respond(form);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/token`,
        get received() {
          return state.received;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("full loopback round trip: browser redirect in, refresh token out", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const state = "state-nonce-1";

  const google = await startMockGoogle((form) => {
    // A real Google rejects a mismatched verifier; mimic that so the test
    // is actually asserting the verifier travels, not just that we POST.
    if (pkceChallenge(form.get("code_verifier") ?? "") !== pkceChallenge(verifier)) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    return { status: 200, body: { access_token: "at-1", refresh_token: "rt-abc123", expires_in: 3599 } };
  });

  try {
    let redirectUri = "";
    const codePromise = awaitCallback(state, (uri) => {
      redirectUri = uri;
      // Stand in for the browser Google would redirect.
      void fetch(`${uri}/?code=auth-code-xyz&state=${state}`);
    });

    const code = await codePromise;
    assert.equal(code, "auth-code-xyz");

    const tokens = await exchangeCode({
      clientId: "client-1",
      clientSecret: "secret-1",
      code,
      verifier,
      redirectUri,
      tokenUrl: google.url,
    });

    assert.equal(tokens.refresh_token, "rt-abc123", "the refresh token is what the whole script exists to produce");

    const form = google.received;
    assert.ok(form);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "auth-code-xyz");
    assert.equal(form.get("code_verifier"), verifier);
    assert.equal(form.get("client_secret"), "secret-1", "Google requires the secret even with PKCE for Desktop clients");
    assert.equal(
      form.get("redirect_uri"),
      redirectUri,
      "redirect_uri must match the one the code was issued for, port included",
    );
  } finally {
    await google.close();
  }
});

test("the loopback server binds to 127.0.0.1 only, never a public interface", async () => {
  let redirectUri = "";
  const codePromise = awaitCallback("s", (uri) => {
    redirectUri = uri;
    void fetch(`${uri}/?code=c&state=s`);
  });
  await codePromise;
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("a callback with the wrong state is rejected, not accepted as a login", async () => {
  const failure = awaitCallback("expected-state", (uri) => {
    void fetch(`${uri}/?code=attacker-code&state=some-other-state`);
  });
  await assert.rejects(failure, /State mismatch/);
});

test("Google returning an error in the redirect surfaces it instead of hanging", async () => {
  const failure = awaitCallback("s", (uri) => {
    void fetch(`${uri}/?error=access_denied&state=s`);
  });
  await assert.rejects(failure, /access_denied/);
});

test("a token exchange Google rejects is reported, not mistaken for success", async () => {
  const google = await startMockGoogle(() => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "Bad Request" },
  }));
  try {
    const tokens = await exchangeCode({
      clientId: "c",
      clientSecret: "s",
      code: "stale-code",
      verifier: "v",
      redirectUri: "http://127.0.0.1:1",
      tokenUrl: google.url,
    });
    assert.equal(tokens.refresh_token, undefined);
    assert.equal(tokens.error, "invalid_grant");
  } finally {
    await google.close();
  }
});
