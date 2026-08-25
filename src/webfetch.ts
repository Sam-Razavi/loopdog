import { ToolError } from "./errors";

const MAX_CHARS = 8000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#?[a-z0-9]+);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    return key in ENTITIES ? ENTITIES[key]! : match;
  });
}

/**
 * Pulls readable text out of raw HTML — no jsdom/readability dependency,
 * consistent with the project's preference for built-ins over new
 * dependencies. Deliberately simple: strips scripts/styles/tags, decodes
 * the common entities, collapses whitespace, and caps the result. Works
 * well for text-heavy pages (articles, docs); poorly for JS-rendered SPAs,
 * whose content never appears in the raw HTML this fetches.
 */
export function extractReadableText(html: string): {
  title: string | null;
  text: string;
  truncated: boolean;
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim() || null : null;

  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  const collapsed = decodeEntities(withoutTags).replace(/\s+/g, " ").trim();

  const truncated = collapsed.length > MAX_CHARS;
  const text = truncated ? collapsed.slice(0, MAX_CHARS) : collapsed;

  return { title, text, truncated };
}

/** Fetches a URL and extracts its readable text. Network half of extractReadableText. */
export async function fetchReadableText(
  url: string,
): Promise<ReturnType<typeof extractReadableText>> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ToolError(`url must start with http:// or https://, got "${url}"`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Loopdog/1.0)" },
    });
  } catch (error) {
    throw new ToolError(
      `couldn't reach that page: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ToolError(`couldn't fetch that page (HTTP ${response.status})`);
  }

  const html = await response.text();
  return extractReadableText(html);
}
