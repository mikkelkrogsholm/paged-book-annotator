import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { AnnotationRepository } from "./annotation-repository.mjs";

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

    assert.equal(await repository.delete(created.id), true);
    assert.equal((await repository.list()).annotations.length, 0);
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
