import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CuratorConfig } from "./config.ts";
import { MCP_PATH } from "./config.ts";
import { createMcpServer, CURATOR_VERSION } from "./server.ts";
import { handleApiRequest } from "./api.ts";
import { WEBUI_HTML } from "./webui.ts";
import type { Repository } from "./repository.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Hostname (sans port/brackets) is a loopback name. */
function isLocalHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return LOCAL_HOSTS.has(host);
}

/**
 * Security gate applied before any MCP handling. Returns an error `Response`
 * to reject, or `null` to allow.
 *
 * - Host header must be loopback (the socket already binds to 127.0.0.1; this
 *   is belt-and-braces against proxies).
 * - Origin, when present, must be loopback — this defeats DNS-rebinding where a
 *   malicious web page tries to reach the local daemon.
 * - When a token is configured, a matching bearer token is required.
 */
function checkRequest(req: Request, cfg: CuratorConfig): Response | null {
  if (!isLocalHost(req.headers.get("host"))) {
    return json({ error: "Forbidden: non-local Host header." }, 403);
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      originHost = null;
    }
    if (!originHost || !LOCAL_HOSTS.has(originHost)) {
      return json({ error: "Forbidden: non-local Origin (possible DNS rebinding)." }, 403);
    }
  }
  if (cfg.token) {
    const auth = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${cfg.token}`;
    if (auth !== expected) {
      return json({ error: "Unauthorized: missing or invalid bearer token." }, 401);
    }
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
}

/**
 * Start the MCP HTTP server bound to loopback. Uses a single stateless
 * transport shared across all requests (no per-session state), which lets any
 * number of local agents connect concurrently as plain HTTP clients.
 */
export async function startHttpServer(
  repo: Repository,
  cfg: CuratorConfig,
): Promise<RunningServer> {
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ name: "curator", version: CURATOR_VERSION, ok: true });
      }

      if (url.pathname === MCP_PATH) {
        const rejected = checkRequest(req, cfg);
        if (rejected) return rejected;
        return handleMcpRequest(req, repo);
      }

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const rejected = checkRequest(req, cfg);
        if (rejected) return rejected;
        return handleApiRequest(req, repo);
      }

      // Web UI shell. Served without a token (top-level navigation cannot send
      // one); the page then supplies the token on its /api calls. Still gated
      // to loopback by the socket binding and Host check.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!isLocalHost(req.headers.get("host"))) {
          return json({ error: "Forbidden" }, 403);
        }
        return new Response(WEBUI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      return json({ error: "Not found" }, 404);
    },
  });

  return {
    server,
    stop: async () => {
      server.stop(true);
    },
  };
}

/**
 * Handle one MCP request in stateless mode. The SDK requires a fresh transport
 * (and thus server) per request when no session id is used; the repository —
 * which owns all shared state — is reused across requests.
 */
async function handleMcpRequest(req: Request, repo: Repository): Promise<Response> {
  const mcp = createMcpServer(repo);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  try {
    // JSON-response mode fully materialises the body, so it is safe to tear the
    // per-request server down once handleRequest resolves.
    return await transport.handleRequest(req);
  } finally {
    void mcp.close();
  }
}
