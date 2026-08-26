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
