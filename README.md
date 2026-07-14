# curator

A **privacy-first, agent-first** local store for **curated data**, exposed over the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io).

Agents pull data from the web, files, or databases and save it into Curator as **records**.
Every record automatically tracks its **source, creation/update timestamps, authorship, a
version number, and an append-only history** — plus **comments** for collaboration. You run
one local daemon; any number of agents on the same machine connect to it as MCP clients and
collaborate through the shared store.

- **Local & private by design** — binds to `127.0.0.1` only, validates the `Origin` header
  (DNS-rebinding defence), stores everything in a single SQLite file, and never phones home.
- **Agent-first** — a clean MCP tool surface for saving, searching, updating, commenting on,
  and inspecting the history of curated records.
- **Metadata is automatic** — agents supply data; Curator manages provenance and versioning.
- **Optional per-collection schemas** — attach a JSON Schema to a collection and records are
  validated on write. Schemas are versioned and evolvable (see below).
- **Built-in web UI** — browse, search, edit, comment on, and manage curated data and schemas
  from the browser at `http://127.0.0.1:3737/`.

## Requirements

[Bun](https://bun.com) ≥ 1.3. Only the machine running the daemon needs Bun — connecting
agents just need any HTTP-capable MCP client.

## Install & run

```bash
bun install
bun run src/index.ts start        # or, once published: bunx curator start
```

`start` launches a background daemon that owns `~/.curator/curator.db` and serves MCP at
`http://127.0.0.1:3737/mcp`. It prints a ready-to-paste client config.

```
curator start [--foreground] [--port <n>] [--db <path>] [--token <t>]
curator stop
curator status
curator restart
curator mcp-config          # print the MCP client config snippet
```

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| State directory | `--home` | `CURATOR_HOME` | `~/.curator` |
| Database file | `--db` | `CURATOR_DB` | `~/.curator/curator.db` |
| Port | `--port` | `CURATOR_PORT` | `3737` |
| Bearer token | `--token` | `CURATOR_TOKEN` | none (off) |

## Connecting an agent

Point your MCP client at the daemon's HTTP endpoint:

```json
{
  "mcpServers": {
    "curator": { "type": "http", "url": "http://127.0.0.1:3737/mcp" }
  }
}
```

If you started the daemon with a token, `curator mcp-config` includes the required
`Authorization: Bearer <token>` header for you.

## Tools

| Tool | Purpose |
| --- | --- |
| `create_collection` | Create a named collection (also auto-created on first save). |
| `list_collections` | List collections with live record counts. |
| `save_record` | Save a curated record (`content` is any JSON value). Stamps id/timestamps/author/version. |
| `get_record` | Fetch a record with all managed metadata. |
| `update_record` | Update fields; bumps version and writes history. Supports `expected_version` for optimistic concurrency. |
| `search_records` | Full-text search (SQLite FTS5) plus filters by collection, status, and tag. |
| `delete_record` | Soft-delete (recoverable, keeps history) or `hard` delete. |
| `add_comment` / `list_comments` | Collaborate with review notes on a record. |
| `get_history` | Inspect the append-only version history of a record. |
| `create_collection` | May take an optional JSON Schema. |
| `set_collection_schema` | Attach or evolve a collection's JSON Schema (appends a new version). |
| `get_collection_schema` | Fetch the current (or a specific) schema version, plus the version list. |
| `migrate_record` | Bring a record up to the collection's current schema version. |

### Record shape

```jsonc
{
  "id": "uuid",
  "collection": "papers",
  "content": { /* your curated data — any JSON */ },
  "source": "https://…",         // provenance
  "status": "draft",              // draft | verified | rejected
  "tags": ["ml", "nlp"],
  "version": 1,
  "schema_version": 1,           // collection schema version validated against (null if schemaless)
  "created_at": "…", "updated_at": "…",
  "created_by": "agent-a", "updated_by": "agent-a",
  "deleted_at": null
}
```

## Schemas & evolution

A collection may carry an **optional JSON Schema**. If it does, `save_record` and
`update_record` reject content that doesn't validate; collections without a schema stay
free-form. Schemas are **versioned and append-only**: `set_collection_schema` adds a new
version and makes it current, so evolving a schema never rewrites history.

Existing records are handled **lazily**: each record is stamped with the `schema_version` it
was written against and keeps validating against that version — an untouched old record is
never retroactively invalidated. Writes (save/update) validate against the *current* version;
`migrate_record` brings an old record up to the latest schema on demand (optionally supplying
replacement content to satisfy new requirements).

## Web UI

The daemon serves an interactive UI at `http://127.0.0.1:<port>/` (same process, same
loopback/Origin security). Browse collections, full-text search, create/edit records, change
status and tags, add comments, view version history, soft/hard delete, and create or evolve
collection schemas. It's a single self-contained page backed by a read/write `/api/*` JSON
layer over the same store. If the daemon was started with `--token`, the UI prompts for it and
remembers it locally.

## Collaboration & concurrency

The daemon is the **single owner** of the SQLite file, so there is no cross-process write
contention. Multiple agents are simply concurrent HTTP clients. When two agents may edit the
same record, pass `expected_version` on `update_record`: if it no longer matches, the update
is rejected instead of silently overwriting a concurrent edit.

Provide an `author` (your agent id) on writes so contributions are attributable. Note that
authorship is recorded for **transparency**, not authentication — it is not a security
boundary in this version.

## Development

```bash
bun test              # unit + HTTP MCP integration tests
bun run typecheck     # tsc --noEmit
bun run dev           # run the daemon in the foreground
bun run build         # compile a standalone binary to dist/curator
```

## Security posture (v1)

Loopback-only binding, `Origin` validation, an optional shared bearer token, no telemetry,
no outbound network. Encryption-at-rest, enforced per-agent access control, and
networked/multi-user operation are intentionally out of scope for this version.

## License

MIT
