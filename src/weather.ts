import { config } from "./config";
import { ToolError } from "./errors";

// WMO weather codes, as used by Open-Meteo. https://open-meteo.com/en/docs
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

/** Plain-English description of an Open-Meteo WMO weather code. */
export function describeWeatherCode(code: number): string {
  return WEATHER_CODES[code] ?? `unrecognized conditions (code ${code})`;
}

interface WeatherResult {
  city: string;
  temperature_c: number;
  condition: string;
  wind_kph: number;
}

interface GeocodeResponse {
  results?: { name: string; latitude: number; longitude: number }[];
}

interface ForecastResponse {
  current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
}

async function fetchJson<T>(url: string, notFoundMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new ToolError(
      `couldn't reach the weather service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new ToolError(notFoundMessage);
  return (await response.json()) as T;
}

/** Geocodes `city` and returns its current conditions, via Open-Meteo (free, no key). */
export async function getWeather(city: string = config.city): Promise<WeatherResult> {
  const geocode = await fetchJson<GeocodeResponse>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
    `couldn't look up "${city}"`,
  );
  const place = geocode.results?.[0];
  if (!place) throw new ToolError(`couldn't find a location called "${city}"`);

  const forecast = await fetchJson<ForecastResponse>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m`,
    `couldn't get the forecast for "${city}"`,
  );
  const current = forecast.current;
  if (!current) throw new ToolError(`couldn't get the forecast for "${city}"`);

  return {
    city: place.name ?? city,
    temperature_c: current.temperature_2m,
    condition: describeWeatherCode(current.weather_code),
    wind_kph: current.wind_speed_10m,
  };
}
