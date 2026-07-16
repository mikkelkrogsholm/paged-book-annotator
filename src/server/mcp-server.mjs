import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

import { createOperationalLogger } from "./operational-logger.mjs";
import { ADMIN_UI_MCP_PARITY, MCP_TOOL_CONTRACTS, mcpToolError } from "./mcp-tool-contracts.mjs";
import {
  MCP_TOOL_OUTPUT_SCHEMAS,
  annotationIdSchema,
  annotationTargetSchema,
  bookIdSchema,
  createAnnotationInputSchema,
  surveyAnswersInputSchema,
  surveyDefinitionInputSchema,
  surveyIdSchema,
} from "./mcp-contract-schemas.mjs";
import { PERMISSIONS } from "./access-policy.mjs";

export { ADMIN_UI_MCP_PARITY, MCP_TOOL_CONTRACTS } from "./mcp-tool-contracts.mjs";

const silentLogger = createOperationalLogger({ level: "silent" });
const bundleContractDocument = new URL("../../docs/book-bundle.md", import.meta.url);
const bundleSchemaDocument = new URL("../../schemas/book-viewer.bundle.v1.schema.json", import.meta.url);
const surveySchemaDocument = new URL("../../schemas/pba-survey.v1.schema.json", import.meta.url);
const reviewExportSchemaDocument = new URL("../../schemas/pba-review-export.v1.schema.json", import.meta.url);
const mcpDocumentation = new URL("../../docs/mcp.md", import.meta.url);
const packageMetadata = await Bun.file(new URL("../../package.json", import.meta.url)).json();

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const ADDITIVE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const NON_IDEMPOTENT_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const IDEMPOTENT_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const DESTRUCTIVE_NON_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

const permissionSchema = z.enum(PERMISSIONS).describe("Exact permission from pba://contracts/mcp-tools/v1.");

function result(data) {
  const structuredContent = Array.isArray(data) ? { items: data } : data == null ? { value: null } : data;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function textResource(uri, value) {
  return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function rawTextResource(uri, mimeType, text) {
  return { contents: [{ uri: String(uri), mimeType, text }] };
}

function itemsFrom(value, property = "items") {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[property])) return value[property];
  if (property !== "items" && Array.isArray(value?.items)) return value.items;
  return [];
}

function operationBookId(arguments_) {
  for (const argument of arguments_) {
    if (argument && typeof argument === "object" && typeof argument.bookId === "string" && argument.bookId.trim()) {
      return argument.bookId.trim();
    }
    if (argument instanceof URL && argument.protocol === "book:" && argument.hostname) return argument.hostname;
  }
  return null;
}

function instrumentMcpRegistrations(server, { logger, principal, createRequestId, monotonicClock }) {
  const wrap = (operation, handler, toolContract = null) => async (...arguments_) => {
    const requestId = createRequestId();
    const startedAt = monotonicClock();
    const bookId = operationBookId(arguments_);
    let status = "ok";
    try {
      return await handler(...arguments_);
    } catch (error) {
      status = "error";
      logger.error("mcp.failed", {
        requestId,
        operation,
        bookId,
        status,
        principalKind: principal?.kind ?? "anonymous",
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: error?.code == null ? undefined : String(error.code),
      });
      if (toolContract) return { ...result(mcpToolError(error, { requestId })), isError: true };
      throw error;
    } finally {
      logger.info("mcp.completed", {
        requestId,
        operation,
        bookId,
        status,
        principalKind: principal?.kind ?? "anonymous",
        durationMs: Math.max(0, Number((monotonicClock() - startedAt).toFixed(3))),
      });
    }
  };
  const registerResource = server.registerResource.bind(server);
  const registerTool = server.registerTool.bind(server);
  server.registerResource = (name, uri, options, handler) => registerResource(name, uri, options, wrap(`resource:${name}`, handler));
  server.registerTool = (name, options, handler) => {
    const contract = MCP_TOOL_CONTRACTS[name];
    if (!contract) throw new TypeError(`MCP tool ${name} mangler en agentkontrakt.`);
    const outputSchema = options.outputSchema ?? MCP_TOOL_OUTPUT_SCHEMAS[name];
    if (!outputSchema) throw new TypeError(`MCP tool ${name} mangler et eksplicit outputSchema.`);
    return registerTool(name, {
      ...options,
      outputSchema,
      _meta: { ...(options._meta ?? {}), "pba/toolContract": contract },
    }, wrap(`tool:${name}`, handler, contract));
  };
}

