import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";

import { startBookViewer, stopBookViewer } from "../../server.mjs";

function jsonRequest(method, body, cookie = "") {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  };
}

async function responseJson(response) {
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error);
  return payload;
}

test("managed HTTP library uploads, publishes and isolates a code-enrolled second book", async () => {
  const root = await mkdtemp(join(tmpdir(), "pba-managed-http-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config.json");
  await mkdir(dataDir);
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    library: { dataDir, catalogDatabase: join(dataDir, "catalog.sqlite"), defaultBookId: "bootstrap", uploadMaxBytes: 5_000_000 },
    book: {
      id: "bootstrap",
      title: "Bootstrap",
      sourceDir: resolve(import.meta.dir, "../../example/book"),
      document: "book.html",
      navigation: "navigation.xhtml",
    },
    annotations: { file: join(dataDir, "legacy.annotations.json") },
    collaboration: { database: join(dataDir, "collaboration.sqlite") },
    access: { preset: "local" },
    logging: { level: "silent" },
  }));
  await writeFile(join(dataDir, "legacy.annotations.json"), JSON.stringify({
    schemaVersion: 3,
    bookId: "bootstrap",
    updatedAt: "2026-01-01T00:00:00.000Z",
    annotations: [],
  }));

  const running = await startBookViewer({ configPath });
  const base = running.server.url.origin;
  try {
    const initial = await responseJson(await fetch(`${base}/api/admin/books`));
    assert.deepEqual(initial.books.map((book) => book.id), ["bootstrap"]);
    await responseJson(await fetch(`${base}/api/books/bootstrap/annotations`));
    assert.equal(await Bun.file(join(dataDir, "library/bootstrap/annotations.json")).json().then((document) => document.schemaVersion), 4);
    const created = await responseJson(await fetch(`${base}/api/admin/books`, jsonRequest("POST", { id: "second", slug: "second", title: "Anden bog" })));
    assert.equal(created.book.activeRevisionId, null);

    const archiveBytes = await new Bun.Archive({
      "book-viewer.json": JSON.stringify({ schemaVersion: 1, book: { id: "second", title: "Anden bog", document: "book.html" } }),
      "book.html": '<!doctype html><html><body><p data-book-anchor="second.chapter" data-annotation-text>Anden tekst</p></body></html>',
    }).bytes();
    const archive = Bun.gzipSync(archiveBytes);
    const upload = await responseJson(await fetch(`${base}/api/admin/books/second/uploads`, jsonRequest("POST", { filename: "second.tar.gz", sizeBytes: archive.byteLength })));
    await responseJson(await fetch(`${base}${upload.upload.uploadUrl}`, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: archive }));
    const validated = await responseJson(await fetch(`${base}/api/admin/books/second/uploads/${upload.upload.id}/validate`, jsonRequest("POST", {})));
    assert.equal(validated.revision.state, "ready");
    const published = await responseJson(await fetch(`${base}/api/admin/books/second/revisions/${validated.revision.id}/publish`, jsonRequest("POST", {})));
    assert.equal(published.book.activeRevisionId, validated.revision.id);

    const publicConfig = await responseJson(await fetch(`${base}/api/books/second/config`));
    assert.equal(publicConfig.book.documentUrl, "/books/second/assets/book.html");
    assert.match(await fetch(`${base}/books/second/assets/book.html`).then((response) => response.text()), /Anden tekst/);

    await responseJson(await fetch(`${base}/api/admin/users`, jsonRequest("POST", {
      email: "admin@example.test",
      displayName: "Administrator",
      password: "administrator-password",
      globalRole: "instance_admin",
      bookId: "second",
      bookRole: "book_admin",
    })));
    await responseJson(await fetch(`${base}/api/admin/books/second/access`, jsonRequest("PUT", { preset: "privateReview", registration: "code" })));
    const accessCode = await responseJson(await fetch(`${base}/api/admin/books/second/access-codes`, jsonRequest("POST", { name: "Prøvelæsere", role: "reviewer", maxUses: 2 })));
    const enrolledResponse = await fetch(`${base}/api/books/second/auth/access-codes/accept`, jsonRequest("POST", {
      bookId: "second",
      accessCode: accessCode.accessCode.secret,
      displayName: "Prøvelæser",
      email: "reader@example.test",
      password: "reader-password",
    }));
    const enrolled = await responseJson(enrolledResponse);
    assert.equal(enrolled.principal.displayName, "Prøvelæser");
    const sessionCookie = enrolledResponse.headers.get("set-cookie").split(";")[0];
    const readerConfig = await responseJson(await fetch(`${base}/api/books/second/config`, { headers: { Cookie: sessionCookie } }));
    assert.equal(readerConfig.session.capabilities.canRead, true);
    assert.equal(readerConfig.session.capabilities.canCreateAnnotations, true);

    const annotation = await responseJson(await fetch(`${base}/api/books/second/annotations`, jsonRequest("POST", {
      type: "page",
      comment: "Kun i anden bog",
      target: { pageNumber: 1, scopeId: "second.chapter" },
    }, sessionCookie)));
    assert.equal(annotation.revisionId, validated.revision.id);
    const bootstrapAnnotations = await responseJson(await fetch(`${base}/api/books/bootstrap/annotations`));
    assert.equal(bootstrapAnnotations.annotations.length, 0);
    const accountExport = await responseJson(await fetch(`${base}/api/books/second/account/export`, { headers: { Cookie: sessionCookie } }));
    assert.equal(accountExport.annotations.length, 1);
    await responseJson(await fetch(`${base}/api/books/second/account`, { method: "DELETE", headers: { Cookie: sessionCookie } }));
    const erasedAnnotations = await responseJson(await fetch(`${base}/api/admin/books/second/annotations`));
    assert.equal(erasedAnnotations.annotations[0].author.kind, "erased");
  } finally {
    await stopBookViewer(running.server);
    await rm(root, { recursive: true, force: true });
  }
});
