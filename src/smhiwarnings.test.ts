import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWarnings } from "./smhiwarnings";

function sampleAlert(overrides: Record<string, unknown> = {}) {
  return {
    identifier: "smhi-test-1",
    event: { sv: "Storm", en: "Storm", code: "STORM" },
    warningAreas: [
      {
        affectedAreas: [
          { id: "07", sv: "Stockholms län", en: "Stockholm County" },
          { id: "03", sv: "Uppsala län", en: "Uppsala County" },
        ],
        warningLevel: { sv: "Gul", en: "Yellow", code: "YELLOW" },
        eventDescription: { sv: "Kraftig vind", en: "Strong winds expected" },
        approximateStart: "2026-08-26T18:00:00+02:00",
        approximateEnd: "2026-08-27T06:00:00+02:00",
      },
    ],
    ...overrides,
  };
}

test("parseWarnings: flattens one alert into one warning with all affected areas", () => {
  const warnings = parseWarnings([sampleAlert()]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.id, "smhi-test-1");
  assert.equal(warnings[0]!.event, "Storm");
  assert.equal(warnings[0]!.level, "Yellow");
  assert.deepEqual(warnings[0]!.areas, ["Stockholm County", "Uppsala County"]);
  assert.equal(warnings[0]!.description, "Strong winds expected");
  assert.equal(warnings[0]!.start, "2026-08-26T18:00:00+02:00");
});

test("parseWarnings: county filter keeps only matching warnings, case-insensitively", () => {
  const warnings = parseWarnings([sampleAlert()], "stockholm");
  assert.equal(warnings.length, 1);

  const none = parseWarnings([sampleAlert()], "skåne");
  assert.equal(none.length, 0);
});

test("parseWarnings: falls back to Swedish text when English is missing", () => {
  const alert = sampleAlert({ event: { sv: "Snöfall" } });
  const warnings = parseWarnings([alert]);
  assert.equal(warnings[0]!.event, "Snöfall");
});

test("parseWarnings: falls back to a description inside `descriptions` when eventDescription is absent", () => {
  const alert = sampleAlert({
    warningAreas: [
      {
        affectedAreas: [{ id: "07", en: "Stockholm County" }],
        warningLevel: { en: "Orange" },
        descriptions: [{ text: { en: "Heavy snowfall expected overnight" } }],
      },
    ],
  });
  const warnings = parseWarnings([alert]);
  assert.equal(warnings[0]!.description, "Heavy snowfall expected overnight");
});

test("parseWarnings: composes a synthetic id when the API gives none, so dedup still has something to key on", () => {
  const alert = sampleAlert({ identifier: undefined, id: undefined });
  const warnings = parseWarnings([alert]);
  assert.ok(warnings[0]!.id.length > 0);
  assert.match(warnings[0]!.id, /Storm/);
});

test("parseWarnings: multiple warning areas in one alert become multiple entries", () => {
  const alert = sampleAlert({
    warningAreas: [
      { affectedAreas: [{ en: "Stockholm County" }], warningLevel: { en: "Yellow" } },
      { affectedAreas: [{ en: "Skåne County" }], warningLevel: { en: "Orange" } },
    ],
  });
  const warnings = parseWarnings([alert]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1]!.level, "Orange");
});

test("parseWarnings: no active alerts returns an empty array, not an error", () => {
  assert.deepEqual(parseWarnings([]), []);
});
