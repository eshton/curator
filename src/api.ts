import { z } from "zod";
import { Repository, ConflictError, NotFoundError, ValidationError } from "./repository.ts";
import {
  addCommentShape,
  createCollectionShape,
  linkRecordsShape,
  listLinksShape,
  saveRecordShape,
  searchRecordsShape,
  setCollectionSchemaShape,
  updateRecordShape,
} from "./schema.ts";

/**
 * Read/write JSON REST layer over the Repository, used by the web UI. It is a
 * thin adapter: the Repository remains the single source of truth for metadata
 * and schema enforcement. Domain errors map to appropriate HTTP status codes.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof NotFoundError) return jsonResponse({ error: err.message }, 404);
  if (err instanceof ConflictError) return jsonResponse({ error: err.message }, 409);
  if (err instanceof ValidationError) return jsonResponse({ error: err.message }, 400);
  if (err instanceof z.ZodError) {
    return jsonResponse({ error: "Invalid request", issues: err.issues }, 400);
  }
  return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
}

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Handle a request whose path begins with `/api`. Returns a JSON Response.
 * `segments` are the decoded path parts after `/api` (e.g. ["records", "<id>"]).
 */
export async function handleApiRequest(req: Request, repo: Repository): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const method = req.method.toUpperCase();

  try {
    // /api/collections ...
    if (segments[0] === "collections") {
      if (segments.length === 1) {
        if (method === "GET") return jsonResponse({ collections: repo.listCollections() });
        if (method === "POST") {
          const a = z.object(createCollectionShape).parse(await body(req));
          return jsonResponse(repo.createCollection(a.name, a.description, a.schema), 201);
        }
      }
      // /api/collections/:name/schema
      if (segments.length === 3 && segments[2] === "schema") {
        const name = segments[1]!;
        if (method === "GET") {
          const version = url.searchParams.get("version");
          return jsonResponse({
            current: repo.getCollectionSchema(name, version ? Number(version) : undefined),
            versions: repo.listCollectionSchemas(name).map((s) => s.version),
          });
        }
        if (method === "PUT" || method === "POST") {
          const a = z.object(setCollectionSchemaShape).parse({ ...(await body(req) as object), collection: name });
          return jsonResponse(repo.setCollectionSchema(a.collection, a.schema, a.author), 201);
        }
      }
    }

    // /api/records ...
    if (segments[0] === "records") {
      if (segments.length === 1) {
        if (method === "GET") {
          const q = url.searchParams;
          const args = searchRecordsSchema.parse({
            query: q.get("query") ?? undefined,
            collection: q.get("collection") ?? undefined,
            status: q.get("status") ?? undefined,
            tag: q.get("tag") ?? undefined,
            include_deleted: q.get("include_deleted") === "true" ? true : undefined,
            limit: q.get("limit") ? Number(q.get("limit")) : undefined,
            offset: q.get("offset") ? Number(q.get("offset")) : undefined,
          });
          return jsonResponse({ results: repo.searchRecords(args) });
        }
        if (method === "POST") {
          const a = z.object(saveRecordShape).parse(await body(req));
          return jsonResponse(repo.saveRecord(a), 201);
        }
      }
      if (segments.length === 2) {
        const id = segments[1]!;
        if (method === "GET") {
          const rec = repo.getRecord(id);
          if (!rec) throw new NotFoundError(`Record "${id}" not found.`);
          return jsonResponse(rec);
        }
        if (method === "PATCH") {
          const a = z.object(updateRecordShape).parse({ ...(await body(req) as object), id });
          return jsonResponse(repo.updateRecord(a));
        }
        if (method === "DELETE") {
          return jsonResponse(
            repo.deleteRecord({
              id,
              hard: url.searchParams.get("hard") === "true",
              author: url.searchParams.get("author") ?? undefined,
            }),
          );
        }
      }
      if (segments.length === 3 && segments[1]) {
        const id = segments[1];
        if (segments[2] === "migrate" && method === "POST") {
          const b = (await body(req)) as { content?: unknown; author?: string };
          return jsonResponse(repo.migrateRecord({ id, content: b.content, author: b.author }));
        }
        if (segments[2] === "comments") {
          if (method === "GET") return jsonResponse({ comments: repo.listComments(id) });
          if (method === "POST") {
            const a = z.object(addCommentShape).parse({ ...(await body(req) as object), record_id: id });
            return jsonResponse(repo.addComment(a), 201);
          }
        }
        if (segments[2] === "history" && method === "GET") {
          const limit = url.searchParams.get("limit");
          return jsonResponse({ history: repo.getHistory(id, limit ? Number(limit) : undefined) });
        }
        if (segments[2] === "links") {
          if (method === "GET") {
            const { direction, rel } = z
              .object(listLinksShape)
              .parse({
                record_id: id,
                direction: url.searchParams.get("direction") ?? undefined,
                rel: url.searchParams.get("rel") ?? undefined,
              });
            return jsonResponse({ links: repo.listLinks(id, { direction, rel }) });
          }
          if (method === "POST") {
            const a = z.object(linkRecordsShape).parse({ ...(await body(req) as object), from_id: id });
            return jsonResponse(
              repo.linkRecords({ from_id: a.from_id, to_id: a.to_id, rel: a.rel, note: a.note, author: a.author }),
              201,
            );
          }
          if (method === "DELETE") {
            const to = url.searchParams.get("to");
            if (!to) return jsonResponse({ error: "Missing 'to' query parameter" }, 400);
            return jsonResponse(
              repo.unlinkRecords({ from_id: id, to_id: to, rel: url.searchParams.get("rel") ?? undefined }),
            );
          }
        }
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

const searchRecordsSchema = z.object(searchRecordsShape);
