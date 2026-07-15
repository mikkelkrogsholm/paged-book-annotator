import { validateBookBundleDirectory } from "../integration/book-bundle-contract.mjs";

function slug(value) {
  const normalized = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const result = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  if (!result) throw new TypeError("Bogens titel eller id kan ikke omsættes til en slug.");
  return result;
}

export class BookRevisionUploadError extends Error {
  constructor(message, { revisionId, cause }) {
    super(message, { cause });
    this.name = "BookRevisionUploadError";
    this.code = "BOOK_REVISION_UPLOAD_FAILED";
    this.revisionId = revisionId;
  }
}

export class ManagedBookCatalog {
  constructor({ repository, storage }) {
    if (!repository || !storage) throw new TypeError("ManagedBookCatalog kræver repository og storage.");
    this.repository = repository;
    this.storage = storage;
  }

  createBook(input) { return this.repository.createBook(input); }
  getBook(bookId) { return this.repository.getBook(bookId); }
  listBooks(options) { return this.repository.listBooks(options); }
  archiveBook(input) { return this.repository.archiveBook(input); }
  getRevision(bookId, revisionId) { return this.repository.getRevision(bookId, revisionId); }
  listRevisions(bookId) { return this.repository.listRevisions(bookId); }
  publishRevision(input) { return this.repository.publishRevision(input); }

  async uploadRevision({ bookId, archivePath, createdBy = null }) {
    return this.#createRevision({
      bookId,
      sourceKind: "archive",
      createdBy,
      store: (revisionId) => this.storage.stageTarGz({ bookId, revisionId, archivePath }),
    });
  }

  async importRevisionFromDirectory({ bookId, sourceDir, createdBy = null }) {
    return this.#createRevision({
      bookId,
      sourceKind: "directory_import",
      createdBy,
      store: (revisionId) => this.storage.importDirectory({ bookId, revisionId, sourceDir }),
    });
  }

  async importBookDirectory({ sourceDir, book = {}, createdBy = null, publish = true }) {
    const { manifest } = await validateBookBundleDirectory(sourceDir, { limits: this.storage.limits });
    const metadata = manifest.book;
    const createdBook = this.repository.createBook({
      id: book.id ?? metadata.id,
      slug: book.slug ?? slug(metadata.id || metadata.title),
      title: book.title ?? metadata.title,
      subtitle: book.subtitle ?? metadata.subtitle ?? null,
      language: book.language ?? metadata.language ?? null,
      createdBy,
    });
    const revision = await this.importRevisionFromDirectory({ bookId: createdBook.id, sourceDir, createdBy });
    if (!publish) return { book: createdBook, revision };
    return this.repository.publishRevision({ bookId: createdBook.id, revisionId: revision.id, publishedBy: createdBy });
  }

  async #createRevision({ bookId, sourceKind, createdBy, store }) {
    const revision = this.repository.beginRevision({ bookId, sourceKind, createdBy });
    try {
      const stored = await store(revision.id);
      return this.repository.markRevisionReady({ bookId, revisionId: revision.id, ...stored });
    } catch (cause) {
      await this.storage.removeRevision({ bookId, revisionId: revision.id });
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        this.repository.markRevisionFailed({ bookId, revisionId: revision.id, errorCode: "validation_failed", errorMessage: message });
      } catch {
        // Preserve the upload failure. Repository failures are covered by recovery/audit at the integration boundary.
      }
      throw new BookRevisionUploadError("Bogrevisionen kunne ikke importeres.", { revisionId: revision.id, cause });
    }
  }
}
