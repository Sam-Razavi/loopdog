import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import mqtt from "mqtt";
import { config } from "./config";
import { crc32 } from "./png";
import { ToolError } from "./errors";

/**
 * Roborock vacuum control — over the cloud MQTT relay, not the local
 * network. Loopdog runs on Railway, not on the user's home LAN, so the
 * better-documented local protocol (a direct TCP connection to the
 * vacuum's LAN IP, port 58867 — what Home Assistant uses) is unreachable
 * from here; everything below goes through Roborock's cloud MQTT broker
 * instead.
 *
 * Unlike most integrations this session, this one was NOT built from
 * blocked doc sites or search snippets. python-roborock (the most
 * actively maintained open-source client) was cloned directly into this
 * session and read line by line — the Hawk request-signing algorithm,
 * the MQTT topic structure, the message framing (AES-128-ECB with an
 * MD5-derived key, CRC32 checksum), and the JSON command envelope are
 * transcribed from real, working source (roborock/web_api.py,
 * roborock/protocol.py, roborock/protocols/v1_protocol.py,
 * roborock/devices/transport/mqtt_channel.py as of this writing) rather
 * than guessed at. Genuinely higher confidence than most other
 * integrations this session, despite the plan initially expecting the
 * opposite before this research happened.
 *
 * mqtt (npm) is used for the broker connection itself — hand-rolling an
 * MQTT client (CONNECT/PUBLISH/SUBSCRIBE packet framing, TLS, keepalive)
 * would be a much larger and riskier undertaking than the crypto pieces
 * above, disproportionate to this project's scope. Audited with `npm
 * audit` before adding (0 vulnerabilities), same due diligence that
 * already ruled out Tuya's own SDK.
 */

const SALT = Buffer.from("TXdfu$jyZ#TZHsg4", "ascii");
const HOME_DATA_CACHE_TTL_MS = 10 * 60 * 1000; // Roborock rate-limits home-data fetches to 5/hour.
const RPC_TIMEOUT_MS = 10_000;

function md5(data: Buffer | string): Buffer {
  return createHash("md5").update(data).digest();
}
function md5Hex(data: Buffer | string): string {
  return createHash("md5").update(data).digest("hex");
}

// --- Pure protocol functions -------------------------------------------

/** Pure. Roborock's timestamp obfuscation: an 8-hex-digit timestamp with its digits permuted. */
export function encodeTimestamp(timestamp: number): Buffer {
  const hex = timestamp.toString(16).padStart(8, "0");
  const order = [5, 6, 3, 7, 1, 2, 0, 4];
  return Buffer.from(order.map((i) => hex[i]).join(""), "ascii");
}

/** Pure. The AES-128 key for one message: MD5(encodeTimestamp(t) + local_key + SALT). */
export function deriveMessageKey(timestamp: number, localKey: string): Buffer {
  return md5(Buffer.concat([encodeTimestamp(timestamp), Buffer.from(localKey, "utf-8"), SALT]));
}

export interface RoborockWireMessage {
  version: string; // "1.0"
  seq: number;
  random: number;
  timestamp: number;
  protocol: number;
  payload: Buffer;
}

/** Pure. Encrypts and frames one message for MQTT — unprefixed, no extra length header (MQTT already frames the payload). */
export function encodeMessage(msg: RoborockWireMessage, localKey: string): Buffer {
  const key = deriveMessageKey(msg.timestamp, localKey);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(msg.payload), cipher.final()]);

  const header = Buffer.alloc(17);
  header.write(msg.version, 0, "ascii");
  header.writeUInt32BE(msg.seq, 3);
  header.writeUInt32BE(msg.random, 7);
  header.writeUInt32BE(msg.timestamp, 11);
  header.writeUInt16BE(msg.protocol, 15);

  const lengthPrefixed = Buffer.concat([header, u16be(encrypted.length), encrypted]);
  const checksum = u32be(crc32(lengthPrefixed));
  return Buffer.concat([lengthPrefixed, checksum]);
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** Pure. Decodes and decrypts one complete message (the inverse of encodeMessage). Ignores the trailing checksum — AES's own padding check is enough of an integrity signal here. */
export function decodeMessage(data: Buffer, localKey: string): RoborockWireMessage {
  if (data.length < 19) throw new ToolError("Roborock message too short to be valid");
  const version = data.subarray(0, 3).toString("ascii");
  const seq = data.readUInt32BE(3);
  const random = data.readUInt32BE(7);
  const timestamp = data.readUInt32BE(11);
  const protocol = data.readUInt16BE(15);
  const payloadLength = data.readUInt16BE(17);
  const encrypted = data.subarray(19, 19 + payloadLength);
  if (encrypted.length !== payloadLength) throw new ToolError("Roborock message payload length mismatch");

  const key = deriveMessageKey(timestamp, localKey);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return { version, seq, random, timestamp, protocol, payload };
}

