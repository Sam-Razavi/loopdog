import { createHash, createHmac } from "node:crypto";
import { config } from "./config";
import { ToolError } from "./errors";

/**
 * Tuya Cloud API — DELTACO's smart plugs are rebranded Tuya hardware
 * (confirmed via Tuya's own partnership press release), so control goes
 * through Tuya's Cloud API rather than anything DELTACO-branded directly.
 *
 * Hand-rolled rather than using Tuya's own official Node SDK
 * (@tuya/tuya-connector-nodejs): that package was installed, audited, and
 * removed again before a line of integration code was written — it pins
 * a severely outdated axios with a long list of unpatched high-severity
 * CVEs (including cloud-metadata exfiltration via header injection, a
 * real concern for a bot running on Railway). This follows the same
 * fetch()-only pattern already used for every other integration here.
 *
 * developer.tuya.com is blocked by this sandbox's egress proxy, same as
 * every other real-world API doc host tried this session, so the signing
 * algorithm below is built from search-indexed doc excerpts and
 * corroborating community writeups rather than the primary source. Two
 * specific things are genuinely uncertain and flagged inline: whether a
 * nonce is strictly required (treated as an optional empty component
 * here, matching how "optional" is described in every excerpt found),
 * and the token endpoint's exact HTTP method (used as GET, the most
 * consistently referenced choice). Written defensively and expected to
 * need a fix against the first real request — same posture as SMHI's
 * warning parser.
 */

function requireTuyaConfig(): { endpoint: string; accessId: string; accessSecret: string; uid: string } {
  if (!config.tuyaAccessId || !config.tuyaAccessSecret || !config.tuyaUid) {
    throw new ToolError(
      "Smart plug control isn't set up yet — TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, and TUYA_UID aren't all configured.",
    );
  }
  return {
    endpoint: config.tuyaApiEndpoint,
    accessId: config.tuyaAccessId,
    accessSecret: config.tuyaAccessSecret,
    uid: config.tuyaUid,
  };
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Pure. Tuya's signature: HMAC-SHA256 over a specific concatenation, uppercase hex. */
export function sign(str: string, secret: string): string {
  return createHmac("sha256", secret).update(str).digest("hex").toUpperCase();
}

/**
 * Pure. The "string to sign" Tuya's docs describe as
 * HTTPMethod + "\n" + Content-SHA256 + "\n" + Signature-Headers + "\n" + URL
 * — Signature-Headers is left empty here (no extra signed headers used).
 */
export function stringToSign(method: string, body: string, path: string): string {
  return [method, sha256Hex(body), "", path].join("\n");
}

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms epoch
}
let tokenCache: TokenCache | null = null;

/** Test-only: lets tests reset the module-scope token cache between runs. */
export function _resetTokenCacheForTests(): void {
  tokenCache = null;
}

async function getAccessToken(): Promise<string> {
  const { endpoint, accessId, accessSecret } = requireTuyaConfig();
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.accessToken;

  const t = String(Date.now());
  const method = "GET";
  const path = "/v1.0/token?grant_type=1";
  const str = accessId + t + stringToSign(method, "", path);
  const signature = sign(str, accessSecret);

  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers: { client_id: accessId, sign_method: "HMAC-SHA256", t, sign: signature },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ToolError(`couldn't reach Tuya: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`Tuya token request failed (HTTP ${response.status})`);

  const data = (await response.json()) as {
    success?: boolean;
    result?: { access_token?: string; expire_time?: number };
    msg?: string;
  };
  if (!data.success || !data.result?.access_token) {
    throw new ToolError(`Tuya rejected the token request: ${data.msg ?? "unknown error"}`);
  }

  const expiresInMs = (data.result.expire_time ?? 7200) * 1000;
  tokenCache = { accessToken: data.result.access_token, expiresAt: Date.now() + expiresInMs - 60_000 };
  return tokenCache.accessToken;
}

async function tuyaRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { endpoint, accessId, accessSecret } = requireTuyaConfig();
  const accessToken = await getAccessToken();

  const t = String(Date.now());
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const str = accessId + accessToken + t + stringToSign(method, bodyStr, path);
  const signature = sign(str, accessSecret);

  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        client_id: accessId,
        access_token: accessToken,
        sign_method: "HMAC-SHA256",
        t,
        sign: signature,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? bodyStr : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ToolError(`couldn't reach Tuya: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`Tuya request failed (HTTP ${response.status})`);

  const data = (await response.json()) as { success?: boolean; result?: T; msg?: string };
  if (!data.success) throw new ToolError(`Tuya rejected the request: ${data.msg ?? "unknown error"}`);
  return data.result as T;
}

export interface TuyaDevice {
  id: string;
  name: string;
  online: boolean;
}

/** Pure over an already-fetched array — same reasoning as every other parser in this codebase. */
export function parseDevices(raw: unknown[]): TuyaDevice[] {
  const devices: TuyaDevice[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const d = entry as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.name !== "string") continue;
    devices.push({ id: d.id, name: d.name, online: d.online === true });
  }
  return devices;
}

