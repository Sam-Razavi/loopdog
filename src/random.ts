import { randomInt } from "node:crypto";
import { ToolError } from "./errors";

/** Picks one option at random. crypto.randomInt, not Math.random — genuine randomness. */
export function pickRandom(options: string[]): string {
  if (options.length < 2) {
    throw new ToolError(`need at least 2 options to pick from, got ${options.length}`);
  }
  return options[randomInt(options.length)]!;
}

/** Rolls `count` dice with `sides` sides each. sides: 2 is a coin flip. */
export function rollDice(sides: number, count: number): number[] {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new ToolError(`sides must be an integer >= 2, got ${sides}`);
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new ToolError(`count must be an integer between 1 and 100, got ${count}`);
  }
  return Array.from({ length: count }, () => randomInt(1, sides + 1));
}
