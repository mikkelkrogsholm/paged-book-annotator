import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startBookViewer, stopBookViewer } from "../../server.mjs";
import { createOperationalLogger } from "./operational-logger.mjs";

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

test("an instance administrator can log in and create the first book in an empty managed library", async () => {
  const root = await mkdtemp(join(tmpdir(), "pba-empty-managed-http-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config.json");
  await mkdir(dataDir);
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    library: { dataDir, catalogDatabase: join(dataDir, "catalog.sqlite") },
    collaboration: { database: join(dataDir, "collaboration.sqlite") },
    access: { preset: "privateReview" },
    logging: { level: "silent" },
  }));

  const running = await startBookViewer({ configPath });
  const base = running.server.url.origin;
  const mcpClient = new Client({ name: "empty-library-bootstrap-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await running.platform.collaboration.ensureBootstrapAdmin({
      email: "owner@example.test",
      displayName: "Owner",
      password: "owner-password",
    });
    const emptyConfig = await responseJson(await fetch(`${base}/api/config`));
    assert.equal(emptyConfig.book, null);

    const loginResponse = await fetch(`${base}/api/auth/login`, jsonRequest("POST", {
      email: "owner@example.test",
      password: "owner-password",
    }));
    const login = await responseJson(loginResponse);
    assert.equal(login.principal.globalRole, "instance_admin");
    assert.equal(login.capabilities.canManageUsers, true);
    const sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];

    const initialBooks = await responseJson(await fetch(`${base}/api/admin/books`, { headers: { Cookie: sessionCookie } }));
    assert.deepEqual(initialBooks.books, []);
    const tokenResponse = await fetch(`${base}/api/admin/tokens`, jsonRequest("POST", {
      name: "Bootstrap-agent",
      instanceAdmin: "true",
      expiresInHours: 1,
    }, sessionCookie));
    const adminToken = (await responseJson(tokenResponse)).token;
    assert.equal(adminToken.instanceAdmin, true);
    assert.deepEqual(adminToken.bookGrants, []);

    await mcpClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { Authorization: `Bearer ${adminToken.secret}` } },
    }));
    const created = await mcpClient.callTool({ name: "create_book", arguments: {
      slug: "first-book",
      title: "Første bog",
    } });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    assert.equal(created.structuredContent.book.id, "first-book");
    const renamed = await mcpClient.callTool({ name: "update_book", arguments: {
      bookId: "first-book",
      slug: "mit-eget-boglink",
    } });
    assert.equal(renamed.isError, undefined, JSON.stringify(renamed));
    assert.equal(renamed.structuredContent.book.slug, "mit-eget-boglink");
    const upload = await mcpClient.callTool({ name: "create_book_upload", arguments: {
      bookId: "first-book",
      filename: "first-book.tar.gz",
      contentType: "application/gzip",
      sizeBytes: 1024,
    } });
    assert.equal(upload.isError, undefined, JSON.stringify(upload));
    assert.match(upload.structuredContent.upload.uploadUrl, /^\/api\/admin\/books\/first-book\/uploads\//);
  } finally {
    await mcpClient.close().catch(() => {});
    await stopBookViewer(running.server);
    await rm(root, { recursive: true, force: true });
  }
});

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

  const logRecords = [];
  const logger = createOperationalLogger({ sink: (_line, record) => logRecords.push(record) });
  const running = await startBookViewer({ configPath, logger });
  const base = running.server.url.origin;
  try {
    const initial = await responseJson(await fetch(`${base}/api/admin/books`));
    assert.deepEqual(initial.books.map((book) => book.id), ["bootstrap"]);
    const libraryConfig = await responseJson(await fetch(`${base}/api/config`));
    assert.equal(libraryConfig.book, null);
    const metadata = await responseJson(await fetch(`${base}/api/admin/metadata?bookId=bootstrap`));
    assert.equal(metadata.accessPresets.includes("privateReview"), true);
    await responseJson(await fetch(`${base}/api/books/bootstrap/annotations`));
    assert.equal(await Bun.file(join(dataDir, "library/bootstrap/annotations.json")).json().then((document) => document.schemaVersion), 4);
    const created = await responseJson(await fetch(`${base}/api/admin/books`, jsonRequest("POST", { id: "second", slug: "second", title: "Anden bog" })));
    assert.equal(created.book.activeRevisionId, null);

    const archiveBytes = await new Bun.Archive({
      "book-viewer.json": JSON.stringify({ schemaVersion: 1, book: { id: "second", title: "Anden bog", document: "book.html" } }),
      "book.html": '<!doctype html><html data-paged-complete="true"><body data-pre-paginated="true"><main class="pagedjs_pages"><section class="pagedjs_page"><p data-book-anchor="second.chapter" data-annotation-text>Anden tekst</p></section></main></body></html>',
    }).bytes();
    const archive = Bun.gzipSync(archiveBytes);
    const upload = await responseJson(await fetch(`${base}/api/admin/books/second/uploads`, jsonRequest("POST", { filename: "second.tar.gz", sizeBytes: archive.byteLength })));
    await responseJson(await fetch(`${base}${upload.upload.uploadUrl}`, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: archive }));
    const validated = await responseJson(await fetch(`${base}/api/admin/books/second/uploads/${upload.upload.id}/validate`, jsonRequest("POST", {})));
    assert.equal(validated.revision.state, "ready");
    const published = await responseJson(await fetch(`${base}/api/admin/books/second/revisions/${validated.revision.id}/publish`, jsonRequest("POST", {})));
    assert.equal(published.book.activeRevisionId, validated.revision.id);

    const publicConfig = await responseJson(await fetch(`${base}/api/books/second/config`));
    assert.equal(publicConfig.book.documentUrl, `/books/second/revisions/${validated.revision.id}/assets/book.html`);
    const revisionAsset = await fetch(`${base}${publicConfig.book.documentUrl}`);
    assert.equal(revisionAsset.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.match(await revisionAsset.text(), /Anden tekst/);
    const eagerViewer = await fetch(`${base}/books/second`);
    const eagerHtml = await eagerViewer.text();
    assert.equal(eagerViewer.headers.get("cache-control"), "no-store");
    assert.match(eagerHtml, /id="viewerBootstrap" type="application\/json"/);
    assert.match(eagerHtml, new RegExp(`src="/books/second/revisions/${validated.revision.id}/assets/book\\.html" loading="eager"`));

    const renamed = await responseJson(await fetch(`${base}/api/admin/books/second`, jsonRequest("PATCH", { slug: "min-anden-bog" })));
    assert.equal(renamed.book.id, "second");
    assert.equal(renamed.book.slug, "min-anden-bog");
    const historicalLink = await fetch(`${base}/books/second?login=1`, { redirect: "manual" });
    assert.equal(historicalLink.status, 308);
    assert.equal(historicalLink.headers.get("location"), `${base}/books/min-anden-bog?login=1`);
    assert.equal((await fetch(`${base}/books/min-anden-bog`)).status, 200);

    await responseJson(await fetch(`${base}/api/admin/users`, jsonRequest("POST", {
      email: "admin@example.test",
      displayName: "Administrator",
      password: "administrator-password",
      globalRole: "instance_admin",
      bookId: "second",
      bookRole: "book_admin",
    })));
    await responseJson(await fetch(`${base}/api/admin/books/second/access`, jsonRequest("PUT", { preset: "privateReview", registration: "code" })));
    const gatedHtml = await fetch(`${base}/books/min-anden-bog`).then((response) => response.text());
    assert.match(gatedHtml, /id="viewerBootstrap"/);
    assert.doesNotMatch(gatedHtml, /src="\/books\/second\/revisions\//);
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
    const authorizedHtml = await fetch(`${base}/books/min-anden-bog`, { headers: { Cookie: sessionCookie } }).then((response) => response.text());
    assert.match(authorizedHtml, new RegExp(`src="/books/second/revisions/${validated.revision.id}/assets/book\\.html" loading="eager"`));

    const annotation = await responseJson(await fetch(`${base}/api/books/second/annotations`, jsonRequest("POST", {
      type: "page",
      comment: "Kun i anden bog",
      target: { pageNumber: 1, scopeId: "second.chapter" },
    }, sessionCookie)));
    assert.equal(annotation.revisionId, validated.revision.id);
    const surveyDraft = await responseJson(await fetch(`${base}/api/admin/books/second/surveys`, jsonRequest("POST", {
      schemaVersion: 1,
      title: "Feedback på anden bog",
      description: "",
      target: { kind: "section", anchorId: "second.chapter", pageNumberHint: 1, label: "Anden tekst" },
      trigger: { mode: "afterLeave" },
      questions: [{ id: "clarity", type: "rating", prompt: "Hvor let var teksten?", required: true, scale: { min: 1, max: 5, minLabel: "Svær", maxLabel: "Let" } }],
    })));
    assert.equal(surveyDraft.survey.status, "draft");
    const publishedSurvey = await responseJson(await fetch(`${base}/api/admin/books/second/surveys/${surveyDraft.survey.id}/publish`, jsonRequest("POST", {})));
    assert.equal(publishedSurvey.survey.published.definition.target.revisionId, validated.revision.id);
    const activeSurveys = await responseJson(await fetch(`${base}/api/books/second/surveys`, { headers: { Cookie: sessionCookie } }));
    assert.equal(activeSurveys.surveys.length, 1);
    const surveyResponse = await responseJson(await fetch(`${base}/api/books/second/surveys/${surveyDraft.survey.id}/response`, jsonRequest("PUT", {
      answers: [{ questionId: "clarity", value: 5 }],
    }, sessionCookie)));
    assert.equal(surveyResponse.response.answers[0].value, 5);
    const adminSurveyResponses = await responseJson(await fetch(`${base}/api/admin/books/second/survey-responses`));
    assert.equal(adminSurveyResponses.responses.length, 1);
    const reviewExport = await responseJson(await fetch(`${base}/api/admin/books/second/review-export`));
    assert.equal(reviewExport.kind, "paged-book-review-export");
    assert.equal(reviewExport.surveyResponses.length, 1);
    assert.equal(reviewExport.readingProgress.included, false);
    const bootstrapAnnotations = await responseJson(await fetch(`${base}/api/books/bootstrap/annotations`));
    assert.equal(bootstrapAnnotations.annotations.length, 0);
    const accountExport = await responseJson(await fetch(`${base}/api/books/second/account/export`, { headers: { Cookie: sessionCookie } }));
    assert.equal(accountExport.annotations.length, 1);
    assert.equal(accountExport.surveyResponses.length, 1);
    await responseJson(await fetch(`${base}/api/books/second/account`, { method: "DELETE", headers: { Cookie: sessionCookie } }));
    const erasedAnnotations = await responseJson(await fetch(`${base}/api/admin/books/second/annotations`));
    assert.equal(erasedAnnotations.annotations[0].author.kind, "erased");
    assert.equal((await responseJson(await fetch(`${base}/api/admin/books/second/survey-responses`))).responses.length, 0);

    const audit = await responseJson(await fetch(`${base}/api/admin/books/second/audit`));
    const actions = new Set(audit.events.map((event) => event.action));
    for (const action of [
      "book_revision.validate", "book_revision.publish", "access.update",
      "access_code.create", "access_code.accept", "annotation.create",
      "survey.create", "survey.publish", "survey_response.submit", "review_export.create",
    ]) assert.equal(actions.has(action), true, `Manglende audit-event: ${action}`);
    assert.equal(running.platform.collaboration.database.query(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.erase' AND book_id IS NULL",
    ).get().count, 1);

    const completions = logRecords.filter((record) => record.event === "request.completed");
    assert.equal(new Set(completions.map((record) => record.requestId)).size, completions.length);
    for (const path of [
      "/api/admin/books/:bookId/uploads/:id/content",
      "/api/admin/books/:bookId/uploads/:id/validate",
      "/api/admin/books/:bookId/revisions/:id/publish",
      "/api/books/:bookId/annotations",
    ]) {
      assert.equal(completions.some((record) => record.path === path && record.bookId === "second"), true, `Manglende logkontekst: ${path}`);
    }
    assert.doesNotMatch(JSON.stringify(logRecords), /admin@example\.test|reader@example\.test|Kun i anden bog|Prøvelæser/);
  } finally {
    await stopBookViewer(running.server);
    await rm(root, { recursive: true, force: true });
  }
});
