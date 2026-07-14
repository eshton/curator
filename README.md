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
  "created_at": "…", "updated_at": "…",
  "created_by": "agent-a", "updated_by": "agent-a",
  "deleted_at": null
}
```

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
