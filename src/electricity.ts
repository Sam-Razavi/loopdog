import { config } from "./config";
import { ToolError } from "./errors";

/**
 * Swedish day-ahead electricity spot prices, via elprisetjustnu.se — free,
 * no key, official Nord Pool pricing per Swedish zone (SE1 north to SE4
 * south; Stockholm is SE3, the default). Same unverified-in-this-sandbox
 * caveat as transit.ts's SL departures: this host is also blocked by the
 * development sandbox's egress policy, so field names come from research,
 * not a live response — parsed defensively for exactly that reason.
 */

const VALID_ZONES = ["SE1", "SE2", "SE3", "SE4"] as const;
export type Zone = (typeof VALID_ZONES)[number];

function normalizeZone(zone: string | undefined): Zone {
  const z = (zone ?? config.electricityZone).toUpperCase();
  if (!(VALID_ZONES as readonly string[]).includes(z)) {
    throw new ToolError(`zone must be one of ${VALID_ZONES.join(", ")}, got "${zone}"`);
  }
  return z as Zone;
}

export interface PricePoint {
  sek_per_kwh: number;
  /** ISO-8601, with offset, exactly as elprisetjustnu.se returns it. */
  time_start: string;
  time_end: string;
}

interface ElprisetApiItem {
  SEK_per_kWh?: number;
  time_start?: string;
  time_end?: string;
}

function priceUrl(day: Date, zone: Zone): string {
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${date}_${zone}.json`;
}

export async function getPrices(zone?: string, day: Date = new Date()): Promise<PricePoint[]> {
  const resolvedZone = normalizeZone(zone);
  const url = priceUrl(day, resolvedZone);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(
      `couldn't reach the electricity price service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) {
    throw new ToolError("no price data for that day yet — tomorrow's prices are usually published mid-afternoon");
  }
  if (!response.ok) throw new ToolError(`couldn't get electricity prices (HTTP ${response.status})`);

  const data = (await response.json()) as unknown;
  const points = (Array.isArray(data) ? data : [])
    .filter((item): item is ElprisetApiItem => typeof item === "object" && item !== null)
    .filter(
      (item) =>
        typeof item.SEK_per_kWh === "number" && typeof item.time_start === "string" && typeof item.time_end === "string",
    )
    .map((item) => ({ sek_per_kwh: item.SEK_per_kWh!, time_start: item.time_start!, time_end: item.time_end! }));

  if (points.length === 0) throw new ToolError("electricity price data came back empty or in an unexpected shape");
  return points;
}

export interface PriceWindow {
  start: string;
  end: string;
  avg_sek_per_kwh: number;
}

/**
 * The cheapest contiguous block of `windowHours` consecutive price points —
 * a sliding-window average, ties broken by the earliest start. Pure, so
 * it's testable without a network call, same reasoning as
 * correlations.ts's math and transit.ts's site resolver.
 */
export function cheapestWindow(points: PricePoint[], windowHours: number): PriceWindow | null {
  if (!Number.isInteger(windowHours) || windowHours < 1 || points.length < windowHours) return null;

  let bestSum = Infinity;
  let bestStart = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i]!.sek_per_kwh;
    if (i >= windowHours) sum -= points[i - windowHours]!.sek_per_kwh;
    if (i >= windowHours - 1) {
      const start = i - windowHours + 1;
      if (sum < bestSum) {
        bestSum = sum;
        bestStart = start;
      }
    }
  }

  return {
    start: points[bestStart]!.time_start,
    end: points[bestStart + windowHours - 1]!.time_end,
    avg_sek_per_kwh: bestSum / windowHours,
  };
}

/**
 * Whether `now` falls in a price point that's in today's cheapest quarter —
 * the trigger condition for the optional proactive nudge (pusher.ts). Pure
 * given the day's points and an instant, same testability reasoning.
 */
export function isCurrentlyCheap(points: PricePoint[], now: Date = new Date()): boolean {
  if (points.length === 0) return false;
  const current = points.find((p) => Date.parse(p.time_start) <= now.getTime() && now.getTime() < Date.parse(p.time_end));
  if (!current) return false;

  const sorted = [...points].sort((a, b) => a.sek_per_kwh - b.sek_per_kwh);
  const cutoffIndex = Math.max(0, Math.ceil(sorted.length * 0.25) - 1);
  return current.sek_per_kwh <= sorted[cutoffIndex]!.sek_per_kwh;
}

export interface ElectricityOverview {
  zone: Zone;
  current: PricePoint | null;
  today_min: PricePoint;
  today_max: PricePoint;
  today_avg_sek_per_kwh: number;
  cheapest_1h: PriceWindow | null;
  cheapest_3h: PriceWindow | null;
}

export async function getElectricityOverview(zone?: string): Promise<ElectricityOverview> {
  const resolvedZone = normalizeZone(zone);
  const points = await getPrices(resolvedZone);
  const now = new Date();

  const current =
    points.find((p) => Date.parse(p.time_start) <= now.getTime() && now.getTime() < Date.parse(p.time_end)) ?? null;

  let min = points[0]!;
  let max = points[0]!;
  let sum = 0;
  for (const point of points) {
    if (point.sek_per_kwh < min.sek_per_kwh) min = point;
    if (point.sek_per_kwh > max.sek_per_kwh) max = point;
    sum += point.sek_per_kwh;
  }

  return {
    zone: resolvedZone,
    current,
    today_min: min,
    today_max: max,
    today_avg_sek_per_kwh: sum / points.length,
    cheapest_1h: cheapestWindow(points, 1),
    cheapest_3h: cheapestWindow(points, 3),
  };
}
