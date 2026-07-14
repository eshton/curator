import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Repository, ConflictError, NotFoundError, ValidationError } from "../src/repository.ts";

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

describe("Record links", () => {
  test("links records across collections, discoverable from both ends", () => {
    const repo = freshRepo();
    const paper = repo.saveRecord({ collection: "papers", content: { title: "T" } });
    const person = repo.saveRecord({ collection: "people", content: { name: "V" } });
    repo.linkRecords({ from_id: person.id, to_id: paper.id, rel: "authored", author: "a" });

    const fromPerson = repo.listLinks(person.id);
    expect(fromPerson).toHaveLength(1);
    expect(fromPerson[0]!.direction).toBe("out");
    expect(fromPerson[0]!.record.collection).toBe("papers");

    const fromPaper = repo.listLinks(paper.id);
    expect(fromPaper).toHaveLength(1);
    expect(fromPaper[0]!.direction).toBe("in");
    expect(fromPaper[0]!.record.collection).toBe("people");
  });

  test("rejects self-links, duplicates and missing endpoints", () => {
    const repo = freshRepo();
    const a = repo.saveRecord({ collection: "c", content: 1 });
    const b = repo.saveRecord({ collection: "c", content: 2 });
    expect(() => repo.linkRecords({ from_id: a.id, to_id: a.id })).toThrow(ValidationError);
    expect(() => repo.linkRecords({ from_id: a.id, to_id: "missing" })).toThrow(NotFoundError);
    repo.linkRecords({ from_id: a.id, to_id: b.id, rel: "related" });
    expect(() => repo.linkRecords({ from_id: a.id, to_id: b.id, rel: "related" })).toThrow(
      ConflictError,
    );
    // a different rel between the same pair is allowed
    repo.linkRecords({ from_id: a.id, to_id: b.id, rel: "cites" });
    expect(repo.listLinks(a.id, { direction: "out" })).toHaveLength(2);
    expect(repo.listLinks(a.id, { direction: "out", rel: "cites" })).toHaveLength(1);
  });

  test("unlink and cascade on hard delete", () => {
    const repo = freshRepo();
    const a = repo.saveRecord({ collection: "c", content: 1 });
    const b = repo.saveRecord({ collection: "c", content: 2 });
    repo.linkRecords({ from_id: a.id, to_id: b.id, rel: "cites" });
    expect(repo.unlinkRecords({ from_id: a.id, to_id: b.id }).removed).toBe(1);
    expect(repo.listLinks(a.id)).toHaveLength(0);

    repo.linkRecords({ from_id: a.id, to_id: b.id, rel: "cites" });
    repo.deleteRecord({ id: b.id, hard: true });
    expect(repo.listLinks(a.id)).toHaveLength(0);
  });
});

describe("Collection schemas", () => {
  const PERSON = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" }, age: { type: "integer" } },
    additionalProperties: true,
  };

  test("schemaless collections accept any content", () => {
    const repo = freshRepo();
    const r = repo.saveRecord({ collection: "free", content: { whatever: [1, 2, 3] } });
    expect(r.schema_version).toBeNull();
  });

  test("a schema enforces content on save and stamps schema_version", () => {
    const repo = freshRepo();
    repo.createCollection("people", undefined, PERSON);
    const ok = repo.saveRecord({ collection: "people", content: { name: "Ada", age: 36 } });
    expect(ok.schema_version).toBe(1);
    expect(() => repo.saveRecord({ collection: "people", content: { age: "x" } })).toThrow(
      ValidationError,
    );
  });

  test("invalid JSON Schema is rejected", () => {
    const repo = freshRepo();
    expect(() => repo.setCollectionSchema("bad", { type: "not-a-type" })).toThrow(ValidationError);
  });

  test("versioned + lazy evolution: old records keep their version, new writes use latest", () => {
    const repo = freshRepo();
    repo.createCollection("people", undefined, PERSON);
    const old = repo.saveRecord({ collection: "people", content: { name: "Ada" } });
    expect(old.schema_version).toBe(1);

    // v2 requires email
    const v2 = repo.setCollectionSchema("people", {
      type: "object",
      required: ["name", "email"],
      properties: { name: { type: "string" }, email: { type: "string" } },
    });
    expect(v2.version).toBe(2);

    // untouched old record still reads, still at v1
    expect(repo.getRecord(old.id)?.schema_version).toBe(1);

    // new save must satisfy v2
    expect(() => repo.saveRecord({ collection: "people", content: { name: "Bob" } })).toThrow(
      ValidationError,
    );
    const fresh = repo.saveRecord({ collection: "people", content: { name: "Bob", email: "b@x" } });
    expect(fresh.schema_version).toBe(2);

    // history of schema versions
    expect(repo.listCollectionSchemas("people").map((s) => s.version)).toEqual([2, 1]);
    expect(repo.getCollectionSchema("people")?.version).toBe(2);
    expect(repo.getCollectionSchema("people", 1)?.version).toBe(1);
  });

  test("migrate_record brings an old record up to the current schema", () => {
    const repo = freshRepo();
    repo.createCollection("people", undefined, PERSON);
    const old = repo.saveRecord({ collection: "people", content: { name: "Ada" } });
    repo.setCollectionSchema("people", {
      type: "object",
      required: ["name", "email"],
      properties: { name: { type: "string" }, email: { type: "string" } },
    });
    // cannot migrate without satisfying the new schema
    expect(() => repo.migrateRecord({ id: old.id })).toThrow(ValidationError);
    const migrated = repo.migrateRecord({ id: old.id, content: { name: "Ada", email: "a@x" } });
    expect(migrated.schema_version).toBe(2);
    expect(migrated.version).toBe(2);
  });

  test("editing an old record must satisfy the current schema", () => {
    const repo = freshRepo();
    repo.createCollection("people", undefined, PERSON);
    const old = repo.saveRecord({ collection: "people", content: { name: "Ada" } });
    repo.setCollectionSchema("people", {
      type: "object",
      required: ["name", "email"],
      properties: { name: { type: "string" }, email: { type: "string" } },
    });
    // a plain update now validates against v2
    expect(() => repo.updateRecord({ id: old.id, status: "verified" })).toThrow(ValidationError);
    const ok = repo.updateRecord({ id: old.id, content: { name: "Ada", email: "a@x" } });
    expect(ok.schema_version).toBe(2);
  });
});
