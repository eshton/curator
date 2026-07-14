import type { Database } from "bun:sqlite";
import { Ajv, type ValidateFunction } from "ajv";
import type {
  Collection,
  CollectionSchemaVersion,
  Comment,
  CuratedRecord,
  HistoryEntry,
  RecordStatus,
} from "./schema.ts";

/** Raised when an operation targets a record/collection that does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Raised on an optimistic-concurrency violation or a duplicate collection. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Raised when content fails validation against its collection's JSON Schema. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

interface RecordRow {
  id: string;
  collection: string;
  content: string;
  source: string | null;
  status: string;
  tags: string;
  version: number;
  schema_version: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
}

const RECORD_SELECT =
  "SELECT r.id, c.name AS collection, r.content, r.source, r.status, r.tags, " +
  "r.version, r.schema_version, r.created_at, r.updated_at, r.created_by, r.updated_by, r.deleted_at " +
  "FROM records r JOIN collections c ON c.id = r.collection_id";

/**
 * Data-access layer for Curator. This is the single choke-point that stamps
 * automatic metadata (timestamps, authorship, version), writes the append-only
 * history, and keeps the full-text index in sync — agents never touch these
 * directly.
 */
export class Repository {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  /** Compiled-validator cache, keyed by `${collectionId}:${version}` (schemas are immutable per version). */
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly db: Database) {}

  // -- Collections ---------------------------------------------------------

  createCollection(name: string, description?: string, schema?: unknown): Collection {
    const existing = this.db
      .query("SELECT id FROM collections WHERE name = ?")
      .get(name);
    if (existing) {
      throw new ConflictError(`Collection "${name}" already exists.`);
    }
    const id = newId();
    this.db
      .query(
        "INSERT INTO collections (id, name, description, created_at) VALUES ($id, $name, $description, $created_at)",
      )
      .run({ $id: id, $name: name, $description: description ?? null, $created_at: nowIso() });
    if (schema !== undefined) {
      this.setCollectionSchema(name, schema);
    }
    return this.getCollection(name)!;
  }

  getCollection(name: string): (Collection & { record_count: number }) | null {
    const row = this.db
      .query(
        `SELECT c.id, c.name, c.description, c.created_at, c.current_schema_version,
                (SELECT count(*) FROM records r
                   WHERE r.collection_id = c.id AND r.deleted_at IS NULL) AS record_count
         FROM collections c WHERE c.name = ?`,
      )
      .get(name) as (Collection & { record_count: number }) | null;
    return row ?? null;
  }

  /** Return the collection id (and current schema version) for `name`, creating it if needed. */
  private ensureCollection(name: string): { id: string; current_schema_version: number | null } {
    const row = this.db
      .query("SELECT id, current_schema_version FROM collections WHERE name = ?")
      .get(name) as { id: string; current_schema_version: number | null } | null;
    if (row) return row;
    this.createCollection(name);
    return this.db
      .query("SELECT id, current_schema_version FROM collections WHERE name = ?")
      .get(name) as { id: string; current_schema_version: number | null };
  }

  listCollections(): (Collection & { record_count: number })[] {
    const rows = this.db
      .query(
        `SELECT c.id, c.name, c.description, c.created_at, c.current_schema_version,
                (SELECT count(*) FROM records r
                   WHERE r.collection_id = c.id AND r.deleted_at IS NULL) AS record_count
         FROM collections c ORDER BY c.name`,
      )
      .all() as (Collection & { record_count: number })[];
    return rows;
  }

  // -- Collection schemas --------------------------------------------------

  /** Attach or evolve a collection's JSON Schema. Appends a new immutable version. */
  setCollectionSchema(
    name: string,
    schema: unknown,
    author?: string,
  ): CollectionSchemaVersion {
    // Reject structurally invalid schemas up-front.
    try {
      this.ajv.compile(schema as object);
    } catch (err) {
      throw new ValidationError(
        `Invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let result!: CollectionSchemaVersion;
    this.db.transaction(() => {
      const col = this.ensureCollection(name);
      const maxRow = this.db
        .query("SELECT COALESCE(MAX(version), 0) AS v FROM collection_schemas WHERE collection_id = ?")
        .get(col.id) as { v: number };
      const version = maxRow.v + 1;
      const entry: CollectionSchemaVersion = {
        id: newId(),
        collection_id: col.id,
        version,
        schema,
        created_at: nowIso(),
        created_by: author ?? null,
      };
      this.db
        .query(
          `INSERT INTO collection_schemas (id, collection_id, version, schema, created_at, created_by)
           VALUES ($id, $cid, $version, $schema, $created_at, $by)`,
        )
        .run({
          $id: entry.id,
          $cid: col.id,
          $version: version,
          $schema: JSON.stringify(schema),
          $created_at: entry.created_at,
          $by: entry.created_by,
        });
      this.db
        .query("UPDATE collections SET current_schema_version = ? WHERE id = ?")
        .run(version, col.id);
      result = entry;
    })();
    return result;
  }

  getCollectionSchema(name: string, version?: number): CollectionSchemaVersion | null {
    const col = this.db
      .query("SELECT id, current_schema_version FROM collections WHERE name = ?")
      .get(name) as { id: string; current_schema_version: number | null } | null;
    if (!col) throw new NotFoundError(`Collection "${name}" not found.`);
    const wanted = version ?? col.current_schema_version;
    if (wanted == null) return null;
    const row = this.db
      .query(
        "SELECT id, collection_id, version, schema, created_at, created_by FROM collection_schemas WHERE collection_id = ? AND version = ?",
      )
      .get(col.id, wanted) as
      | { id: string; collection_id: string; version: number; schema: string; created_at: string; created_by: string | null }
      | null;
    return row ? { ...row, schema: safeParse(row.schema) } : null;
  }

  listCollectionSchemas(name: string): CollectionSchemaVersion[] {
    const col = this.db.query("SELECT id FROM collections WHERE name = ?").get(name) as
      | { id: string }
      | null;
    if (!col) throw new NotFoundError(`Collection "${name}" not found.`);
    const rows = this.db
      .query(
        "SELECT id, collection_id, version, schema, created_at, created_by FROM collection_schemas WHERE collection_id = ? ORDER BY version DESC",
      )
      .all(col.id) as {
      id: string;
      collection_id: string;
      version: number;
      schema: string;
      created_at: string;
      created_by: string | null;
    }[];
    return rows.map((r) => ({ ...r, schema: safeParse(r.schema) }));
  }

  /**
   * Validate `content` against a collection's schema version. No-op (returns
   * null) if the version is null (schemaless). Throws ValidationError on
   * failure. Returns the schema version the content was validated against.
   */
  private validateContent(
    collectionId: string,
    schemaVersion: number | null,
    content: unknown,
  ): number | null {
    if (schemaVersion == null) return null;
    const key = `${collectionId}:${schemaVersion}`;
    let validate = this.validators.get(key);
    if (!validate) {
      const row = this.db
        .query("SELECT schema FROM collection_schemas WHERE collection_id = ? AND version = ?")
        .get(collectionId, schemaVersion) as { schema: string } | null;
      if (!row) return schemaVersion; // schema row missing; do not block writes
      validate = this.ajv.compile(safeParse(row.schema) as object);
      this.validators.set(key, validate);
    }
    if (!validate(content)) {
      const details = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
        .join("; ");
      throw new ValidationError(
        `Content does not match schema v${schemaVersion} for this collection: ${details}`,
      );
    }
    return schemaVersion;
  }

  // -- Records -------------------------------------------------------------

  saveRecord(input: {
    collection: string;
    content: unknown;
    source?: string;
    status?: RecordStatus;
    tags?: string[];
    author?: string;
  }): CuratedRecord {
    const now = nowIso();
    const id = newId();
    const status: RecordStatus = input.status ?? "draft";
    const tags = input.tags ?? [];
    const author = input.author ?? null;
    const contentJson = JSON.stringify(input.content ?? null);
    const tagsJson = JSON.stringify(tags);

    const tx = this.db.transaction(() => {
      const col = this.ensureCollection(input.collection);
      const schemaVersion = this.validateContent(
        col.id,
        col.current_schema_version,
        input.content ?? null,
      );
      this.db
        .query(
          `INSERT INTO records
             (id, collection_id, content, source, status, tags, version, schema_version,
              created_at, updated_at, created_by, updated_by, deleted_at)
           VALUES ($id, $cid, $content, $source, $status, $tags, 1, $schema_version,
                   $now, $now, $author, $author, NULL)`,
        )
        .run({
          $id: id,
          $cid: col.id,
          $content: contentJson,
          $source: input.source ?? null,
          $status: status,
          $tags: tagsJson,
          $schema_version: schemaVersion,
          $now: now,
          $author: author,
        });
      this.writeHistory(id, 1, contentJson, input.source ?? null, status, tagsJson, author, now);
      this.ftsIndex(id, contentJson, input.source ?? null, tagsJson);
    });
    tx();
    return this.getRecord(id)!;
  }

  getRecord(id: string): CuratedRecord | null {
    const row = this.db.query(`${RECORD_SELECT} WHERE r.id = ?`).get(id) as
      | RecordRow
      | null;
    return row ? mapRecord(row) : null;
  }

  updateRecord(input: {
    id: string;
    content?: unknown;
    source?: string;
    status?: RecordStatus;
    tags?: string[];
    author?: string;
    expected_version?: number;
  }): CuratedRecord {
    const now = nowIso();
    const author = input.author ?? null;

    const tx = this.db.transaction(() => {
      const current = this.getRecord(input.id);
      if (!current) throw new NotFoundError(`Record "${input.id}" not found.`);
      if (current.deleted_at) {
        throw new ConflictError(`Record "${input.id}" is deleted and cannot be updated.`);
      }
      if (
        input.expected_version !== undefined &&
        input.expected_version !== current.version
      ) {
        throw new ConflictError(
          `Version conflict on "${input.id}": expected ${input.expected_version} but current is ${current.version}. Re-read the record and retry.`,
        );
      }

      const content = input.content !== undefined ? input.content : current.content;
      const source = input.source !== undefined ? input.source : current.source;
      const status = input.status ?? current.status;
      const tags = input.tags ?? current.tags;
      const nextVersion = current.version + 1;
      const contentJson = JSON.stringify(content ?? null);
      const tagsJson = JSON.stringify(tags);

      // A write validates against the collection's CURRENT schema and re-stamps
      // the record to that version (lazy migration: untouched records keep their
      // old version; editing brings a record up to the latest schema).
      const col = this.ensureCollection(current.collection);
      const schemaVersion = this.validateContent(col.id, col.current_schema_version, content);

      this.db
        .query(
          `UPDATE records
             SET content = $content, source = $source, status = $status,
                 tags = $tags, version = $version, schema_version = $schema_version,
                 updated_at = $now, updated_by = $author
           WHERE id = $id`,
        )
        .run({
          $content: contentJson,
          $source: source,
          $status: status,
          $tags: tagsJson,
          $version: nextVersion,
          $schema_version: schemaVersion,
          $now: now,
          $author: author,
          $id: input.id,
        });
      this.writeHistory(input.id, nextVersion, contentJson, source, status, tagsJson, author, now);
      this.ftsIndex(input.id, contentJson, source, tagsJson);
    });
    tx();
    return this.getRecord(input.id)!;
  }

  /**
   * Bring a record up to its collection's current schema version (lazy
   * migration, on demand). Optionally replace content; then validate against
   * the latest schema and re-stamp `schema_version`. Throws ValidationError if
   * the (new or existing) content does not satisfy the current schema.
   */
  migrateRecord(input: { id: string; content?: unknown; author?: string }): CuratedRecord {
    this.db.transaction(() => {
      const current = this.getRecord(input.id);
      if (!current) throw new NotFoundError(`Record "${input.id}" not found.`);
      if (current.deleted_at) {
        throw new ConflictError(`Record "${input.id}" is deleted and cannot be migrated.`);
      }
      const col = this.ensureCollection(current.collection);
      const content = input.content !== undefined ? input.content : current.content;
      const schemaVersion = this.validateContent(col.id, col.current_schema_version, content);

      const contentChanged = input.content !== undefined;
      const schemaChanged = schemaVersion !== current.schema_version;
      if (!contentChanged && !schemaChanged) return; // already current, nothing to do

      const now = nowIso();
      const nextVersion = current.version + 1;
      const contentJson = JSON.stringify(content ?? null);
      const tagsJson = JSON.stringify(current.tags);
      this.db
        .query(
          `UPDATE records SET content = $content, schema_version = $schema_version,
             version = $version, updated_at = $now, updated_by = $author WHERE id = $id`,
        )
        .run({
          $content: contentJson,
          $schema_version: schemaVersion,
          $version: nextVersion,
          $now: now,
          $author: input.author ?? null,
          $id: input.id,
        });
      this.writeHistory(
        input.id,
        nextVersion,
        contentJson,
        current.source,
        current.status,
        tagsJson,
        input.author ?? null,
        now,
      );
      this.ftsIndex(input.id, contentJson, current.source, tagsJson);
    })();
    return this.getRecord(input.id)!;
  }

  searchRecords(input: {
    query?: string;
    collection?: string;
    status?: RecordStatus;
    tag?: string;
    include_deleted?: boolean;
    limit?: number;
    offset?: number;
  }): CuratedRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    let from = RECORD_SELECT;

    if (input.query) {
      from += " JOIN records_fts ON records_fts.record_id = r.id";
      where.push("records_fts MATCH ?");
      params.push(ftsQuery(input.query));
    }
    if (!input.include_deleted) where.push("r.deleted_at IS NULL");
    if (input.collection) {
      where.push("c.name = ?");
      params.push(input.collection);
    }
    if (input.status) {
      where.push("r.status = ?");
      params.push(input.status);
    }
    if (input.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = ?)");
      params.push(input.tag);
    }

    let sql = from;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += input.query ? " ORDER BY rank" : " ORDER BY r.updated_at DESC";
    sql += " LIMIT ? OFFSET ?";
    params.push(input.limit ?? 50, input.offset ?? 0);

    const rows = this.db.query(sql).all(...(params as never[])) as RecordRow[];
    return rows.map(mapRecord);
  }

  deleteRecord(input: { id: string; author?: string; hard?: boolean }): {
    id: string;
    deleted: true;
    hard: boolean;
  } {
    const tx = this.db.transaction(() => {
      const current = this.getRecord(input.id);
      if (!current) throw new NotFoundError(`Record "${input.id}" not found.`);

      if (input.hard) {
        this.db.query("DELETE FROM record_history WHERE record_id = ?").run(input.id);
        this.db.query("DELETE FROM records_fts WHERE record_id = ?").run(input.id);
        // comments cascade via FK
        this.db.query("DELETE FROM records WHERE id = ?").run(input.id);
      } else {
        const now = nowIso();
        const nextVersion = current.version + 1;
        this.db
          .query(
            "UPDATE records SET deleted_at = $now, version = $version, updated_at = $now, updated_by = $author WHERE id = $id",
          )
          .run({
            $now: now,
            $version: nextVersion,
            $author: input.author ?? null,
            $id: input.id,
          });
        this.writeHistory(
          input.id,
          nextVersion,
          JSON.stringify(current.content ?? null),
          current.source,
          current.status,
          JSON.stringify(current.tags),
          input.author ?? null,
          now,
        );
      }
    });
    tx();
    return { id: input.id, deleted: true, hard: input.hard ?? false };
  }

  // -- Comments ------------------------------------------------------------

  addComment(input: { record_id: string; body: string; author?: string }): Comment {
    const rec = this.db
      .query("SELECT id FROM records WHERE id = ?")
      .get(input.record_id);
    if (!rec) throw new NotFoundError(`Record "${input.record_id}" not found.`);
    const comment: Comment = {
      id: newId(),
      record_id: input.record_id,
      author: input.author ?? null,
      body: input.body,
      created_at: nowIso(),
    };
    this.db
      .query(
        "INSERT INTO comments (id, record_id, author, body, created_at) VALUES ($id, $rid, $author, $body, $created_at)",
      )
      .run({
        $id: comment.id,
        $rid: comment.record_id,
        $author: comment.author,
        $body: comment.body,
        $created_at: comment.created_at,
      });
    return comment;
  }

  listComments(recordId: string): Comment[] {
    return this.db
      .query(
        "SELECT id, record_id, author, body, created_at FROM comments WHERE record_id = ? ORDER BY created_at ASC",
      )
      .all(recordId) as Comment[];
  }

  // -- History -------------------------------------------------------------

  getHistory(recordId: string, limit = 50): HistoryEntry[] {
    const rows = this.db
      .query(
        "SELECT id, record_id, version, content, source, status, tags, changed_by, changed_at " +
          "FROM record_history WHERE record_id = ? ORDER BY version DESC LIMIT ?",
      )
      .all(recordId, limit) as {
      id: string;
      record_id: string;
      version: number;
      content: string;
      source: string | null;
      status: string;
      tags: string;
      changed_by: string | null;
      changed_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      record_id: r.record_id,
      version: r.version,
      content: safeParse(r.content),
      source: r.source,
      status: r.status as RecordStatus,
      tags: safeParse(r.tags) as string[],
      changed_by: r.changed_by,
      changed_at: r.changed_at,
    }));
  }

  // -- Internal helpers ----------------------------------------------------

  private writeHistory(
    recordId: string,
    version: number,
    contentJson: string,
    source: string | null,
    status: RecordStatus,
    tagsJson: string,
    changedBy: string | null,
    changedAt: string,
  ): void {
    this.db
      .query(
        `INSERT INTO record_history
           (id, record_id, version, content, source, status, tags, changed_by, changed_at)
         VALUES ($id, $rid, $version, $content, $source, $status, $tags, $by, $at)`,
      )
      .run({
        $id: newId(),
        $rid: recordId,
        $version: version,
        $content: contentJson,
        $source: source,
        $status: status,
        $tags: tagsJson,
        $by: changedBy,
        $at: changedAt,
      });
  }

  /** Replace the FTS entry for a record (standalone index, kept in sync here). */
  private ftsIndex(
    recordId: string,
    contentJson: string,
    source: string | null,
    tagsJson: string,
  ): void {
    this.db.query("DELETE FROM records_fts WHERE record_id = ?").run(recordId);
    this.db
      .query(
        "INSERT INTO records_fts (record_id, content, source, tags) VALUES ($rid, $content, $source, $tags)",
      )
      .run({
        $rid: recordId,
        $content: contentJson,
        $source: source ?? "",
        $tags: (safeParse(tagsJson) as string[]).join(" "),
      });
  }
}

function mapRecord(row: RecordRow): CuratedRecord {
  return {
    id: row.id,
    collection: row.collection,
    content: safeParse(row.content),
    source: row.source,
    status: row.status as RecordStatus,
    tags: safeParse(row.tags) as string[],
    version: row.version,
    schema_version: row.schema_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    deleted_at: row.deleted_at,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/**
 * Turn free user text into a safe FTS5 MATCH expression. We wrap each
 * whitespace-delimited term in double quotes (escaping embedded quotes) so
 * punctuation in the query can't produce an FTS syntax error or be abused.
 */
function ftsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" ") : '""';
}