const MAX_CANDIDATES_SHOWN = 8;

/**
 * Pure over an already-fetched device list, so this is testable without a
 * network call — same disambiguation shape as transit.ts's
 * resolveSiteFromList: exact case-insensitive match wins outright,
 * otherwise a substring match; zero or too many hits is a ToolError
 * telling the caller what to do next rather than guessing.
 */
export function resolveDeviceFromList(devices: TuyaDevice[], query: string): TuyaDevice {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new ToolError("device name can't be empty");

  const exact = devices.find((d) => d.name.toLowerCase() === needle);
  if (exact) return exact;

  const partial = devices.filter((d) => d.name.toLowerCase().includes(needle));
  if (partial.length === 0) throw new ToolError(`no smart device matching "${query}"`);
  if (partial.length === 1) return partial[0]!;
  if (partial.length > MAX_CANDIDATES_SHOWN) {
    throw new ToolError(`"${query}" matches too many devices (${partial.length}) — be more specific`);
  }
  throw new ToolError(
    `"${query}" matches more than one device: ${partial.map((d) => d.name).join(", ")} — ask which one`,
  );
}

export async function listDevices(): Promise<TuyaDevice[]> {
  const { uid } = requireTuyaConfig();
  const data = await tuyaRequest<unknown[]>("GET", `/v1.0/users/${uid}/devices`);
  return parseDevices(Array.isArray(data) ? data : []);
}

interface DeviceStatus {
  code: string;
  value: unknown;
}

/**
 * Pure. Picks the on/off status point (DP) to toggle: the first
 * boolean-valued code whose name contains "switch" (covers Tuya's common
 * conventions — switch_1, switch, switch_led — without assuming any one
 * of them), falling back to Tuya's documented default of "switch_1" if
 * none is found in the reported status at all.
 */
export function findSwitchCode(status: DeviceStatus[]): string {
  const match = status.find((s) => typeof s.value === "boolean" && s.code.toLowerCase().includes("switch"));
  return match?.code ?? "switch_1";
}

export async function setDevicePower(deviceId: string, on: boolean): Promise<void> {
  requireTuyaConfig();
  const status = await tuyaRequest<DeviceStatus[]>("GET", `/v1.0/devices/${deviceId}/status`);
  const code = findSwitchCode(Array.isArray(status) ? status : []);
  await tuyaRequest("POST", `/v1.0/devices/${deviceId}/commands`, {
    commands: [{ code, value: on }],
  });
}

// --- Lights ------------------------------------------------------------
//
// A lamp is not a switch with extras: brightness, colour temperature and
// colour live on their own data points, with ranges that genuinely differ
// between devices (bright_value is 25-255 on older firmware,
// bright_value_v2 is 10-1000). So rather than hardcoding either, the
// device's own specification is fetched and its reported min/max used —
// the same "ask the device what it supports" posture findSwitchCode
// already takes for switches, just with more to discover.

export interface TuyaFunction {
  code: string;
  type: string;
  /** Tuya sends this as a JSON *string*, not an object. */
  values: string;
}

export interface NumericRange {
  code: string;
  min: number;
  max: number;
}

/** What a given device can actually be asked to do. */
export interface LightCapabilities {
  switchCode: string | null;
  brightness: NumericRange | null;
  temperature: NumericRange | null;
  colourCode: string | null;
  workModeCode: string | null;
}

/** Pure. Tuya wraps the function list in { functions: [...] }; tolerate junk entries. */
export function parseSpecification(raw: unknown): TuyaFunction[] {
  const container = raw as { functions?: unknown } | null;
  const list = Array.isArray(container?.functions) ? container.functions : [];
  const functions: TuyaFunction[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.code !== "string" || typeof f.type !== "string") continue;
    functions.push({ code: f.code, type: f.type, values: typeof f.values === "string" ? f.values : "" });
  }
  return functions;
}

/** Pure. Reads {"min":10,"max":1000,...} out of a function's values string. */
function rangeOf(fn: TuyaFunction | undefined): NumericRange | null {
  if (!fn) return null;
  try {
    const parsed = JSON.parse(fn.values) as { min?: unknown; max?: unknown };
    if (typeof parsed.min !== "number" || typeof parsed.max !== "number") return null;
    if (parsed.max <= parsed.min) return null;
    return { code: fn.code, min: parsed.min, max: parsed.max };
  } catch {
    return null; // an unparseable values blob means "can't safely drive this"
  }
}

/**
 * Pure. Works out which codes this device actually uses. Prefers the _v2
 * variants when both are present — a device that reports both is a newer
 * one where the v1 codes are legacy aliases, and mixing the two means
 * sending a v1-ranged value to a v2-ranged point.
 */
