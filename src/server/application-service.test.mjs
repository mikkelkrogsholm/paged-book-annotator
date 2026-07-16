import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import * as z from "zod/v4";

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
    assert.equal((await service.listAnnotations(tokenPrincipal)).annotations.length, 0);
    assert.equal(service.listAllProgress(tokenPrincipal).length, 1);
    assert.throws(() => service.getProgress(tokenPrincipal), ApplicationError);
    assert.throws(() => service.saveProgress(tokenPrincipal, { anchorId: "chapter-2", pageNumber: 4, percent: 30 }), ApplicationError);
    assert.equal(collaboration.listAudit().some((event) => event.action === "token.create"), true);
    await assert.rejects(() => service.createToken(reviewerPrincipal, { name: "For stærk", scopes: ["users:read"] }), ApplicationError);
    assert.equal(await service.deleteAnnotation(adminPrincipal, note.id), true);
    const deletionChanges = await service.listChangesSince(adminPrincipal, { since: "1970-01-01T00:00:00.000Z" });
    assert.equal(deletionChanges.items.at(-1).type, "annotation.deleted");
    assert.equal(deletionChanges.items.at(-1).annotationId, note.id);

    const replaced = await service.createAnnotation(reviewerPrincipal, pageDraft("Skal erstattes"));
    const importSince = new Date(Date.now() - 1_000).toISOString();
    await service.importAnnotations(adminPrincipal, {
      schemaVersion: 4,
      bookId: "book-1",
      updatedAt: "2020-01-01T00:00:00.000Z",
      annotations: [{
        ...replaced,
        id: "imported-old-timestamp",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }],
    }, "replace");
    const importChanges = await service.listChangesSince(adminPrincipal, { since: importSince, limit: 100 });
    assert.equal(importChanges.items.some((item) => item.type === "annotation.upsert" && item.annotation.id === "imported-old-timestamp"), true);
    assert.equal(importChanges.items.some((item) => item.type === "annotation.deleted" && item.annotationId === replaced.id), true);
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

