import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

    const pendingUpload = await library.createBookUpload(local, "book-a", { filename: "draft.tar.gz" });
    await library.writeBookUpload(local, "book-a", pendingUpload.upload.id, new Request("http://localhost/upload", {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: "archive-placeholder",
    }));
    const restartedLibrary = new LibraryApplication({ config, catalog, collaborationRepository: collaboration });
    const restoredUpload = await restartedLibrary.uploadRecord("book-a", pendingUpload.upload.id);
    assert.equal(restoredUpload.uploaded, true);
    assert.equal((await stat(restoredUpload.filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(restartedLibrary.pendingUploadDir)).mode & 0o777, 0o700);
    await restartedLibrary.removeUpload(restoredUpload);

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
    const bookAdmin = await collaboration.createUser({
      email: "book-admin@example.test",
      displayName: "Bogadmin",
      password: "meget-hemmeligt",
      bookId: "book-a",
      bookRole: "book_admin",
    });
    const bookAdminPrincipal = collaboration.principalForUser(bookAdmin.id, "book-a");
    assert.throws(() => library.createUser(bookAdminPrincipal, {
      email: "root@example.test",
      displayName: "Root",
      password: "andet-hemmeligt",
      globalRole: "instance_admin",
      bookId: "book-a",
    }), /instansadministrator/i);
    assert.throws(() => library.updateUser(bookAdminPrincipal, bookAdmin.id, { globalRole: "instance_admin", bookId: "book-a" }), /instansadministrator/i);
    assert.equal(library.listTokens(bookAdminPrincipal, { bookId: "book-a" }).some((token) => token.id === adminToken.id), false);
    assert.equal(library.revokeToken(bookAdminPrincipal, adminToken.id), false);
    assert.equal(library.listTokens(local).some((token) => token.id === adminToken.id), true);
    assert.equal(library.revokeToken(local, multiBookToken.id), true);
    const tokenAuditActions = collaboration.listAudit({ bookId: "book-a" })
      .filter((event) => event.resourceType === "service_token")
      .map((event) => event.action);
    assert.deepEqual(new Set(tokenAuditActions), new Set(["token.create", "token.revoke"]));

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

    const archivedReaderToken = await library.createToken(local, {
      name: "Arkivgrænse",
      grants: [{ bookId: "book-b", permissions: ["books:read", "annotations:read", "annotations:read:all"] }],
      expiresInHours: 24,
    });
    const archivedReaderPrincipal = await collaboration.resolveServiceToken(archivedReaderToken.secret);
    library.archiveBook(local, "book-a");
    assert.equal(library.defaultBookId, "book-b");
    library.archiveBook(local, "book-b");
    assert.equal(library.defaultBookId, "");
    assert.throws(() => library.listAnnotations(archivedReaderPrincipal, "book-b"), /arkiveret/i);
    assert.equal((await library.listAnnotations(local, "book-b")).bookId, "book-b");
    assert.deepEqual(library.listBooks(local).map((book) => book.id), []);
    assert.deepEqual(library.listBooks(local, { includeArchived: true }).map((book) => book.id), ["book-a", "book-b"]);
    assert.equal(library.getBook(local, "book-b", { includeArchived: true }).status, "archived");
  } finally {
    collaboration.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
