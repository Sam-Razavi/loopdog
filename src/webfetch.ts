import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/**
 * Whether an IP literal points somewhere inside the host's own network.
 * fetch_url and watch_page take URLs Claude chose, and Claude reads text
 * from web pages, emails and Telegram messages — so a URL can ultimately
 * originate with someone else. Without this, "fetch http://169.254.169.254/"
 * reaches the cloud metadata endpoint, and localhost reaches anything bound
 * on the container.
 */
function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts as [number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // IPv4-mapped — re-check the embedded address. Two spellings matter:
    // the dotted form (::ffff:127.0.0.1) and the hex form the WHATWG URL
    // parser normalises it to (::ffff:7f00:1). Matching only the dotted one
    // let the hex form through as "not private".
    const mappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isPrivateAddress(mappedDotted[1]!);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1]!, 16);
      const low = parseInt(mappedHex[2]!, 16);
      return isPrivateAddress(
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
      );
    }
    if (/^f[cd]/.test(lower)) return true; // unique-local fc00::/7
    if (lower.startsWith("fe80")) return true; // link-local
    return false;
  }

  return true; // unparseable: refuse rather than guess
}

/**
 * Resolves a URL's host and refuses anything internal.
 *
 * Note honestly: this does not close DNS rebinding — a hostname could
 * resolve to a public address here and a private one microseconds later
 * when fetch() does its own lookup. Closing that means connecting to a
 * validated IP with a pinned Host header, which is disproportionate for a
 * single-user bot. Don't assume this is airtight.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`that doesn't look like a valid URL: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`url must start with http:// or https://, got "${raw}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ToolError(`refusing to fetch a private address (${host})`);
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new ToolError(`couldn't resolve "${host}"`);
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ToolError(`refusing to fetch "${host}" — it resolves to a private address`);
  }
  return url;
}

const MAX_REDIRECTS = 3;

/**
 * Fetches a URL and extracts its readable text. Network half of
 * extractReadableText.
 *
 * Redirects are followed by hand rather than by fetch(), because fetch()
 * follows them transparently — so a public URL redirecting to
 * 169.254.169.254 would sail straight past a check on the original host
 * only. Every hop gets revalidated.
 */
export async function fetchReadableText(
  url: string,
): Promise<ReturnType<typeof extractReadableText>> {
  let current = await assertPublicUrl(url);

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Loopdog/1.0)" },
      });
    } catch (error) {
      throw new ToolError(
        `couldn't reach that page: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ToolError(`that page redirected without saying where (HTTP ${response.status})`);
      if (hop >= MAX_REDIRECTS) throw new ToolError(`that page redirected too many times`);
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new ToolError(`couldn't fetch that page (HTTP ${response.status})`);
    }

    const html = await response.text();
    return extractReadableText(html);
  }
}
