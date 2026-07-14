import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Repository, ConflictError, NotFoundError } from "../src/repository.ts";

function freshRepo(): Repository {
  return new Repository(openDatabase(":memory:"));
}

describe("Repository", () => {
  test("saveRecord stamps automatic metadata", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({
      collection: "papers",
      content: { title: "Attention" },
      source: "https://arxiv.org/abs/1706.03762",
      tags: ["ml"],
      author: "agent-a",
    });
    expect(r.id).toBeTruthy();
    expect(r.version).toBe(1);
    expect(r.created_by).toBe("agent-a");
    expect(r.updated_by).toBe("agent-a");
    expect(r.created_at).toBeTruthy();
    expect(r.updated_at).toBe(r.created_at);
    expect(r.status).toBe("draft");
    expect(r.deleted_at).toBeNull();
    expect(r.content).toEqual({ title: "Attention" });
  });

  test("collections are auto-created and counted", () => {
    const repo = freshRepo();
    repo.saveRecord({ collection: "a", content: 1 });
    repo.saveRecord({ collection: "a", content: 2 });
    repo.saveRecord({ collection: "b", content: 3 });
    const cols = repo.listCollections();
    expect(cols.map((c) => c.name).sort()).toEqual(["a", "b"]);
    expect(cols.find((c) => c.name === "a")?.record_count).toBe(2);
  });

  test("createCollection rejects duplicates", () => {
    const repo = freshRepo();
    repo.createCollection("dupes");
    expect(() => repo.createCollection("dupes")).toThrow(ConflictError);
  });

  test("updateRecord bumps version, preserves creation metadata, writes history", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: "v1", author: "a" });
    const u = repo.updateRecord({ id: r.id, content: "v2", author: "b" });
    expect(u.version).toBe(2);
    expect(u.created_by).toBe("a");
    expect(u.updated_by).toBe("b");
    expect(u.content).toBe("v2");
    const history = repo.getHistory(r.id);
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history[1]?.content).toBe("v1");
  });

  test("updateRecord only changes provided fields", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: "x", source: "s", tags: ["t"] });
    const u = repo.updateRecord({ id: r.id, status: "verified" });
    expect(u.content).toBe("x");
    expect(u.source).toBe("s");
    expect(u.tags).toEqual(["t"]);
    expect(u.status).toBe("verified");
  });

  test("expected_version guards against concurrent overwrite", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: 1 });
    repo.updateRecord({ id: r.id, content: 2, expected_version: 1 }); // now v2
    expect(() => repo.updateRecord({ id: r.id, content: 3, expected_version: 1 })).toThrow(
      ConflictError,
    );
    // correct version succeeds
    const u = repo.updateRecord({ id: r.id, content: 3, expected_version: 2 });
    expect(u.version).toBe(3);
  });

  test("update/get on missing record throws NotFound", () => {
    const repo = freshRepo();
    expect(() => repo.updateRecord({ id: "nope", content: 1 })).toThrow(NotFoundError);
    expect(repo.getRecord("nope")).toBeNull();
  });

  test("full-text search matches content and source", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({
      collection: "c",
      content: { note: "transformers changed everything" },
      source: "https://example.com/paper",
    });
    repo.saveRecord({ collection: "c", content: { note: "unrelated cooking recipe" } });
    const hits = repo.searchRecords({ query: "transformers" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe(r.id);
    // punctuation in query must not throw
    expect(() => repo.searchRecords({ query: 'a "quote" (paren)' })).not.toThrow();
  });

  test("search filters by collection, status and tag", () => {
    const repo = freshRepo();
    repo.saveRecord({ collection: "x", content: 1, tags: ["keep"], status: "verified" });
    repo.saveRecord({ collection: "y", content: 2, tags: ["drop"], status: "draft" });
    expect(repo.searchRecords({ collection: "x" }).length).toBe(1);
    expect(repo.searchRecords({ status: "verified" }).length).toBe(1);
    expect(repo.searchRecords({ tag: "keep" }).length).toBe(1);
    expect(repo.searchRecords({ tag: "missing" }).length).toBe(0);
  });

  test("soft delete hides from search but retains record and history", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: { k: "findme" } });
    repo.deleteRecord({ id: r.id });
    expect(repo.searchRecords({ query: "findme" }).length).toBe(0);
    expect(repo.searchRecords({ query: "findme", include_deleted: true }).length).toBe(1);
    const got = repo.getRecord(r.id);
    expect(got?.deleted_at).toBeTruthy();
    expect(repo.getHistory(r.id).length).toBeGreaterThan(0);
  });

  test("hard delete removes record, comments and history", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: 1 });
    repo.addComment({ record_id: r.id, body: "hi" });
    repo.deleteRecord({ id: r.id, hard: true });
    expect(repo.getRecord(r.id)).toBeNull();
    expect(repo.getHistory(r.id).length).toBe(0);
  });

  test("comments attach to records and list chronologically", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "c", content: 1 });
    repo.addComment({ record_id: r.id, body: "first", author: "a" });
    repo.addComment({ record_id: r.id, body: "second", author: "b" });
    const comments = repo.listComments(r.id);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(() => repo.addComment({ record_id: "nope", body: "x" })).toThrow(NotFoundError);
  });
});
