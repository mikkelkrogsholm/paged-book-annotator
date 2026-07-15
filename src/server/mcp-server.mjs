import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

import { createOperationalLogger } from "./operational-logger.mjs";

const silentLogger = createOperationalLogger({ level: "silent" });

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const ADDITIVE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const IDEMPOTENT_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

const bookIdSchema = z.string().trim().min(1).describe("Stable book id from list_books.");
const annotationIdSchema = z.string().trim().min(1);
const annotationTargetSchema = z.object({
  scopeId: z.string().optional(),
  pageNumber: z.number().int().positive(),
  label: z.string().optional(),
  selector: z.unknown().optional(),
});
const annotationDraftSchema = {
  type: z.enum(["text", "element", "page"]),
  target: annotationTargetSchema,
  comment: z.string().trim().min(1),
  status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(),
  category: z.enum(["general", "language", "structure", "fact", "design"]).optional(),
  anchorState: z.enum(["attached", "orphaned"]).optional(),
  visibility: z.enum(["private", "reviewGroup", "public"]).optional(),
};

function result(data) {
  const structuredContent = Array.isArray(data) ? { items: data } : data == null ? { value: null } : data;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function textResource(uri, value) {
  return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function itemsFrom(value, property = "items") {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[property])) return value[property];
  if (property !== "items" && Array.isArray(value?.items)) return value.items;
  return [];
}

function instrumentMcpRegistrations(server, { logger, principal, createRequestId, monotonicClock }) {
  const wrap = (operation, handler) => async (...arguments_) => {
    const requestId = createRequestId();
    const startedAt = monotonicClock();
    let status = "ok";
    try {
      return await handler(...arguments_);
    } catch (error) {
      status = "error";
      logger.error("mcp.failed", {
        requestId,
        operation,
        principalKind: principal?.kind ?? "anonymous",
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: error?.code == null ? undefined : String(error.code),
      });
      throw error;
    } finally {
      logger.info("mcp.completed", {
        requestId,
        operation,
        status,
        principalKind: principal?.kind ?? "anonymous",
        durationMs: Math.max(0, Number((monotonicClock() - startedAt).toFixed(3))),
      });
    }
  };
  const registerResource = server.registerResource.bind(server);
  const registerTool = server.registerTool.bind(server);
  server.registerResource = (name, uri, options, handler) => registerResource(name, uri, options, wrap(`resource:${name}`, handler));
  server.registerTool = (name, options, handler) => registerTool(name, options, wrap(`tool:${name}`, handler));
}

function createServiceAdapter({ service, principal, config }) {
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

  return {
    isMultiBook,
    async listBooks() {
      if (!isMultiBook) return [legacyBook];
      return itemsFrom(await service.listBooks(principal), "books");
    },
    async getBook(bookId) {
      if (!isMultiBook) {
        assertLegacyBook(bookId);
        return legacyBook;
      }
      return requireMethod("getBook")(principal, bookId);
    },
    async catalog(name, ...arguments_) {
      if (!isMultiBook) throw new TypeError(`${name} requires the managed multi-book library.`);
      return requireMethod(name)(principal, ...arguments_);
    },
    async book(name, bookId, ...arguments_) {
      if (!isMultiBook) {
        assertLegacyBook(bookId);
        return requireMethod(name)(principal, ...arguments_);
      }
      return requireMethod(name)(principal, bookId, ...arguments_);
    },
    async global(name, ...arguments_) {
      return requireMethod(name)(principal, ...arguments_);
    },
    session(bookId) {
      if (isMultiBook && typeof service.sessionForBook === "function") return service.sessionForBook(principal, bookId);
      return typeof service.session === "function" ? service.session(principal, bookId) : undefined;
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
    "book-metadata",
    new ResourceTemplate("book://{bookId}/metadata", { list: bookResources }),
    { title: "Book metadata", description: "Metadata and effective session for one accessible book.", mimeType: "application/json" },
    async (uri, { bookId }) => {
      const book = await adapter.getBook(bookId);
      return textResource(uri, { book, session: adapter.session(bookId) });
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
  }, async ({ bookId }) => result({ book: await adapter.getBook(bookId), session: adapter.session(bookId) }));

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
    annotations: IDEMPOTENT_WRITE,
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
    annotations: DESTRUCTIVE,
  }, async ({ bookId }) => result({ book: await adapter.catalog("archiveBook", bookId) }));
}

