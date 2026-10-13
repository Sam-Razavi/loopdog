import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { classifyRefreshFailure, postRefresh } from "./oauthrefresh";
import { json, restoreFetch, stubFetch } from "./testutil/fetchstub";

/**
 * The shared refresh POST, exercised directly — the Google and Hotmail suites
 * cover each provider's use of it; this covers what it promises on its own,
 * including the Microsoft-shaped bodies that Google's tests never see.
 */
afterEach(restoreFetch);

const URL_ = "https://idp.example/token";
const form = (): URLSearchParams => new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r" });

test("a success returns the access token, defaulting the lifetime to an hour", async () => {
  stubFetch(() => json(200, { access_token: "a" }));
  const outcome = await postRefresh(URL_, form());
  assert.deepEqual(outcome, { ok: true, accessToken: "a", expiresIn: 3600 });
});

test("a rotated refresh token is surfaced; its absence is not invented", async () => {
  stubFetch(() => json(200, { access_token: "a", expires_in: 100, refresh_token: "rotated" }));
  const rotated = await postRefresh(URL_, form());
  assert.ok(rotated.ok && rotated.refreshToken === "rotated" && rotated.expiresIn === 100);

  stubFetch(() => json(200, { access_token: "a" }));
  const plain = await postRefresh(URL_, form());
  assert.ok(plain.ok && !("refreshToken" in plain), "Google never sends one — callers keep the old token");
});

test("the request is a form-encoded POST carrying exactly the form it was given", async () => {
  const calls = stubFetch(() => json(200, { access_token: "a" }));
  await postRefresh(URL_, form());
  assert.equal(calls[0]!.url, URL_);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.body?.get("refresh_token"), "r");
});

test("a Microsoft AADSTS70008 inactivity body is dead, and its description is kept as the detail", async () => {
  stubFetch(() =>
    json(400, {
      error: "invalid_grant",
      error_description: "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.",
      error_codes: [70008],
    }),
  );
  const outcome = await postRefresh(URL_, form());
  assert.ok(!outcome.ok && outcome.kind === "dead");
  assert.match(outcome.detail, /AADSTS70008/, "the provider's own words are what the user can act on");
});

test("interaction_required is deliberately NOT dead — unconfirmed for personal accounts", () => {
  // Pinned so nobody "completes" the classifier from memory. Treating it as
  // dead would wipe a login on a code whose meaning for consumer accounts was
  // never verified; unknown stays conservative, and the provider's
  // error_description is surfaced so a real cause isn't hidden.
  assert.equal(classifyRefreshFailure(400, { error: "interaction_required" }), "transient");
});

test("network failure, a non-JSON gateway page, and an empty 200 are transient — and never throw", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const network = await postRefresh(URL_, form());
  assert.ok(!network.ok && network.kind === "transient" && /fetch failed/.test(network.detail));

  stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
  const gateway = await postRefresh(URL_, form());
  assert.ok(!gateway.ok && gateway.kind === "transient");

  stubFetch(() => json(200, {}));
  const empty = await postRefresh(URL_, form());
  assert.ok(!empty.ok && empty.kind === "transient", "a 200 with no token is not a success");
});
