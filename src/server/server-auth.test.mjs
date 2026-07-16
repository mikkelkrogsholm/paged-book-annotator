import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { createBookViewerServer, handleBookViewerRequest, loadBookViewerConfig } from "../../server.mjs";

function sessionCookie(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("private HTTP profile gates book assets and separates reviewer from admin APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-auth-server-"));
  await mkdir(join(directory, "book"));
  await writeFile(join(directory, "book/book.html"), "<!doctype html><title>Privat bog</title>");
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 }, book: { id: "private-book", title: "Privat bog", sourceDir: "book", document: "book.html" },
    annotations: { file: "annotations.json" }, access: { preset: "privateReview" }, logging: { level: "silent" },
  }));
  const config = await loadBookViewerConfig(configPath);
  const server = createBookViewerServer({ config, hostname: "127.0.0.1", port: 0 });
  try {
    const reviewer = await server.collaborationRepository.createUser({ email: "reader@example.test", displayName: "Læser", password: "hemmeligt-password", bookRole: "reviewer" });
    await server.collaborationRepository.createUser({ email: "admin@example.test", displayName: "Admin", password: "hemmeligt-password", globalRole: "instance_admin", bookRole: "book_admin" });
    assert.ok(reviewer.id);
    assert.equal((await fetch(new URL("/book/book.html", server.url))).status, 403);

    const login = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "reader@example.test", password: "hemmeligt-password" }) });
    assert.equal(login.status, 200);
    const reviewerCookie = sessionCookie(login);
    assert.equal((await fetch(new URL("/book/book.html", server.url), { headers: { Cookie: reviewerCookie } })).status, 200);
    assert.equal((await fetch(new URL("/api/admin/users", server.url), { headers: { Cookie: reviewerCookie } })).status, 403);

    const adminLogin = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.test", password: "hemmeligt-password" }) });
    const adminCookie = sessionCookie(adminLogin);
    assert.equal((await fetch(new URL("/api/admin/users", server.url), { headers: { Cookie: adminCookie } })).status, 200);
    const accessUpdate = await fetch(new URL("/api/admin/access", server.url), { method: "PUT", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ preset: "publicRead" }) });
    assert.equal(accessUpdate.status, 200);
    assert.equal((await accessUpdate.json()).access.preset, "publicRead");
    assert.equal((await fetch(new URL("/book/book.html", server.url))).status, 200);

    const reset = await fetch(new URL(`/api/admin/users/${reviewer.id}/password`, server.url), { method: "PUT", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ newPassword: "nyt-hemmeligt-password" }) });
    assert.equal(reset.status, 200);
    const oldLogin = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "reader@example.test", password: "hemmeligt-password" }) });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "reader@example.test", password: "nyt-hemmeligt-password" }) });
    assert.equal(newLogin.status, 200);
  } finally {
    await server.stop(true);
    server.collaborationRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP mutations require the exact origin and public guest identities cannot be forged from annotation authors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-guest-security-"));
  await mkdir(join(directory, "book"));
  await writeFile(join(directory, "book/book.html"), "<!doctype html><title>Åben bog</title>");
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    book: { id: "open-book", title: "Åben bog", sourceDir: "book", document: "book.html" },
    annotations: { file: "annotations.json" },
    access: { preset: "publicOpenReview" },
    logging: { level: "silent" },
  }));
  const config = await loadBookViewerConfig(configPath);
  const server = createBookViewerServer({ config, hostname: "127.0.0.1", port: 0 });
  const draft = {
    type: "page",
    comment: "Ejerens note",
    visibility: "public",
    target: { pageNumber: 1, scopeId: "chapter-1" },
  };
  try {
    const wrongMediaType = await fetch(new URL("/api/annotations", server.url), {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: server.url.origin },
      body: JSON.stringify(draft),
    });
    assert.equal(wrongMediaType.status, 415);

    let cancelled = false;
    let chunks = 0;
    const oversizedBody = new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const oversizedRequest = new Request(new URL("/api/annotations", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url.origin },
      body: oversizedBody,
    });
    const oversized = await handleBookViewerRequest(oversizedRequest, {
      config,
      service: server.bookApplicationService,
      logger: server.operationalLogger,
    });
    assert.equal(oversized.status, 413);
    assert.equal(cancelled, true);
    assert.equal(chunks, 2);

    const rejected = await fetch(new URL("/api/annotations", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" },
      body: JSON.stringify(draft),
    });
    assert.equal(rejected.status, 403);

    const createdResponse = await fetch(new URL("/api/annotations", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url.origin },
      body: JSON.stringify(draft),
    });
    assert.equal(createdResponse.status, 201);
    const ownerCookie = sessionCookie(createdResponse);
    const created = await createdResponse.json();
    assert.match(ownerCookie, /^pba_guest=pbg_/);
    assert.match(created.author.id, /^guest-[0-9a-f]{64}$/);
    assert.equal(ownerCookie.includes(created.author.id), false);

    const forged = await fetch(new URL(`/api/annotations/${created.id}`, server.url), {
      method: "DELETE",
      headers: { Cookie: `pba_guest=${encodeURIComponent(created.author.id)}`, Origin: server.url.origin },
    });
    assert.equal(forged.status, 403);
    const owned = await fetch(new URL(`/api/annotations/${created.id}`, server.url), {
      method: "DELETE",
      headers: { Cookie: ownerCookie, Origin: server.url.origin },
    });
    assert.equal(owned.status, 200);
  } finally {
    await server.stop(true);
    server.collaborationRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
