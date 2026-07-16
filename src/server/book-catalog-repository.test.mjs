import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Database } from "bun:sqlite";

import { BOOK_CATALOG_SCHEMA_VERSION, BookCatalogRepository } from "./book-catalog-repository.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "pba-catalog-"));
  temporaryRoots.push(root);
  let number = 0;
  return new BookCatalogRepository({
    filePath: resolve(root, "catalog.sqlite"),
    clock: () => new Date(`2026-07-15T12:00:0${number}.000Z`),
    createId: (prefix) => `${prefix}-${++number}`,
    ...options,
  });
}

describe("BookCatalogRepository", () => {
  test("migrerer et tomt katalog eksplicit og opretter bøger", async () => {
    const catalog = await repository();
    expect((await stat(catalog.filePath)).mode & 0o777).toBe(0o600);
    const created = catalog.createBook({ id: "book-one", slug: "book-one", title: "Book One", createdBy: "admin-1" });

    expect(created).toMatchObject({ id: "book-one", slug: "book-one", status: "active", activeRevisionId: null });
    expect(catalog.listBooks()).toHaveLength(1);
    expect(catalog.database.query("PRAGMA user_version").get().user_version).toBe(BOOK_CATALOG_SCHEMA_VERSION);
    catalog.close();
  });

  test("afviser databaser fra et nyere schema", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pba-catalog-newer-"));
    temporaryRoots.push(root);
    const filePath = resolve(root, "catalog.sqlite");
    const database = new Database(filePath, { create: true });
    database.exec(`PRAGMA user_version = ${BOOK_CATALOG_SCHEMA_VERSION + 1}`);
    database.close();

    expect(() => new BookCatalogRepository({ filePath })).toThrow("understøtter");
  });

  test("publicerer kun en klar revision i én katalogtransaktion", async () => {
    const catalog = await repository();
    catalog.createBook({ id: "book-one", slug: "book-one", title: "Book One" });
    const first = catalog.beginRevision({ bookId: "book-one", sourceKind: "archive" });
    catalog.markRevisionReady({
      bookId: "book-one", revisionId: first.id, storageKey: "library/book-one/revisions/revision-1/content",
      contentHash: "hash-one", manifest: { book: { id: "book-one" } }, validation: { fileCount: 2 },
    });
    const published = catalog.publishRevision({ bookId: "book-one", revisionId: first.id, publishedBy: "admin-1" });

    expect(published.book.activeRevisionId).toBe(first.id);
    expect(published.revision.state).toBe("published");

    const failed = catalog.beginRevision({ bookId: "book-one", sourceKind: "archive" });
    catalog.markRevisionFailed({ bookId: "book-one", revisionId: failed.id, errorCode: "invalid", errorMessage: "bad bundle" });
    expect(() => catalog.publishRevision({ bookId: "book-one", revisionId: failed.id })).toThrow("Kun en klar revision");
    expect(catalog.getBook("book-one").activeRevisionId).toBe(first.id);
    catalog.close();
  });

  test("bevarer revisionsindholdet immutable efter validering", async () => {
    const catalog = await repository();
    catalog.createBook({ id: "book-one", slug: "book-one", title: "Book One" });
    const revision = catalog.beginRevision({ bookId: "book-one", sourceKind: "directory_import" });
    catalog.markRevisionReady({
      bookId: "book-one", revisionId: revision.id, storageKey: "library/book-one/revisions/revision-1/content",
      contentHash: "immutable-hash", manifest: { book: { id: "book-one" } }, validation: {},
    });

    expect(() => catalog.database.query("UPDATE book_revisions SET content_hash = 'changed' WHERE id = ?").run(revision.id))
      .toThrow("immutable");
    catalog.close();
  });

  test("arkiverede bøger skjules som standard", async () => {
    const catalog = await repository();
    catalog.createBook({ id: "book-one", slug: "book-one", title: "Book One" });
    catalog.archiveBook({ bookId: "book-one", archivedBy: "admin-1" });

    expect(catalog.listBooks()).toEqual([]);
    expect(catalog.listBooks({ includeArchived: true })[0].status).toBe("archived");
    catalog.close();
  });
});
