import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Repository } from "../src/repository.ts";
import { startHttpServer, type RunningServer } from "../src/http.ts";
import type { CuratorConfig } from "../src/config.ts";

function baseConfig(): CuratorConfig {
  return { home: "/tmp/curator-api-test", dbPath: ":memory:", host: "127.0.0.1", port: 0, token: undefined };
}

describe("REST /api layer", () => {
  let running: RunningServer;
  let base: string;
  const origin = () => ({ origin: base });

  beforeAll(async () => {
    running = await startHttpServer(new Repository(openDatabase(":memory:")), baseConfig());
    base = `http://127.0.0.1:${running.server.port}`;
  });
  afterAll(async () => {
    await running.stop();
  });

  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...origin() }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(base + path, { headers: origin() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonOf = (r: Response) => r.json() as Promise<any>;

  test("serves the web UI shell at /", async () => {
    const res = await fetch(base + "/");
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Curator</title>");
  });

  test("create collection with schema, enforce on records", async () => {
    const col = await post("/api/collections", {
      name: "books",
      schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    });
    expect(col.status).toBe(201);
    expect((await jsonOf(col)).current_schema_version).toBe(1);

    const good = await post("/api/records", { collection: "books", content: { title: "Dune" }, author: "web" });
    expect(good.status).toBe(201);
    const rec = await jsonOf(good);
    expect(rec.schema_version).toBe(1);

    const bad = await post("/api/records", { collection: "books", content: { pages: 412 } });
    expect(bad.status).toBe(400);

    // search finds it
    const search = await jsonOf(await get("/api/records?query=Dune"));
    expect(search.results.length).toBe(1);

    // patch with optimistic concurrency
    const patched = await fetch(base + "/api/records/" + rec.id, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...origin() },
      body: JSON.stringify({ status: "verified", expected_version: 1 }),
    });
    expect((await jsonOf(patched)).status).toBe("verified");

    // comment + history
    expect((await post("/api/records/" + rec.id + "/comments", { body: "hi" })).status).toBe(201);
    expect((await jsonOf(await get("/api/records/" + rec.id + "/history"))).history.length).toBe(2);
  });

  test("schema evolution + migrate over the API", async () => {
    await post("/api/collections", { name: "movies", schema: { type: "object", properties: { title: { type: "string" } } } });
    const rec = await jsonOf(await post("/api/records", { collection: "movies", content: { title: "Alien" } }));

    const put = await fetch(base + "/api/collections/movies/schema", {
      method: "PUT",
      headers: { "content-type": "application/json", ...origin() },
      body: JSON.stringify({ schema: { type: "object", required: ["title", "year"], properties: { title: { type: "string" }, year: { type: "integer" } } } }),
    });
    expect((await jsonOf(put)).version).toBe(2);

    const migrated = await jsonOf(await post("/api/records/" + rec.id + "/migrate", { content: { title: "Alien", year: 1979 } }));
    expect(migrated.schema_version).toBe(2);
  });

  test("404 for unknown record, 409 for duplicate collection", async () => {
    expect((await get("/api/records/does-not-exist")).status).toBe(404);
    await post("/api/collections", { name: "dup" });
    expect((await post("/api/collections", { name: "dup" })).status).toBe(409);
  });

  test("rejects non-local Origin on /api", async () => {
    const res = await fetch(base + "/api/records", { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
  });
});
