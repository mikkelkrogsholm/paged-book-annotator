import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { Database } from "bun:sqlite";

import { CollaborationRepository } from "./collaboration-repository.mjs";
import { resolveAccessPolicy } from "./access-policy.mjs";

test("collaboration credentials expire or revoke and progress stays anchored", async () => {
  let now = new Date("2026-07-15T10:00:00.000Z");
  let sequence = 0;
  const repository = new CollaborationRepository({
    filePath: ":memory:", bookId: "book-1", sessionHours: 1, invitationHours: 1,
    clock: () => new Date(now), createId: (prefix) => `${prefix}-${++sequence}`,
  });
  try {
    assert.equal(repository.health(), true);
    const admin = await repository.createUser({
      email: "admin@example.test", displayName: "Admin", password: "meget-hemmeligt", globalRole: "instance_admin", bookRole: "book_admin",
    });
    const reviewer = await repository.createUser({
      email: "reviewer@example.test", displayName: "Reviewer", password: "andet-hemmeligt", bookRole: "reviewer",
    });
    assert.equal(repository.getAccessPolicy(resolveAccessPolicy({ preset: "local" })).preset, "local");
    assert.equal(repository.saveAccessPolicy({ preset: "privateReview" }, admin.id).preset, "privateReview");
    assert.equal(repository.getAccessPolicy(resolveAccessPolicy({ preset: "local" })).preset, "privateReview");

    const expiredSession = await repository.createSession(reviewer.id);
    assert.equal((await repository.resolveSession(expiredSession.secret)).id, reviewer.id);
    now = new Date("2026-07-15T11:00:01.000Z");
    assert.equal(await repository.resolveSession(expiredSession.secret), null);
    const revokedSession = await repository.createSession(reviewer.id);
    assert.equal(await repository.revokeSession(revokedSession.secret), true);
    assert.equal(await repository.resolveSession(revokedSession.secret), null);

    const expiredInvitation = await repository.createInvitation({ email: "late@example.test", role: "reader" });
    now = new Date("2026-07-15T12:00:02.000Z");
    await assert.rejects(() => repository.acceptInvitation({ secret: expiredInvitation.secret, password: "inviteret-hemmeligt" }), /udløbet/);
    const revokedInvitation = await repository.createInvitation({ email: "revoked@example.test" });
    assert.equal(repository.revokeInvitation(revokedInvitation.id), true);
    await assert.rejects(() => repository.acceptInvitation({ secret: revokedInvitation.secret, password: "inviteret-hemmeligt" }), /ugyldig/);
    const acceptedInvitation = await repository.createInvitation({ email: "accepted@example.test", role: "reviewer" });
    const invitedUser = await repository.acceptInvitation({ secret: acceptedInvitation.secret, displayName: "Inviteret", password: "inviteret-hemmeligt" });
    assert.equal(invitedUser.membership.role, "reviewer");

    const expiredToken = await repository.createServiceToken({ name: "Kort token", scopes: ["books:read"], expiresInHours: 1 });
    now = new Date("2026-07-15T13:00:03.000Z");
    assert.equal(await repository.resolveServiceToken(expiredToken.secret), null);
    const revokedToken = await repository.createServiceToken({ name: "Tilbagekaldt", scopes: ["books:read", "annotations:read"] });
    assert.equal((await repository.resolveServiceToken(revokedToken.secret)).tokenId, revokedToken.id);
    assert.equal(repository.revokeServiceToken(revokedToken.id), true);
    assert.equal(await repository.resolveServiceToken(revokedToken.secret), null);

    assert.throws(() => repository.setGlobalRole(admin.id, "user"), /sidste aktive administrator/);
    assert.throws(() => repository.setUserStatus(admin.id, "disabled"), /sidste aktive administrator/);
    repository.saveProgress(reviewer.id, { anchorId: "chapter-1.p-1", pageNumber: 1, percent: 10, buildId: "build-a" });
    repository.saveProgress(reviewer.id, { anchorId: "chapter-1.p-1", pageNumber: 2, percent: 20, buildId: "build-b" });
    repository.saveProgress(reviewer.id, { anchorId: "chapter-1.p-2", pageNumber: 3, percent: 30, buildId: "build-b" });
    const progress = repository.getProgress(reviewer.id);
    assert.equal(progress.anchorId, "chapter-1.p-2");
    assert.equal(progress.readPages.find((page) => page.anchorId === "chapter-1.p-1").visitCount, 2);
    assert.equal(repository.listProgress()[0].readPages.length, 2);
    repository.saveProgress(reviewer.id, { anchorId: "chapter-1.p-3", pageNumber: 30, percent: 95, event: "position" });
    assert.equal(repository.getProgress(reviewer.id).engagedPercent, 30);
    repository.saveProgress(reviewer.id, { anchorId: "chapter-1.p-3", pageNumber: 30, percent: 100, event: "complete" });
    assert.ok(repository.getProgress(reviewer.id).completedAt);
    assert.equal(repository.setReadingPreference(reviewer.id, false).trackingEnabled, false);
    assert.equal(repository.getProgress(reviewer.id), null);
    assert.equal(repository.saveProgress(reviewer.id, { anchorId: "chapter-1", pageNumber: 1 }), null);
    assert.equal(repository.setReadingPreference(reviewer.id, true).trackingEnabled, true);

    const passwordSession = await repository.createSession(reviewer.id);
    await repository.changePassword(reviewer.id, { currentPassword: "andet-hemmeligt", newPassword: "helt-nyt-hemmeligt" });
    assert.equal(await repository.resolveSession(passwordSession.secret), null);
    assert.equal((await repository.authenticate("reviewer@example.test", "helt-nyt-hemmeligt")).id, reviewer.id);
  } finally {
    repository.close();
  }
});

test("collaboration schema migrates an existing version 1 database to version 2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collaboration-v1-"));
  const filePath = join(directory, "collaboration.sqlite");
  const legacy = new Database(filePath, { create: true });
  legacy.exec(`
    CREATE TABLE reading_progress (
      user_id TEXT NOT NULL, book_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
      page_number INTEGER NOT NULL, percent REAL NOT NULL, build_id TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, book_id)
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();
  const repository = new CollaborationRepository({ filePath, bookId: "book-1" });
  try {
    assert.equal(repository.database.query("PRAGMA user_version").get().user_version, 2);
    assert.equal(repository.getAccessPolicy(resolveAccessPolicy({ preset: "publicRead" })).preset, "publicRead");
    assert.equal(repository.database.query("PRAGMA table_info(reading_progress)").all().some((column) => column.name === "engaged_percent"), true);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
