import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

export const BOOK_CATALOG_SCHEMA_VERSION = 1;

function requireText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  return text;
}

function safeId(value, field) {
  const id = requireText(value, field);
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id)) throw new TypeError(`${field} har et ugyldigt format.`);
  return id;
}

function slugValue(value) {
  const slug = requireText(value, "slug").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(slug)) throw new TypeError("slug skal bestå af små bogstaver, tal og bindestreger.");
  return slug;
}

function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function bookFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    language: row.language,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    createdBy: row.created_by,
    archivedBy: row.archived_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function revisionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    sequence: row.sequence,
    state: row.state,
    sourceKind: row.source_kind,
    storageKey: row.storage_key,
    contentHash: row.content_hash,
    manifest: parseJson(row.manifest_json),
    validation: parseJson(row.validation_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    publishedAt: row.published_at,
    failedAt: row.failed_at,
  };
}

export class BookCatalogRepository {
  constructor({
    filePath,
    clock = () => new Date(),
    createId = (prefix) => `${prefix}-${Bun.randomUUIDv7()}`,
  }) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.clock = clock;
    this.createId = createId;
    this.database = new Database(filePath, { create: true, strict: true });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate() {
    const version = Number(this.database.query("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > BOOK_CATALOG_SCHEMA_VERSION) {
      throw new TypeError(`Bogkataloget bruger schema ${version}; denne version understøtter ${BOOK_CATALOG_SCHEMA_VERSION}.`);
    }
    if (version === BOOK_CATALOG_SCHEMA_VERSION) return;
    const migrateVersionOne = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE books (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          subtitle TEXT,
          language TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          active_revision_id TEXT,
          created_by TEXT,
          archived_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        );
        CREATE TABLE book_revisions (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'published', 'superseded', 'failed')),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('archive', 'directory_import')),
          storage_key TEXT,
          content_hash TEXT,
          manifest_json TEXT,
          validation_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_by TEXT,
          published_by TEXT,
          created_at TEXT NOT NULL,
          ready_at TEXT,
          published_at TEXT,
          failed_at TEXT,
          UNIQUE (book_id, sequence),
          UNIQUE (book_id, content_hash)
        );
        CREATE INDEX book_revisions_book_sequence ON book_revisions(book_id, sequence DESC);
        CREATE TRIGGER immutable_revision_content
        BEFORE UPDATE OF book_id, sequence, source_kind, storage_key, content_hash, manifest_json, validation_json, created_by, created_at
        ON book_revisions
        WHEN OLD.state <> 'uploading'
        BEGIN
          SELECT RAISE(ABORT, 'published revision content is immutable');
        END;
        PRAGMA user_version = 1;
      `);
    });
    migrateVersionOne();
  }

  createBook({ id = this.createId("book"), slug, title, subtitle = null, language = null, createdBy = null }) {
    const timestamp = this.clock().toISOString();
    const bookId = safeId(id, "id");
    this.database.query(`
      INSERT INTO books (id, slug, title, subtitle, language, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(bookId, slugValue(slug), requireText(title, "title"), subtitle ? String(subtitle).trim() : null,
      language ? String(language).trim() : null, createdBy, timestamp, timestamp);
    return this.getBook(bookId);
  }

  listBooks({ includeArchived = false } = {}) {
    const rows = includeArchived
      ? this.database.query("SELECT * FROM books ORDER BY created_at, id").all()
      : this.database.query("SELECT * FROM books WHERE status = 'active' ORDER BY created_at, id").all();
    return rows.map(bookFromRow);
  }

  getBook(bookId) {
    return bookFromRow(this.database.query("SELECT * FROM books WHERE id = ?").get(safeId(bookId, "bookId")));
  }

  archiveBook({ bookId, archivedBy = null }) {
    const timestamp = this.clock().toISOString();
    const result = this.database.query(`
      UPDATE books SET status = 'archived', archived_by = ?, archived_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(archivedBy, timestamp, timestamp, safeId(bookId, "bookId"));
    if (result.changes !== 1) throw new TypeError("Bogen findes ikke eller er allerede arkiveret.");
    return this.getBook(bookId);
  }

  beginRevision({ bookId, sourceKind, createdBy = null }) {
    const normalizedBookId = safeId(bookId, "bookId");
    const book = this.getBook(normalizedBookId);
    if (!book || book.status !== "active") throw new TypeError("Bogen findes ikke eller er arkiveret.");
    if (!["archive", "directory_import"].includes(sourceKind)) throw new TypeError("sourceKind er ugyldig.");
    const revisionId = safeId(this.createId("revision"), "revisionId");
    const timestamp = this.clock().toISOString();
    const insert = this.database.transaction(() => {
      const sequence = Number(this.database.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM book_revisions WHERE book_id = ?").get(normalizedBookId).sequence);
      this.database.query(`
        INSERT INTO book_revisions (id, book_id, sequence, state, source_kind, created_by, created_at)
        VALUES (?, ?, ?, 'uploading', ?, ?, ?)
      `).run(revisionId, normalizedBookId, sequence, sourceKind, createdBy, timestamp);
    });
    insert();
    return this.getRevision(normalizedBookId, revisionId);
  }

  markRevisionReady({ bookId, revisionId, storageKey, contentHash, manifest, validation }) {
    const timestamp = this.clock().toISOString();
    const result = this.database.query(`
      UPDATE book_revisions
      SET state = 'ready', storage_key = ?, content_hash = ?, manifest_json = ?, validation_json = ?, ready_at = ?
      WHERE id = ? AND book_id = ? AND state = 'uploading'
    `).run(requireText(storageKey, "storageKey"), requireText(contentHash, "contentHash"), JSON.stringify(manifest),
      JSON.stringify(validation), timestamp, safeId(revisionId, "revisionId"), safeId(bookId, "bookId"));
    if (result.changes !== 1) throw new TypeError("Revisionen findes ikke eller kan ikke markeres som klar.");
    return this.getRevision(bookId, revisionId);
  }

  markRevisionFailed({ bookId, revisionId, errorCode, errorMessage }) {
    const timestamp = this.clock().toISOString();
    const result = this.database.query(`
      UPDATE book_revisions SET state = 'failed', error_code = ?, error_message = ?, failed_at = ?
      WHERE id = ? AND book_id = ? AND state = 'uploading'
    `).run(requireText(errorCode, "errorCode"), requireText(errorMessage, "errorMessage").slice(0, 1_000), timestamp,
      safeId(revisionId, "revisionId"), safeId(bookId, "bookId"));
    if (result.changes !== 1) throw new TypeError("Revisionen findes ikke eller kan ikke markeres som fejlet.");
    return this.getRevision(bookId, revisionId);
  }

  getRevision(bookId, revisionId) {
    return revisionFromRow(this.database.query("SELECT * FROM book_revisions WHERE book_id = ? AND id = ?")
      .get(safeId(bookId, "bookId"), safeId(revisionId, "revisionId")));
  }

  listRevisions(bookId) {
    return this.database.query("SELECT * FROM book_revisions WHERE book_id = ? ORDER BY sequence DESC")
      .all(safeId(bookId, "bookId")).map(revisionFromRow);
  }

  publishRevision({ bookId, revisionId, publishedBy = null }) {
    const normalizedBookId = safeId(bookId, "bookId");
    const normalizedRevisionId = safeId(revisionId, "revisionId");
    const timestamp = this.clock().toISOString();
    const publish = this.database.transaction(() => {
      const book = this.database.query("SELECT * FROM books WHERE id = ?").get(normalizedBookId);
      if (!book || book.status !== "active") throw new TypeError("Bogen findes ikke eller er arkiveret.");
      if (book.active_revision_id === normalizedRevisionId) return;
      const revision = this.database.query("SELECT state FROM book_revisions WHERE book_id = ? AND id = ?")
        .get(normalizedBookId, normalizedRevisionId);
      if (!revision || revision.state !== "ready") throw new TypeError("Kun en klar revision kan publiceres.");
      this.database.query("UPDATE book_revisions SET state = 'superseded' WHERE book_id = ? AND state = 'published'").run(normalizedBookId);
      this.database.query(`
        UPDATE book_revisions SET state = 'published', published_by = ?, published_at = ? WHERE book_id = ? AND id = ?
      `).run(publishedBy, timestamp, normalizedBookId, normalizedRevisionId);
      this.database.query("UPDATE books SET active_revision_id = ?, updated_at = ? WHERE id = ?")
        .run(normalizedRevisionId, timestamp, normalizedBookId);
    });
    publish();
    return { book: this.getBook(normalizedBookId), revision: this.getRevision(normalizedBookId, normalizedRevisionId) };
  }

  close() {
    this.database.close(false);
  }
}
