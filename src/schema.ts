import { z } from "zod";

/**
 * Domain types and Zod validation shapes for Curator.
 *
 * The Zod "raw shapes" (plain objects of field -> ZodType) are consumed
 * directly by `McpServer.registerTool({ inputSchema })`, giving every tool
 * strict, self-describing input validation for free.
 */

// ---------------------------------------------------------------------------
// Field-level building blocks
// ---------------------------------------------------------------------------

export const RECORD_STATUSES = ["draft", "verified", "rejected"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Arbitrary JSON-serialisable curated payload. Stored as JSON text. */
export const contentSchema = z
  .unknown()
  .describe("The curated data itself. Any JSON-serialisable value.");

const tagsSchema = z
  .array(z.string().min(1).max(120))
  .max(64)
  .describe("Free-form labels for filtering and organisation.");

const sourceSchema = z
  .string()
  .max(2048)
  .describe(
    "Provenance of the data: a URL, file path, database reference, or note on where it came from.",
  );

const authorSchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Identifier of the agent or person performing the action. Recorded for collaboration transparency; not an authentication boundary.",
  );

// ---------------------------------------------------------------------------
// Domain row types (as stored / returned)
// ---------------------------------------------------------------------------

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  /** Active JSON Schema version, or null if the collection is free-form. */
  current_schema_version: number | null;
}

/** One append-only version of a collection's JSON Schema. */
export interface CollectionSchemaVersion {
  id: string;
  collection_id: string;
  version: number;
  schema: unknown;
  created_at: string;
  created_by: string | null;
}

export interface CuratedRecord {
  id: string;
  collection: string;
  content: unknown;
  source: string | null;
  status: RecordStatus;
  tags: string[];
  version: number;
  schema_version: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
}

export interface Comment {
  id: string;
  record_id: string;
  author: string | null;
  body: string;
  created_at: string;
}

export interface RecordLink {
  id: string;
  from_record_id: string;
  to_record_id: string;
  rel: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

/** A link as seen from one record's perspective, with the other record inlined. */
export interface LinkView {
  link_id: string;
  rel: string;
  /** "out" = this record -> record; "in" = record -> this record. */
  direction: "out" | "in";
  note: string | null;
  created_at: string;
  created_by: string | null;
  record: CuratedRecord;
}

export interface HistoryEntry {
  id: string;
  record_id: string;
  version: number;
  content: unknown;
  source: string | null;
  status: RecordStatus;
  tags: string[];
  changed_by: string | null;
  changed_at: string;
}

// ---------------------------------------------------------------------------
// Tool input shapes (ZodRawShape objects consumed by registerTool)
// ---------------------------------------------------------------------------

/** A JSON Schema document (an object). Structural validity is checked at runtime by Ajv. */
export const jsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "A JSON Schema document describing the shape records in this collection must satisfy.",
  );

export const createCollectionShape = {
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Collection names may contain letters, numbers, dot, underscore and hyphen.",
    )
    .describe("Unique name for the collection (namespace/topic)."),
  description: z.string().max(2000).optional(),
  schema: jsonSchemaSchema
    .optional()
    .describe("Optional JSON Schema. If given, records saved here must validate against it."),
} as const;

export const listCollectionsShape = {} as const;

export const setCollectionSchemaShape = {
  collection: z.string().min(1).max(120).describe("Collection to attach/evolve the schema on."),
  schema: jsonSchemaSchema,
  author: authorSchema.optional(),
} as const;

export const getCollectionSchemaShape = {
  collection: z.string().min(1).max(120),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Specific schema version to fetch. Defaults to the current version."),
} as const;

export const migrateRecordShape = {
  id: z.string().min(1),
  content: contentSchema
    .optional()
    .describe("Replacement content. Omit to re-validate the existing content against the latest schema."),
  author: authorSchema.optional(),
} as const;

export const saveRecordShape = {
  collection: z
    .string()
    .min(1)
    .max(120)
    .describe("Collection to store the record in. Created if it does not exist."),
  content: contentSchema,
  source: sourceSchema.optional(),
  status: z.enum(RECORD_STATUSES).default("draft"),
  tags: tagsSchema.optional(),
  author: authorSchema.optional(),
} as const;

export const updateRecordShape = {
  id: z.string().min(1).describe("ID of the record to update."),
  content: contentSchema.optional(),
  source: sourceSchema.optional(),
  status: z.enum(RECORD_STATUSES).optional(),
  tags: tagsSchema.optional(),
  author: authorSchema.optional(),
  expected_version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optimistic-concurrency guard. If given and it does not match the record's current version, the update is rejected so a concurrent edit is not silently overwritten.",
    ),
} as const;

export const getRecordShape = {
  id: z.string().min(1),
} as const;

export const searchRecordsShape = {
  query: z
    .string()
    .max(500)
    .optional()
    .describe("Full-text search over content and source (SQLite FTS5)."),
  collection: z.string().max(120).optional(),
  status: z.enum(RECORD_STATUSES).optional(),
  tag: z.string().max(120).optional().describe("Return records carrying this tag."),
  include_deleted: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
} as const;

export const deleteRecordShape = {
  id: z.string().min(1),
  author: authorSchema.optional(),
  hard: z
    .boolean()
    .default(false)
    .describe("If true, permanently remove the record and its history instead of soft-deleting."),
} as const;

export const addCommentShape = {
  record_id: z.string().min(1),
  body: z.string().min(1).max(10000),
  author: authorSchema.optional(),
} as const;

export const listCommentsShape = {
  record_id: z.string().min(1),
} as const;

export const getHistoryShape = {
  record_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50),
} as const;

const relSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Relationship labels may contain letters, numbers, dot, underscore and hyphen.",
  )
  .describe('Relationship label, e.g. "cites", "supersedes", "derived_from". Defaults to "related".');

export const linkRecordsShape = {
  from_id: z.string().min(1).describe("Source record id."),
  to_id: z.string().min(1).describe("Target record id (may be in any collection)."),
  rel: relSchema.default("related"),
  note: z.string().max(2000).optional(),
  author: authorSchema.optional(),
} as const;

export const unlinkRecordsShape = {
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  rel: relSchema
    .optional()
    .describe("If given, remove only this relationship; otherwise remove all links from→to."),
} as const;

export const listLinksShape = {
  record_id: z.string().min(1),
  direction: z
    .enum(["out", "in", "both"])
    .default("both")
    .describe('"out" = links from this record, "in" = links to it, "both" = all.'),
  rel: relSchema.optional().describe("Filter to a single relationship label."),
} as const;
