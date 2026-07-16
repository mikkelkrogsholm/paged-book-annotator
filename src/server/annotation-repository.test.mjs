import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { ANNOTATION_LIMITS, AnnotationRepository } from "./annotation-repository.mjs";

function textDraft(comment = "Gør formuleringen mere konkret.") {
  return {
    type: "text",
    comment,
    target: {
      scopeId: "stanza-001.companion.paragraph-4",
      pageNumber: 15,
      label: "Ledsager 001, afsnit 4",
      selector: {
        type: "TextQuoteSelector",
        exact: "Det oldnordiske rum",
        prefix: "hinanden. ",
        suffix: ". Gáttir",
        position: { start: 0, end: 21 }
      }
    }
  };
}

test("repository creates, updates, resolves and deletes annotations atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-repository-"));
  const filePath = join(directory, "annotations.json");
  const times = [
    new Date("2026-07-14T10:00:00.000Z"),
    new Date("2026-07-14T10:01:00.000Z"),
    new Date("2026-07-14T10:02:00.000Z"),
  ];
  const repository = new AnnotationRepository({
    filePath,
    bookId: "test-book",
    revisionId: "revision-2",
    clock: () => times.shift() ?? new Date("2026-07-14T10:03:00.000Z"),
    createId: () => "annotation-fixed",
  });

  try {
    const created = await repository.create(textDraft());
    assert.equal(created.id, "annotation-fixed");
    assert.equal(created.status, "open");
    assert.equal(created.author.id, "local-owner");
    assert.equal(created.visibility, "reviewGroup");
    assert.equal(created.category, "general");
    assert.equal(created.revisionId, "revision-2");

    const updated = await repository.update(created.id, { status: "resolved", comment: "Løst." });
    assert.equal(updated.status, "resolved");
    assert.equal(updated.comment, "Løst.");
    assert.equal(updated.target.selector.exact, "Det oldnordiske rum");

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.annotations.length, 1);
    assert.equal(persisted.annotations[0].status, "resolved");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    assert.equal(await repository.delete(created.id), true);
    assert.equal((await repository.list()).annotations.length, 0);
    await assert.rejects(() => repository.create({ type: "page", comment: "Mangler anker", target: { pageNumber: 3 } }), /scopeId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository attributes annotations and explicitly migrates schema 1 through schema 4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-migration-"));
  const filePath = join(directory, "annotations.json");
  const legacy = {
    schemaVersion: 1,
    bookId: "test-book",
    updatedAt: "2026-07-14T10:00:00.000Z",
    annotations: [{
      id: "legacy-note",
      bookId: "test-book",
      ...textDraft("Ældre note."),
      status: "open",
      anchorState: "attached",
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
    }],
  };
  await writeFile(filePath, `${JSON.stringify(legacy)}\n`);
  const repository = new AnnotationRepository({ filePath, bookId: "test-book" });

  try {
    const [migrated, concurrentRead] = await Promise.all([repository.list(), repository.list()]);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(concurrentRead.schemaVersion, 4);
    assert.equal(migrated.annotations[0].author.id, "local-owner");
    assert.equal(migrated.annotations[0].visibility, "reviewGroup");
    assert.equal(migrated.annotations[0].category, "general");
    assert.equal(migrated.annotations[0].revisionId, "legacy");

    const created = await repository.create(textDraft("Ny note."), {
      principal: { kind: "user", id: "user-1", displayName: "Ada" },
    });
    assert.deepEqual(created.author, { id: "user-1", displayName: "Ada", kind: "user" });
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).schemaVersion, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository rejects text annotations without an exact quote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-invalid-"));
  const repository = new AnnotationRepository({
    filePath: join(directory, "annotations.json"),
    bookId: "test-book",
  });

  try {
    const invalid = textDraft();
    invalid.target.selector.exact = "";
    await assert.rejects(() => repository.create(invalid), /TextQuoteSelector|ikke-tom/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository enforces annotation field limits before persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-field-limits-"));
  const repository = new AnnotationRepository({ filePath: join(directory, "annotations.json"), bookId: "test-book" });
  try {
    await assert.rejects(
      () => repository.create(textDraft("x".repeat(ANNOTATION_LIMITS.maxCommentLength + 1))),
      /comment må højst/,
    );
    const oversizedScope = textDraft();
    oversizedScope.target.scopeId = "s".repeat(ANNOTATION_LIMITS.maxScopeIdLength + 1);
    await assert.rejects(() => repository.create(oversizedScope), /scopeId må højst/);
    assert.equal(await Bun.file(join(directory, "annotations.json")).exists(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository rejects excessive annotation counts and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-total-limits-"));
  const filePath = join(directory, "annotations.json");
  const repository = new AnnotationRepository({ filePath, bookId: "test-book" });
  try {
    await assert.rejects(
      () => repository.importDocument({
        schemaVersion: 4,
        bookId: "test-book",
        updatedAt: "2026-07-14T10:00:00.000Z",
        annotations: Array(ANNOTATION_LIMITS.maxAnnotations + 1).fill({}),
      }),
      /må højst indeholde/,
    );

    await writeFile(filePath, "{}");
    await truncate(filePath, ANNOTATION_LIMITS.maxDocumentBytes + 1);
    await assert.rejects(() => repository.list(), /må højst fylde/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository preserves concurrent creates without lost updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-concurrent-"));
  let nextId = 0;
  const repository = new AnnotationRepository({
    filePath: join(directory, "annotations.json"),
    bookId: "test-book",
    createId: () => `annotation-${++nextId}`,
  });

  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => repository.create(textDraft(`Kommentar ${index + 1}`))));
    const document = await repository.list();
    assert.equal(document.annotations.length, 12);
    assert.equal(new Set(document.annotations.map((annotation) => annotation.id)).size, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate repository instances serialize writes to the same annotations file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "annotation-cross-process-lock-"));
  const filePath = join(directory, "annotations.json");
  const first = new AnnotationRepository({ filePath, bookId: "book-1", createId: () => "first" });
  const second = new AnnotationRepository({ filePath, bookId: "book-1", createId: () => "second" });
  try {
    await Promise.all([
      first.create(textDraft("Første")),
      second.create(textDraft("Anden")),
    ]);
    const document = await first.list();
    assert.deepEqual(document.annotations.map((annotation) => annotation.id).sort(), ["first", "second"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository rejects a non-file annotations path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "annotation-invalid-path-"));
  const filePath = join(directory, "annotations.json");
  await mkdir(filePath);
  const repository = new AnnotationRepository({ filePath, bookId: "book-1" });
  try {
    await assert.rejects(() => repository.list(), /regulær fil/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository anonymizes erased annotation actors atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-viewer-erasure-"));
  const filePath = join(directory, "annotations.json");
  const repository = new AnnotationRepository({ filePath, bookId: "test-book", revisionId: "revision-1" });
  try {
    await repository.create(textDraft("Personlig feedback."), {
      principal: { kind: "user", id: "user-to-erase", displayName: "Personnavn" },
    });
    const result = await repository.anonymizeAuthor("user-to-erase");
    assert.equal(result.changed, 1);
    const [annotation] = (await repository.list()).annotations;
    assert.equal(annotation.author.displayName, "Slettet bruger");
    assert.equal(annotation.author.kind, "erased");
    assert.doesNotMatch(JSON.stringify(annotation), /Personnavn|user-to-erase/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
