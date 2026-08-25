import assert from "node:assert/strict";
import { test } from "node:test";
import { pickRandom, rollDice } from "./random";

test("pickRandom always returns one of the given options", () => {
  const options = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) {
    assert.ok(options.includes(pickRandom(options)));
  }
});

test("pickRandom throws with fewer than 2 options", () => {
  assert.throws(() => pickRandom(["only-one"]), /at least 2/);
  assert.throws(() => pickRandom([]), /at least 2/);
});

test("rollDice returns the right count of values, each within [1, sides]", () => {
  for (let i = 0; i < 50; i++) {
    const rolls = rollDice(6, 3);
    assert.equal(rolls.length, 3);
    for (const roll of rolls) {
      assert.ok(roll >= 1 && roll <= 6, `roll ${roll} out of range`);
    }
  }
});

test("rollDice with sides: 2 is a coin flip — only 1 or 2", () => {
  for (let i = 0; i < 50; i++) {
    const [flip] = rollDice(2, 1);
    assert.ok(flip === 1 || flip === 2);
  }
});

test("rollDice defaults aside, rejects invalid sides", () => {
  assert.throws(() => rollDice(1, 1), /sides must be/);
  assert.throws(() => rollDice(1.5, 1), /sides must be/);
});

test("rollDice rejects invalid count", () => {
  assert.throws(() => rollDice(6, 0), /count must be/);
  assert.throws(() => rollDice(6, 101), /count must be/);
});