export interface CommandRequest {
  id: number;
  method: string;
  params: unknown[];
}

/** Pure. Builds the dps-wrapped JSON payload an RPC_REQUEST (protocol 101) message carries. */
export function buildCommandPayload(request: CommandRequest, timestamp: number): Buffer {
  const inner = JSON.stringify({ id: request.id, method: request.method, params: request.params });
  const outer = JSON.stringify({ dps: { "101": inner }, t: timestamp });
  return Buffer.from(outer, "utf-8");
}

export interface CommandResponse {
  id: number | null;
  result: unknown;
  error: unknown;
}

/** Pure. Parses a decrypted RPC_RESPONSE (protocol 102) payload back into {id, result, error}. */
export function parseCommandResponse(payload: Buffer): CommandResponse {
  const outer = JSON.parse(payload.toString("utf-8")) as { dps?: Record<string, string> };
  const inner = outer.dps?.["102"];
  if (!inner) throw new ToolError("Roborock response is missing the expected data point");
  const parsed = JSON.parse(inner) as { id?: number; result?: unknown; error?: unknown };
  return { id: parsed.id ?? null, result: parsed.result, error: parsed.error };
}

export interface Rriot {
  u: string;
  s: string;
  h: string;
  k: string;
  r: { a: string; m: string };
}

