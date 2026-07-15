import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hasPermission } from "./access-policy.mjs";
import { AnnotationRepository } from "./annotation-repository.mjs";
import { ApplicationError, BookCollaboration } from "./application-service.mjs";
import { BookContentIndex } from "./book-content-index.mjs";

function actorId(principal) {
  return principal?.actorUserId ?? principal?.id ?? null;
}

function instanceAdministrator(principal) {
  return principal?.kind === "local"
    || principal?.globalRole === "instance_admin"
    || principal?.instanceAdmin === true;
}

function deny(message = "Du har ikke adgang til denne handling.") {
  throw new ApplicationError(403, message, "forbidden");
}

function safeUploadName(value) {
  const name = String(value ?? "book.tar.gz").trim();
  if (!name.toLowerCase().endsWith(".tar.gz")) throw new TypeError("Uploaden skal være en .tar.gz-fil.");
  return name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 160);
}

function slug(value) {
  const normalized = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const result = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  if (!result) throw new TypeError("Bogens titel kan ikke omsættes til en slug.");
  return result;
}

export class LibraryApplication {
  constructor({ config, catalog, collaborationRepository, clock = () => new Date(), createId = () => `upload-${Bun.randomUUIDv7()}` }) {
    this.config = config;
    this.catalog = catalog;
    this.collaboration = collaborationRepository;
    this.clock = clock;
    this.createId = createId;
    this.services = new Map();
    this.uploads = new Map();
  }

  get defaultBookId() {
    if (this.config.library.defaultBookId && this.catalog.getBook(this.config.library.defaultBookId)) return this.config.library.defaultBookId;
    return this.catalog.listBooks()[0]?.id ?? "";
  }

  resolveBookId(value) {
    const requested = String(value ?? "");
    const book = this.catalog.getBook(requested) ?? this.catalog.listBooks({ includeArchived: true }).find((item) => item.slug === requested);
    if (!book) throw new ApplicationError(404, "Bogen findes ikke.", "book_not_found");
    return book.id;
  }

  bookContext(bookId) {
    bookId = this.resolveBookId(bookId);
    const book = this.catalog.getBook(bookId);
    if (!book) throw new ApplicationError(404, "Bogen findes ikke.", "book_not_found");
    const revision = book.activeRevisionId ? this.catalog.getRevision(book.id, book.activeRevisionId) : null;
    const manifestBook = revision?.manifest?.book ?? {};
    const sourceDir = revision?.storageKey ? this.catalog.storage.resolveContentPath(revision.storageKey) : "";
    return {
      book,
      revision,
      config: {
        ...this.config,
        book: {
          id: book.id,
          slug: book.slug,
          title: book.title,
          subtitle: book.subtitle ?? manifestBook.subtitle ?? "",
          mark: manifestBook.mark ?? book.title.slice(0, 1),
          language: book.language ?? manifestBook.language ?? "da",
          sourceDir,
          document: manifestBook.document ?? "",
          navigation: manifestBook.navigation ?? "",
          paginationTimeoutMs: this.config.book?.paginationTimeoutMs ?? 45_000,
          buildId: manifestBook.buildId ?? revision?.contentHash ?? "",
          revisionId: revision?.id ?? "unpublished",
        },
        annotations: { file: join(this.config.library.dataDir, "library", book.id, "annotations.json") },
      },
    };
  }

  serviceForBook(bookId) {
    const context = this.bookContext(bookId);
    bookId = context.book.id;
    const cacheKey = `${bookId}:${context.revision?.id ?? "unpublished"}`;
    const cached = this.services.get(cacheKey);
    if (cached) return cached;
    for (const key of this.services.keys()) if (key.startsWith(`${bookId}:`)) this.services.delete(key);
    const annotations = new AnnotationRepository({
      filePath: context.config.annotations.file,
      bookId,
      revisionId: context.config.book.revisionId,
    });
    const bookContentIndex = context.config.book.sourceDir && context.config.book.document
      ? new BookContentIndex({
        filePath: join(context.config.book.sourceDir, context.config.book.document),
        bookId,
        buildId: context.config.book.buildId,
      })
      : null;
    const service = new BookCollaboration({
      config: context.config,
      annotationRepository: annotations,
      collaborationRepository: this.collaboration,
      bookContentIndex,
    });
    this.services.set(cacheKey, service);
    return service;
  }

