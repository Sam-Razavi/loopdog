import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

/**
 * Drives the real setLight() code path against a mock Tuya — the same
 * technique that caught a genuine response-envelope bug in the Roborock
 * work, where unit tests on the pure pieces all passed and the integration
 * still didn't work.
 *
 * What this proves: the specification is actually fetched and parsed, the
 * discovered ranges are actually used, and the resulting commands are
 * actually POSTed in the right shape. What it cannot prove is that a real
 * lamp accepts them — there's no hardware here, and Tuya's request signing
 * has never been confirmed against live servers either (the README says so
 * plainly). The first real run is the user's.
 *
 * Env must be set before ./config is imported, same CJS-hoisting dance as
 * the DB-backed tests.
 */

interface MockTuya {
  url: string;
  posted: { path: string; body: unknown }[];
  close: () => Promise<void>;
}

const LAMP_SPEC = {
  functions: [
    { code: "switch_led", type: "Boolean", values: "{}" },
    { code: "work_mode", type: "Enum", values: '{"range":["white","colour","scene","music"]}' },
    { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: "colour_data_v2", type: "Json", values: "{}" },
  ],
};

function startMockTuya(): Promise<MockTuya> {
  return new Promise((resolve) => {
    const posted: { path: string; body: unknown }[] = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });

        if (path.includes("/token")) {
          res.end(JSON.stringify({ success: true, result: { access_token: "tok", expire_time: 7200 } }));
          return;
        }
        if (path.includes("/specification")) {
          res.end(JSON.stringify({ success: true, result: LAMP_SPEC }));
          return;
        }
        if (path.includes("/commands")) {
          posted.push({ path, body: raw ? JSON.parse(raw) : null });
          res.end(JSON.stringify({ success: true, result: true }));
          return;
        }
        res.end(JSON.stringify({ success: false, msg: `unexpected path ${path}` }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        posted,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * One shared mock for both cases, deliberately: config.ts reads env at
 * import time, so the endpoint is frozen the moment ./tuya is first
 * imported. A second server on a new port would never be reached — the
 * first test would pass and the second would fail against a closed socket,
 * which is a property of the config layer rather than anything wrong with
 * the lamp code.
 *
 * Memoised rather than awaited at module scope because tsx compiles these
 * to CJS, where top-level await isn't available — same reason and same
 * shape as the DB-backed tests.
 */
type TuyaModule = typeof import("./tuya");

let started: Promise<{ mock: MockTuya; tuya: TuyaModule }> | null = null;

function lamp(): Promise<{ mock: MockTuya; tuya: TuyaModule }> {
  started ??= (async () => {
    const mock = await startMockTuya();
    process.env.TUYA_API_ENDPOINT = mock.url;
    process.env.TUYA_ACCESS_ID = "test-id";
    process.env.TUYA_ACCESS_SECRET = "test-secret";
    process.env.TUYA_UID = "test-uid";
    return { mock, tuya: await import("./tuya") };
  })();
  return started;
}

after(async () => {
  if (started) (await started).mock.close();
});

test("setLight fetches the spec, then posts commands built from its real ranges", async () => {
  const { mock, tuya } = await lamp();
  tuya._resetTokenCacheForTests();
  mock.posted.length = 0;

  const commands = await tuya.setLight("device-1", { on: true, brightness: 50 });

  assert.deepEqual(commands, [
    { code: "switch_led", value: true },
    // 50% of the spec's own 10-1000 range — not of a hardcoded 0-255.
    { code: "bright_value_v2", value: 505 },
  ]);

  assert.equal(mock.posted.length, 1, "exactly one command POST");
  assert.match(mock.posted[0]!.path, /\/v1\.0\/devices\/device-1\/commands/);
  assert.deepEqual(mock.posted[0]!.body, { commands });
});

test("a colour request carries work_mode through the real code path", async () => {
  const { mock, tuya } = await lamp();
  mock.posted.length = 0;

  await tuya.setLight("device-1", { colour: "red" });

  const body = mock.posted[0]!.body as { commands: { code: string; value: unknown }[] };
  assert.deepEqual(body.commands[0], { code: "work_mode", value: "colour" });
  assert.deepEqual(body.commands[1], { code: "colour_data_v2", value: { h: 0, s: 1000, v: 1000 } });
});

test("capabilities come from the device's own spec endpoint, not an assumption", async () => {
  const { tuya } = await lamp();
  const caps = await tuya.getLightCapabilities("device-1");
  assert.deepEqual(caps.brightness, { code: "bright_value_v2", min: 10, max: 1000 });
  assert.equal(caps.temperature, null, "this mock lamp reports no temp point, so it must not claim one");
});