function registerReadingTools(server, adapter) {
  server.registerTool("get_book_context", {
    title: "Get book context",
    description: "Return book metadata and the token's effective capabilities for this book.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result({ book: await adapter.getBook(bookId), session: adapter.session(bookId) }));
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
    description: "List visible annotation changes in one book after an ISO timestamp.",
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
    inputSchema: { bookId: bookIdSchema, ...annotationDraftSchema },
    annotations: ADDITIVE,
  }, async ({ bookId, ...input }) => result(await adapter.book("createAnnotation", bookId, input)));
  server.registerTool("update_annotation", {
    title: "Update annotation",
    description: "Update an owned annotation, or any annotation with moderation permission.",
    inputSchema: { bookId: bookIdSchema, id: annotationIdSchema, changes: z.record(z.string(), z.unknown()) },
    annotations: IDEMPOTENT_WRITE,
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
    description: "Merge or replace a validated schema 1/2/3 annotation document in one book. Replace is destructive.",
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
    annotations: IDEMPOTENT_WRITE,
  }, async ({ bookId, ...input }) => result({ progress: await adapter.book("saveProgress", bookId, input) }));
  server.registerTool("list_reader_progress", {
    title: "List reader progress",
    description: "List every reader's position and visited stable anchors in one book; requires progress:read:all.",
    inputSchema: { bookId: bookIdSchema },
    annotations: READ_ONLY,
  }, async ({ bookId }) => result(await adapter.book("listAllProgress", bookId)));
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
      enrollment: z.enum(["open", "invite", "code", "closed"]).optional(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, async ({ bookId, ...input }) => result(await adapter.book("updateAccessSettings", bookId, input)));
  server.registerTool("create_user", {
    title: "Create user",
    description: "Create a local identity and optionally grant access to one book. Phone is optional and requires a stated purpose.",
    inputSchema: {
      email: z.email(),
      displayName: z.string().trim().min(1),
      phone: z.string().trim().min(3).max(40).optional(),
      phonePurpose: z.string().trim().min(3).max(300).optional(),
      password: z.string().min(10),
      globalRole: z.enum(["instance_admin", "user"]).optional(),
      bookId: bookIdSchema.optional(),
      bookRole: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).optional(),
    },
    annotations: ADDITIVE,
  }, async (input) => {
    if (input.phone && !input.phonePurpose) throw new TypeError("phonePurpose is required when phone is provided.");
    return result(await adapter.global("createUser", input));
  });
  server.registerTool("update_user_access", {
    title: "Update user access",
    description: "Change a global role/status or one book membership. Protects the final active administrator.",
    inputSchema: {
      userId: z.string().trim().min(1),
      bookId: bookIdSchema.optional(),
      globalRole: z.enum(["instance_admin", "user"]).optional(),
      bookRole: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).nullable().optional(),
      permissions: z.array(z.string().trim().min(1)).optional(),
      status: z.enum(["active", "disabled"]).optional(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, async ({ userId, ...changes }) => result(await adapter.global("updateUser", userId, changes)));
  server.registerTool("reset_user_password", {
    title: "Reset user password",
    description: "Set a new local password and revoke the user's sessions.",
    inputSchema: { userId: z.string().trim().min(1), newPassword: z.string().min(10) },
    annotations: DESTRUCTIVE,
  }, async ({ userId, newPassword }) => result(await adapter.global("resetUserPassword", userId, newPassword)));
  server.registerTool("create_invitation", {
    title: "Create book invitation",
    description: "Create an expiring invitation for one book. The secret is returned once.",
    inputSchema: {
      bookId: bookIdSchema,
      email: z.email(),
      displayName: z.string().trim().min(1).optional(),
      role: z.enum(["book_admin", "publisher", "editor", "reviewer", "reader"]).optional(),
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
  server.registerTool("create_service_token", {
    title: "Create service token",
    description: "Create a scoped, expiring token with optional grants for one or more books. Plaintext is returned once.",
    inputSchema: {
      name: z.string().trim().min(1),
      scopes: z.array(z.string().trim().min(1)).min(1),
      bookIds: z.array(bookIdSchema).min(1).optional(),
      expiresInHours: z.number().min(1).max(8760).optional(),
      actorUserId: z.string().nullable().optional(),
    },
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
    description: "Immediately revoke a service token across every book grant.",
    inputSchema: { id: z.string().trim().min(1) },
    annotations: DESTRUCTIVE,
  }, async ({ id }) => result({ revoked: await adapter.global("revokeToken", id) }));
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
  config,
  logger = silentLogger,
  createRequestId = () => `mcp-${Bun.randomUUIDv7()}`,
  monotonicClock = () => performance.now(),
}) {
  const server = new McpServer(
    { name: "paged-book-annotator", version: "0.2.0" },
    { instructions: "Call list_books first. Pass bookId to every book-specific tool. For uploads: create_book_upload, HTTP PUT the tar.gz to uploadUrl, validate_book_upload, then publish_book_revision." },
  );
  instrumentMcpRegistrations(server, { logger, principal, createRequestId, monotonicClock });
  const adapter = createServiceAdapter({ service, principal, config });
  registerLibraryResources(server, adapter);
  registerLibraryTools(server, adapter);
  registerReadingTools(server, adapter);
  registerAnnotationTools(server, adapter);
  registerProgressTools(server, adapter);
  registerAdministrationTools(server, adapter);
  return server;
}

export async function handleMcpHttpRequest(request, { service, config, bearerToken, logger = silentLogger }) {
  if (!bearerToken) return new Response(JSON.stringify({ error: "MCP kræver et Bearer service-token." }), { status: 401, headers: { "Content-Type": "application/json" } });
  let principal;
  try {
    principal = await service.resolvePrincipal({ bearerToken });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createPagedBookMcpServer({ service, principal, config, logger });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: { token: bearerToken, clientId: principal.tokenId, scopes: principal.scopes } });
}