  principalForBook(principal, bookId) {
    if (!principal || principal.kind !== "user") return principal;
    return this.collaboration.principalForUser(principal.id, bookId) ?? principal;
  }

  async resolvePrincipal({ bookId = this.defaultBookId, sessionSecret = "", bearerToken = "", guestId = "" } = {}) {
    if (bearerToken) {
      const token = await this.collaboration.resolveServiceToken(bearerToken);
      if (!token) throw new ApplicationError(401, "Tokenet er ugyldigt, udløbet eller tilbagekaldt.", "invalid_token");
      return token;
    }
    const localBypass = bookId ? this.serviceForBook(bookId).policy.localBypass : this.config.access.localBypass;
    if (localBypass) return { kind: "local", id: "local-owner", displayName: "Lokal ejer", bookId };
    if (sessionSecret) {
      const user = await this.collaboration.resolveSession(sessionSecret, bookId || null);
      if (user) return user;
    }
    return guestId ? { kind: "guest", id: guestId, displayName: "Gæstelæser", bookId } : null;
  }

  async acceptAccessCode({ bookId, accessCode, email, displayName, password, phone, phonePurpose }) {
    this.bookContext(bookId);
    let user = this.collaboration.getUserByEmail(email);
    if (!user) user = await this.collaboration.createUser({ email, displayName, password });
    else if (!await this.collaboration.authenticate(email, password, null)) {
      throw new ApplicationError(401, "E-mail eller password er forkert.", "invalid_credentials");
    }
    await this.collaboration.enrollUser({ userId: user.id, bookId, method: "code", accessCode });
    if (phone) this.collaboration.saveReviewerProfile(user.id, { bookId, phone, phonePurpose });
    const principal = this.collaboration.principalForUser(user.id, bookId);
    const session = await this.collaboration.createSession(user.id);
    this.collaboration.audit({ principal, action: "access_code.accept", resourceType: "user", resourceId: user.id, bookId });
    return { ...session, principal };
  }

  sessionForBook(principal, bookId) {
    return this.serviceForBook(bookId).session(this.principalForBook(principal, bookId));
  }

  assertBookPermission(principal, permission, bookId) {
    if (!hasPermission(this.principalForBook(principal, bookId), permission, bookId)) deny();
  }

  listBooks(principal) {
    return this.catalog.listBooks().filter((book) => {
      if (instanceAdministrator(principal)) return true;
      try {
        this.serviceForBook(book.id).assertCanRead(this.principalForBook(principal, book.id));
        return true;
      } catch {
        return false;
      }
    }).map((book) => ({ ...book, activeRevision: book.activeRevisionId ? this.catalog.getRevision(book.id, book.activeRevisionId) : null }));
  }

  getBook(principal, bookId) {
    const book = this.bookContext(bookId).book;
    if (!instanceAdministrator(principal)) this.serviceForBook(bookId).assertCanRead(this.principalForBook(principal, bookId));
    return { ...book, activeRevision: book.activeRevisionId ? this.catalog.getRevision(bookId, book.activeRevisionId) : null };
  }

  createBook(principal, input) {
    if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan oprette bøger.");
    const bookSlug = input.slug ? slug(input.slug) : slug(input.title);
    const book = this.catalog.createBook({ ...input, id: input.id || bookSlug, slug: bookSlug, createdBy: actorId(principal) });
    this.collaboration.saveAccessPolicy(this.config.access, actorId(principal), book.id);
    if (principal?.kind === "user") this.collaboration.setMembership(principal.id, "book_admin", { bookId: book.id });
    this.collaboration.audit({ principal, action: "book.create", resourceType: "book", resourceId: book.id, bookId: book.id });
    return book;
  }

  archiveBook(principal, bookId) {
    this.assertBookPermission(principal, "books:settings", bookId);
    const book = this.catalog.archiveBook({ bookId, archivedBy: actorId(principal) });
    this.services.forEach((_service, key) => { if (key.startsWith(`${bookId}:`)) this.services.delete(key); });
    this.collaboration.audit({ principal, action: "book.archive", resourceType: "book", resourceId: bookId, bookId });
    return book;
  }

