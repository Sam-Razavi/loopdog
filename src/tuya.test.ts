import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { test } from "node:test";
import { findSwitchCode, parseDevices, resolveDeviceFromList, sign, stringToSign } from "./tuya";

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
