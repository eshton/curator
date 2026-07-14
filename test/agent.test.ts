import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Repository } from "../src/repository.ts";
import { startHttpServer, type RunningServer } from "../src/http.ts";
import { runAgent, type AgentConfig } from "../src/agent.ts";
import { execWebTool } from "../src/webtools.ts";
import type { CuratorConfig } from "../src/config.ts";

function cfg(): CuratorConfig {
  return { home: "/tmp/curator-agent-test", dbPath: ":memory:", host: "127.0.0.1", port: 0, token: undefined };
}

/** A scripted OpenAI-compatible endpoint: web_fetch -> save_record -> finish. */
function stubModel() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/page") {
        return new Response("<html><body><p>Transformers are attention-based.</p></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as { messages: { role: string }[] };
        const toolTurns = body.messages.filter((m) => m.role === "tool").length;
        const pageUrl = `${url.origin}/page`;
        if (toolTurns === 0) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: pageUrl }) } }] }, finish_reason: "tool_calls" }],
            usage: { total_tokens: 10 },
          });
        }
        if (toolTurns === 1) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "save_record", arguments: JSON.stringify({ collection: "research", content: { fact: "Transformers are attention-based." }, source: pageUrl, tags: ["ml"], status: "verified", author: "curator-agent" }) } }] }, finish_reason: "tool_calls" }],
            usage: { total_tokens: 10 },
          });
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { total_tokens: 4 } });
      }
      return new Response("nf", { status: 404 });
    },
  });
}

describe("Curation agent", () => {
  let repo: Repository;
  let curator: RunningServer;
  let model: ReturnType<typeof stubModel>;
  let mcpUrl: string;
  let modelUrl: string;

  beforeAll(async () => {
    repo = new Repository(openDatabase(":memory:"));
    curator = await startHttpServer(repo, cfg());
    mcpUrl = `http://127.0.0.1:${curator.server.port}/mcp`;
    model = stubModel();
    modelUrl = `http://127.0.0.1:${model.port}/v1`;
  });
  afterAll(async () => {
    await curator.stop();
    model.stop(true);
  });

  test("runs the tool-use loop and records work via curator MCP", async () => {
    const config: AgentConfig = {
      task: "Curate a fact about transformers.",
      mcpUrl,
      model: "stub",
      modelUrl,
      collection: "research",
      author: "curator-agent",
      maxSteps: 10,
      web: {},
    };
    const result = await runAgent(config);
    expect(result.stoppedReason).toBe("completed");
    expect(result.steps).toBe(3);

    const records = repo.searchRecords({ collection: "research" });
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("verified");
    expect(records[0]!.created_by).toBe("curator-agent");
    expect((records[0]!.content as { fact: string }).fact).toContain("attention");
    expect(records[0]!.source).toContain("/page");
  });

  test("web_fetch extracts text; web_search reports when unconfigured", async () => {
    const fetched = await execWebTool("web_fetch", { url: `http://127.0.0.1:${model.port}/page` }, {});
    expect(fetched).toContain("attention-based");

    const search = await execWebTool("web_search", { query: "anything" }, {});
    expect(search).toContain("not configured");
  });
});
