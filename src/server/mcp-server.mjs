import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

import { createOperationalLogger } from "./operational-logger.mjs";

const silentLogger = createOperationalLogger({ level: "silent" });

function result(data) {
  const structuredContent = Array.isArray(data) ? { items: data } : data == null ? { value: null } : data;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function textResource(uri, value) {
  return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

const annotationTargetSchema = z.object({
  scopeId: z.string().optional(), pageNumber: z.number().int().positive(), label: z.string().optional(), selector: z.unknown().optional(),
});
const annotationDraftSchema = {
  type: z.enum(["text", "element", "page"]),
  target: annotationTargetSchema,
  comment: z.string().min(1),
  status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(),
  category: z.enum(["general", "language", "structure", "fact", "design"]).optional(),
  anchorState: z.enum(["attached", "orphaned"]).optional(),
  visibility: z.enum(["private", "reviewGroup", "public"]).optional(),
};

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
        requestId, operation, principalKind: principal?.kind ?? "anonymous",
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: error?.code == null ? undefined : String(error.code),
      });
      throw error;
    } finally {
      logger.info("mcp.completed", {
        requestId, operation, status, principalKind: principal?.kind ?? "anonymous",
        durationMs: Math.max(0, Number((monotonicClock() - startedAt).toFixed(3))),
      });
    }
  };
  const registerResource = server.registerResource.bind(server);
  const registerTool = server.registerTool.bind(server);
  server.registerResource = (name, uri, options, handler) => registerResource(name, uri, options, wrap(`resource:${name}`, handler));
  server.registerTool = (name, options, handler) => registerTool(name, options, wrap(`tool:${name}`, handler));
}

