import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { createBookViewerServer, loadBookViewerConfig } from "../../server.mjs";

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
