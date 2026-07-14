import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../src/db.ts";
import { Repository } from "../src/repository.ts";
import { startHttpServer, type RunningServer } from "../src/http.ts";
import type { CuratorConfig } from "../src/config.ts";

/** Parse a tool result's JSON text payload. */
function payload(res: CallToolResult): any {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

function baseConfig(overrides: Partial<CuratorConfig> = {}): CuratorConfig {
  return {
    home: "/tmp/curator-test",
    dbPath: ":memory:",
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    ...overrides,
  };
}

describe("MCP server over HTTP", () => {
  let running: RunningServer;
  let client: Client;
  let url: string;

  beforeAll(async () => {
    const repo = new Repository(openDatabase(":memory:"));
    running = await startHttpServer(repo, baseConfig());
    url = `http://127.0.0.1:${running.server.port}/mcp`;
    client = new Client({ name: "curator-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  });

  afterAll(async () => {
    await client.close();
    await running.stop();
  });

  test("exposes the expected tool surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_comment",
        "create_collection",
        "delete_record",
        "get_collection_schema",
        "get_history",
        "get_record",
        "link_records",
        "list_collections",
        "list_comments",
        "list_links",
        "migrate_record",
        "save_record",
        "search_records",
        "set_collection_schema",
        "unlink_records",
        "update_record",
      ].sort(),
    );
  });

  test("full curation lifecycle through MCP tools", async () => {
    const saved = payload(
      (await client.callTool({
        name: "save_record",
        arguments: {
          collection: "research",
          content: { finding: "MCP is a good fit" },
          source: "https://modelcontextprotocol.io",
          tags: ["mcp", "notes"],
          author: "agent-1",
        },
      })) as CallToolResult,
    );
    expect(saved.version).toBe(1);
    expect(saved.created_by).toBe("agent-1");
    const id = saved.id;

    const got = payload(
      (await client.callTool({ name: "get_record", arguments: { id } })) as CallToolResult,
    );
    expect(got.content.finding).toBe("MCP is a good fit");

    await client.callTool({
      name: "add_comment",
      arguments: { record_id: id, body: "verified against the spec", author: "agent-2" },
    });
    const comments = payload(
      (await client.callTool({
        name: "list_comments",
        arguments: { record_id: id },
      })) as CallToolResult,
    );
    expect(comments.comments.length).toBe(1);

    const updated = payload(
      (await client.callTool({
        name: "update_record",
        arguments: { id, status: "verified", author: "agent-2", expected_version: 1 },
      })) as CallToolResult,
    );
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("verified");

    const search = payload(
      (await client.callTool({
        name: "search_records",
        arguments: { query: "MCP", collection: "research" },
      })) as CallToolResult,
    );
    expect(search.results.length).toBe(1);
    expect(search.results[0].id).toBe(id);

    const history = payload(
      (await client.callTool({
        name: "get_history",
        arguments: { record_id: id },
      })) as CallToolResult,
    );
    expect(history.history.map((h: any) => h.version)).toEqual([2, 1]);
  });

  test("stale expected_version returns a tool error, not a crash", async () => {
    const saved = payload(
      (await client.callTool({
        name: "save_record",
        arguments: { collection: "conflicts", content: 1 },
      })) as CallToolResult,
    );
    await client.callTool({
      name: "update_record",
      arguments: { id: saved.id, content: 2, expected_version: 1 },
    });
    const res = (await client.callTool({
      name: "update_record",
      arguments: { id: saved.id, content: 3, expected_version: 1 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("ConflictError");
  });
});

describe("Security gate", () => {
  let running: RunningServer;
  let base: string;

  beforeAll(async () => {
    const repo = new Repository(openDatabase(":memory:"));
    running = await startHttpServer(repo, baseConfig());
    base = `http://127.0.0.1:${running.server.port}`;
  });

  afterAll(async () => {
    await running.stop();
  });

  test("health endpoint is open", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { name: string }).name).toBe("curator");
  });

  test("rejects a non-local Origin (DNS-rebinding defence)", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("Bearer token enforcement", () => {
  let running: RunningServer;
  let base: string;
  const token = "s3cret-token";

  beforeAll(async () => {
    const repo = new Repository(openDatabase(":memory:"));
    running = await startHttpServer(repo, baseConfig({ token }));
    base = `http://127.0.0.1:${running.server.port}`;
  });

  afterAll(async () => {
    await running.stop();
  });

  test("requests without the token are rejected", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("a matching token is accepted", async () => {
    const client = new Client({ name: "tok", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });
});
