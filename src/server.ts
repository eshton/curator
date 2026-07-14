import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Repository, ConflictError, NotFoundError } from "./repository.ts";
import {
  addCommentShape,
  createCollectionShape,
  deleteRecordShape,
  getHistoryShape,
  getRecordShape,
  listCommentsShape,
  listCollectionsShape,
  saveRecordShape,
  searchRecordsShape,
  updateRecordShape,
} from "./schema.ts";

/** Package version, surfaced to MCP clients on initialize. */
export const CURATOR_VERSION = "0.1.0";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a tool handler so domain errors become clean, agent-legible MCP tool
 * errors instead of transport-level exceptions.
 */
function guard<T>(fn: (args: T) => unknown): (args: T) => CallToolResult {
  return (args: T) => {
    try {
      return ok(fn(args));
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ConflictError) {
        return fail(`${err.name}: ${err.message}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Error: ${message}`);
    }
  };
}

/**
 * Build an MCP server exposing Curator's data-curation tools, backed by the
 * given repository. Transport-agnostic — the caller connects a transport.
 */
export function createMcpServer(repo: Repository): McpServer {
  const server = new McpServer(
    { name: "curator", version: CURATOR_VERSION },
    {
      instructions:
        "Curator is a shared, local, privacy-first store for curated data. " +
        "Save findings as records inside named collections; every record automatically " +
        "tracks source, creation/update timestamps, authorship, a version number and an " +
        "append-only history. Use collaboratively: leave comments, search existing records " +
        "before adding duplicates, and pass `expected_version` on update to avoid clobbering " +
        "a concurrent edit. Provide `author` (your agent id) so collaboration is attributable.",
    },
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description:
        "Create a named collection (namespace/topic) to group curated records. Collections are also created automatically on first save_record.",
      inputSchema: createCollectionShape,
    },
    guard((a) => repo.createCollection(a.name, a.description)),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "List all collections with their live (non-deleted) record counts.",
      inputSchema: listCollectionsShape,
      annotations: { readOnlyHint: true },
    },
    guard(() => ({ collections: repo.listCollections() })),
  );

  server.registerTool(
    "save_record",
    {
      title: "Save curated record",
      description:
        "Save a new curated record. `content` is any JSON-serialisable value. Metadata (id, timestamps, author, version=1) is stamped automatically. The collection is created if it does not exist.",
      inputSchema: saveRecordShape,
    },
    guard((a) =>
      repo.saveRecord({
        collection: a.collection,
        content: a.content,
        source: a.source,
        status: a.status,
        tags: a.tags,
        author: a.author,
      }),
    ),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get record",
      description: "Fetch a single record by id, including all managed metadata.",
      inputSchema: getRecordShape,
      annotations: { readOnlyHint: true },
    },
    guard((a) => {
      const rec = repo.getRecord(a.id);
      if (!rec) throw new NotFoundError(`Record "${a.id}" not found.`);
      return rec;
    }),
  );

  server.registerTool(
    "update_record",
    {
      title: "Update record",
      description:
        "Update fields of a record. Only provided fields change. Bumps the version, refreshes updated_at/updated_by and appends to history. Pass `expected_version` for optimistic concurrency: if it does not match, the update is rejected instead of overwriting a concurrent edit.",
      inputSchema: updateRecordShape,
    },
    guard((a) =>
      repo.updateRecord({
        id: a.id,
        content: a.content,
        source: a.source,
        status: a.status,
        tags: a.tags,
        author: a.author,
        expected_version: a.expected_version,
      }),
    ),
  );

  server.registerTool(
    "search_records",
    {
      title: "Search records",
      description:
        "Search records with optional full-text `query` (matches content and source), and optional filters by collection, status and tag. Excludes soft-deleted records unless include_deleted is true.",
      inputSchema: searchRecordsShape,
      annotations: { readOnlyHint: true },
    },
    guard((a) => ({
      results: repo.searchRecords({
        query: a.query,
        collection: a.collection,
        status: a.status,
        tag: a.tag,
        include_deleted: a.include_deleted,
        limit: a.limit,
        offset: a.offset,
      }),
    })),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete record",
      description:
        "Soft-delete a record by default (recoverable, retains history). Set `hard` to permanently remove the record, its comments and history.",
      inputSchema: deleteRecordShape,
      annotations: { destructiveHint: true },
    },
    guard((a) => repo.deleteRecord({ id: a.id, author: a.author, hard: a.hard })),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Attach a comment to a record for collaboration and review notes.",
      inputSchema: addCommentShape,
    },
    guard((a) => repo.addComment({ record_id: a.record_id, body: a.body, author: a.author })),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "List all comments on a record in chronological order.",
      inputSchema: listCommentsShape,
      annotations: { readOnlyHint: true },
    },
    guard((a) => ({ comments: repo.listComments(a.record_id) })),
  );

  server.registerTool(
    "get_history",
    {
      title: "Get record history",
      description:
        "Return the append-only version history of a record (newest first) for provenance and conflict inspection.",
      inputSchema: getHistoryShape,
      annotations: { readOnlyHint: true },
    },
    guard((a) => ({ history: repo.getHistory(a.record_id, a.limit) })),
  );

  return server;
}