export function createPagedBookMcpServer({
  service,
  principal,
  config,
  logger = silentLogger,
  createRequestId = () => `mcp-${Bun.randomUUIDv7()}`,
  monotonicClock = () => performance.now(),
}) {
  const server = new McpServer({ name: "paged-book-annotator", version: "0.1.0" });
  instrumentMcpRegistrations(server, { logger, principal, createRequestId, monotonicClock });

  server.registerResource("book-metadata", `book://${service.bookId}/metadata`, { title: "Book metadata", mimeType: "application/json" }, async (uri) => textResource(uri, {
    id: config.book.id, title: config.book.title, subtitle: config.book.subtitle, language: config.book.language,
    buildId: config.book.buildId, access: service.policy, session: service.session(principal),
  }));
  server.registerResource("annotations", `book://${service.bookId}/annotations`, { title: "Visible annotations", mimeType: "application/json" }, async (uri) => textResource(uri, await service.listAnnotations(principal)));
  server.registerResource("reading-progress", `book://${service.bookId}/progress`, { title: "Reading progress", mimeType: "application/json" }, async (uri) => textResource(uri, service.getProgress(principal)));

  server.registerTool("get_book_context", {
    title: "Get book context", description: "Return book metadata, active access profile and token capabilities.", annotations: { readOnlyHint: true },
  }, async () => result({ book: { id: config.book.id, title: config.book.title, subtitle: config.book.subtitle, language: config.book.language, buildId: config.book.buildId }, access: service.policy, session: service.session(principal) }));

  server.registerTool("list_book_outline", {
    title: "List book outline", description: "List stable heading anchors with cursor pagination.",
    inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: { readOnlyHint: true },
  }, async (input) => result(await service.listBookOutline(principal, input)));
  server.registerTool("get_book_section", {
    title: "Get book section", description: "Read the normalized text at one stable data-book-anchor.",
    inputSchema: { anchorId: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ anchorId }) => result({ section: await service.getBookSection(principal, anchorId) }));
  server.registerTool("search_book", {
    title: "Search book", description: "Search normalized book text and return stable anchors with cursor pagination.",
    inputSchema: { query: z.string().min(2), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: { readOnlyHint: true },
  }, async ({ query, ...options }) => result(await service.searchBook(principal, query, options)));
  server.registerTool("get_annotation_context", {
    title: "Get annotation context", description: "Return one visible annotation and the current text at its stable anchor.",
    inputSchema: { annotationId: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ annotationId }) => result({ context: await service.getAnnotationContext(principal, annotationId) }));
  server.registerTool("list_changes_since", {
    title: "List changes since", description: "List visible annotation changes after an ISO timestamp with cursor pagination.",
    inputSchema: { since: z.iso.datetime().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: { readOnlyHint: true },
  }, async (input) => result(await service.listChangesSince(principal, input)));

  server.registerTool("list_annotations", {
    title: "List annotations", description: "List annotations visible to this token, optionally filtered.",
    inputSchema: { status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(), category: z.enum(["general", "language", "structure", "fact", "design"]).optional(), authorId: z.string().optional(), pageNumber: z.number().int().positive().optional(), query: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ status, category, authorId, pageNumber, query }) => {
    const document = await service.listAnnotations(principal);
    const search = String(query ?? "").trim().toLocaleLowerCase();
    const annotations = document.annotations.filter((note) => (!status || note.status === status) && (!category || note.category === category) && (!authorId || note.author.id === authorId) && (!pageNumber || note.target.pageNumber === pageNumber) && (!search || `${note.comment} ${note.target.label} ${note.target.scopeId}`.toLocaleLowerCase().includes(search)));
    return result({ ...document, annotations });
  });

  server.registerTool("create_annotation", {
    title: "Create annotation", description: "Create an attributed text, element or page annotation.", inputSchema: annotationDraftSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (input) => result(await service.createAnnotation(principal, input)));
  server.registerTool("update_annotation", {
    title: "Update annotation", description: "Update an owned annotation, or any annotation with moderation scope.",
    inputSchema: { id: z.string().min(1), changes: z.record(z.string(), z.unknown()) }, annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ id, changes }) => result({ annotation: await service.updateAnnotation(principal, id, changes) }));
  server.registerTool("delete_annotation", {
    title: "Delete annotation", description: "Delete an owned annotation, or any annotation with moderation scope.",
    inputSchema: { id: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ id }) => result({ deleted: await service.deleteAnnotation(principal, id) }));
  server.registerTool("export_annotations", {
    title: "Export annotations", description: "Export visible annotations as JSON, CSV or Markdown.",
    inputSchema: { format: z.enum(["json", "csv", "markdown"]).default("json") }, annotations: { readOnlyHint: true },
  }, async ({ format }) => result(await service.exportAnnotations(principal, format)));
  server.registerTool("import_annotations", {
    title: "Import annotations", description: "Merge or replace a validated schema 1/2/3 annotation document; requires moderation scope.",
    inputSchema: { document: z.record(z.string(), z.unknown()), mode: z.enum(["merge", "replace"]).default("merge") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ document, mode }) => result(await service.importAnnotations(principal, document, mode)));

  server.registerTool("get_reading_progress", {
    title: "Get reading progress", description: "Return the current reader's stable anchor, page hint and visited anchors.", annotations: { readOnlyHint: true },
  }, async () => result({ progress: service.getProgress(principal) }));
  server.registerTool("record_reading_progress", {
    title: "Record reading progress", description: "Save a stable anchor and derived page/progress hints.",
    inputSchema: { anchorId: z.string().min(1), pageNumber: z.number().int().positive(), percent: z.number().min(0).max(100), buildId: z.string().optional(), event: z.enum(["position", "engaged", "complete"]).optional() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async (input) => result({ progress: service.saveProgress(principal, input) }));
  server.registerTool("list_reader_progress", {
    title: "List reader progress", description: "List every reader's position and visited stable anchors; requires progress:read:all.", annotations: { readOnlyHint: true },
  }, async () => result(service.listAllProgress(principal)));

  server.registerTool("list_users", { title: "List users", description: "List users and assigned book roles.", annotations: { readOnlyHint: true } }, async () => result(service.listUsers(principal)));
  server.registerTool("get_access_settings", { title: "Get access settings", description: "Read the active persisted access policy; requires access:manage.", annotations: { readOnlyHint: true } }, async () => result(service.accessSettings(principal)));
  server.registerTool("update_access_settings", {
    title: "Update access settings", description: "Activate and persist an access preset; protects local installations from lockout.",
    inputSchema: { preset: z.enum(["local", "publicRead", "publicOpenReview", "publicMemberReview", "publicInviteReview", "privateRead", "privateReview"]) }, annotations: { readOnlyHint: false, idempotentHint: true },
  }, async (input) => result(service.updateAccessSettings(principal, input)));
  server.registerTool("create_user", {
    title: "Create user", description: "Create a local user and optionally assign admin/book access.",
    inputSchema: { email: z.email(), displayName: z.string().min(1), password: z.string().min(10), globalRole: z.enum(["instance_admin", "user"]).optional(), bookRole: z.enum(["book_admin", "reviewer", "reader"]).optional() },
    annotations: { readOnlyHint: false },
  }, async (input) => result(await service.createUser(principal, input)));
  server.registerTool("update_user_access", {
    title: "Update user access", description: "Change global role, book role or status; protects the final active administrator.",
    inputSchema: { userId: z.string(), globalRole: z.enum(["instance_admin", "user"]).optional(), bookRole: z.enum(["book_admin", "reviewer", "reader"]).nullable().optional(), status: z.enum(["active", "disabled"]).optional() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ userId, ...changes }) => result(service.updateUser(principal, userId, changes)));
  server.registerTool("reset_user_password", {
    title: "Reset user password", description: "Set a new local password and revoke the user's sessions; requires access:manage.",
    inputSchema: { userId: z.string().min(1), newPassword: z.string().min(10) }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ userId, newPassword }) => result(await service.resetUserPassword(principal, userId, newPassword)));
  server.registerTool("create_invitation", {
    title: "Create invitation", description: "Create an expiring invitation. The secret is returned once.",
    inputSchema: { email: z.email(), displayName: z.string().min(1).optional(), role: z.enum(["book_admin", "reviewer", "reader"]).optional() },
    annotations: { readOnlyHint: false },
  }, async (input) => result(await service.createInvitation(principal, input)));
  server.registerTool("list_invitations", { title: "List invitations", description: "List invitation metadata without secrets.", annotations: { readOnlyHint: true } }, async () => result(service.listInvitations(principal)));
  server.registerTool("revoke_invitation", {
    title: "Revoke invitation", description: "Revoke an unaccepted invitation.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ id }) => result({ revoked: service.revokeInvitation(principal, id) }));

  server.registerTool("create_service_token", {
    title: "Create service token", description: "Create a scoped, expiring service token. The plaintext secret is returned once.",
    inputSchema: { name: z.string().min(1), scopes: z.array(z.string()).min(1), expiresInHours: z.number().min(1).max(8760).optional(), actorUserId: z.string().nullable().optional() },
    annotations: { readOnlyHint: false },
  }, async (input) => result(await service.createToken(principal, input)));
  server.registerTool("list_service_tokens", { title: "List service tokens", description: "List token metadata, scopes, expiry and revocation state.", annotations: { readOnlyHint: true } }, async () => result(service.listTokens(principal)));
  server.registerTool("revoke_service_token", {
    title: "Revoke service token", description: "Immediately revoke a service token.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ id }) => result({ revoked: service.revokeToken(principal, id) }));
  server.registerTool("list_audit_events", {
    title: "List audit events", description: "List mutation events including user and token actors.", inputSchema: { limit: z.number().int().min(1).max(1000).optional() }, annotations: { readOnlyHint: true },
  }, async ({ limit }) => result(service.listAudit(principal, { limit })));
  return server;
}

export async function handleMcpHttpRequest(request, { service, config, bearerToken, logger = silentLogger }) {
  if (!bearerToken) return new Response(JSON.stringify({ error: "MCP kræver et Bearer service-token." }), { status: 401, headers: { "Content-Type": "application/json" } });
  let principal;
  try { principal = await service.resolvePrincipal({ bearerToken }); } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createPagedBookMcpServer({ service, principal, config, logger });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: { token: bearerToken, clientId: principal.tokenId, scopes: principal.scopes } });
}
