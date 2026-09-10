import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildLightCommands,
  colourToHsv,
  findSwitchCode,
  parseDevices,
  parseSpecification,
  pickLightCodes,
  resolveDeviceFromList,
  scaleToRange,
  sign,
  stringToSign,
} from "./tuya";

test("sign: matches a hand-computed HMAC-SHA256, uppercase hex", () => {
  const expected = createHmac("sha256", "mysecret").update("hello").digest("hex").toUpperCase();
  assert.equal(sign("hello", "mysecret"), expected);
});

test("stringToSign: joins method, content hash, empty signed-headers, and path with newlines", () => {
  const bodyHash = createHash("sha256").update("").digest("hex");
  const result = stringToSign("GET", "", "/v1.0/token?grant_type=1");
  assert.equal(result, `GET\n${bodyHash}\n\n/v1.0/token?grant_type=1`);
});

test("stringToSign: hashes a non-empty body", () => {
  const body = JSON.stringify({ commands: [{ code: "switch_1", value: true }] });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const result = stringToSign("POST", body, "/v1.0/devices/abc123/commands");
  assert.equal(result, `POST\n${bodyHash}\n\n/v1.0/devices/abc123/commands`);
});

test("parseDevices: keeps well-formed devices, drops malformed entries", () => {
  const raw = [
    { id: "dev1", name: "Coffee maker", online: true },
    { id: "dev2", name: "Desk lamp" }, // no online field, defaults to false
    { name: "missing id" },
    { id: "dev3" }, // missing name
    null,
    "not an object",
  ];
  const devices = parseDevices(raw);
  assert.deepEqual(devices, [
    { id: "dev1", name: "Coffee maker", online: true },
    { id: "dev2", name: "Desk lamp", online: false },
  ]);
});

test("resolveDeviceFromList: exact match wins even when it's also a substring of another", () => {
  const devices = [
    { id: "1", name: "Lamp", online: true },
    { id: "2", name: "Lamp 2", online: true },
  ];
  const result = resolveDeviceFromList(devices, "lamp");
  assert.equal(result.id, "1");
});

test("resolveDeviceFromList: an unambiguous substring match resolves", () => {
  const devices = [
    { id: "1", name: "Coffee maker", online: true },
    { id: "2", name: "Desk lamp", online: true },
  ];
  const result = resolveDeviceFromList(devices, "coffee");
  assert.equal(result.id, "1");
});

test("resolveDeviceFromList: an ambiguous match lists the candidates", () => {
  const devices = [
    { id: "1", name: "Living room lamp", online: true },
    { id: "2", name: "Bedroom lamp", online: true },
  ];
  assert.throws(() => resolveDeviceFromList(devices, "lamp"), /matches more than one device/);
});

test("resolveDeviceFromList: no match at all is a clear error", () => {
  assert.throws(() => resolveDeviceFromList([], "anything"), /no smart device matching/);
});

test("findSwitchCode: picks the first boolean code containing 'switch'", () => {
  const status = [
    { code: "countdown_1", value: 0 },
    { code: "switch_1", value: true },
  ];
  assert.equal(findSwitchCode(status), "switch_1");
});

test("findSwitchCode: ignores a non-boolean code even if its name contains 'switch'", () => {
  const status = [{ code: "switch_mode", value: "manual" }];
  assert.equal(findSwitchCode(status), "switch_1"); // falls back to the documented default
});

test("findSwitchCode: falls back to switch_1 when nothing matches at all", () => {
  assert.equal(findSwitchCode([]), "switch_1");
});

// --- Lights ------------------------------------------------------------

/** A realistic specification response, shaped as Tuya actually sends it. */
const LAMP_SPEC = {
  functions: [
    { code: "switch_led", type: "Boolean", values: "{}" },
    { code: "work_mode", type: "Enum", values: '{"range":["white","colour","scene","music"]}' },
    { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: "temp_value_v2", type: "Integer", values: '{"min":0,"max":1000,"scale":0,"step":1}' },
    { code: "colour_data_v2", type: "Json", values: '{"h":{"min":0,"max":360},"s":{"min":0,"max":1000}}' },
  ],
};

