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

test("collaboration schema migrates an existing version 1 database through version 3", async () => {
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
    assert.equal(repository.database.query("PRAGMA user_version").get().user_version, 3);
    assert.equal(repository.getAccessPolicy(resolveAccessPolicy({ preset: "publicRead" })).preset, "publicRead");
    assert.equal(repository.database.query("PRAGMA table_info(reading_progress)").all().some((column) => column.name === "engaged_percent"), true);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collaboration schema migrates version 2 grants and pseudonymizes legacy audit actors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collaboration-v2-"));
  const filePath = join(directory, "collaboration.sqlite");
  const legacy = new Database(filePath, { create: true });
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, global_role TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE memberships (
      user_id TEXT NOT NULL REFERENCES users(id), book_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, book_id)
    );
    CREATE TABLE invitations (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, book_id TEXT NOT NULL,
      role TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, accepted_at TEXT, revoked_at TEXT
    );
    CREATE TABLE service_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL UNIQUE, actor_user_id TEXT, book_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_by TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, token_id TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, book_id TEXT,
      details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO service_tokens (
      id, name, prefix, secret_hash, book_id, scopes_json, expires_at, created_at
    ) VALUES ('token-1', 'Legacy', 'pba_legacy', 'hash', 'book-a', '["books:read"]', '2099-01-01', '2026-01-01');
    INSERT INTO audit_events (
      id, actor_type, actor_id, action, resource_type, book_id, details_json, created_at
    ) VALUES (
      'audit-1', 'user', 'user-legacy', 'read', 'book', 'book-a',
      '{"email":"person@example.test","safe":"kept"}', '2026-01-01'
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();
  const repository = new CollaborationRepository({ filePath });
  try {
    assert.equal(repository.database.query("PRAGMA user_version").get().user_version, 3);
    assert.equal(repository.database.query("PRAGMA table_info(memberships)").all()
      .some((column) => column.name === "permissions_json"), true);
    assert.deepEqual(repository.database.query(
      "SELECT book_id, permissions_json FROM service_token_book_grants WHERE token_id = 'token-1'",
    ).get(), { book_id: "book-a", permissions_json: '["books:read"]' });
    const audit = repository.database.query(
      "SELECT actor_id, actor_ref, details_json FROM audit_events WHERE id = 'audit-1'",
    ).get();
    assert.equal(audit.actor_id, audit.actor_ref);
    assert.notEqual(audit.actor_ref, "user-legacy");
    assert.deepEqual(JSON.parse(audit.details_json), { safe: "kept" });
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("book grants, registration credentials and progress stay isolated across books", async () => {
  let sequence = 0;
  const repository = new CollaborationRepository({
    filePath: ":memory:",
    createId: (prefix) => `${prefix}-${++sequence}`,
    clock: () => new Date("2026-07-15T10:00:00.000Z"),
  });
  try {
    repository.saveAccessPolicy({ preset: "publicMemberReview", registration: "open" }, null, "book-a");
    repository.saveAccessPolicy({ preset: "privateReview", registration: "code" }, null, "book-b");
    repository.saveAccessPolicy({ preset: "privateReview", registration: "inviteOnly" }, null, "book-c");
    repository.saveAccessPolicy({ preset: "privateReview", registration: "closed" }, null, "book-d");
    const user = await repository.createUser({
      email: "reader@example.test", displayName: "Reader", password: "meget-hemmeligt",
    });
    assert.equal(repository.getUser(user.id, "book-a").membership, null);
    const openEnrollment = await repository.enrollUser({ userId: user.id, bookId: "book-a" });
    assert.equal(openEnrollment.membership.role, "reader");
    assert.equal(repository.getUser(user.id, "book-b").membership, null);
    await assert.rejects(
      () => repository.enrollUser({ userId: user.id, bookId: "book-d" }),
      /Åben tilmelding/,
    );

    const code = await repository.createAccessCode({
      bookId: "book-b",
      role: "reviewer",
      permissions: ["annotations:moderate"],
      maxUses: 1,
    });
    const codeEnrollment = await repository.enrollUser({
      userId: user.id, bookId: "book-b", method: "code", accessCode: code.secret,
    });
    assert.equal(codeEnrollment.membership.role, "reviewer");
    assert.deepEqual(codeEnrollment.membership.permissions, ["annotations:moderate"]);
    const secondUser = await repository.createUser({
      email: "second@example.test", displayName: "Second", password: "andet-hemmeligt",
    });
    await assert.rejects(
      () => repository.enrollUser({
        userId: secondUser.id, bookId: "book-b", method: "code", accessCode: code.secret,
      }),
      /ugyldig eller udløbet/,
    );

    const invitation = await repository.createInvitation({
      bookId: "book-c", email: "second@example.test", permissions: ["annotations:export"],
    });
    await assert.rejects(
      () => repository.acceptInvitation({ secret: invitation.secret, userId: user.id, bookId: "book-c" }),
      /anden konto/,
    );
    const invited = await repository.enrollUser({
      userId: secondUser.id,
      bookId: "book-c",
      method: "invite",
      invitationSecret: invitation.secret,
    });
    assert.deepEqual(invited.membership.permissions, ["annotations:export"]);
    await assert.rejects(
      () => repository.enrollUser({
        userId: secondUser.id,
        bookId: "book-c",
        method: "invite",
        invitationSecret: invitation.secret,
      }),
      /ugyldig eller udløbet/,
    );

    repository.saveProgress(user.id, { anchorId: "a", pageNumber: 1, percent: 10 }, "book-a");
    repository.saveProgress(user.id, { anchorId: "b", pageNumber: 2, percent: 20 }, "book-b");
    assert.equal(repository.getProgress(user.id, "book-a").anchorId, "a");
    assert.equal(repository.getProgress(user.id, "book-b").anchorId, "b");
    assert.equal(repository.listProgress("book-a").length, 1);
    assert.equal(repository.listProgress("book-c").length, 0);
  } finally {
    repository.close();
  }
});

test("multi-book tokens, reviewer PII export and erasure use explicit boundaries", async () => {
  let sequence = 0;
  const repository = new CollaborationRepository({
    filePath: ":memory:", createId: (prefix) => `${prefix}-${++sequence}`,
  });
  try {
    const user = await repository.createUser({
      email: "private@example.test", displayName: "Private Person", password: "meget-hemmeligt",
    });
    repository.setMembership(user.id, "reviewer", { bookId: "book-a" });
    assert.throws(
      () => repository.saveReviewerProfile(user.id, { bookId: "book-a", phone: "+45 12345678" }),
      /angivet formål/,
    );
    repository.saveReviewerProfile(user.id, {
      bookId: "book-a", phone: "+45 12345678", phonePurpose: "Opfølgende interview",
    });
    const token = await repository.createServiceToken({
      name: "Agent",
      grants: [
        { bookId: "book-a", permissions: ["books:read", "annotations:write"] },
        { bookId: "book-b", permissions: ["books:read"] },
      ],
    });
    const principal = await repository.resolveServiceToken(token.secret);
    assert.equal(principal.bookId, null);
    assert.equal(principal.bookGrants.length, 2);
    assert.equal(repository.listServiceTokens("book-a").length, 1);
    assert.equal(repository.listServiceTokens("book-c").length, 0);

    const instanceToken = await repository.createServiceToken({ name: "Root agent", instanceAdmin: true });
    assert.equal((await repository.resolveServiceToken(instanceToken.secret)).instanceAdmin, true);
    repository.audit({
      principal: repository.principalForUser(user.id, "book-a"),
      action: "profile.updated",
      resourceType: "reviewer-profile",
      resourceId: user.id,
      bookId: "book-a",
      details: { email: "private@example.test", phone: "+45 12345678", field: "phone" },
    });
    const audit = repository.listAudit({ bookId: "book-a" })[0];
    assert.notEqual(audit.actorId, user.id);
    assert.deepEqual(audit.details, { field: "phone" });
    const exported = repository.exportUserData(user.id);
    assert.equal(exported.user.email, "private@example.test");
    assert.equal(exported.reviewerProfiles[0].phonePurpose, "Opfølgende interview");
    assert.equal(exported.auditEvents.length, 1);

    const erasure = repository.eraseUserData(user.id);
    assert.ok(erasure.erasedAt);
    const erased = repository.getUser(user.id, null);
    assert.equal(erased.status, "erased");
    assert.equal(erased.displayName, "Slettet bruger");
    assert.equal(erased.email.includes("private"), false);
    assert.equal(repository.getReviewerProfile(user.id, "book-a"), null);
    assert.equal(repository.principalForUser(user.id, "book-a"), null);
    assert.equal(repository.listAudit({ bookId: "book-a" })[0].actorId, audit.actorId);
  } finally {
    repository.close();
  }
});
