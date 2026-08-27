import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** DB-backed: liveState() reads reminders/habits/mute. Same pattern as reminders.test.ts. */
process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type PromptModule = typeof import("./prompt");
let loaded: Promise<PromptModule> | null = null;
function prompt(): Promise<PromptModule> {
  loaded ??= (async () => {
    const { migrate } = await import("./db");
    migrate();
    return import("./prompt");
  })();
  return loaded;
}

test("buildSystemPrompt: two blocks, cache breakpoint on the first only", async () => {
  const { buildSystemPrompt } = await prompt();
  const blocks = buildSystemPrompt();

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "text");
  assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" });
  // The dynamic block must NOT carry a breakpoint — that would cache volatile
  // content and burn a write on every single call.
  assert.equal(blocks[1]!.cache_control, undefined);
});

test("buildSystemPrompt: the cached block holds the static persona/rules and no live state", async () => {
  const { buildSystemPrompt } = await prompt();
  const [stable, live] = buildSystemPrompt();

  assert.match(stable!.text, /You are Loopdog/);
  assert.match(stable!.text, /How to work:/);
  assert.match(stable!.text, /Tone, roughly:/);

  // The cache-breaker guard: anything that varies per call belongs in block 2.
  // If this fails, the prefix changes every request and caching silently stops
  // paying — the exact failure the split exists to prevent.
  assert.ok(!/Right now it is/.test(stable!.text), "clock leaked into the cached block");
  assert.ok(!/Today, for streak purposes/.test(stable!.text), "current day leaked into the cached block");
  assert.match(live!.text, /Right now it is/);
});

test("buildSystemPrompt: the cached block is byte-identical across calls", async () => {
  const { buildSystemPrompt } = await prompt();
  assert.equal(buildSystemPrompt()[0]!.text, buildSystemPrompt()[0]!.text);
});

test("buildSystemPrompt: names unconfigured integrations so a dropped tool still explains itself", async () => {
  const { buildSystemPrompt } = await prompt();
  const stable = buildSystemPrompt()[0]!.text;
  // Nothing is configured in the test env, so the note must be present and
  // must name integrations whose tools were gated out.
  assert.match(stable, /Not set up on this deployment/);
  assert.match(stable, /Canvas/);
});