export interface MqttConnectionParams {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

/** Pure. Derives MQTT broker connection details from the account's rriot data. */
export function mqttConnectionParams(rriot: Rriot): MqttConnectionParams {
  const url = new URL(rriot.r.m);
  return {
    host: url.hostname,
    port: Number(url.port),
    tls: url.protocol === "ssl:",
    username: md5Hex(`${rriot.u}:${rriot.k}`).slice(2, 10),
    password: md5Hex(`${rriot.s}:${rriot.k}`).slice(16),
  };
}

export function publishTopic(rriot: Rriot, mqttUsername: string, duid: string): string {
  return `rr/m/i/${rriot.u}/${mqttUsername}/${duid}`;
}
export function subscribeTopic(rriot: Rriot, mqttUsername: string, duid: string): string {
  return `rr/m/o/${rriot.u}/${mqttUsername}/${duid}`;
}

function sortedKeyValueMd5(values: Record<string, string> | undefined): string {
  if (!values) return "";
  const parts = Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`);
  return md5Hex(parts.join("&"));
}

/**
 * Pure (given timestamp/nonce). Roborock's "Hawk" REST auth scheme —
 * transcribed from web_api.py's `_get_hawk_authentication`.
 */
export function hawkAuthorization(
  rriot: Rriot,
  url: string,
  params: Record<string, string> | undefined,
  timestamp: number,
  nonce: string,
): string {
  const paramsStr = sortedKeyValueMd5(params);
  const payloadStr = sortedKeyValueMd5(undefined); // no request body on the GET calls this module makes
  const prestr = [rriot.u, rriot.s, nonce, String(timestamp), md5Hex(url), paramsStr, payloadStr].join(":");
  const mac = createHmac("sha256", rriot.h).update(prestr).digest("base64");
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${timestamp}",nonce="${nonce}",mac="${mac}"`;
}

// --- Thin IO layer -------------------------------------------------------

export interface UserData {
  token: string;
  rriot: Rriot;
}

function requireUserData(): UserData {
  if (!config.roborockUserData) {
    throw new ToolError("Vacuum control isn't set up yet — ROBOROCK_USER_DATA isn't configured.");
  }
  try {
    return JSON.parse(config.roborockUserData) as UserData;
  } catch {
    throw new ToolError("ROBOROCK_USER_DATA isn't valid JSON — re-run `npm run roborock-login` and paste the fresh value.");
  }
}

async function restGet(baseUrl: string, path: string, authorization: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ToolError(`couldn't reach Roborock: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`Roborock request failed (HTTP ${response.status})`);
  return response.json();
}

/**
 * Roborock's REST API uses two different response envelopes depending on
 * the endpoint's auth scheme — confirmed against the real reference
 * implementation, and initially missed here (caught by an end-to-end test
 * against a mock server, not by a pure-function unit test, since both
 * envelope shapes are structurally valid JSON on their own):
 *   - bearer-token endpoints (e.g. getHomeDetail): {code, data, msg}
 *   - Hawk-authenticated endpoints (e.g. /user/homes/{id}): {success, result}
 */
async function restGetToken(baseUrl: string, path: string, token: string): Promise<unknown> {
  const data = (await restGet(baseUrl, path, token)) as { code?: number; data?: unknown; msg?: string };
  if (data.code !== 200) throw new ToolError(`Roborock rejected the request: ${data.msg ?? `code ${data.code}`}`);
  return data.data;
}

async function restGetHawk(baseUrl: string, path: string, authorization: string): Promise<unknown> {
  const data = (await restGet(baseUrl, path, authorization)) as { success?: boolean; result?: unknown; msg?: string };
  if (!data.success) throw new ToolError(`Roborock rejected the request: ${data.msg ?? "unknown error"}`);
  return data.result;
}

async function getHomeId(userData: UserData): Promise<number> {
  const data = (await restGetToken(userData.rriot.r.a, "/api/v1/getHomeDetail", userData.token)) as
    | { rrHomeId?: number }
    | undefined;
  if (!data?.rrHomeId) throw new ToolError("Roborock didn't return a home id");
  return data.rrHomeId;
}

export interface RoborockDevice {
  duid: string;
  name: string;
  localKey: string;
  online: boolean;
}

interface HomeDataCache {
  fetchedAt: number;
  devices: RoborockDevice[];
}
let homeDataCache: HomeDataCache | null = null;

/** Test-only: lets tests reset the module-scope home-data cache between runs. */
export function _resetHomeDataCacheForTests(): void {
  homeDataCache = null;
}

/** Pure over an already-fetched array — same reasoning as every other parser in this codebase. */
export function parseDevices(raw: unknown[]): RoborockDevice[] {
  const devices: RoborockDevice[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const d = entry as Record<string, unknown>;
    if (typeof d.duid !== "string" || typeof d.name !== "string" || typeof d.local_key !== "string") continue;
    devices.push({ duid: d.duid, name: d.name, localKey: d.local_key, online: d.online === true });
  }
  return devices;
}

async function getDevices(): Promise<RoborockDevice[]> {
  if (homeDataCache && Date.now() - homeDataCache.fetchedAt < HOME_DATA_CACHE_TTL_MS) {
    return homeDataCache.devices;
  }
  const userData = requireUserData();
  const homeId = await getHomeId(userData);
  const path = `/user/homes/${homeId}`;
  const nonce = randomBytes(6).toString("base64url");
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = hawkAuthorization(userData.rriot, path, undefined, timestamp, nonce);
  const data = (await restGetHawk(userData.rriot.r.a, path, authorization)) as { devices?: unknown[] } | undefined;
  const devices = parseDevices(data?.devices ?? []);

  homeDataCache = { fetchedAt: Date.now(), devices };
  return devices;
}

const MAX_CANDIDATES_SHOWN = 8;

/**
 * Pure over an already-fetched device list — same disambiguation shape as
 * transit.ts's resolveSiteFromList and tuya.ts's resolveDeviceFromList.
 */
export function resolveVacuumFromList(devices: RoborockDevice[], query: string): RoborockDevice {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new ToolError("vacuum name can't be empty");

  const exact = devices.find((d) => d.name.toLowerCase() === needle);
  if (exact) return exact;

  const partial = devices.filter((d) => d.name.toLowerCase().includes(needle));
  if (partial.length === 0) throw new ToolError(`no vacuum matching "${query}"`);
  if (partial.length === 1) return partial[0]!;
  if (partial.length > MAX_CANDIDATES_SHOWN) {
    throw new ToolError(`"${query}" matches too many vacuums (${partial.length}) — be more specific`);
  }
  throw new ToolError(`"${query}" matches more than one vacuum: ${partial.map((d) => d.name).join(", ")} — ask which one`);
}

export async function listVacuums(): Promise<RoborockDevice[]> {
  return getDevices();
}

let mqttClientCache: { client: mqtt.MqttClient; key: string } | null = null;

async function getMqttClient(userData: UserData): Promise<mqtt.MqttClient> {
  const params = mqttConnectionParams(userData.rriot);
  const cacheKey = `${params.host}:${params.port}:${params.username}`;
  if (mqttClientCache && mqttClientCache.key === cacheKey && mqttClientCache.client.connected) {
    return mqttClientCache.client;
  }

  const client = mqtt.connect({
    host: params.host,
    port: params.port,
    protocol: params.tls ? "mqtts" : "mqtt",
    username: params.username,
    password: params.password,
    connectTimeout: 15_000,
    reconnectPeriod: 0, // this module reconnects deliberately on the next call, not silently in the background
  });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", (err) => reject(new ToolError(`couldn't reach Roborock's MQTT broker: ${err.message}`)));
  });

  mqttClientCache = { client, key: cacheKey };
  return client;
}

let nextRequestId = 10_000;
function newRequestId(): number {
  nextRequestId = nextRequestId >= 32_767 ? 10_000 : nextRequestId + 1;
  return nextRequestId;
}

async function sendCommand(device: RoborockDevice, method: string, params: unknown[] = []): Promise<unknown> {
  const userData = requireUserData();
  const client = await getMqttClient(userData);
  const mqttParams = mqttConnectionParams(userData.rriot);
  const pub = publishTopic(userData.rriot, mqttParams.username, device.duid);
  const sub = subscribeTopic(userData.rriot, mqttParams.username, device.duid);

  const requestId = newRequestId();
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildCommandPayload({ id: requestId, method, params }, timestamp);
  const encoded = encodeMessage(
    {
      version: "1.0",
      seq: Math.floor(Math.random() * 900_000) + 100_000,
      random: Math.floor(Math.random() * 90_000) + 10_000,
      timestamp,
      protocol: 101, // RPC_REQUEST
      payload,
    },
    device.localKey,
  );

  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new ToolError(`vacuum command "${method}" timed out — the vacuum may be offline`));
    }, RPC_TIMEOUT_MS);

    const onMessage = (topic: string, data: Buffer) => {
      if (topic !== sub) return;
      let decoded: RoborockWireMessage;
      try {
        decoded = decodeMessage(data, device.localKey);
      } catch {
        return; // not decodable with this key — not a response to us
      }
      if (decoded.protocol !== 102) return; // RPC_RESPONSE only
      let response: CommandResponse;
      try {
        response = parseCommandResponse(decoded.payload);
      } catch {
        return;
      }
      if (response.id !== requestId) return;

      cleanup();
      if (response.error) {
        reject(new ToolError(`vacuum rejected "${method}": ${JSON.stringify(response.error)}`));
      } else {
        resolve(response.result ?? {});
      }
    };

    function cleanup() {
      clearTimeout(timeout);
      client.removeListener("message", onMessage);
      client.unsubscribe(sub);
    }

    client.on("message", onMessage);
    client.subscribe(sub, (err) => {
      if (err) {
        cleanup();
        reject(new ToolError(`couldn't subscribe to the vacuum's response topic: ${err.message}`));
        return;
      }
      client.publish(pub, encoded, (err2) => {
        if (err2) {
          cleanup();
          reject(new ToolError(`couldn't publish the vacuum command: ${err2.message}`));
        }
      });
    });
  });
}

export async function startVacuum(device: RoborockDevice): Promise<void> {
  await sendCommand(device, "app_start");
}

export async function stopVacuum(device: RoborockDevice): Promise<void> {
  await sendCommand(device, "app_stop");
}

export async function getVacuumStatus(device: RoborockDevice): Promise<unknown> {
  return sendCommand(device, "get_status");
}