test("invitation acceptance requires invite-only policy and an existing account password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-invitation-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const service = new BookCollaboration({
    config: { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "privateReview" }) },
    annotationRepository: new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1" }),
    collaborationRepository: collaboration,
  });
  try {
    const victim = await collaboration.createUser({
      email: "existing@example.test", displayName: "Existing", password: "rigtigt-hemmeligt",
    });
    const invitation = await collaboration.createInvitation({ email: victim.email, role: "reviewer" });
    await assert.rejects(
      () => service.acceptInvitation({ secret: invitation.secret, userId: victim.id, password: "forkert-hemmeligt" }),
      /korrekte password/,
    );
    const accepted = await service.acceptInvitation({ secret: invitation.secret, password: "rigtigt-hemmeligt" });
    assert.equal(accepted.principal.id, victim.id);

    const disabledInvitation = await collaboration.createInvitation({ email: "disabled@example.test" });
    const disabledService = new BookCollaboration({
      config: { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "publicRead" }) },
      annotationRepository: new AnnotationRepository({ filePath: join(directory, "disabled-annotations.json"), bookId: "book-1" }),
      collaborationRepository: collaboration,
    });
    await assert.rejects(
      () => disabledService.acceptInvitation({ secret: disabledInvitation.secret, password: "nyt-hemmeligt" }),
      ApplicationError,
    );
  } finally {
    collaboration.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("book administrators cannot take over global accounts and tokens cannot impersonate account self-service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-boundaries-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const annotations = new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1" });
  const service = new BookCollaboration({
    config: { book: { id: "book-1" }, access: resolveAccessPolicy({ preset: "privateReview" }) },
    annotationRepository: annotations,
    collaborationRepository: collaboration,
  });

  try {
    const bookAdmin = await collaboration.createUser({
      email: "book-admin@example.test", displayName: "Bogadmin", password: "meget-hemmeligt", bookRole: "book_admin",
    });
    const reader = await collaboration.createUser({
      email: "reader-boundary@example.test", displayName: "Læser", password: "andet-hemmeligt",
    });
    const principal = collaboration.principalForUser(bookAdmin.id);

    await assert.rejects(() => service.createUser(principal, {
      email: "root@example.test", displayName: "Root", password: "helt-hemmeligt", globalRole: "instance_admin",
    }), ApplicationError);
    assert.throws(() => service.updateUser(principal, reader.id, { globalRole: "instance_admin" }), ApplicationError);
    assert.throws(() => service.updateUser(principal, reader.id, { status: "disabled" }), ApplicationError);
    await assert.rejects(() => service.resetUserPassword(principal, reader.id, "nyt-hemmeligt-password"), ApplicationError);

    assert.equal(service.updateUser(principal, reader.id, { bookRole: "reviewer" }).membership.role, "reviewer");
    assert.equal(collaboration.getUser(reader.id, null).globalRole, "user");

    const token = await collaboration.createServiceToken({
      name: "Reader impersonator",
      actorUserId: reader.id,
      grants: [{ bookId: "book-1", permissions: ["books:read"] }],
    });
    const tokenPrincipal = await collaboration.resolveServiceToken(token.secret);
    await assert.rejects(() => service.exportUserData(tokenPrincipal), ApplicationError);
    await assert.rejects(() => service.eraseUserData(tokenPrincipal), ApplicationError);

    const readerPrincipal = collaboration.principalForUser(reader.id);
    assert.equal((await service.exportUserData(readerPrincipal)).user.id, reader.id);
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

test("admin create to reader response to review export is one permissioned vertical slice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-app-survey-"));
  const collaboration = new CollaborationRepository({ filePath: ":memory:", bookId: "book-1" });
  const service = new BookCollaboration({
    config: {
      book: { id: "book-1", title: "Surveybog", revisionId: "revision-1", buildId: "build-1" },
      access: resolveAccessPolicy({ preset: "privateReview" }),
    },
    annotationRepository: new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "book-1", revisionId: "revision-1" }),
    collaborationRepository: collaboration,
    bookContentIndex: { section: async (anchorId) => anchorId === "chapter-1" ? { anchorId } : null },
  });
  try {
    const admin = await collaboration.createUser({ email: "admin@survey.test", displayName: "Admin", password: "meget-hemmeligt", globalRole: "instance_admin", bookRole: "book_admin" });
    const reader = await collaboration.createUser({ email: "reader@survey.test", displayName: "Reader", password: "andet-hemmeligt", bookRole: "reviewer" });
    const adminPrincipal = collaboration.principalForUser(admin.id);
    const readerPrincipal = collaboration.principalForUser(reader.id);
    const survey = service.createSurvey(adminPrincipal, {
      schemaVersion: 1, title: "Feedback", description: "",
      target: { kind: "section", anchorId: "chapter-1", label: "Kapitel 1" }, trigger: { mode: "afterLeave" },
      questions: [
        { id: "clarity", type: "rating", prompt: "Hvor let var det?", required: true, scale: { min: 1, max: 5, minLabel: "Svært", maxLabel: "Let" } },
        { id: "comment", type: "longText", prompt: "Hvad var uklart?", required: false, maxLength: 1_000 },
      ],
    });
    await service.publishSurvey(adminPrincipal, survey.id);
    assert.equal(service.listActiveSurveys(readerPrincipal).length, 1);
    const response = service.submitSurveyResponse(readerPrincipal, survey.id, [
      { questionId: "clarity", value: 4 }, { questionId: "comment", value: "Forklar eksemplet bedre" },
    ]);
    assert.equal(service.getMySurveyResponse(readerPrincipal, survey.id).id, response.id);
    const readerToken = await collaboration.createServiceToken({
      name: "Reader agent",
      actorUserId: reader.id,
      grants: [{ bookId: "book-1", permissions: ["books:read", "surveys:respond"] }],
    });
    const readerTokenPrincipal = await collaboration.resolveServiceToken(readerToken.secret);
    const agentResponse = service.submitSurveyResponse(readerTokenPrincipal, survey.id, [
      { questionId: "clarity", value: 4 }, { questionId: "comment", value: "Forklar eksemplet bedre" },
    ]);
    assert.equal(agentResponse.id, response.id);
    assert.equal(agentResponse.respondent.kind, "user");
    assert.equal(service.listSurveyResponses(adminPrincipal).length, 1);
    collaboration.saveReviewerProfile(reader.id, { bookId: "book-1", phone: "+45 12345678", phonePurpose: "Kontakt om prøvelæsning" });
    const listedReader = service.listUsers(adminPrincipal).find((user) => user.id === reader.id);
    assert.equal(listedReader.phone, "+45 12345678");
    assert.equal(listedReader.reviewerProfile.phonePurpose, "Kontakt om prøvelæsning");
    await service.createAnnotation(readerPrincipal, pageDraft("Surveyflowets annotationsspor"));
    const exported = await service.exportReviewBundle(adminPrincipal, { includeProgress: false });
    assert.equal(exported.document.annotations.items.length, 1);
    assert.equal(exported.document.surveyResponses[0].answers[1].value, "Forklar eksemplet bedre");
    assert.equal(exported.document.readingProgress.included, false);
    const exportSchema = z.fromJSONSchema(await Bun.file(new URL("../../schemas/pba-review-export.v1.schema.json", import.meta.url)).json());
    assert.deepEqual(exportSchema.parse(exported.document), exported.document);
    assert.doesNotMatch(JSON.stringify(collaboration.listAudit()), /Forklar eksemplet bedre/);
    service.closeSurvey(adminPrincipal, survey.id);
    assert.throws(() => service.submitSurveyResponse(readerPrincipal, survey.id, [{ questionId: "clarity", value: 5 }]), /ikke aktiv/);

    const unreachable = service.createSurvey(adminPrincipal, {
      schemaVersion: 1, title: "Ugyldigt mål", target: { kind: "section", anchorId: "missing-anchor" },
      questions: [{ id: "clarity", type: "rating", prompt: "Forstod du det?", scale: { min: 1, max: 5, minLabel: "Nej", maxLabel: "Ja" } }],
    });
    await assert.rejects(() => service.publishSurvey(adminPrincipal, unreachable.id), /anker findes ikke/);
  } finally {
    collaboration.close();
    await rm(directory, { recursive: true, force: true });
  }
});
