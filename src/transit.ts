import { config } from "./config";
import { ToolError } from "./errors";

/**
 * Stockholm public transit (SL) — real-time departures, no API key at all.
 * Trip planning across operators (SL + SJ + regional) is a separate,
 * Trafiklab-keyed API layered on below.
 *
 * Verification note, stated plainly rather than glossed over: this
 * sandbox's egress proxy blocks transport.integration.sl.se outright (a
 * policy denial, confirmed via the proxy status endpoint — not something to
 * retry or route around), so none of this could be exercised against the
 * real API the way Gmail's real 401 or PrivateMail's real IMAP timeout
 * were. Field names below come from research, not a live response — the
 * parsing is written defensively (optional chaining, fallbacks, a
 * ToolError on an unexpected shape) specifically because of that gap, and
 * it needs a first real run against production to confirm.
 */

const SITES_URL = "https://transport.integration.sl.se/v1/sites";
const SITE_LIST_TTL_MS = 24 * 60 * 60 * 1000;

interface SlSite {
  id: number;
  name: string;
}

interface SiteListCache {
  fetchedAt: number;
  sites: SlSite[];
}

let siteListCache: SiteListCache | null = null;

async function fetchSiteList(): Promise<SlSite[]> {
  let response: Response;
  try {
    response = await fetch(SITES_URL, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(
      `couldn't reach SL's stop list: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new ToolError(`couldn't fetch SL's stop list (HTTP ${response.status})`);

  const data = (await response.json()) as unknown;
  const sites = (Array.isArray(data) ? data : [])
    .filter(
      (s): s is { id: number; name: string } =>
        typeof s === "object" && s !== null && typeof (s as { id?: unknown }).id === "number" && typeof (s as { name?: unknown }).name === "string",
    )
    .map((s) => ({ id: s.id, name: s.name }));

  if (sites.length === 0) throw new ToolError("SL's stop list came back empty or in an unexpected shape");
  return sites;
}

async function loadSites(): Promise<SlSite[]> {
  if (siteListCache && Date.now() - siteListCache.fetchedAt < SITE_LIST_TTL_MS) {
    return siteListCache.sites;
  }
  const sites = await fetchSiteList();
  siteListCache = { fetchedAt: Date.now(), sites };
  return sites;
}

export interface SiteMatch {
  id: number;
  name: string;
}

const MAX_CANDIDATES_SHOWN = 8;

/**
 * Pure over an already-loaded site list, so this is testable without a
 * network call. Case-insensitive exact match wins outright; otherwise a
 * substring match — zero hits or too many is a ToolError telling the
 * caller what to do next rather than guessing at one.
 */
export function resolveSiteFromList(sites: SlSite[], query: string): SiteMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new ToolError("stop name can't be empty");

  const exact = sites.find((s) => s.name.toLowerCase() === needle);
  if (exact) return exact;

  const partial = sites.filter((s) => s.name.toLowerCase().includes(needle));
  if (partial.length === 0) throw new ToolError(`no SL stop matching "${query}"`);
  if (partial.length === 1) return partial[0]!;
  if (partial.length > MAX_CANDIDATES_SHOWN) {
    throw new ToolError(`"${query}" matches too many stops (${partial.length}) — be more specific`);
  }
  throw new ToolError(
    `"${query}" matches more than one stop: ${partial.map((s) => s.name).join(", ")} — ask which one`,
  );
}

async function resolveSite(query: string): Promise<SiteMatch> {
  return resolveSiteFromList(await loadSites(), query);
}

export interface Departure {
  line: string;
  destination: string;
  transport_mode: string;
  /** SL's own precomputed "X min" / clock-time string — used as-is rather than recomputed. */
  display: string;
  scheduled: string | null;
  expected: string | null;
}

interface SlDeparturesResponse {
  departures?: {
    destination?: string;
    display?: string;
    line?: { designation?: string; transport_mode?: string };
    scheduled?: string;
    expected?: string;
  }[];
}

async function fetchDepartures(siteId: number, forecastMinutes: number): Promise<Departure[]> {
  const url = new URL(`${SITES_URL}/${siteId}/departures`);
  url.searchParams.set("forecast", String(forecastMinutes));

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(`couldn't reach SL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`couldn't get departures (HTTP ${response.status})`);

  const data = (await response.json()) as SlDeparturesResponse;
  return (data.departures ?? []).map((d) => ({
    line: d.line?.designation ?? "?",
    destination: d.destination ?? "?",
    transport_mode: d.line?.transport_mode ?? "unknown",
    display: d.display ?? "",
    scheduled: d.scheduled ?? null,
    expected: d.expected ?? null,
  }));
}

export interface DeparturesResult {
  stop: string;
  departures: Departure[];
}

export async function findDepartures(
  stopQuery: string,
  maxResults: number,
  transportFilter?: string,
): Promise<DeparturesResult> {
  const site = await resolveSite(stopQuery);
  let departures = await fetchDepartures(site.id, 60);
  if (transportFilter) {
    const wanted = transportFilter.toLowerCase();
    departures = departures.filter((d) => d.transport_mode.toLowerCase() === wanted);
  }
  return { stop: site.name, departures: departures.slice(0, maxResults) };
}

/** Test-only: lets tests reset the module-scope cache between runs. */
export function _resetSiteListCacheForTests(): void {
  siteListCache = null;
}
// --- Trip planning across operators (SL + SJ + regional), via Trafiklab's
// ResRobot API. Needs a free API key, unlike the departures board above —
// this is the one piece of this file that couldn't be exercised at all
// during development, not even against a real (blocked) host: no key was
// available to test with either. Code-complete, unverified against a real
// account, same honesty as Hotmail/PrivateMail/Telegram's first ship. -----

const RESROBOT_LOCATION_URL = "https://api.resrobot.se/v2.1/location.name";
const RESROBOT_TRIP_URL = "https://api.resrobot.se/v2.1/trip";

function requireTrafiklabKey(): string {
  if (!config.trafiklabApiKey) {
    throw new ToolError("Trip planning isn't set up yet — TRAFIKLAB_API_KEY isn't configured.");
  }
  return config.trafiklabApiKey;
}

interface ResRobotStop {
  id?: string;
  name?: string;
}

async function resolveResRobotStop(query: string): Promise<{ id: string; name: string }> {
  const apiKey = requireTrafiklabKey();
  const url = new URL(RESROBOT_LOCATION_URL);
  url.searchParams.set("input", query);
  url.searchParams.set("accessId", apiKey);
  url.searchParams.set("format", "json");

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(`couldn't reach the trip planner: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`couldn't look up "${query}" (HTTP ${response.status})`);

  const data = (await response.json()) as { stopLocationOrCoordLocation?: { StopLocation?: ResRobotStop }[] };
  const first = data.stopLocationOrCoordLocation?.find((entry) => entry.StopLocation?.id)?.StopLocation;
  if (!first?.id) throw new ToolError(`no place matching "${query}"`);
  return { id: first.id, name: first.name ?? query };
}

export interface TripLeg {
  mode: string;
  line: string | null;
  origin: string;
  destination: string;
  departure: string | null;
  arrival: string | null;
}

export interface TripPlan {
  origin: string;
  destination: string;
  legs: TripLeg[];
  departure: string | null;
  arrival: string | null;
}

interface ResRobotLeg {
  name?: string;
  type?: string;
  Origin?: { name?: string; time?: string; date?: string };
  Destination?: { name?: string; time?: string; date?: string };
}

interface ResRobotTripResponse {
  Trip?: { LegList?: { Leg?: ResRobotLeg[] } }[];
}

/**
 * ResRobot returns date/time as plain local (Europe/Stockholm) values with
 * no UTC offset attached — toUtcIso() would reject that outright (it
 * requires an explicit offset, by design, to avoid guessing at ambiguous
 * local times elsewhere in this codebase). There is nothing to guess here:
 * every other "local time" Loopdog surfaces already means the configured
 * zone, so this is returned the same way rather than forced through a
 * conversion that would just fail and silently null out every leg.
 */
function combineDateTime(date: string | undefined, time: string | undefined): string | null {
  if (!date || !time) return null;
  return `${date}T${time}`;
}

export async function planTrip(originQuery: string, destQuery: string): Promise<TripPlan> {
  const apiKey = requireTrafiklabKey();
  const [origin, dest] = await Promise.all([
    resolveResRobotStop(originQuery),
    resolveResRobotStop(destQuery),
  ]);

  const url = new URL(RESROBOT_TRIP_URL);
  url.searchParams.set("originId", origin.id);
  url.searchParams.set("destId", dest.id);
  url.searchParams.set("accessId", apiKey);
  url.searchParams.set("format", "json");

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(`couldn't reach the trip planner: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`couldn't plan that trip (HTTP ${response.status})`);

  const data = (await response.json()) as ResRobotTripResponse;
  const firstTrip = data.Trip?.[0];
  const legs = firstTrip?.LegList?.Leg ?? [];
  if (legs.length === 0) throw new ToolError(`no route found from "${origin.name}" to "${dest.name}"`);

  const mapped: TripLeg[] = legs.map((leg) => ({
    mode: leg.type ?? "unknown",
    line: leg.name ?? null,
    origin: leg.Origin?.name ?? origin.name,
    destination: leg.Destination?.name ?? dest.name,
    departure: combineDateTime(leg.Origin?.date, leg.Origin?.time),
    arrival: combineDateTime(leg.Destination?.date, leg.Destination?.time),
  }));

  return {
    origin: origin.name,
    destination: dest.name,
    legs: mapped,
    departure: mapped[0]?.departure ?? null,
    arrival: mapped[mapped.length - 1]?.arrival ?? null,
  };
}
