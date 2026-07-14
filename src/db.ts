import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open (creating if needed) the Curator SQLite database and bring its schema
 * up to date.
 *
 * Concurrency: the daemon is the single owner of this file, so there is no
 * cross-process write contention. WAL mode plus a busy timeout still guard
 * against the WAL checkpointer and any incidental second connection.
 */
export function openDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");

  migrate(db);
  return db;
}

/** Current target schema version. Bump when adding a migration step. */
const SCHEMA_VERSION = 3;

function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version;").get() as { user_version: number };
  let version = row.user_version;

  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE collections (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          description TEXT,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE records (
          id           TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          content      TEXT NOT NULL,           -- JSON
          source       TEXT,
          status       TEXT NOT NULL DEFAULT 'draft',
          tags         TEXT NOT NULL DEFAULT '[]', -- JSON array
          version      INTEGER NOT NULL DEFAULT 1,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          created_by   TEXT,
          updated_by   TEXT,
          deleted_at   TEXT
        );
        CREATE INDEX idx_records_collection ON records(collection_id);
        CREATE INDEX idx_records_status     ON records(status);
        CREATE INDEX idx_records_deleted    ON records(deleted_at);

        CREATE TABLE comments (
          id         TEXT PRIMARY KEY,
          record_id  TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          author     TEXT,
          body       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_comments_record ON comments(record_id);

        CREATE TABLE record_history (
          id         TEXT PRIMARY KEY,
          record_id  TEXT NOT NULL,
          version    INTEGER NOT NULL,
          content    TEXT NOT NULL,
          source     TEXT,
          status     TEXT NOT NULL,
          tags       TEXT NOT NULL DEFAULT '[]',
          changed_by TEXT,
          changed_at TEXT NOT NULL
        );
        CREATE INDEX idx_history_record ON record_history(record_id);

        -- Standalone FTS5 index kept in sync by the repository layer.
        CREATE VIRTUAL TABLE records_fts USING fts5(
          record_id UNINDEXED,
          content,
          source,
          tags
        );

        -- Defence-in-depth: stamp updated_at even if a write bypasses the
        -- repository layer. The repository is the primary source of truth.
        CREATE TRIGGER trg_records_updated_at
        AFTER UPDATE ON records
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE records SET updated_at = datetime('now') WHERE id = NEW.id;
        END;
      `);
      db.exec(`PRAGMA user_version = 1;`);
    })();
    version = 1;
  }

  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        -- Optional, versioned JSON Schema per collection. Append-only: each
        -- change inserts a new row with an incremented version, mirroring how
        -- record_history preserves record versions.
        CREATE TABLE collection_schemas (
          id            TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          version       INTEGER NOT NULL,
          schema        TEXT NOT NULL,        -- JSON Schema document
          created_at    TEXT NOT NULL,
          created_by    TEXT,
          UNIQUE(collection_id, version)
        );
        CREATE INDEX idx_collection_schemas_collection ON collection_schemas(collection_id);

        -- Active schema version for the collection (NULL = schemaless / free-form).
        ALTER TABLE collections ADD COLUMN current_schema_version INTEGER;

        -- The collection schema version each record was validated against at
        -- write time (NULL = written while the collection was schemaless).
        ALTER TABLE records ADD COLUMN schema_version INTEGER;
      `);
      db.exec(`PRAGMA user_version = 2;`);
    })();
    version = 2;
  }

  if (version < 3) {
    db.transaction(() => {
      db.exec(`
        -- Directed, typed links between records. Because links reference record
        -- ids only, they cross collections ("entity types") freely. Cascades
        -- when either endpoint is hard-deleted.
        CREATE TABLE record_links (
          id             TEXT PRIMARY KEY,
          from_record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          to_record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          rel            TEXT NOT NULL DEFAULT 'related',
          note           TEXT,
          created_at     TEXT NOT NULL,
          created_by     TEXT,
          UNIQUE(from_record_id, to_record_id, rel)
        );
        CREATE INDEX idx_links_from ON record_links(from_record_id);
        CREATE INDEX idx_links_to   ON record_links(to_record_id);
      `);
      db.exec(`PRAGMA user_version = 3;`);
    })();
    version = 3;
  }
}
