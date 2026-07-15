import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBookViewerServer, loadBookViewerConfig } from "../../server.mjs";
import { createPagedBookMcpServer } from "./mcp-server.mjs";
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
      name: "Testagent", scopes: ["books:read", "annotations:read", "annotations:write"], expiresInHours: 1,
    });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token.secret}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "list_annotations"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "search_book"), true);
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
    const forbidden = await client.callTool({ name: "list_users", arguments: {} });
    assert.equal(forbidden.isError, true);
    assert.deepEqual(
      logRecords.filter((record) => record.event === "mcp.completed").map((record) => record.operation),
      ["tool:list_book_outline", "tool:search_book", "tool:create_annotation", "tool:list_annotations", "tool:list_users"],
    );
    assert.equal(logRecords.some((record) => record.event === "mcp.failed" && record.operation === "tool:list_users"), true);
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
  const books = [
    { id: "book-a", title: "Bog A", status: "published", activeRevisionId: "rev-a1" },
    { id: "book-b", title: "Bog B", status: "draft", activeRevisionId: null },
  ];
  const service = {
    listBooks: async () => ({ books }),
    getBook: async (_principal, bookId) => books.find((book) => book.id === bookId),
    sessionForBook: (_principal, bookId) => ({ bookId, permissions: ["book:read"] }),
    listAnnotations: async (_principal, bookId) => ({ schemaVersion: 3, bookId, annotations: [] }),
    getProgress: async (_principal, bookId) => ({ bookId, anchorId: null }),
    createBookUpload: async (_principal, bookId, metadata) => {
      calls.push(["createBookUpload", bookId, metadata]);
      return { upload: { id: "upload-1", uploadUrl: "/api/uploads/upload-1?secret=once", expiresAt: "2026-07-15T22:00:00.000Z" } };
    },
    validateBookUpload: async (_principal, bookId, uploadId) => {
      calls.push(["validateBookUpload", bookId, uploadId]);
      return { revision: { id: "rev-b1", status: "ready" } };
    },
    publishBookRevision: async (_principal, bookId, revisionId) => {
      calls.push(["publishBookRevision", bookId, revisionId]);
      return { book: { id: bookId, activeRevisionId: revisionId } };
    },
    listBookRevisions: async (_principal, bookId) => ({ revisions: [{ id: "rev-b1", bookId, status: "ready" }] }),
    archiveBook: async (_principal, bookId) => ({ id: bookId, status: "archived" }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createPagedBookMcpServer({ service, principal: { kind: "token", tokenId: "token-1" } });
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
    assert.equal("bundle" in byName.get("create_book_upload").inputSchema.properties, false);
    assert.equal("data" in byName.get("create_book_upload").inputSchema.properties, false);

    const listed = await client.callTool({ name: "list_books", arguments: {} });
    assert.equal(listed.structuredContent.items.length, 2);
    const missingBook = await client.callTool({ name: "list_annotations", arguments: {} });
    assert.equal(missingBook.isError, true);
    const upload = await client.callTool({ name: "create_book_upload", arguments: {
      bookId: "book-b", filename: "manuscript.tar.gz", contentType: "application/gzip", sizeBytes: 512,
    } });
    assert.equal(upload.structuredContent.upload.uploadUrl, "/api/uploads/upload-1?secret=once");
    const validated = await client.callTool({ name: "validate_book_upload", arguments: { bookId: "book-b", uploadId: "upload-1" } });
    assert.equal(validated.structuredContent.revision.status, "ready");
    await client.callTool({ name: "publish_book_revision", arguments: { bookId: "book-b", revisionId: "rev-b1" } });
    assert.deepEqual(calls, [
      ["createBookUpload", "book-b", { filename: "manuscript.tar.gz", contentType: "application/gzip", sizeBytes: 512 }],
      ["validateBookUpload", "book-b", "upload-1"],
      ["publishBookRevision", "book-b", "rev-b1"],
    ]);

    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === "book://book-a/metadata"), true);
    const metadata = await client.readResource({ uri: "book://book-a/metadata" });
    assert.match(metadata.contents[0].text, /"title": "Bog A"/);
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});