test("parseSpecification tolerates junk entries and a missing functions list", () => {
  assert.deepEqual(parseSpecification(null), []);
  assert.deepEqual(parseSpecification({}), []);
  const parsed = parseSpecification({
    functions: [
      { code: "switch_led", type: "Boolean", values: "{}" },
      null,
      { code: 5, type: "Boolean" },
      { type: "Boolean", values: "{}" },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.code, "switch_led");
});

test("pickLightCodes reads the device's real ranges rather than assuming them", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  assert.equal(caps.switchCode, "switch_led");
  assert.deepEqual(caps.brightness, { code: "bright_value_v2", min: 10, max: 1000 });
  assert.deepEqual(caps.temperature, { code: "temp_value_v2", min: 0, max: 1000 });
  assert.equal(caps.colourCode, "colour_data_v2");
  assert.equal(caps.workModeCode, "work_mode");
});

test("pickLightCodes prefers _v2 codes when a device reports both generations", () => {
  // A device reporting both is a newer one where v1 is a legacy alias with a
  // different range — mixing them sends a v1-ranged value to a v2 point.
  const caps = pickLightCodes(
    parseSpecification({
      functions: [
        { code: "bright_value", type: "Integer", values: '{"min":25,"max":255}' },
        { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000}' },
      ],
    }),
  );
  assert.equal(caps.brightness?.code, "bright_value_v2");
  assert.equal(caps.brightness?.max, 1000);
});

test("pickLightCodes falls back to v1 codes and their older ranges", () => {
  const caps = pickLightCodes(
    parseSpecification({ functions: [{ code: "bright_value", type: "Integer", values: '{"min":25,"max":255}' }] }),
  );
  assert.deepEqual(caps.brightness, { code: "bright_value", min: 25, max: 255 });
});

test("a plug reports no light capabilities at all", () => {
  const caps = pickLightCodes(parseSpecification({ functions: [{ code: "switch_1", type: "Boolean", values: "{}" }] }));
  assert.equal(caps.brightness, null);
  assert.equal(caps.colourCode, null);
});

test("scaleToRange maps 0-100 onto whatever range the device reports, clamping", () => {
  assert.equal(scaleToRange(0, 10, 1000), 10);
  assert.equal(scaleToRange(100, 10, 1000), 1000);
  assert.equal(scaleToRange(50, 0, 1000), 500);
  assert.equal(scaleToRange(50, 25, 255), 140);
  // Out of range clamps rather than sending the device an illegal value.
  assert.equal(scaleToRange(-20, 10, 1000), 10);
  assert.equal(scaleToRange(500, 10, 1000), 1000);
});

test("colourToHsv uses Tuya's 0-1000 saturation scale, not 0-100 or 0-255", () => {
  // Getting this wrong lights the lamp almost-white and reads as a bug.
  assert.deepEqual(colourToHsv("red"), { h: 0, s: 1000, v: 1000 });
  assert.deepEqual(colourToHsv("#00ff00"), { h: 120, s: 1000, v: 1000 });
  assert.deepEqual(colourToHsv("blue"), { h: 240, s: 1000, v: 1000 });
  assert.deepEqual(colourToHsv("white"), { h: 0, s: 0, v: 1000 });
});

test("colourToHsv accepts hex with or without a leading hash, any case", () => {
  assert.deepEqual(colourToHsv("#FF0000"), colourToHsv("ff0000"));
});

test("an unknown colour name is a clear error naming what is accepted", () => {
  assert.throws(() => colourToHsv("chartreuse"), /don't know the colour/);
  assert.throws(() => colourToHsv("#12345"), /don't know the colour/);
});

test("setting a colour also sends work_mode — without it the lamp ignores the command", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  const commands = buildLightCommands(caps, { colour: "red" });
  assert.deepEqual(commands[0], { code: "work_mode", value: "colour" });
  assert.equal(commands[1]?.code, "colour_data_v2");
});

test("setting a colour temperature switches the lamp into white mode", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  const commands = buildLightCommands(caps, { temperature: 100 });
  assert.deepEqual(commands[0], { code: "work_mode", value: "white" });
  assert.deepEqual(commands[1], { code: "temp_value_v2", value: 1000 });
});

test("on + brightness in one request produces both commands", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  const commands = buildLightCommands(caps, { on: true, brightness: 50 });
  assert.deepEqual(commands, [
    { code: "switch_led", value: true },
    { code: "bright_value_v2", value: 505 },
  ]);
});

test("colour and colour temperature together is refused, not silently half-applied", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  assert.throws(
    () => buildLightCommands(caps, { colour: "red", temperature: 50 }),
    /can't be in both modes at once/,
  );
});

test("asking a plug for brightness or colour says so plainly", () => {
  const plug = pickLightCodes(parseSpecification({ functions: [{ code: "switch_1", type: "Boolean", values: "{}" }] }));
  assert.throws(() => buildLightCommands(plug, { brightness: 50 }), /isn't dimmable/);
  assert.throws(() => buildLightCommands(plug, { colour: "red" }), /doesn't do colour/);
});

test("an empty request is an error rather than a no-op API call", () => {
  const caps = pickLightCodes(parseSpecification(LAMP_SPEC));
  assert.throws(() => buildLightCommands(caps, {}), /nothing to change/);
});
