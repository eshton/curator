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
const SCHEMA_VERSION = 1;

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
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    })();
    version = SCHEMA_VERSION;
  }
}
