import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { resolveAccessPolicy } from "./access-policy.mjs";
import { AnnotationRepository } from "./annotation-repository.mjs";
import { ApplicationError, BookCollaboration } from "./application-service.mjs";
import { CollaborationRepository } from "./collaboration-repository.mjs";

function pageDraft(comment = "Se på denne side.") {
  return { type: "page", comment, target: { pageNumber: 3, scopeId: "chapter-1", label: "Side 3" } };
}

test("application service enforces private review access, attribution, progress and scoped tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-service-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const annotations = new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1" });
  const config = { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "privateReview" }) };
  const service = new BookCollaboration({ config, annotationRepository: annotations, collaborationRepository: collaboration });

  try {
    const admin = await collaboration.createUser({
      email: "admin@example.test", displayName: "Admin", password: "meget-hemmeligt", globalRole: "instance_admin", bookRole: "book_admin",
    });
    const reviewer = await collaboration.createUser({
      email: "reviewer@example.test", displayName: "Prøvelæser", password: "endnu-hemmeligt", bookRole: "reviewer",
    });
    const adminPrincipal = collaboration.principalForUser(admin.id);
    const reviewerPrincipal = collaboration.principalForUser(reviewer.id);

    assert.equal(service.session(null).capabilities.canRead, false);
    assert.equal(service.session(reviewerPrincipal).capabilities.canRead, true);
    const note = await service.createAnnotation(reviewerPrincipal, pageDraft());
    assert.equal(note.author.id, reviewer.id);
    assert.equal((await service.listAnnotations(reviewerPrincipal)).annotations.length, 1);

    const secondReviewer = await collaboration.createUser({
      email: "other@example.test", displayName: "Anden", password: "virkelig-hemmeligt", bookRole: "reviewer",
    });
    assert.equal((await service.listAnnotations(collaboration.principalForUser(secondReviewer.id))).annotations.length, 0);
    assert.equal((await service.listAnnotations(adminPrincipal)).annotations.length, 1);
    await assert.rejects(() => service.updateAnnotation(collaboration.principalForUser(secondReviewer.id), note.id, { comment: "Nej" }), ApplicationError);
    assert.match((await service.exportAnnotations(adminPrincipal, "csv")).body, /Se på denne side\./);
    assert.match((await service.exportAnnotations(adminPrincipal, "markdown")).body, /# Annotationer til book-1/);

    const progress = service.saveProgress(reviewerPrincipal, { anchorId: "chapter-1.p-3", pageNumber: 3, percent: 25, buildId: "build-a" });
    assert.equal(progress.readPages[0].anchorId, "chapter-1.p-3");
    assert.equal(service.listAllProgress(adminPrincipal)[0].percent, 25);

    const token = await service.createToken(adminPrincipal, {
      name: "Bogagent", scopes: ["books:read", "annotations:read", "progress:read:all"], expiresInHours: 24,
    });
    const tokenPrincipal = await service.resolvePrincipal({ bearerToken: token.secret });
    assert.equal((await service.listAnnotations(tokenPrincipal)).annotations.length, 1);
    assert.equal(service.listAllProgress(tokenPrincipal).length, 1);
    assert.equal(collaboration.listAudit().some((event) => event.action === "token.create"), true);
    await assert.rejects(() => service.createToken(reviewerPrincipal, { name: "For stærk", scopes: ["users:read"] }), ApplicationError);
  } finally {
    collaboration.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("open registration creates an attributed reviewer session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-register-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const service = new BookCollaboration({
    config: { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "publicMemberReview" }) },
    annotationRepository: new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1" }),
    collaborationRepository: collaboration,
  });
  try {
    const registration = await service.register({ email: "new@example.test", displayName: "Ny læser", password: "sikkert-password" });
    assert.match(registration.secret, /^pbs_/);
    const principal = await service.resolvePrincipal({ sessionSecret: registration.secret });
    assert.equal(principal.role, "reviewer");
    assert.equal((await service.createAnnotation(principal, pageDraft())).author.displayName, "Ny læser");
  } finally {
    collaboration.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("access changes persist and local owner cannot remove the final administration path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-access-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const service = new BookCollaboration({
    config: { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "local" }) },
    annotationRepository: new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1" }),
    collaborationRepository: collaboration,
  });
  const local = await service.resolvePrincipal();
  try {
    assert.throws(() => service.updateAccessSettings(local, { preset: "privateReview" }), /aktiv administrator/);
    await collaboration.createUser({ email: "admin@example.test", displayName: "Admin", password: "meget-hemmeligt", globalRole: "instance_admin", bookRole: "book_admin" });
    assert.equal(service.updateAccessSettings(local, { preset: "privateReview" }).preset, "privateReview");
    assert.equal(service.policy.preset, "privateReview");
  } finally {
    collaboration.close();
    await rm(directory, { recursive: true, force: true });
  }
});