  createBookUpload(principal, bookId, input = {}) {
    this.assertBookPermission(principal, "books:upload", bookId);
    this.bookContext(bookId);
    const id = this.createId();
    const filename = safeUploadName(input.filename);
    const expiresAt = new Date(this.clock().getTime() + 60 * 60 * 1000).toISOString();
    const filePath = join(this.config.library.dataDir, "uploads", "pending", `${id}.tar.gz`);
    this.uploads.set(id, { id, bookId, filename, filePath, expiresAt, uploaded: false });
    return { upload: { id, bookId, filename, uploadUrl: `/api/admin/books/${encodeURIComponent(bookId)}/uploads/${encodeURIComponent(id)}/content`, expiresAt } };
  }

  uploadRecord(bookId, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.bookId !== bookId || upload.expiresAt <= this.clock().toISOString()) {
      throw new ApplicationError(404, "Uploaden findes ikke eller er udløbet.", "upload_not_found");
    }
    return upload;
  }

  async writeBookUpload(principal, bookId, uploadId, request) {
    this.assertBookPermission(principal, "books:upload", bookId);
    const upload = this.uploadRecord(bookId, uploadId);
    const declaredBytes = Number(request.headers.get("content-length") ?? 0);
    if (declaredBytes > this.config.library.uploadMaxBytes) throw new ApplicationError(413, "Uploaden er for stor.", "upload_too_large");
    await mkdir(dirname(upload.filePath), { recursive: true });
    const written = await Bun.write(upload.filePath, request);
    if (written > this.config.library.uploadMaxBytes) {
      await rm(upload.filePath, { force: true });
      throw new ApplicationError(413, "Uploaden er for stor.", "upload_too_large");
    }
    upload.uploaded = true;
    upload.sizeBytes = written;
    return { upload: { id: upload.id, bookId, filename: upload.filename, sizeBytes: written, expiresAt: upload.expiresAt } };
  }

  async validateBookUpload(principal, bookId, uploadId) {
    this.assertBookPermission(principal, "books:upload", bookId);
    const upload = this.uploadRecord(bookId, uploadId);
    if (!upload.uploaded) throw new TypeError("Uploaden mangler indhold.");
    try {
      const revision = await this.catalog.uploadRevision({ bookId, archivePath: upload.filePath, createdBy: actorId(principal) });
      this.collaboration.audit({ principal, action: "book_revision.validate", resourceType: "book_revision", resourceId: revision.id, bookId });
      return { revision };
    } finally {
      this.uploads.delete(uploadId);
      await rm(upload.filePath, { force: true });
    }
  }

  listBookRevisions(principal, bookId) {
    this.assertBookPermission(principal, "books:read", bookId);
    return this.catalog.listRevisions(bookId);
  }

  publishBookRevision(principal, bookId, revisionId) {
    this.assertBookPermission(principal, "books:publish", bookId);
    const published = this.catalog.publishRevision({ bookId, revisionId, publishedBy: actorId(principal) });
    this.services.forEach((_service, key) => { if (key.startsWith(`${bookId}:`)) this.services.delete(key); });
    this.collaboration.audit({ principal, action: "book_revision.publish", resourceType: "book_revision", resourceId: revisionId, bookId });
    return published;
  }

  delegate(principal, bookId, method, ...arguments_) {
    const service = this.serviceForBook(bookId);
    return service[method](this.principalForBook(principal, bookId), ...arguments_);
  }

  listBookOutline(principal, bookId, options) { return this.delegate(principal, bookId, "listBookOutline", options); }
  getBookSection(principal, bookId, anchorId) { return this.delegate(principal, bookId, "getBookSection", anchorId); }
  searchBook(principal, bookId, query, options) { return this.delegate(principal, bookId, "searchBook", query, options); }
  getAnnotationContext(principal, bookId, id) { return this.delegate(principal, bookId, "getAnnotationContext", id); }
  listChangesSince(principal, bookId, options) { return this.delegate(principal, bookId, "listChangesSince", options); }
  listAnnotations(principal, bookId) { return this.delegate(principal, bookId, "listAnnotations"); }
  createAnnotation(principal, bookId, input) { return this.delegate(principal, bookId, "createAnnotation", input); }
  updateAnnotation(principal, bookId, id, input) { return this.delegate(principal, bookId, "updateAnnotation", id, input); }
  deleteAnnotation(principal, bookId, id) { return this.delegate(principal, bookId, "deleteAnnotation", id); }
  importAnnotations(principal, bookId, document, mode) { return this.delegate(principal, bookId, "importAnnotations", document, mode); }
  exportAnnotations(principal, bookId, format) { return this.delegate(principal, bookId, "exportAnnotations", format); }
  getProgress(principal, bookId) { return this.delegate(principal, bookId, "getProgress"); }
  saveProgress(principal, bookId, input) { return this.delegate(principal, bookId, "saveProgress", input); }
  listAllProgress(principal, bookId) { return this.delegate(principal, bookId, "listAllProgress"); }
  accessSettings(principal, bookId) { return this.delegate(principal, bookId, "accessSettings"); }
  updateAccessSettings(principal, bookId, input) { return this.delegate(principal, bookId, "updateAccessSettings", input); }
  listMembers(principal, bookId) { return this.delegate(principal, bookId, "listUsers"); }
  createInvitation(principal, bookId, input) { return this.delegate(principal, bookId, "createInvitation", input); }
  listInvitations(principal, bookId) { return this.delegate(principal, bookId, "listInvitations"); }
  revokeInvitation(principal, bookId, id) { return this.delegate(principal, bookId, "revokeInvitation", id); }
  createAccessCode(principal, bookId, input) { return this.delegate(principal, bookId, "createAccessCode", input); }
  listAccessCodes(principal, bookId) { return this.delegate(principal, bookId, "listAccessCodes"); }
  revokeAccessCode(principal, bookId, id) { return this.delegate(principal, bookId, "revokeAccessCode", id); }

  listUsers(principal, options = {}) {
    const bookId = options?.bookId;
    if (bookId) return this.delegate(principal, bookId, "listUsers");
    if (!instanceAdministrator(principal)) deny();
    return this.collaboration.listUsers(null);
  }

  createUser(principal, input) {
    if (input.bookId) return this.delegate(principal, input.bookId, "createUser", input);
    if (!instanceAdministrator(principal)) deny();
    return this.collaboration.createUser(input);
  }

  updateUser(principal, userId, input) {
    const bookId = input.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "updateUser", userId, {
      ...input,
      bookRole: input.bookRole === undefined ? input.role : input.bookRole,
    });
  }

  resetUserPassword(principal, userId, newPassword) {
    const bookId = this.defaultBookId;
    return this.delegate(principal, bookId, "resetUserPassword", userId, newPassword);
  }

  createToken(principal, input) {
    const instanceAdmin = input.instanceAdmin === true || input.instanceAdmin === "true";
    const grants = instanceAdmin ? [] : input.grants ?? (input.bookIds?.length
      ? input.bookIds.map((bookId) => ({ bookId, permissions: input.scopes }))
      : undefined);
    const bookId = grants?.[0]?.bookId ?? input.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "createToken", { ...input, instanceAdmin, grants });
  }

  listTokens(principal, options = {}) {
    const bookId = options?.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "listTokens");
  }

  revokeToken(principal, id) {
    return this.delegate(principal, this.defaultBookId, "revokeToken", id);
  }

  listAudit(principal, options = {}) {
    const bookId = options?.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "listAudit", options);
  }

  async exportUserData(principal, userId = actorId(principal)) {
    if (!userId || (userId !== actorId(principal) && !instanceAdministrator(principal))) deny();
    const account = this.collaboration.exportUserData(userId);
    const annotations = [];
    for (const book of this.catalog.listBooks({ includeArchived: true })) {
      const document = await this.serviceForBook(book.id).annotations.list();
      annotations.push(...document.annotations.filter((annotation) => annotation.author.id === userId));
    }
    return { ...account, annotations };
  }

  async eraseUserData(principal, userId = actorId(principal)) {
    if (!userId || (userId !== actorId(principal) && !instanceAdministrator(principal))) deny();
    this.collaboration.audit({ principal, action: "user.erase", resourceType: "user", resourceId: userId, bookId: null });
    for (const book of this.catalog.listBooks({ includeArchived: true })) {
      await this.serviceForBook(book.id).annotations.anonymizeAuthor(userId);
    }
    return this.collaboration.eraseUserData(userId);
  }
}
