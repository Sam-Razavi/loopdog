import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuthUrl, pkceChallenge } from "./gmail-login";

/**
 * The PKCE vector below is not invented — it's the worked example from
 * RFC 7636 Appendix B itself, the same "check against a real published
 * reference rather than against my own output" approach used for tuya.ts's
 * signatures and roborock.ts's protocol encoding. It matters here because
 * every plausible way to get this wrong (base64 instead of base64url,
 * keeping the `=` padding, hashing the challenge instead of the verifier)
 * still produces a confident-looking string, and the failure only surfaces
 * at the final token exchange — after the browser dance has already
 * appeared to succeed.
 */
test("pkceChallenge matches RFC 7636's own published S256 test vector", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("pkceChallenge output is base64url — no padding, no + or /", () => {
  // 600 verifiers is enough to hit the ~1-in-4 chance of a '+' or '/' in
  // plain base64 many times over, so a wrong encoding can't slip through
  // on a lucky sample.
  for (let i = 0; i < 600; i++) {
    const challenge = pkceChallenge(`verifier-${i}`);
    assert.doesNotMatch(challenge, /[+/=]/, `challenge ${challenge} isn't base64url`);
  }
});

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test("buildAuthUrl asks for offline access and forces a fresh consent", () => {
  const p = params(
    buildAuthUrl({
      clientId: "client-123",
      redirectUri: "http://127.0.0.1:51234",
      challenge: "challenge-abc",
      state: "state-xyz",
    }),
  );

  // Without access_type=offline Google issues no refresh token at all, and
  // without prompt=consent a *second* login returns only an access token —
  // the script would have nothing to print. Both are load-bearing.
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("prompt"), "consent");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("code_challenge"), "challenge-abc");
  assert.equal(p.get("state"), "state-xyz");
  assert.equal(p.get("redirect_uri"), "http://127.0.0.1:51234");
  assert.equal(p.get("client_id"), "client-123");
});

test("buildAuthUrl requests read and draft scopes, and no send scope", () => {
  const scope = params(
    buildAuthUrl({ clientId: "c", redirectUri: "http://127.0.0.1:1", challenge: "x", state: "s" }),
  ).get("scope");

  assert.ok(scope);
  const scopes = scope.split(" ");
  assert.deepEqual(scopes.sort(), [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
  // The no-send policy is enforced by there being no send function in
  // google.ts, but requesting gmail.send would still be a red flag that
  // someone was heading that way.
  assert.doesNotMatch(scope, /gmail\.send|gmail\.modify|mail\.google\.com/);
});
