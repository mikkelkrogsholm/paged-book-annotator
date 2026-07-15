import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";

import { resolveAccessPolicy } from "./access-policy.mjs";
import { BookCatalogRepository } from "./book-catalog-repository.mjs";
import { LocalBookStorage } from "./book-storage.mjs";
import { CollaborationRepository } from "./collaboration-repository.mjs";
import { LibraryApplication } from "./library-application.mjs";
import { ManagedBookCatalog } from "./managed-book-catalog.mjs";

function pageDraft(comment) {
  return { type: "page", comment, target: { pageNumber: 1, scopeId: "chapter-1" } };
}

test("library application isolates book services, annotations and memberships", async () => {
  const root = await mkdtemp(join(tmpdir(), "pba-library-application-"));
  const dataDir = join(root, "data");
  const repository = new BookCatalogRepository({ filePath: join(dataDir, "catalog.sqlite") });
  const storage = new LocalBookStorage({ rootDir: dataDir });
  const catalog = new ManagedBookCatalog({ repository, storage });
  const collaboration = new CollaborationRepository({ filePath: join(dataDir, "collaboration.sqlite") });
  const sourceDir = resolve(import.meta.dir, "../../example/book");

  try {
    await catalog.importBookDirectory({ sourceDir, book: { id: "book-a", slug: "book-a", title: "Bog A" } });
    await catalog.importBookDirectory({ sourceDir, book: { id: "book-b", slug: "book-b", title: "Bog B" } });
    const config = {
      library: { dataDir, defaultBookId: "book-a", uploadMaxBytes: 5_000_000 },
      access: resolveAccessPolicy({ preset: "privateReview" }),
      auth: { sessionHours: 24, invitationHours: 24 },
      book: { paginationTimeoutMs: 45_000 },
    };
    const library = new LibraryApplication({ config, catalog, collaborationRepository: collaboration });
    const local = { kind: "local", id: "local-owner", displayName: "Lokal ejer" };
    assert.deepEqual(library.listBooks(local).map((book) => book.id), ["book-a", "book-b"]);

    const first = await library.createAnnotation(local, "book-a", pageDraft("Kun A"));
    const second = await library.createAnnotation(local, "book-b", pageDraft("Kun B"));
    assert.notEqual(first.revisionId, second.revisionId);
    assert.equal((await library.listAnnotations(local, "book-a")).annotations[0].comment, "Kun A");
    assert.equal((await library.listAnnotations(local, "book-b")).annotations[0].comment, "Kun B");

    const multiBookToken = await library.createToken(local, {
      name: "Begge bøger",
      bookIds: ["book-a", "book-b"],
      scopes: ["books:read", "annotations:read"],
      expiresInHours: 24,
    });
    assert.deepEqual(multiBookToken.bookGrants.map((grant) => grant.bookId), ["book-a", "book-b"]);
    const adminToken = await library.createToken(local, {
      name: "Instansagent",
      instanceAdmin: "true",
      bookIds: [],
      scopes: [],
      expiresInHours: 24,
    });
    assert.equal((await collaboration.resolveServiceToken(adminToken.secret)).instanceAdmin, true);

    const user = await collaboration.createUser({
      email: "reader@example.test",
      displayName: "Læser",
      password: "hemmeligt-password",
      bookId: "book-a",
      bookRole: "reviewer",
    });
    const principal = collaboration.principalForUser(user.id, "book-a");
    library.serviceForBook("book-a").assertCanRead(principal);
    assert.throws(() => library.serviceForBook("book-b").assertCanRead(library.principalForBook(principal, "book-b")), /adgang/i);

    collaboration.setMembership(user.id, "reviewer", { bookId: "book-b" });
    await library.createAnnotation(principal, "book-a", pageDraft("Læser A"));
    await library.createAnnotation(principal, "book-b", pageDraft("Læser B"));
    assert.equal((await library.exportUserData(principal)).annotations.length, 2);
    await library.eraseUserData(principal);
    const erasedAuthors = [
      ...(await library.serviceForBook("book-a").annotations.list()).annotations,
      ...(await library.serviceForBook("book-b").annotations.list()).annotations,
    ].filter((annotation) => annotation.comment.startsWith("Læser")).map((annotation) => annotation.author.kind);
    assert.deepEqual(erasedAuthors, ["erased", "erased"]);
  } finally {
    collaboration.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