function createServiceAdapter({ service, principal, principalProvider, config }) {
  const legacyBook = {
    id: service.bookId ?? config?.book?.id,
    title: config?.book?.title,
    subtitle: config?.book?.subtitle,
    language: config?.book?.language,
    buildId: config?.book?.buildId,
    status: "published",
  };
  const isMultiBook = typeof service.listBooks === "function";

  function requireMethod(name) {
    if (typeof service[name] !== "function") throw new TypeError(`Service method ${name} is not available.`);
    return service[name].bind(service);
  }

  function assertLegacyBook(bookId) {
    if (!legacyBook.id || bookId !== legacyBook.id) throw new TypeError(`Unknown book: ${bookId}`);
  }

  async function currentPrincipal() {
    return principalProvider ? principalProvider() : principal;
  }

  return {
    isMultiBook,
    async listBooks() {
      const activePrincipal = await currentPrincipal();
      if (!isMultiBook) {
        requireMethod("assertCanRead")(activePrincipal);
        return [legacyBook];
      }
      return itemsFrom(await service.listBooks(activePrincipal), "books");
    },
    async getBook(bookId) {
      if (!isMultiBook) {
        assertLegacyBook(bookId);
        requireMethod("assertCanRead")(await currentPrincipal());
        return legacyBook;
      }
      return requireMethod("getBook")(await currentPrincipal(), bookId);
    },
    async catalog(name, ...arguments_) {
      if (!isMultiBook) throw new TypeError(`${name} requires the managed multi-book library.`);
      return requireMethod(name)(await currentPrincipal(), ...arguments_);
    },
    async book(name, bookId, ...arguments_) {
      const activePrincipal = await currentPrincipal();
      if (!isMultiBook) {
        assertLegacyBook(bookId);
        return requireMethod(name)(activePrincipal, ...arguments_);
      }
      return requireMethod(name)(activePrincipal, bookId, ...arguments_);
    },
    async global(name, ...arguments_) {
      return requireMethod(name)(await currentPrincipal(), ...arguments_);
    },
    async session(bookId) {
      const activePrincipal = await currentPrincipal();
      if (isMultiBook && typeof service.sessionForBook === "function") return service.sessionForBook(activePrincipal, bookId);
      return typeof service.session === "function" ? service.session(activePrincipal, bookId) : undefined;
    },
  };
}