export function pickLightCodes(functions: TuyaFunction[]): LightCapabilities {
  const byCode = new Map(functions.map((f) => [f.code, f]));
  const firstOf = (...codes: string[]): TuyaFunction | undefined => {
    for (const code of codes) {
      const found = byCode.get(code);
      if (found) return found;
    }
    return undefined;
  };

  const switchFn = firstOf("switch_led", "switch_led_1", "switch");
  const colourFn = firstOf("colour_data_v2", "colour_data");
  const workModeFn = firstOf("work_mode");

  return {
    switchCode: switchFn?.code ?? null,
    brightness: rangeOf(firstOf("bright_value_v2", "bright_value")),
    temperature: rangeOf(firstOf("temp_value_v2", "temp_value")),
    colourCode: colourFn?.code ?? null,
    workModeCode: workModeFn?.code ?? null,
  };
}

/**
 * Pure. Maps a friendly 0-100 onto the device's own range, so callers
 * never have to know whether this particular lamp wants 25-255 or 10-1000.
 * Clamped, because a lamp asked for 0% should go to its dimmest legal
 * value rather than be sent an out-of-range 0 the device may reject.
 */
export function scaleToRange(percent: number, min: number, max: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(min + ((max - min) * clamped) / 100);
}

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const NAMED_COLOURS: Record<string, string> = {
  red: "ff0000",
  orange: "ff8000",
  yellow: "ffff00",
  green: "00ff00",
  cyan: "00ffff",
  blue: "0000ff",
  purple: "8000ff",
  magenta: "ff00ff",
  pink: "ff69b4",
  white: "ffffff",
  warm: "ffb46b",
};

/**
 * Pure. Accepts a colour name or a hex string and returns Tuya's HSV
 * shape: hue 0-360, saturation and value 0-1000 (not the 0-100 or 0-255
 * every other HSV API uses — getting this wrong produces a lamp that
 * lights up almost-white and looks like a saturation bug).
 */
export function colourToHsv(colour: string): Hsv {
  const key = colour.trim().toLowerCase();
  const hex = (NAMED_COLOURS[key] ?? key).replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    throw new ToolError(
      `don't know the colour "${colour}" — use a hex value like #ff8800 or one of: ${Object.keys(NAMED_COLOURS).join(", ")}`,
    );
  }

  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;

  return {
    h: Math.round(h),
    s: Math.round((max === 0 ? 0 : delta / max) * 1000),
    v: Math.round(max * 1000),
  };
}

export interface LightRequest {
  on?: boolean;
  /** 0-100. */
  brightness?: number;
  /** 0-100, 0 = warmest. */
  temperature?: number;
  /** Colour name or hex. */
  colour?: string;
}

export interface TuyaCommand {
  code: string;
  value: unknown;
}

/**
 * Pure. Turns a friendly request into the exact commands Tuya wants.
 *
 * The work_mode command is the part that isn't obvious: a lamp sitting in
 * "white" mode silently ignores a colour_data command, and one in "colour"
 * mode ignores temp_value. Sending the mode alongside is what makes the
 * command actually take effect rather than appearing to succeed and doing
 * nothing — a failure mode with no error to notice.
 */
export function buildLightCommands(caps: LightCapabilities, request: LightRequest): TuyaCommand[] {
  const commands: TuyaCommand[] = [];

  if (request.on !== undefined) {
    if (!caps.switchCode) throw new ToolError("that device can't be switched on or off");
    commands.push({ code: caps.switchCode, value: request.on });
  }

  if (request.colour !== undefined) {
    if (!caps.colourCode) throw new ToolError("that device doesn't do colour");
    if (caps.workModeCode) commands.push({ code: caps.workModeCode, value: "colour" });
    commands.push({ code: caps.colourCode, value: colourToHsv(request.colour) });
  }

  if (request.temperature !== undefined) {
    if (!caps.temperature) throw new ToolError("that device doesn't do colour temperature");
    if (request.colour !== undefined) {
      throw new ToolError("pick either a colour or a colour temperature — a lamp can't be in both modes at once");
    }
    if (caps.workModeCode) commands.push({ code: caps.workModeCode, value: "white" });
    commands.push({
      code: caps.temperature.code,
      value: scaleToRange(request.temperature, caps.temperature.min, caps.temperature.max),
    });
  }

  if (request.brightness !== undefined) {
    if (!caps.brightness) throw new ToolError("that device isn't dimmable");
    commands.push({
      code: caps.brightness.code,
      value: scaleToRange(request.brightness, caps.brightness.min, caps.brightness.max),
    });
  }

  if (commands.length === 0) throw new ToolError("nothing to change — say a brightness, colour, or on/off");
  return commands;
}

export async function getLightCapabilities(deviceId: string): Promise<LightCapabilities> {
  requireTuyaConfig();
  const spec = await tuyaRequest<unknown>("GET", `/v1.0/iot-03/devices/${deviceId}/specification`);
  return pickLightCodes(parseSpecification(spec));
}

export async function setLight(deviceId: string, request: LightRequest): Promise<TuyaCommand[]> {
  const caps = await getLightCapabilities(deviceId);
  const commands = buildLightCommands(caps, request);
  await tuyaRequest("POST", `/v1.0/devices/${deviceId}/commands`, { commands });
  return commands;
}
