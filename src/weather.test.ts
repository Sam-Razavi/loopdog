import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWeatherCode } from "./weather";

test("describeWeatherCode covers common conditions", () => {
  assert.equal(describeWeatherCode(0), "clear sky");
  assert.equal(describeWeatherCode(3), "overcast");
  assert.equal(describeWeatherCode(61), "slight rain");
  assert.equal(describeWeatherCode(95), "thunderstorm");
});

test("describeWeatherCode falls back gracefully for an unknown code", () => {
  assert.match(describeWeatherCode(12345), /unrecognized conditions \(code 12345\)/);
});
