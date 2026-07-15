import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { createBookViewerServer, loadBookViewerConfig } from "../../server.mjs";

test("server exposes config, book assets and persistent annotation CRUD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-server-"));
  const bookDirectory = join(directory, "book");
  await mkdir(bookDirectory);
  await writeFile(join(bookDirectory, "book.html"), "<!doctype html><title>Testbog</title>", "utf8");
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    book: {
      id: "server-test",
      title: "Testbog",
      sourceDir: "book",
      document: "book.html",
      navigation: "navigation.xhtml",
      paginationTimeoutMs: 120_000,
    },
    annotations: { file: "annotations.json" }, logging: { level: "silent" },
  }), "utf8");

  const config = await loadBookViewerConfig(configPath);
  const server = createBookViewerServer({ config, hostname: "127.0.0.1", port: 0 });
  const baseUrl = server.url.origin;

  try {
    const publicConfig = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
    assert.equal(publicConfig.runtime.name, "Bun");
    assert.equal(publicConfig.book.id, "server-test");
    assert.equal(publicConfig.book.documentUrl, "/book/book.html");
    assert.equal(publicConfig.book.navigationUrl, "/book/navigation.xhtml");
    assert.equal(publicConfig.book.paginationTimeoutMs, 120_000);
    assert.equal(publicConfig.access.preset, "local");
    assert.equal(publicConfig.session.capabilities.canManageUsers, true);

    const adminResponse = await fetch(`${baseUrl}/admin`);
    assert.equal(adminResponse.status, 200);
    assert.match(await adminResponse.text(), /Service-tokens/);
    const metadata = await fetch(`${baseUrl}/api/admin/metadata`).then((response) => response.json());
    assert.equal(metadata.accessPresets.includes("privateReview"), true);

    const bookResponse = await fetch(`${baseUrl}/book/book.html`);
    assert.equal(bookResponse.status, 200);
    assert.match(await bookResponse.text(), /Testbog/);

    const viewerHeadResponse = await fetch(`${baseUrl}/preview.html`, { method: "HEAD" });
    assert.equal(viewerHeadResponse.status, 200);
    assert.equal(await viewerHeadResponse.text(), "");

    const bookHeadResponse = await fetch(`${baseUrl}/book/book.html`, { method: "HEAD" });
    assert.equal(bookHeadResponse.status, 200);

    const foreignOriginResponse = await fetch(`${baseUrl}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.org" },
      body: JSON.stringify({ type: "page", comment: "Afvis mig", target: { pageNumber: 1 } }),
    });
    assert.equal(foreignOriginResponse.status, 403);

    const unauthorizedMcp = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthorizedMcp.status, 401);

    const createdResponse = await fetch(`${baseUrl}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "element",
        comment: "Flyt overskriften.",
        target: { scopeId: "chapter-1.title", pageNumber: 1, label: "Kapiteloverskrift" },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const resolved = await fetch(`${baseUrl}/api/annotations/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    }).then((response) => response.json());
    assert.equal(resolved.status, "resolved");

    const reopened = await fetch(`${baseUrl}/api/annotations/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    }).then((response) => response.json());
    assert.equal(reopened.status, "open");

    const exported = await fetch(`${baseUrl}/api/annotations/export`).then((response) => response.json());
    assert.equal(exported.annotations.length, 1);

    const imported = await fetch(`${baseUrl}/api/annotations/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: exported, mode: "replace" }),
    }).then((response) => response.json());
    assert.equal(imported.annotations[0].id, created.id);

    const deletedResponse = await fetch(`${baseUrl}/api/annotations/${created.id}`, { method: "DELETE" });
    assert.equal(deletedResponse.status, 200);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration supports an empty managed library without a mounted bootstrap book", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-library-config-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    library: { dataDir: "managed-data", uploadMaxBytes: 5_000_000 },
    access: { preset: "privateReview" },
  }));
  try {
    const config = await loadBookViewerConfig(configPath);
    assert.equal(config.book, null);
    assert.equal(config.library.defaultBookId, "");
    assert.equal(config.library.dataDir, join(directory, "managed-data"));
    assert.equal(config.library.catalogDatabase, join(directory, "managed-data/catalog.sqlite"));
    assert.equal(config.collaboration.database, join(directory, "managed-data/collaboration.sqlite"));
    assert.equal(config.library.uploadMaxBytes, 5_000_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
