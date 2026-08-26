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