function registerLibraryResources(server, adapter) {
  const bookResources = async () => ({
    resources: (await adapter.listBooks()).map((book) => (
      { uri: `book://${book.id}/metadata`, name: `${book.title ?? book.id} metadata`, mimeType: "application/json" },
    )),
  });

  server.registerResource(
    "book-bundle-contract",
    "pba://contracts/book-bundle/v1",
    {
      title: "Paged Book Bundle Contract v1",
      description: "Normative, self-contained instructions for generating, validating and packaging a book bundle.",
      mimeType: "text/markdown",
    },
    async (uri) => rawTextResource(uri, "text/markdown", await Bun.file(bundleContractDocument).text()),
  );
  server.registerResource(
    "book-bundle-schema",
    "pba://schemas/book-viewer.bundle.v1.json",
    {
      title: "Paged Book Bundle manifest schema v1",
      description: "JSON Schema 2020-12 for the strict book-viewer.json manifest.",
      mimeType: "application/schema+json",
    },
    async (uri) => rawTextResource(uri, "application/schema+json", await Bun.file(bundleSchemaDocument).text()),
  );
  server.registerResource(
    "mcp-agent-guide",
    "pba://docs/mcp/v1",
    {
      title: "Paged Book Annotator MCP agent guide",
      description: "Complete workflows, permissions, errors and tool contracts for agents.",
      mimeType: "text/markdown",
    },
    async (uri) => rawTextResource(uri, "text/markdown", await Bun.file(mcpDocumentation).text()),
  );
  server.registerResource(
    "mcp-tool-contracts",
    "pba://contracts/mcp-tools/v1",
    {
      title: "MCP tool contracts V1",
      description: "Machine-readable purpose, permissions, effects, errors, examples and workflow for every tool.",
      mimeType: "application/json",
    },
    async (uri) => textResource(uri, { schemaVersion: 1, tools: MCP_TOOL_CONTRACTS }),
  );
  server.registerResource(
    "admin-ui-mcp-parity",
    "pba://contracts/admin-ui-mcp-parity/v1",
    {
      title: "Admin UI to MCP parity contract V1",
      description: "Machine-readable guarantee and complete mapping from persistent UI capabilities to MCP tools.",
      mimeType: "application/json",
    },
    async (uri) => textResource(uri, ADMIN_UI_MCP_PARITY),
  );
  server.registerResource(
    "survey-schema",
    "pba://schemas/survey.v1.json",
    { title: "Survey schema V1", description: "JSON Schema for immutable survey definitions.", mimeType: "application/schema+json" },
    async (uri) => rawTextResource(uri, "application/schema+json", await Bun.file(surveySchemaDocument).text()),
  );
  server.registerResource(
    "review-export-schema",
    "pba://schemas/review-export.v1.json",
    { title: "Review export schema V1", description: "JSON Schema for combined annotations, surveys, responses and optional progress.", mimeType: "application/schema+json" },
    async (uri) => rawTextResource(uri, "application/schema+json", await Bun.file(reviewExportSchemaDocument).text()),
  );

  server.registerResource(
    "book-metadata",
    new ResourceTemplate("book://{bookId}/metadata", { list: bookResources }),
    { title: "Book metadata", description: "Metadata and effective session for one accessible book.", mimeType: "application/json" },
    async (uri, { bookId }) => {
      const book = await adapter.getBook(bookId);
      return textResource(uri, { book, session: await adapter.session(bookId) });
    },
  );
  server.registerResource(
    "book-annotations",
    new ResourceTemplate("book://{bookId}/annotations", { list: undefined }),
    { title: "Visible annotations", description: "Annotations visible to this principal in one book.", mimeType: "application/json" },
    async (uri, { bookId }) => textResource(uri, await adapter.book("listAnnotations", bookId)),
  );
  server.registerResource(
    "book-progress",
    new ResourceTemplate("book://{bookId}/progress", { list: undefined }),
    { title: "Reading progress", description: "This principal's reading progress in one book.", mimeType: "application/json" },
    async (uri, { bookId }) => textResource(uri, await adapter.book("getProgress", bookId)),
  );
  server.registerResource(
    "book-surveys",
    new ResourceTemplate("book://{bookId}/surveys", { list: undefined }),
    { title: "Active surveys", description: "Published surveys for the active revision that this principal can answer.", mimeType: "application/json" },
    async (uri, { bookId }) => textResource(uri, { surveys: await adapter.book("listActiveSurveys", bookId) }),
  );
}

