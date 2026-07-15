import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBookViewerServer, loadBookViewerConfig } from "../../server.mjs";
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
    const outline = await client.callTool({ name: "list_book_outline", arguments: {} });
    assert.equal(outline.structuredContent.items[0].anchorId, "chapter-1");
    const search = await client.callTool({ name: "search_book", arguments: { query: "prøveafsnit" } });
    assert.equal(search.structuredContent.items[0].anchorId, "chapter-1.p-1");
    const created = await client.callTool({ name: "create_annotation", arguments: {
      type: "page", comment: "Agentnote", target: { pageNumber: 1, scopeId: "front" }, visibility: "reviewGroup",
    } });
    assert.equal(created.isError, undefined);
    const listed = await client.callTool({ name: "list_annotations", arguments: {} });
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
