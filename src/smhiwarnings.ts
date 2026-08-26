import { ToolError } from "./errors";

/**
 * SMHI (Sweden's met office) impact-based weather warnings — free, no key.
 * Same unverified-in-this-sandbox caveat as transit.ts/electricity.ts: this
 * host is also blocked by the development sandbox's egress policy.
 *
 * The shape below is reconstructed from SMHI's own docs plus a real,
 * working parser (github.com/Lallassu/smhialert, a Home Assistant
 * integration) rather than guessed at cold — the most confidence available
 * without a live fetch, but still not a confirmed live response. Every
 * field access is defensive for exactly that reason.
 */

const WARNINGS_URL = "https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json";

interface SmhiLangText {
  sv?: string;
  en?: string;
  code?: string;
}

interface SmhiAffectedArea {
  id?: string | number;
  sv?: string;
  en?: string;
}

interface SmhiWarningArea {
  affectedAreas?: SmhiAffectedArea[];
  warningLevel?: SmhiLangText;
  eventDescription?: SmhiLangText;
  descriptions?: { text?: SmhiLangText }[];
  approximateStart?: string;
  approximateEnd?: string;
}

interface SmhiAlert {
  identifier?: string;
  id?: string | number;
  event?: SmhiLangText;
  warningAreas?: SmhiWarningArea[];
}

export interface WeatherWarning {
  /** From the API when present; otherwise composed from event+areas+start so dedup still works. */
  id: string;
  event: string;
  level: string;
  areas: string[];
  description: string;
  start: string | null;
  end: string | null;
}

function pickText(obj: SmhiLangText | undefined): string {
  return obj?.en ?? obj?.sv ?? obj?.code ?? "unknown";
}

/**
 * Pure over an already-fetched alert array, so this is testable without a
 * network call — same reasoning as transit.ts's resolveSiteFromList and
 * electricity.ts's cheapestWindow. Flattens SMHI's alert -> warningAreas
 * nesting into one entry per area-group; `county` filters by substring
 * match against the affected-area names when given.
 */
export function parseWarnings(alerts: SmhiAlert[], county?: string): WeatherWarning[] {
  const needle = county?.trim().toLowerCase();
  const warnings: WeatherWarning[] = [];

  for (const alert of alerts) {
    const eventName = pickText(alert.event);
    for (const area of alert.warningAreas ?? []) {
      const areaNames = (area.affectedAreas ?? []).map((a) => a.en ?? a.sv ?? "").filter(Boolean);
      if (needle && !areaNames.some((name) => name.toLowerCase().includes(needle))) continue;

      const id =
        alert.identifier ??
        (alert.id !== undefined ? String(alert.id) : `${eventName}|${areaNames.join(",")}|${area.approximateStart ?? ""}`);

      const description =
        pickText(area.eventDescription) !== "unknown"
          ? pickText(area.eventDescription)
          : pickText(area.descriptions?.[0]?.text);

      warnings.push({
        id,
        event: eventName,
        level: pickText(area.warningLevel),
        areas: areaNames,
        description,
        start: area.approximateStart ?? null,
        end: area.approximateEnd ?? null,
      });
    }
  }
  return warnings;
}

export async function getActiveWarnings(county?: string): Promise<WeatherWarning[]> {
  let response: Response;
  try {
    response = await fetch(WARNINGS_URL, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ToolError(`couldn't reach SMHI: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ToolError(`couldn't get weather warnings (HTTP ${response.status})`);

  const data = (await response.json()) as unknown;
  const alerts = Array.isArray(data) ? (data as SmhiAlert[]) : [];
  return parseWarnings(alerts, county);
}