function registerLibraryTools(server, adapter) {
  server.registerTool("list_books", {
    title: "List books",
    description: "List books visible to this token, including lifecycle and active revision metadata.",
    annotations: READ_ONLY,
  }, async () => result(await adapter.listBooks()));

  server.registerTool("get_book", {
    title: "Get book",
    description: "Get one visible book and the token's effective access in that book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ book: await adapter.getBook(bookId), session: await adapter.session(bookId) }));

  server.registerTool("create_book", {
    title: "Create book",
    description: "Create an empty managed book. Content must subsequently be uploaded, validated and published.",
    inputSchema: {
      title: z.string().trim().min(1).max(200),
      slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
      subtitle: z.string().trim().max(300).optional(),
      language: z.string().trim().min(2).max(35).optional(),
    },
    annotations: ADDITIVE,
  }, async (input) => result({ book: await adapter.catalog("createBook", input) }));

  server.registerTool("create_book_upload", {
    title: "Create book upload",
    description: "Create a staged tar.gz upload and return a short-lived HTTP PUT URL. Do not put bundle bytes or base64 in MCP arguments.",
    inputSchema: {
      bookId: bookIdSchema,
      filename: z.string().trim().min(1).max(255).refine((value) => value.endsWith(".tar.gz"), "filename must end in .tar.gz"),
      contentType: z.enum(["application/gzip", "application/x-gzip"]),
      sizeBytes: z.number().int().positive().optional(),
    },
    annotations: ADDITIVE,
  }, async ({ bookId, ...metadata }) => result(await adapter.catalog("createBookUpload", bookId, metadata)));

  server.registerTool("validate_book_upload", {
    title: "Validate book upload",
    description: "Validate a completed staged upload without changing the active book revision.",
    inputSchema: { bookId: bookIdSchema, uploadId: z.string().trim().min(1) },
    annotations: NON_IDEMPOTENT_WRITE,
  }, async ({ bookId, uploadId }) => result(await adapter.catalog("validateBookUpload", bookId, uploadId)));

  server.registerTool("list_book_revisions", {
    title: "List book revisions",
    description: "List staged, validated, published and failed revisions for one book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.catalog("listBookRevisions", bookId)));

  server.registerTool("publish_book_revision", {
    title: "Publish book revision",
    description: "Atomically make one validated immutable revision active for a book.",
    inputSchema: { bookId: bookIdSchema, revisionId: z.string().trim().min(1) },
    annotations: IDEMPOTENT_WRITE,
  }, async ({ bookId, revisionId }) => result(await adapter.catalog("publishBookRevision", bookId, revisionId)));

  server.registerTool("archive_book", {
    title: "Archive book",
    description: "Archive a book so readers can no longer open it. Stored revisions and review data are retained.",
    inputSchema: { bookId: bookIdSchema },
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
  }, async ({ bookId }) => result({ book: await adapter.catalog("archiveBook", bookId) }));
}

function registerReadingTools(server, adapter) {
  server.registerTool("get_book_context", {
    title: "Get book context",
    description: "Return book metadata and the token's effective capabilities for this book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ book: await adapter.getBook(bookId), session: await adapter.session(bookId) }));
  server.registerTool("list_book_outline", {
    title: "List book outline",
    description: "List stable heading anchors with cursor pagination.",
    inputSchema: { bookId: bookIdSchema, cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: READ_ONLY,
  }, async ({ bookId, ...options }) => result(await adapter.book("listBookOutline", bookId, options)));
  server.registerTool("get_book_section", {
    title: "Get book section",
    description: "Read normalized text at one stable data-book-anchor.",
    inputSchema: { bookId: bookIdSchema, anchorId: z.string().trim().min(1) },
    annotations: READ_ONLY,
  }, async ({ bookId, anchorId }) => result({ section: await adapter.book("getBookSection", bookId, anchorId) }));
  server.registerTool("search_book", {
    title: "Search book",
    description: "Search normalized book text and return stable anchors with cursor pagination.",
    inputSchema: { bookId: bookIdSchema, query: z.string().trim().min(2), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: READ_ONLY,
  }, async ({ bookId, query, ...options }) => result(await adapter.book("searchBook", bookId, query, options)));
  server.registerTool("get_annotation_context", {
    title: "Get annotation context",
    description: "Return one visible annotation and current text at its stable anchor.",
    inputSchema: { bookId: bookIdSchema, annotationId: annotationIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId, annotationId }) => result({ context: await adapter.book("getAnnotationContext", bookId, annotationId) }));
  server.registerTool("list_changes_since", {
    title: "List changes since",
    description: "Synchronize visible annotation upserts with a stable keyset cursor. Deletion tombstones are returned only to annotations:read:all or annotations:moderate callers.",
    inputSchema: { bookId: bookIdSchema, since: z.iso.datetime().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: READ_ONLY,
  }, async ({ bookId, ...options }) => result(await adapter.book("listChangesSince", bookId, options)));
}

function registerAnnotationTools(server, adapter) {
  server.registerTool("list_annotations", {
    title: "List annotations",
    description: "List annotations visible to this token in one book, optionally filtered.",
    inputSchema: {
      bookId: bookIdSchema,
      status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(),
      category: z.enum(["general", "language", "structure", "fact", "design"]).optional(),
      authorId: z.string().optional(),
      pageNumber: z.number().int().positive().optional(),
      query: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async ({ bookId, status, category, authorId, pageNumber, query }) => {
    const document = await adapter.book("listAnnotations", bookId);
    const search = String(query ?? "").trim().toLocaleLowerCase();
    const annotations = itemsFrom(document, "annotations").filter((note) => (
      (!status || note.status === status)
      && (!category || note.category === category)
      && (!authorId || note.author?.id === authorId)
      && (!pageNumber || note.target?.pageNumber === pageNumber)
      && (!search || `${note.comment ?? ""} ${note.target?.label ?? ""} ${note.target?.scopeId ?? ""}`.toLocaleLowerCase().includes(search))
    ));
    return result({ ...document, bookId, annotations });
  });
  server.registerTool("create_annotation", {
    title: "Create annotation",
    description: "Create an attributed text, element or page annotation in one book.",
    inputSchema: createAnnotationInputSchema,
    annotations: ADDITIVE,
  }, async ({ bookId, ...input }) => result(await adapter.book("createAnnotation", bookId, input)));
  server.registerTool("update_annotation", {
    title: "Update annotation",
    description: "Update an owned annotation, or any annotation with moderation permission.",
    inputSchema: {
      bookId: bookIdSchema,
      id: annotationIdSchema,
      changes: z.object({
        comment: z.string().trim().min(1).optional(),
        status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(),
        category: z.enum(["general", "language", "structure", "fact", "design"]).optional(),
        visibility: z.enum(["private", "reviewGroup", "public"]).optional(),
        anchorState: z.enum(["attached", "orphaned"]).optional(),
        target: annotationTargetSchema.optional(),
      }).refine((changes) => Object.keys(changes).length > 0, "changes must contain at least one field"),
    },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, id, changes }) => result({ annotation: await adapter.book("updateAnnotation", bookId, id, changes) }));
  server.registerTool("delete_annotation", {
    title: "Delete annotation",
    description: "Permanently delete an owned annotation, or any annotation with moderation permission.",
    inputSchema: { bookId: bookIdSchema, id: annotationIdSchema },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, id }) => result({ deleted: await adapter.book("deleteAnnotation", bookId, id) }));
  server.registerTool("export_annotations", {
    title: "Export annotations",
    description: "Export visible annotations from one book as JSON, CSV or Markdown.",
    inputSchema: { bookId: bookIdSchema, format: z.enum(["json", "csv", "markdown"]).default("json") },
    annotations: READ_ONLY,
  }, async ({ bookId, format }) => result(await adapter.book("exportAnnotations", bookId, format)));
  server.registerTool("import_annotations", {
    title: "Import annotations",
    description: "Merge or replace a validated schema 1/2/3/4 annotation document in one book. Replace is destructive.",
    inputSchema: { bookId: bookIdSchema, document: z.record(z.string(), z.unknown()), mode: z.enum(["merge", "replace"]).default("merge") },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, document, mode }) => result(await adapter.book("importAnnotations", bookId, document, mode)));
}

function registerProgressTools(server, adapter) {
  server.registerTool("get_reading_progress", {
    title: "Get reading progress",
    description: "Return this reader's stable anchor, page hint and visited anchors in one book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ progress: await adapter.book("getProgress", bookId) }));
  server.registerTool("record_reading_progress", {
    title: "Record reading progress",
    description: "Save a stable anchor and derived page/progress hints in one book.",
    inputSchema: {
      bookId: bookIdSchema,
      anchorId: z.string().trim().min(1),
      pageNumber: z.number().int().positive(),
      percent: z.number().min(0).max(100),
      buildId: z.string().optional(),
      event: z.enum(["position", "engaged", "complete"]).optional(),
    },
    annotations: NON_IDEMPOTENT_WRITE,
  }, async ({ bookId, ...input }) => result({ progress: await adapter.book("saveProgress", bookId, input) }));
  server.registerTool("list_reader_progress", {
    title: "List reader progress",
    description: "List every reader's position and visited stable anchors in one book; requires progress:read:all.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("listAllProgress", bookId)));
}

function registerSurveyTools(server, adapter) {
  server.registerTool("list_active_surveys", {
    title: "List active surveys",
    description: "List published surveys bound to the active immutable book revision that this principal may answer.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ surveys: await adapter.book("listActiveSurveys", bookId) }));
  server.registerTool("get_survey", {
    title: "Get survey",
    description: "Read one active survey including its stable anchor target, version and complete question definitions.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId, surveyId }) => result({ survey: await adapter.book("getSurvey", bookId, surveyId) }));
  server.registerTool("get_my_survey_response", {
    title: "Get my survey response",
    description: "Return this principal's response for the survey's published version and current book revision, if any.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId, surveyId }) => result({ response: await adapter.book("getMySurveyResponse", bookId, surveyId) }));
  server.registerTool("submit_survey_response", {
    title: "Submit survey response",
    description: "Create or replace exactly one response for this principal, survey version and book revision; answers are validated against the immutable question snapshot.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema, answers: surveyAnswersInputSchema },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, surveyId, answers }) => result({ response: await adapter.book("submitSurveyResponse", bookId, surveyId, answers) }));
  server.registerTool("list_surveys", {
    title: "List surveys",
    description: "List draft, published and closed surveys with every immutable version for one book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ surveys: await adapter.book("listSurveys", bookId) }));
  server.registerTool("create_survey", {
    title: "Create survey",
    description: "Create survey version 1 as a draft. Use a stable data-book-anchor; pageNumberHint is informational only.",
    inputSchema: { bookId: bookIdSchema, definition: surveyDefinitionInputSchema },
    annotations: ADDITIVE,
  }, async ({ bookId, definition }) => result({ survey: await adapter.book("createSurvey", bookId, definition) }));
  server.registerTool("update_survey_draft", {
    title: "Update survey draft",
    description: "Replace the complete draft definition. Updating a published survey creates a new draft version without mutating the published version.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema, definition: surveyDefinitionInputSchema },
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
  }, async ({ bookId, surveyId, definition }) => result({ survey: await adapter.book("updateSurveyDraft", bookId, surveyId, definition) }));
  server.registerTool("publish_survey", {
    title: "Publish survey",
    description: "Publish the current draft immutably and bind it to the active book revision.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema },
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
  }, async ({ bookId, surveyId }) => result({ survey: await adapter.book("publishSurvey", bookId, surveyId) }));
  server.registerTool("close_survey", {
    title: "Close survey",
    description: "Close a survey so readers and agents can no longer create or change responses; existing responses remain exportable.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema },
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
  }, async ({ bookId, surveyId }) => result({ survey: await adapter.book("closeSurvey", bookId, surveyId) }));
  server.registerTool("list_survey_responses", {
    title: "List survey responses",
    description: "List pseudonymized responses with survey version, book revision, stable target and timestamps. Free text is returned only to authorized callers and never logged.",
    inputSchema: { bookId: bookIdSchema, surveyId: surveyIdSchema.optional() },
    annotations: READ_ONLY,
  }, async ({ bookId, surveyId }) => result({ responses: await adapter.book("listSurveyResponses", bookId, { surveyId }) }));
  server.registerTool("export_review_bundle", {
    title: "Export review bundle",
    description: "Return review-export V1 with annotations, all survey versions, survey responses and optional reading progress. Read pba://schemas/review-export.v1.json first.",
    inputSchema: {
      bookId: bookIdSchema,
      includeProgress: z.boolean().default(false).describe("Requires progress:read:all when true."),
    },
    annotations: READ_ONLY,
  }, async ({ bookId, includeProgress }) => {
    const exported = await adapter.book("exportReviewBundle", bookId, { includeProgress });
    return result(exported.document);
  });
}

function registerAdministrationTools(server, adapter) {
  server.registerTool("list_users", {
    title: "List users",
    description: "List installation users. Optionally include their membership in one book.",
    inputSchema: { bookId: bookIdSchema.optional() },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.global("listUsers", bookId ? { bookId } : undefined)));
  server.registerTool("list_book_members", {
    title: "List book members",
    description: "List members and effective per-book permissions.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("listMembers", bookId)));
  server.registerTool("get_access_settings", {
    title: "Get access settings",
    description: "Read one book's persisted access and enrollment policy.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("accessSettings", bookId)));
  server.registerTool("update_access_settings", {
    title: "Update access settings",
    description: "Persist one book's access preset and optional enrollment mode with lockout protection.",
    inputSchema: {
      bookId: bookIdSchema,
      preset: z.enum(["local", "publicRead", "publicOpenReview", "publicMemberReview", "publicInviteReview", "privateRead", "privateReview"]),
      reading: z.enum(["public", "authenticated", "invited"]).optional(),
      annotationCreate: z.enum(["disabled", "public", "authenticated", "invited"]).optional(),
      annotationView: z.enum(["none", "own", "reviewGroup", "public"]).optional(),
      surveyResponse: z.enum(["disabled", "public", "authenticated", "invited"]).optional(),
      registration: z.enum(["disabled", "closed", "open", "inviteOnly", "code"]).optional(),
      progressTracking: z.enum(["off", "resume", "analytics"]).optional(),
      localBypass: z.boolean().optional(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, async ({ bookId, ...input }) => result(await adapter.book("updateAccessSettings", bookId, input)));
  server.registerTool("create_user", {
    title: "Create user",
    description: "Create a local identity and optionally grant access to one book. Phone is optional and requires a stated purpose.",
    inputSchema: z.object({
      email: z.email(),
      displayName: z.string().trim().min(1),
      phone: z.string().trim().min(3).max(40).optional(),
      phonePurpose: z.string().trim().min(3).max(300).optional(),
      password: z.string().min(10),
      globalRole: z.enum(["instance_admin", "user"]).optional(),
      bookId: bookIdSchema.optional(),
      bookRole: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).optional(),
    }).superRefine((input, context) => {
      if (input.phone && !input.phonePurpose) context.addIssue({ code: "custom", path: ["phonePurpose"], message: "phonePurpose is required when phone is provided" });
      if (input.bookRole && !input.bookId) context.addIssue({ code: "custom", path: ["bookId"], message: "bookId is required when bookRole is provided" });
    }),
    annotations: ADDITIVE,
  }, async (input) => {
    return result(await adapter.global("createUser", input));
  });
  server.registerTool("update_user_access", {
    title: "Update user access",
    description: "Change a global role/status or one book membership. Protects the final active administrator.",
    inputSchema: z.object({
      userId: z.string().trim().min(1),
      bookId: bookIdSchema.optional(),
      globalRole: z.enum(["instance_admin", "user"]).optional(),
      bookRole: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).nullable().optional(),
      permissions: z.array(permissionSchema).optional(),
      status: z.enum(["active", "disabled"]).optional(),
    }).superRefine((input, context) => {
      const changes = [input.globalRole, input.bookRole, input.permissions, input.status];
      if (changes.every((value) => value === undefined)) context.addIssue({ code: "custom", message: "at least one access field is required" });
      if ((input.bookRole !== undefined || input.permissions !== undefined) && !input.bookId) {
        context.addIssue({ code: "custom", path: ["bookId"], message: "bookId is required for membership changes" });
      }
    }),
    annotations: DESTRUCTIVE,
  }, async ({ userId, ...changes }) => result(await adapter.global("updateUser", userId, changes)));
  server.registerTool("reset_user_password", {
    title: "Reset user password",
    description: "Set a new local password and revoke the user's sessions.",
    inputSchema: { userId: z.string().trim().min(1), newPassword: z.string().min(10) },
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
  }, async ({ userId, newPassword }) => result(await adapter.global("resetUserPassword", userId, newPassword)));
  server.registerTool("create_invitation", {
    title: "Create book invitation",
    description: "Create an expiring invitation for one book. The secret is returned once.",
    inputSchema: {
      bookId: bookIdSchema,
      email: z.email(),
      displayName: z.string().trim().min(1).optional(),
      role: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).optional(),
      permissions: z.array(permissionSchema).optional(),
      expiresInHours: z.number().int().min(1).max(8760).optional(),
    },
    annotations: ADDITIVE,
  }, async ({ bookId, ...input }) => result(await adapter.book("createInvitation", bookId, input)));
  server.registerTool("list_invitations", {
    title: "List book invitations",
    description: "List invitation metadata without secrets for one book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("listInvitations", bookId)));
  server.registerTool("revoke_invitation", {
    title: "Revoke invitation",
    description: "Revoke an unaccepted invitation for one book.",
    inputSchema: { bookId: bookIdSchema, id: z.string().trim().min(1) },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, id }) => result({ revoked: await adapter.book("revokeInvitation", bookId, id) }));
  server.registerTool("create_access_code", {
    title: "Create book access code",
    description: "Create an expiring, limited-use enrollment code for one book. The code is returned once.",
    inputSchema: {
      bookId: bookIdSchema,
      name: z.string().trim().min(1).max(100),
      role: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).default("reviewer"),
      permissions: z.array(permissionSchema).optional(),
      expiresInHours: z.number().int().min(1).max(8760).optional(),
      maxUses: z.number().int().min(1).max(10_000).optional(),
    },
    annotations: ADDITIVE,
  }, async ({ bookId, ...input }) => result(await adapter.book("createAccessCode", bookId, input)));
  server.registerTool("list_access_codes", {
    title: "List book access codes",
    description: "List enrollment code metadata without plaintext secrets for one book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("listAccessCodes", bookId)));
  server.registerTool("revoke_access_code", {
    title: "Revoke access code",
    description: "Immediately prevent further uses of an enrollment code.",
    inputSchema: { bookId: bookIdSchema, id: z.string().trim().min(1) },
    annotations: DESTRUCTIVE,
  }, async ({ bookId, id }) => result({ revoked: await adapter.book("revokeAccessCode", bookId, id) }));
  const serviceTokenIdentityInput = {
    name: z.string().trim().min(1),
    expiresInHours: z.number().min(1).max(8760).optional(),
    actorUserId: z.string().nullable().optional(),
  };
  server.registerTool("create_service_token", {
    title: "Create service token",
    description: "Create an expiring token. An instance-administrator token needs no existing book and can bootstrap an empty installation; scoped tokens require explicit book grants. Plaintext is returned once.",
    inputSchema: z.union([
      z.object({
        ...serviceTokenIdentityInput,
        instanceAdmin: z.literal(true),
      }),
      z.object({
        ...serviceTokenIdentityInput,
        instanceAdmin: z.literal(false).optional(),
        scopes: z.array(permissionSchema).min(1),
        bookIds: z.array(bookIdSchema).min(1).refine(
          (bookIds) => new Set(bookIds).size === bookIds.length,
          "bookIds must be unique",
        ),
      }),
      z.object({
        ...serviceTokenIdentityInput,
        instanceAdmin: z.literal(false).optional(),
        grants: z.array(z.object({
          bookId: bookIdSchema,
          permissions: z.array(permissionSchema).min(1),
        })).min(1).refine(
          (grants) => new Set(grants.map((grant) => grant.bookId)).size === grants.length,
          "grant bookIds must be unique",
        ),
      }),
    ]),
    annotations: ADDITIVE,
  }, async (input) => result(await adapter.global("createToken", input)));
  server.registerTool("list_service_tokens", {
    title: "List service tokens",
    description: "List token metadata, book grants, scopes, expiry and revocation state.",
    inputSchema: { bookId: bookIdSchema.optional() },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.global("listTokens", bookId ? { bookId } : undefined)));
  server.registerTool("revoke_service_token", {
    title: "Revoke service token",
    description: "Immediately revoke a service token. Non-instance administrators must supply the bookId whose token-management grant authorizes the operation.",
    inputSchema: { id: z.string().trim().min(1), bookId: bookIdSchema.optional() },
    annotations: DESTRUCTIVE,
  }, async ({ id, bookId }) => result({ revoked: await adapter.global("revokeToken", id, { bookId }) }));
  server.registerTool("list_audit_events", {
    title: "List audit events",
    description: "List mutation events, optionally limited to one book.",
    inputSchema: { bookId: bookIdSchema.optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: READ_ONLY,
  }, async (options) => result(await adapter.global("listAudit", options)));
}

export function createPagedBookMcpServer({
  service,
  principal,
  principalProvider,
  config,
  transport = "http",
  logger = silentLogger,
  createRequestId = () => `mcp-${Bun.randomUUIDv7()}`,
  monotonicClock = () => performance.now(),
}) {
  const server = new McpServer(
    { name: "paged-book-annotator", version: String(packageMetadata.version) },
    { instructions: [
      "Start with pba://docs/mcp/v1 and pba://contracts/mcp-tools/v1, then call list_books.",
      "Pass bookId to every book-specific tool.",
      "Domain failures handled by a tool return error.code, retryable, suggestedAction and requestId; SDK input validation errors may be protocol/text errors without structuredContent.",
      "Before generating a book bundle, read pba://contracts/book-bundle/v1 and pba://schemas/book-viewer.bundle.v1.json.",
      "Upload workflow: create_book_upload, authenticated HTTP PUT to uploadUrl on the configured PBA HTTP server, validate_book_upload, then publish_book_revision.",
      "Pending upload metadata is persisted, so create/validate MCP calls may use stdio while the PUT uses the HTTP server sharing the configured data directory.",
      "Survey workflow: list_active_surveys, get_survey, get_my_survey_response, then submit_survey_response.",
      "Review export schema is pba://schemas/review-export.v1.json.",
      "List tools without pagination return authorization-filtered, installation-bounded collections; use their filters before consuming the result.",
    ].join(" ") },
  );
  instrumentMcpRegistrations(server, { logger, principal, createRequestId, monotonicClock });
  const adapter = createServiceAdapter({ service, principal, principalProvider, config });
  registerLibraryResources(server, adapter);
  registerLibraryTools(server, adapter);
  registerReadingTools(server, adapter);
  registerAnnotationTools(server, adapter);
  registerProgressTools(server, adapter);
  registerSurveyTools(server, adapter);
  registerAdministrationTools(server, adapter);
  return server;
}

export async function handleMcpHttpRequest(request, { service, config, bearerToken, logger = silentLogger }) {
  if (!bearerToken) return new Response(JSON.stringify({ error: "MCP kræver et Bearer service-token." }), { status: 401, headers: { "Content-Type": "application/json" } });
  let principal;
  try {
    principal = await service.resolvePrincipal({ bearerToken });
  } catch {
    return new Response(JSON.stringify({ error: "MCP-tokenet er ugyldigt, udløbet eller tilbagekaldt." }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createPagedBookMcpServer({ service, principal, config, logger });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: { token: bearerToken, clientId: principal.tokenId, scopes: principal.scopes } });
}
