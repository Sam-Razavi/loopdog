import { config } from "./config";
import { ToolError } from "./errors";

/**
 * Real web search, via Tavily — chosen over the more Google/Bing-shaped
 * options because it's free with no credit card and built specifically for
 * this use case (an LLM agent deciding what to look up), rather than being
 * a general SERP API repurposed for it. Distinct from fetch_url: that tool
 * needs an exact URL already in hand; this one is for "look this up."
 */

const SEARCH_URL = "https://api.tavily.com/search";

function requireApiKey(): string {
  if (!config.tavilyApiKey) {
    throw new ToolError("Web search isn't set up yet — TAVILY_API_KEY isn't configured.");
  }
  return config.tavilyApiKey;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchResponse {
  /** Tavily's own synthesized short answer, when it has enough confidence to give one. */
  answer: string | null;
  results: SearchResult[];
}

interface TavilyApiResponse {
  answer?: string | null;
  results?: { title?: string; url?: string; content?: string }[];
}

export async function searchWeb(query: string, maxResults: number): Promise<SearchResponse> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ToolError(
      `couldn't reach the search service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ToolError(`search failed (HTTP ${response.status})`);
  }

  const data = (await response.json()) as TavilyApiResponse;
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? "(untitled)",
      url: r.url ?? "",
      content: r.content ?? "",
    })),
  };
}
