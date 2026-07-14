import type { ToolDef } from "./llm.ts";

/**
 * Web tools the agent runs locally: `web_search` (bring-your-own search API
 * key) and `web_fetch` (fetch a URL and extract readable text). Search is
 * disabled unless a provider + key are configured; fetch always works.
 */

export interface WebToolEnv {
  searchProvider?: string; // "tavily" | "brave"
  searchApiKey?: string;
}

export function webToolDefs(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web and return a list of results (title, url, snippet). Use this to discover sources before curating.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            max_results: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description:
          "Fetch a URL and return its readable text content (HTML stripped, truncated). Use to read a source before saving curated data from it.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL to fetch." },
            max_chars: { type: "integer", minimum: 500, maximum: 50000, default: 8000 },
          },
          required: ["url"],
        },
      },
    },
  ];
}

export function isWebTool(name: string): boolean {
  return name === "web_search" || name === "web_fetch";
}

export async function execWebTool(
  name: string,
  args: Record<string, unknown>,
  env: WebToolEnv,
): Promise<string> {
  if (name === "web_search") return webSearch(String(args.query ?? ""), Number(args.max_results) || 5, env);
  if (name === "web_fetch") return webFetch(String(args.url ?? ""), Number(args.max_chars) || 8000);
  return `Unknown web tool: ${name}`;
}

async function webSearch(query: string, maxResults: number, env: WebToolEnv): Promise<string> {
  if (!query) return "web_search error: empty query.";
  const provider = (env.searchProvider ?? "").toLowerCase();
  const key = env.searchApiKey;
  if (!provider || !key) {
    return "web_search is not configured. Set CURATOR_SEARCH_PROVIDER (tavily|brave) and CURATOR_SEARCH_API_KEY to enable it. You can still use web_fetch on known URLs.";
  }
  try {
    const results =
      provider === "tavily"
        ? await tavily(query, maxResults, key)
        : provider === "brave"
          ? await brave(query, maxResults, key)
          : null;
    if (results === null) return `web_search error: unknown provider "${provider}" (use tavily or brave).`;
    if (!results.length) return "No results.";
    return JSON.stringify(results, null, 2);
  } catch (err) {
    return `web_search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function tavily(query: string, maxResults: number, key: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function brave(query: string, maxResults: number, key: string): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": key } });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

async function webFetch(url: string, maxChars: number): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "web_fetch error: url must start with http:// or https://";
  try {
    const res = await fetch(url, { headers: { "user-agent": "curator-agent/0.1 (+local)" }, redirect: "follow" });
    if (!res.ok) return `web_fetch error: ${res.status} ${res.statusText}`;
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = ct.includes("html") ? htmlToText(raw) : raw;
    const clipped = text.slice(0, maxChars);
    return clipped + (text.length > maxChars ? `\n…[truncated ${text.length - maxChars} chars]` : "");
  } catch (err) {
    return `web_fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Crude but dependency-free HTML → text: drop script/style, strip tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
