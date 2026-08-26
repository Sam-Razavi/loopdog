import assert from "node:assert/strict";
import { test } from "node:test";
import { clampInt } from "./tools";

test("clampInt leaves an in-range value alone", () => {
  assert.equal(clampInt(84, 1, 370), 84);
  assert.equal(clampInt(1, 1, 370), 1);
  assert.equal(clampInt(370, 1, 370), 370);
});

test("clampInt pulls an absurd value down to the ceiling", () => {
  // The case that mattered: habit_chart with days=50000 allocated ~78MB of
  // pixels and emitted a 142,864px-wide PNG.
  assert.equal(clampInt(50_000, 1, 370), 370);
});

test("clampInt pulls zero and negatives up to the floor", () => {
  assert.equal(clampInt(0, 1, 370), 1);
  assert.equal(clampInt(-5, 1, 370), 1);
});
