import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBookViewerServer, loadBookViewerConfig } from "../../server.mjs";
import { ADMIN_UI_MCP_PARITY, createPagedBookMcpServer, MCP_TOOL_CONTRACTS } from "./mcp-server.mjs";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp-contract-schemas.mjs";
import { mcpToolError } from "./mcp-tool-contracts.mjs";
import { createOperationalLogger } from "./operational-logger.mjs";

test("Streamable HTTP MCP requires a token and exposes scoped book tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-mcp-"));
  await mkdir(join(directory, "book"));
  await writeFile(join(directory, "book/book.html"), "<!doctype html><title>MCP-bog</title><main><h1 data-book-anchor=chapter-1>Første kapitel</h1><p data-book-anchor=chapter-1.p-1>Et særligt prøveafsnit.</p></main>");
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    book: { id: "mcp-book", title: "MCP-bog", sourceDir: "book", document: "book.html" },
    annotations: { file: "annotations.json" }, access: { preset: "privateReview" },
  }));
  const config = await loadBookViewerConfig(configPath);
  const logRecords = [];
  const logger = createOperationalLogger({ sink: (_line, record) => logRecords.push(record) });
  const server = createBookViewerServer({ config, hostname: "127.0.0.1", port: 0, logger });
  const client = new Client({ name: "mcp-test", version: "1.0.0" }, { capabilities: {} });

  try {
    const unauthorized = await fetch(new URL("/mcp", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const admin = await server.collaborationRepository.createUser({
      email: "admin@mcp.test", displayName: "MCP Admin", password: "meget-hemmeligt", globalRole: "instance_admin", bookRole: "book_admin",
    });
    const token = await server.bookApplicationService.createToken(server.collaborationRepository.principalForUser(admin.id), {
      name: "Testagent", scopes: [
        "books:read", "annotations:read", "annotations:read:all", "annotations:write", "annotations:export",
        "surveys:respond", "surveys:manage", "surveys:responses:read", "surveys:export",
        "users:invite",
      ], expiresInHours: 1,
    });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token.secret}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, Object.keys(MCP_TOOL_CONTRACTS).length);
    assert.equal(tools.tools.every((tool) => tool.outputSchema?.type === "object"
      || Array.isArray(tool.outputSchema?.anyOf)
      || Array.isArray(tool.outputSchema?.oneOf)), true);
    assert.equal(tools.tools.every((tool) => {
      const contract = tool._meta?.["pba/toolContract"];
      return contract?.purpose && Array.isArray(contract.requiredPermissions)
        && contract.effect && typeof contract.idempotent === "boolean"
        && contract.workflow && contract.exampleArguments && contract.errors?.length;
    }), true);
    assert.equal(tools.tools.some((tool) => tool.name === "list_annotations"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "search_book"), true);
    const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const successfulOutput = (name) => toolsByName.get(name).outputSchema.anyOf?.[0]
      ?? toolsByName.get(name).outputSchema.oneOf?.[0]
      ?? toolsByName.get(name).outputSchema;
    assert.equal(successfulOutput("get_book").properties.book.type, "object");
    assert.equal(successfulOutput("get_book").properties.session.type, "object");
    assert.deepEqual(MCP_TOOL_CONTRACTS.get_book.output.topLevelKeys, ["book", "session"]);
    assert.equal(successfulOutput("create_survey").properties.survey.type, "object");
    assert.equal(successfulOutput("create_survey").properties.survey.properties.versions.items.type, "object");
    assert.equal(successfulOutput("list_survey_responses").properties.responses.items.properties.answers.items.properties.value.anyOf.length, 2);
    assert.equal(successfulOutput("export_review_bundle").properties.annotations.properties.items.items.properties.target.anyOf.length, 3);
    assert.equal(successfulOutput("export_review_bundle").properties.readingProgress.properties.items.items.type, "object");
    const book = await client.callTool({ name: "get_book", arguments: { bookId: "mcp-book" } });
    assert.equal(book.structuredContent.book.id, "mcp-book");
    assert.equal(typeof book.structuredContent.session, "object");
    const outline = await client.callTool({ name: "list_book_outline", arguments: { bookId: "mcp-book" } });
    assert.equal(outline.structuredContent.items[0].anchorId, "chapter-1");
    const search = await client.callTool({ name: "search_book", arguments: { bookId: "mcp-book", query: "prøveafsnit" } });
    assert.equal(search.structuredContent.items[0].anchorId, "chapter-1.p-1");
    const created = await client.callTool({ name: "create_annotation", arguments: {
      bookId: "mcp-book", type: "page", comment: "Agentnote", target: { pageNumber: 1, scopeId: "front" }, visibility: "reviewGroup",
    } });
    assert.equal(created.isError, undefined);
    const listed = await client.callTool({ name: "list_annotations", arguments: { bookId: "mcp-book" } });
    assert.equal(listed.structuredContent.annotations.length, 1);
    assert.equal(listed.structuredContent.annotations[0].author.kind, "token");
    const draft = await client.callTool({ name: "create_survey", arguments: {
      bookId: "mcp-book",
      definition: {
        schemaVersion: 1, title: "Agentfeedback", description: "",
        target: { kind: "section", anchorId: "chapter-1", pageNumberHint: 1 }, trigger: { mode: "afterLeave" },
        questions: [{ id: "clarity", type: "rating", prompt: "Hvor klart var afsnittet?", required: true, scale: { min: 1, max: 5, minLabel: "Uklart", maxLabel: "Klart" } }],
      },
    } });
    const surveyId = draft.structuredContent.survey.id;
    await client.callTool({ name: "publish_survey", arguments: { bookId: "mcp-book", surveyId } });
    assert.equal((await client.callTool({ name: "list_active_surveys", arguments: { bookId: "mcp-book" } })).structuredContent.surveys.length, 1);
    const submitted = await client.callTool({ name: "submit_survey_response", arguments: {
      bookId: "mcp-book", surveyId, answers: [{ questionId: "clarity", value: 5 }],
    } });
    assert.equal(submitted.structuredContent.response.answers[0].value, 5);
    assert.equal((await client.callTool({ name: "list_survey_responses", arguments: { bookId: "mcp-book", surveyId } })).structuredContent.responses.length, 1);
    const reviewExport = await client.callTool({ name: "export_review_bundle", arguments: { bookId: "mcp-book", includeProgress: false } });
    assert.equal(reviewExport.isError, undefined, JSON.stringify(reviewExport));
    assert.equal(reviewExport.structuredContent.kind, "paged-book-review-export");
    const forbidden = await client.callTool({ name: "list_users", arguments: {} });
    assert.equal(forbidden.isError, true);
    assert.equal(forbidden.structuredContent.error.code, "forbidden");
    assert.equal(forbidden.structuredContent.error.retryable, false);
    assert.match(forbidden.structuredContent.error.suggestedAction, /token/);
    const delegationEscalation = await client.callTool({ name: "create_invitation", arguments: {
      bookId: "mcp-book", email: "escalation@example.test", role: "book_admin",
    } });
    assert.equal(delegationEscalation.isError, true);
    assert.equal(delegationEscalation.structuredContent.error.code, "forbidden");
    assert.deepEqual(
      logRecords.filter((record) => record.event === "mcp.completed").map((record) => record.operation),
      [
        "tool:get_book", "tool:list_book_outline", "tool:search_book", "tool:create_annotation", "tool:list_annotations",
        "tool:create_survey", "tool:publish_survey", "tool:list_active_surveys", "tool:submit_survey_response",
        "tool:list_survey_responses", "tool:export_review_bundle", "tool:list_users", "tool:create_invitation",
      ],
    );
    const mcpCompletions = logRecords.filter((record) => record.event === "mcp.completed");
    assert.equal(mcpCompletions.every((record) => record.requestId && record.durationMs >= 0 && record.principalKind === "token"), true);
    assert.deepEqual(mcpCompletions.map((record) => record.bookId), [
      "mcp-book", "mcp-book", "mcp-book", "mcp-book", "mcp-book", "mcp-book", "mcp-book",
      "mcp-book", "mcp-book", "mcp-book", "mcp-book", null, "mcp-book",
    ]);
    const mcpFailure = logRecords.find((record) => record.event === "mcp.failed" && record.operation === "tool:list_users");
    assert.equal(mcpFailure.status, "error");
    assert.equal(mcpFailure.requestId, mcpCompletions.find((record) => record.operation === "tool:list_users").requestId);
    assert.doesNotMatch(JSON.stringify(logRecords), new RegExp(`${token.secret}|Agentnote`));
  } finally {
    await client.close().catch(() => {});
    await server.stop(true);
    server.collaborationRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-book MCP validates explicit book context and keeps bundle bytes out of tool arguments", async () => {
  const calls = [];
  const logRecords = [];
  const books = [
    { id: "book-a", slug: "book-a", title: "Bog A", status: "active", activeRevisionId: "rev-a1" },
    { id: "book-b", slug: "book-b", title: "Bog B", status: "draft", activeRevisionId: null },
  ];
  const service = {
    listBooks: async () => ({ books }),
    getBook: async (_principal, bookId) => books.find((book) => book.id === bookId),
    updateBook: async (_principal, bookId, input) => {
      calls.push(["updateBook", bookId, input]);
      return { ...books.find((book) => book.id === bookId), slug: input.slug };
    },
    sessionForBook: (_principal, bookId) => ({ bookId, permissions: ["book:read"] }),
    listAnnotations: async (_principal, bookId) => ({ schemaVersion: 3, bookId, annotations: [] }),
    getProgress: async (_principal, bookId) => ({ bookId, anchorId: null }),
    createBookUpload: async (_principal, bookId, metadata) => {
      calls.push(["createBookUpload", bookId, metadata]);
      return { upload: { id: "upload-1", bookId, filename: metadata.filename, uploadUrl: "/api/uploads/upload-1?secret=once", expiresAt: "2026-07-15T22:00:00.000Z" } };
    },
    validateBookUpload: async (_principal, bookId, uploadId) => {
      calls.push(["validateBookUpload", bookId, uploadId]);
      return { revision: { id: "rev-b1", state: "ready" } };
    },
    publishBookRevision: async (_principal, bookId, revisionId) => {
      calls.push(["publishBookRevision", bookId, revisionId]);
      return { book: { id: bookId, status: "active", activeRevisionId: revisionId }, revision: { id: revisionId, state: "published" } };
    },
    listBookRevisions: async (_principal, bookId) => [{ id: "rev-b1", bookId, status: "ready" }],
    archiveBook: async (_principal, bookId) => ({ id: bookId, status: "archived" }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let requestNumber = 0;
  let monotonicTime = 0;
  const mcp = createPagedBookMcpServer({
    service,
    principal: { kind: "token", tokenId: "token-1" },
    logger: createOperationalLogger({ sink: (_line, record) => logRecords.push(record) }),
    createRequestId: () => `mcp-request-${++requestNumber}`,
    monotonicClock: () => ++monotonicTime,
  });
  const client = new Client({ name: "multi-book-mcp-test", version: "1.0.0" }, { capabilities: {} });

  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.get("list_annotations").inputSchema.required.includes("bookId"), true);
    assert.deepEqual(byName.get("delete_annotation").annotations, {
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    });
    assert.deepEqual(byName.get("list_books").annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    assert.deepEqual(byName.get("validate_book_upload").annotations, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
    assert.deepEqual(byName.get("record_reading_progress").annotations, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
    assert.equal(MCP_TOOL_CONTRACTS.validate_book_upload.idempotent, false);
    assert.equal(MCP_TOOL_CONTRACTS.record_reading_progress.idempotent, false);
    assert.equal("bundle" in byName.get("create_book_upload").inputSchema.properties, false);
    assert.equal("data" in byName.get("create_book_upload").inputSchema.properties, false);

    const listed = await client.callTool({ name: "list_books", arguments: {} });
    assert.equal(listed.structuredContent.items.length, 2);
    const managedBook = await client.callTool({ name: "get_book", arguments: { bookId: "book-a" } });
    assert.equal(managedBook.isError, undefined, JSON.stringify(managedBook));
    assert.equal(managedBook.structuredContent.book.status, "active");
    const renamed = await client.callTool({ name: "update_book", arguments: { bookId: "book-a", slug: "mit-boglink" } });
    assert.equal(renamed.structuredContent.book.slug, "mit-boglink");
    const missingBook = await client.callTool({ name: "list_annotations", arguments: {} });
    assert.equal(missingBook.isError, true);
    const upload = await client.callTool({ name: "create_book_upload", arguments: {
      bookId: "book-b", filename: "manuscript.tar.gz", contentType: "application/gzip", sizeBytes: 512,
    } });
    assert.equal(upload.structuredContent.upload.uploadUrl, "/api/uploads/upload-1?secret=once");
    const validated = await client.callTool({ name: "validate_book_upload", arguments: { bookId: "book-b", uploadId: "upload-1" } });
    assert.equal(validated.structuredContent.revision.state, "ready");
    await client.callTool({ name: "publish_book_revision", arguments: { bookId: "book-b", revisionId: "rev-b1" } });
    const republished = await client.callTool({ name: "publish_book_revision", arguments: { bookId: "book-b", revisionId: "rev-b1" } });
    assert.equal(republished.isError, undefined, JSON.stringify(republished));
    assert.deepEqual(calls, [
      ["updateBook", "book-a", { slug: "mit-boglink" }],
      ["createBookUpload", "book-b", { filename: "manuscript.tar.gz", contentType: "application/gzip", sizeBytes: 512 }],
      ["validateBookUpload", "book-b", "upload-1"],
      ["publishBookRevision", "book-b", "rev-b1"],
      ["publishBookRevision", "book-b", "rev-b1"],
    ]);

    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === "book://book-a/metadata"), true);
    assert.equal(resources.resources.some((resource) => resource.uri === "pba://contracts/book-bundle/v1"), true);
    assert.equal(resources.resources.some((resource) => resource.uri === "pba://schemas/book-viewer.bundle.v1.json"), true);
    assert.equal(resources.resources.some((resource) => resource.uri === "pba://contracts/admin-ui-mcp-parity/v1"), true);
    const metadata = await client.readResource({ uri: "book://book-a/metadata" });
    assert.match(metadata.contents[0].text, /"title": "Bog A"/);
    const contract = await client.readResource({ uri: "pba://contracts/book-bundle/v1" });
    assert.match(contract.contents[0].text, /bun run bundle init/);
    const schema = await client.readResource({ uri: "pba://schemas/book-viewer.bundle.v1.json" });
    assert.equal(JSON.parse(schema.contents[0].text).properties.schemaVersion.const, 1);
    const parity = await client.readResource({ uri: "pba://contracts/admin-ui-mcp-parity/v1" });
    assert.equal(JSON.parse(parity.contents[0].text).areas.length, ADMIN_UI_MCP_PARITY.areas.length);
    const completions = logRecords.filter((record) => record.event === "mcp.completed");
    assert.equal(new Set(completions.map((record) => record.requestId)).size, completions.length);
    assert.equal(completions.filter((record) => record.operation === "tool:create_book_upload").at(0).bookId, "book-b");
    assert.equal(completions.filter((record) => record.operation === "tool:validate_book_upload").at(0).bookId, "book-b");
    assert.equal(completions.filter((record) => record.operation === "tool:publish_book_revision").at(0).bookId, "book-b");
    assert.equal(completions.filter((record) => record.operation === "resource:book-metadata").at(0).bookId, "book-a");
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

test("MCP output contracts accept superseded surveys and guest/erased identities", async () => {
  const now = "2026-07-16T12:00:00.000Z";
  const target = { kind: "section", anchorId: "chapter-1", contextStartAnchorId: null, pageNumberHint: 1, revisionId: "rev-1", label: "Kapitel 1" };
  const definition = {
    schemaVersion: 1, title: "Feedback", description: "", target, trigger: { mode: "manual" },
    questions: [{ id: "clarity", type: "rating", prompt: "Klart?", helpText: "", required: true, scale: { min: 1, max: 5, minLabel: "Nej", maxLabel: "Ja" } }],
  };
  const survey = {
    id: "survey-1", bookId: "book-a", status: "published", publishedVersion: 2, draftVersion: null,
    published: { version: 2, state: "published", definition, createdAt: now, publishedAt: now }, draft: null,
    versions: [
      { version: 1, state: "superseded", definition, createdAt: now, publishedAt: now },
      { version: 2, state: "published", definition, createdAt: now, publishedAt: now },
    ],
    createdAt: now, updatedAt: now, publishedAt: now, closedAt: null,
  };
  const response = {
    id: "response-1", surveyId: "survey-1", surveyVersion: 2, bookId: "book-a", revisionId: "rev-1",
    respondent: { kind: "guest", ref: "guest:opaque", userId: null, displayName: null }, target,
    answers: [{ questionId: "clarity", value: 4 }], submittedAt: now, updatedAt: now,
  };
  const annotation = {
    id: "annotation-1", bookId: "book-a", revisionId: "rev-1", type: "page",
    target: { scopeId: "chapter-1", pageNumber: 1 }, comment: "Slettet bruger", author: { kind: "erased", id: null, displayName: null },
    status: "open", category: "general", anchorState: "attached", visibility: "reviewGroup", createdAt: now, updatedAt: now,
  };
  const service = {
    listBooks: async () => ({ books: [{ id: "book-a", status: "active" }] }),
    listSurveys: async () => [survey],
    listSurveyResponses: async () => [response],
    listAnnotations: async () => ({ schemaVersion: 4, bookId: "book-a", updatedAt: now, annotations: [annotation] }),
    listChangesSince: async () => ({
      bookId: "book-a", buildId: "build-1", since: now, nextCursor: null,
      items: [
        { type: "annotation.upsert", changedAt: now, annotation },
        { type: "annotation.deleted", changedAt: now, annotationId: "annotation-deleted" },
      ],
    }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createPagedBookMcpServer({ service, principal: { kind: "token", tokenId: "token-1" } });
  const client = new Client({ name: "identity-contract-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const surveys = await client.callTool({ name: "list_surveys", arguments: { bookId: "book-a" } });
    assert.equal(surveys.isError, undefined, JSON.stringify(surveys));
    assert.equal(surveys.structuredContent.surveys[0].versions[0].state, "superseded");
    const responses = await client.callTool({ name: "list_survey_responses", arguments: { bookId: "book-a" } });
    assert.equal(responses.structuredContent.responses[0].respondent.kind, "guest");
    const annotations = await client.callTool({ name: "list_annotations", arguments: { bookId: "book-a" } });
    assert.equal(annotations.structuredContent.annotations[0].author.kind, "erased");
    const changes = await client.callTool({ name: "list_changes_since", arguments: { bookId: "book-a" } });
    assert.equal(changes.isError, undefined, JSON.stringify(changes));
    assert.deepEqual(changes.structuredContent.items.map((item) => item.type), ["annotation.upsert", "annotation.deleted"]);
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

test("MCP output contracts match persisted revision, tracking-off and erased-user states", () => {
  assert.equal(MCP_TOOL_OUTPUT_SCHEMAS.validate_book_upload.parse({
    revision: { id: "revision-1", state: "ready" },
  }).revision.state, "ready");
  assert.equal(MCP_TOOL_OUTPUT_SCHEMAS.record_reading_progress.parse({ progress: null }).progress, null);
  const erased = MCP_TOOL_OUTPUT_SCHEMAS.list_users.parse({ items: [{
    id: "user-erased", email: "erased@example.test", displayName: "Slettet bruger",
    globalRole: "user", status: "erased",
  }] });
  assert.equal(erased.items[0].status, "erased");
});

test("stdio revalidates its token per call and supports persisted upload staging", async () => {
  let active = true;
  let resolutions = 0;
  const principalProvider = async () => {
    resolutions += 1;
    if (!active) throw Object.assign(new Error("Tokenet er tilbagekaldt."), { status: 401, code: "token_revoked" });
    return { kind: "token", tokenId: "token-1" };
  };
  const service = {
    listBooks: async () => ({ books: [{ id: "book-a", status: "active" }] }),
    createBookUpload: async (_principal, bookId, metadata) => ({ upload: {
      id: "upload-1", bookId, filename: metadata.filename,
      uploadUrl: `/api/admin/books/${bookId}/uploads/upload-1/content`, expiresAt: "2026-07-16T13:00:00.000Z",
    } }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const principal = await principalProvider();
  const mcp = createPagedBookMcpServer({ service, principal, principalProvider, transport: "stdio" });
  const client = new Client({ name: "stdio-token-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal((await client.callTool({ name: "list_books", arguments: {} })).isError, undefined);
    const upload = await client.callTool({ name: "create_book_upload", arguments: { bookId: "book-a", filename: "book.tar.gz", contentType: "application/gzip" } });
    assert.equal(upload.isError, undefined, JSON.stringify(upload));
    assert.equal(upload.structuredContent.upload.id, "upload-1");
    active = false;
    const revoked = await client.callTool({ name: "list_books", arguments: {} });
    assert.equal(revoked.isError, true);
    assert.equal(revoked.structuredContent.error.code, "forbidden");
    assert.equal(resolutions, 4);
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

test("legacy MCP metadata requires read permission", async () => {
  const service = {
    bookId: "legacy-book",
    assertCanRead() { throw Object.assign(new Error("Ingen læseadgang."), { status: 403, code: "forbidden" }); },
    session: () => ({ principal: null, capabilities: { permissions: [] } }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createPagedBookMcpServer({
    service,
    principal: { kind: "token", tokenId: "metadata-denied" },
    config: { book: { id: "legacy-book", title: "Privat bog" } },
  });
  const client = new Client({ name: "legacy-authz-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.callTool({ name: "list_books", arguments: {} });
    assert.equal(listed.isError, true);
    assert.equal(listed.structuredContent.error.code, "forbidden");
    const fetched = await client.callTool({ name: "get_book", arguments: { bookId: "legacy-book" } });
    assert.equal(fetched.isError, true);
    assert.equal(fetched.structuredContent.error.code, "forbidden");
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

test("MCP contracts are complete, reject no-op writes, scope token revocation, and mask internals", async () => {
  assert.deepEqual(Object.keys(MCP_TOOL_OUTPUT_SCHEMAS).sort(), Object.keys(MCP_TOOL_CONTRACTS).sort());
  const parityTools = ADMIN_UI_MCP_PARITY.areas.flatMap((area) => area.tools).sort();
  assert.deepEqual(parityTools, Object.keys(MCP_TOOL_CONTRACTS).sort());
  assert.equal(mcpToolError(Object.assign(new Error("unprocessable"), { status: 422 }), { requestId: "request-1" }).error.code, "invalid_input");
  const masked = mcpToolError(new Error("database password leaked"), { requestId: "request-2" });
  assert.equal(masked.error.code, "internal_error");
  assert.doesNotMatch(masked.error.message, /password/);

  const calls = [];
  const service = {
    listBooks: async () => ({ books: [{ id: "book-b", status: "active" }] }),
    revokeToken: async (_principal, id, options) => { calls.push([id, options]); return true; },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createPagedBookMcpServer({ service, principal: { kind: "token", tokenId: "admin-token" } });
  const client = new Client({ name: "adversarial-contract-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getServerVersion().version, (await Bun.file(new URL("../../package.json", import.meta.url)).json()).version);
    const noAnnotationChanges = await client.callTool({ name: "update_annotation", arguments: { bookId: "book-b", id: "annotation-1", changes: {} } });
    assert.equal(noAnnotationChanges.isError, true);
    assert.equal(noAnnotationChanges.structuredContent, undefined);
    const noUserChanges = await client.callTool({ name: "update_user_access", arguments: { userId: "user-1" } });
    assert.equal(noUserChanges.isError, true);
    assert.equal(noUserChanges.structuredContent, undefined);
    const revoked = await client.callTool({ name: "revoke_service_token", arguments: { id: "token-b", bookId: "book-b" } });
    assert.equal(revoked.structuredContent.revoked, true);
    assert.deepEqual(calls, [["token-b", { bookId: "book-b" }]]);
    assert.match(MCP_TOOL_CONTRACTS.update_user_access.authorization.conditional, /må ikke overstige/);
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

test("every machine-readable tool example passes SDK input validation", async () => {
  const serviceFailure = Object.assign(new Error("Example reached the service boundary."), { status: 409 });
  // agent-lint: disable=AR004 -- A proxy is the test double that proves every generated tool reaches the same explicit service seam.
  const service = new Proxy({}, {
    get: () => async () => { throw serviceFailure; },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createPagedBookMcpServer({ service, principal: { kind: "token", tokenId: "example-token" } });
  const client = new Client({ name: "contract-example-test", version: "1.0.0" }, { capabilities: {} });

  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    for (const [name, contract] of Object.entries(MCP_TOOL_CONTRACTS)) {
      const response = await client.callTool({ name, arguments: contract.exampleArguments });
      assert.doesNotMatch(response.content?.[0]?.text ?? "", /Input validation error|Invalid arguments/i, `${name} has an invalid example`);
    }

    const invalidAnnotation = await client.callTool({
      name: "create_annotation",
      arguments: {
        bookId: "book-id",
        type: "element",
        target: {
          scopeId: "chapter-1",
          pageNumber: 1,
          selector: { type: "TextQuoteSelector", exact: "Må ikke være her" },
        },
        comment: "Ugyldig elementannotation",
      },
    });
    assert.equal(invalidAnnotation.isError, true);
    assert.equal(invalidAnnotation.structuredContent, undefined);
    assert.match(invalidAnnotation.content[0].text, /Input validation error/i);

    const invalidToken = await client.callTool({ name: "create_service_token", arguments: { name: "Manglende grants" } });
    assert.equal(invalidToken.isError, true);
    assert.equal(invalidToken.structuredContent, undefined);
    assert.match(invalidToken.content[0].text, /Input validation error/i);
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});
