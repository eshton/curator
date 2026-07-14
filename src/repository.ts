import type { Database } from "bun:sqlite";
import type {
  Collection,
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
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
}

const RECORD_SELECT =
  "SELECT r.id, c.name AS collection, r.content, r.source, r.status, r.tags, " +
  "r.version, r.created_at, r.updated_at, r.created_by, r.updated_by, r.deleted_at " +
  "FROM records r JOIN collections c ON c.id = r.collection_id";

/**
 * Data-access layer for Curator. This is the single choke-point that stamps
 * automatic metadata (timestamps, authorship, version), writes the append-only
 * history, and keeps the full-text index in sync — agents never touch these
 * directly.
 */
export class Repository {
  constructor(private readonly db: Database) {}

  // -- Collections ---------------------------------------------------------

  createCollection(name: string, description?: string): Collection {
    const existing = this.db
      .query("SELECT id FROM collections WHERE name = ?")
      .get(name);
    if (existing) {
      throw new ConflictError(`Collection "${name}" already exists.`);
    }
    const col: Collection = {
      id: newId(),
      name,
      description: description ?? null,
      created_at: nowIso(),
    };
    this.db
      .query(
        "INSERT INTO collections (id, name, description, created_at) VALUES ($id, $name, $description, $created_at)",
      )
      .run({
        $id: col.id,
        $name: col.name,
        $description: col.description,
        $created_at: col.created_at,
      });
    return col;
  }

  /** Return the collection id for `name`, creating the collection if needed. */
  private ensureCollectionId(name: string): string {
    const row = this.db
      .query("SELECT id FROM collections WHERE name = ?")
      .get(name) as { id: string } | null;
    if (row) return row.id;
    const col = this.createCollection(name);
    return col.id;
  }

  listCollections(): (Collection & { record_count: number })[] {
    const rows = this.db
      .query(
        `SELECT c.id, c.name, c.description, c.created_at,
                (SELECT count(*) FROM records r
                   WHERE r.collection_id = c.id AND r.deleted_at IS NULL) AS record_count
         FROM collections c ORDER BY c.name`,
      )
      .all() as (Collection & { record_count: number })[];
    return rows;
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
      const collectionId = this.ensureCollectionId(input.collection);
      this.db
        .query(
          `INSERT INTO records
             (id, collection_id, content, source, status, tags, version,
              created_at, updated_at, created_by, updated_by, deleted_at)
           VALUES ($id, $cid, $content, $source, $status, $tags, 1,
                   $now, $now, $author, $author, NULL)`,
        )
        .run({
          $id: id,
          $cid: collectionId,
          $content: contentJson,
          $source: input.source ?? null,
          $status: status,
          $tags: tagsJson,
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

      this.db
        .query(
          `UPDATE records
             SET content = $content, source = $source, status = $status,
                 tags = $tags, version = $version, updated_at = $now, updated_by = $author
           WHERE id = $id`,
        )
        .run({
          $content: contentJson,
          $source: source,
          $status: status,
          $tags: tagsJson,
          $version: nextVersion,
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
