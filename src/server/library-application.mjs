import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hasPermission } from "./access-policy.mjs";
import { AnnotationRepository } from "./annotation-repository.mjs";
import { ApplicationError, BookCollaboration, principalSummary } from "./application-service.mjs";
import { BookContentIndex } from "./book-content-index.mjs";

function actorId(principal) {
  return principal?.actorUserId ?? principal?.id ?? null;
}

function instanceAdministrator(principal) {
  return principal?.kind === "local"
    || (principal?.kind === "user" && principal.globalRole === "instance_admin")
    || (principal?.kind === "token" && principal.instanceAdmin === true);
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

const MAX_PENDING_UPLOADS_PER_BOOK = 10;
const ARCHIVED_ADMIN_READ_METHODS = new Set([
  "listBookOutline", "getBookSection", "searchBook", "getAnnotationContext", "listChangesSince",
  "listAnnotations", "exportAnnotations", "listSurveys", "getSurvey", "listSurveyResponses",
  "exportReviewBundle", "listAllProgress", "accessSettings", "listUsers", "listInvitations",
  "listAccessCodes", "listTokens", "listAudit",
]);

function validUploadId(value) {
  const id = String(value ?? "");
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) {
    throw new ApplicationError(404, "Uploaden findes ikke eller er udløbet.", "upload_not_found");
  }
  return id;
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

  get pendingUploadDir() {
    return join(this.config.library.dataDir, "uploads", "pending");
  }

  uploadMetadataPath(uploadId) {
    return join(this.pendingUploadDir, `${validUploadId(uploadId)}.json`);
  }

  async persistUpload(upload) {
    await mkdir(this.pendingUploadDir, { recursive: true, mode: 0o700 });
    await chmod(this.pendingUploadDir, 0o700);
    const metadataPath = this.uploadMetadataPath(upload.id);
    const temporaryPath = `${metadataPath}.${Bun.randomUUIDv7()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(upload)}\n`, { mode: 0o600 });
    await rename(temporaryPath, metadataPath);
    await chmod(metadataPath, 0o600);
    this.uploads.set(upload.id, upload);
  }

  async removeUpload(upload) {
    if (!upload) return;
    const id = validUploadId(upload.id);
    this.uploads.delete(id);
    await Promise.all([
      rm(join(this.pendingUploadDir, `${id}.tar.gz`), { force: true }),
      rm(this.uploadMetadataPath(id), { force: true }),
    ]);
  }

  async cleanupUploads() {
    await mkdir(this.pendingUploadDir, { recursive: true, mode: 0o700 });
    await chmod(this.pendingUploadDir, 0o700);
    const entries = await readdir(this.pendingUploadDir);
    const active = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const id = entry.slice(0, -5);
      try {
        const upload = JSON.parse(await readFile(this.uploadMetadataPath(id), "utf8"));
        upload.filePath = join(this.pendingUploadDir, `${id}.tar.gz`);
        if (upload.id !== id || upload.expiresAt <= this.clock().toISOString()) await this.removeUpload(upload);
        else active.push(upload);
      } catch {
        await rm(join(this.pendingUploadDir, entry), { force: true });
        await rm(join(this.pendingUploadDir, `${id}.tar.gz`), { force: true });
      }
    }
    return active;
  }

  get defaultBookId() {
    const configured = this.config.library.defaultBookId && this.catalog.getBook(this.config.library.defaultBookId);
    if (configured?.status === "active") return configured.id;
    return this.catalog.listBooks()[0]?.id ?? "";
  }

  async health() {
    const storage = {
      catalog: this.catalog.repository?.health?.() ? "ok" : "unavailable",
      collaboration: this.collaboration.health() ? "ok" : "unavailable",
      annotations: "ok",
    };
    const bookId = this.defaultBookId;
    if (bookId) {
      const bookHealth = await this.serviceForBook(bookId).health();
      storage.annotations = bookHealth.annotations;
    }
    return storage;
  }

  resolveBookId(value, { includeArchived = false } = {}) {
    const requested = String(value ?? "");
    const byId = this.catalog.getBook(requested);
    let bySlug = null;
    try { bySlug = this.catalog.getBookBySlug(requested)?.book ?? null; } catch {}
    const book = byId ?? bySlug;
    if (!book) throw new ApplicationError(404, "Bogen findes ikke.", "book_not_found");
    if (book.status === "archived" && !includeArchived) {
      throw new ApplicationError(410, "Bogen er arkiveret.", "book_archived");
    }
    return book.id;
  }

  bookContext(bookId, { includeArchived = false } = {}) {
    bookId = this.resolveBookId(bookId, { includeArchived });
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

  serviceForBook(bookId, { includeArchived = false } = {}) {
    const context = this.bookContext(bookId, { includeArchived });
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

  session(principal) {
    return {
      principal: principalSummary(principal),
      capabilities: { canManageUsers: instanceAdministrator(principal), permissions: [] },
    };
  }

  async login({ email, password }) {
    const user = await this.collaboration.authenticate(email, password, null);
    if (!user) throw new ApplicationError(401, "E-mail eller password er forkert.", "invalid_credentials");
    const principal = this.collaboration.principalForUser(user.id, null);
    const session = await this.collaboration.createSession(user.id);
    this.collaboration.audit({ principal, action: "session.login", resourceType: "session", bookId: null });
    return { ...session, principal };
  }

  async logout(sessionSecret, principal) {
    const revoked = await this.collaboration.revokeSession(sessionSecret);
    if (revoked) this.collaboration.audit({ principal, action: "session.logout", resourceType: "session", bookId: null });
    return revoked;
  }

  async changeOwnPassword(principal, input) {
    if (principal?.kind !== "user") deny("Log ind som bruger for at ændre password.");
    const user = await this.collaboration.changePassword(principal.id, input);
    this.collaboration.audit({ principal, action: "user.password.change", resourceType: "user", resourceId: principal.id, bookId: null });
    return user;
  }

  async acceptAccessCode({ bookId, accessCode, email, displayName, password, phone, phonePurpose }) {
    this.bookContext(bookId);
    await this.collaboration.validateAccessCode(accessCode, bookId);
    let user = this.collaboration.getUserByEmail(email);
    let createdUser = false;
    if (!user) {
      user = await this.collaboration.createUser({ email, displayName, password });
      createdUser = true;
    } else if (!await this.collaboration.authenticate(email, password, null)) {
      throw new ApplicationError(401, "E-mail eller password er forkert.", "invalid_credentials");
    }
    try {
      await this.collaboration.enrollUser({ userId: user.id, bookId, method: "code", accessCode });
    } catch (error) {
      if (createdUser) this.collaboration.discardUnenrolledUser(user.id);
      throw error;
    }
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

  listBooks(principal, { includeArchived = false } = {}) {
    return this.catalog.listBooks({ includeArchived }).filter((book) => {
      if (instanceAdministrator(principal)) return true;
      if (book.status === "archived") return hasPermission(this.principalForBook(principal, book.id), "books:read", book.id);
      try {
        this.serviceForBook(book.id).assertCanRead(this.principalForBook(principal, book.id));
        return true;
      } catch {
        return false;
      }
    }).map((book) => ({ ...book, activeRevision: book.activeRevisionId ? this.catalog.getRevision(book.id, book.activeRevisionId) : null }));
  }

  getBook(principal, bookId, { includeArchived = false } = {}) {
    const book = this.bookContext(bookId, { includeArchived }).book;
    if (!instanceAdministrator(principal)) {
      if (book.status === "archived") this.assertBookPermission(principal, "books:read", bookId);
      else this.serviceForBook(bookId).assertCanRead(this.principalForBook(principal, bookId));
    }
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

  updateBook(principal, bookId, input) {
    this.assertBookPermission(principal, "books:settings", bookId);
    const previous = this.bookContext(bookId).book;
    const nextSlug = slug(input.slug);
    const book = this.catalog.updateBookSlug({ bookId: previous.id, slug: nextSlug });
    this.collaboration.audit({
      principal,
      action: "book.update",
      resourceType: "book",
      resourceId: book.id,
      bookId: book.id,
      details: { previousSlug: previous.slug, slug: book.slug },
    });
    return book;
  }

  archiveBook(principal, bookId) {
    this.assertBookPermission(principal, "books:settings", bookId);
    const book = this.catalog.archiveBook({ bookId, archivedBy: actorId(principal) });
    this.services.forEach((_service, key) => { if (key.startsWith(`${bookId}:`)) this.services.delete(key); });
    this.collaboration.audit({ principal, action: "book.archive", resourceType: "book", resourceId: bookId, bookId });
    return book;
  }

  async createBookUpload(principal, bookId, input = {}) {
    this.assertBookPermission(principal, "books:upload", bookId);
    this.bookContext(bookId);
    const pending = await this.cleanupUploads();
    if (pending.filter((upload) => upload.bookId === bookId).length >= MAX_PENDING_UPLOADS_PER_BOOK) {
      throw new ApplicationError(429, "Der er for mange afventende uploads til bogen.", "upload_limit_reached");
    }
    const id = this.createId();
    const filename = safeUploadName(input.filename);
    const expiresAt = new Date(this.clock().getTime() + 60 * 60 * 1000).toISOString();
    const filePath = join(this.config.library.dataDir, "uploads", "pending", `${id}.tar.gz`);
    await this.persistUpload({ id, bookId, filename, filePath, expiresAt, uploaded: false });
    return { upload: { id, bookId, filename, uploadUrl: `/api/admin/books/${encodeURIComponent(bookId)}/uploads/${encodeURIComponent(id)}/content`, expiresAt } };
  }

  async uploadRecord(bookId, uploadId) {
    uploadId = validUploadId(uploadId);
    let upload = this.uploads.get(uploadId);
    if (!upload) {
      try {
        upload = JSON.parse(await readFile(this.uploadMetadataPath(uploadId), "utf8"));
        upload.filePath = join(this.pendingUploadDir, `${uploadId}.tar.gz`);
      } catch {}
    }
    if (!upload || upload.bookId !== bookId || upload.expiresAt <= this.clock().toISOString()) {
      if (upload) await this.removeUpload(upload);
      throw new ApplicationError(404, "Uploaden findes ikke eller er udløbet.", "upload_not_found");
    }
    this.uploads.set(uploadId, upload);
    return upload;
  }

  async writeBookUpload(principal, bookId, uploadId, request) {
    this.assertBookPermission(principal, "books:upload", bookId);
    const upload = await this.uploadRecord(bookId, uploadId);
    const declaredBytes = Number(request.headers.get("content-length") ?? 0);
    if (declaredBytes > this.config.library.uploadMaxBytes) throw new ApplicationError(413, "Uploaden er for stor.", "upload_too_large");
    await mkdir(dirname(upload.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(upload.filePath), 0o700);
    const written = await Bun.write(upload.filePath, request);
    if (written > this.config.library.uploadMaxBytes) {
      await rm(upload.filePath, { force: true });
      throw new ApplicationError(413, "Uploaden er for stor.", "upload_too_large");
    }
    await chmod(upload.filePath, 0o600);
    upload.uploaded = true;
    upload.sizeBytes = written;
    await this.persistUpload(upload);
    return { upload: { id: upload.id, bookId, filename: upload.filename, sizeBytes: written, expiresAt: upload.expiresAt } };
  }

  async validateBookUpload(principal, bookId, uploadId) {
    this.assertBookPermission(principal, "books:upload", bookId);
    const upload = await this.uploadRecord(bookId, uploadId);
    if (!upload.uploaded) throw new TypeError("Uploaden mangler indhold.");
    try {
      const revision = await this.catalog.uploadRevision({ bookId, archivePath: upload.filePath, createdBy: actorId(principal) });
      this.collaboration.audit({ principal, action: "book_revision.validate", resourceType: "book_revision", resourceId: revision.id, bookId });
      return { revision };
    } finally {
      await this.removeUpload(upload);
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
    const resolvedBookId = this.resolveBookId(bookId, { includeArchived: true });
    const book = this.catalog.getBook(resolvedBookId);
    let includeArchived = false;
    if (book.status === "archived") {
      const archivedAdmin = principal?.kind !== "token"
        && (instanceAdministrator(principal) || hasPermission(this.principalForBook(principal, resolvedBookId), "books:settings", resolvedBookId));
      if (!archivedAdmin || !ARCHIVED_ADMIN_READ_METHODS.has(method)) {
        throw new ApplicationError(410, "Bogen er arkiveret.", "book_archived");
      }
      includeArchived = true;
    }
    const service = this.serviceForBook(resolvedBookId, { includeArchived });
    return service[method](this.principalForBook(principal, resolvedBookId), ...arguments_);
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
  listActiveSurveys(principal, bookId) { return this.delegate(principal, bookId, "listActiveSurveys"); }
  getSurvey(principal, bookId, id) { return this.delegate(principal, bookId, "getSurvey", id); }
  getMySurveyResponse(principal, bookId, id) { return this.delegate(principal, bookId, "getMySurveyResponse", id); }
  submitSurveyResponse(principal, bookId, id, answers) { return this.delegate(principal, bookId, "submitSurveyResponse", id, answers); }
  listSurveys(principal, bookId, options) { return this.delegate(principal, bookId, "listSurveys", options); }
  createSurvey(principal, bookId, definition) { return this.delegate(principal, bookId, "createSurvey", definition); }
  updateSurveyDraft(principal, bookId, id, definition) { return this.delegate(principal, bookId, "updateSurveyDraft", id, definition); }
  publishSurvey(principal, bookId, id) { return this.delegate(principal, bookId, "publishSurvey", id); }
  closeSurvey(principal, bookId, id) { return this.delegate(principal, bookId, "closeSurvey", id); }
  listSurveyResponses(principal, bookId, options) { return this.delegate(principal, bookId, "listSurveyResponses", options); }
  exportReviewBundle(principal, bookId, options) { return this.delegate(principal, bookId, "exportReviewBundle", options); }
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
    if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan oprette globale brugerkonti.");
    if (input.bookId) return this.delegate(principal, input.bookId, "createUser", input);
    return this.collaboration.createUser(input);
  }

  updateUser(principal, userId, input) {
    if ((input.globalRole !== undefined || input.status !== undefined) && !instanceAdministrator(principal)) {
      deny("Kun en instansadministrator kan ændre globale kontooplysninger.");
    }
    const bookId = input.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "updateUser", userId, {
      ...input,
      bookRole: input.bookRole === undefined ? input.role : input.bookRole,
    });
  }

  resetUserPassword(principal, userId, newPassword) {
    if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan nulstille andre brugeres passwords.");
    const bookId = this.defaultBookId;
    return this.delegate(principal, bookId, "resetUserPassword", userId, newPassword);
  }

  async createToken(principal, input) {
    const instanceAdmin = input.instanceAdmin === true || input.instanceAdmin === "true";
    if (instanceAdmin) {
      if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan oprette et instansadministrator-token.");
      if (input.actorUserId != null && (principal?.kind !== "user" || input.actorUserId !== principal.id)) {
        deny("Et token kan kun bindes til den bruger, der opretter det.");
      }
      const token = await this.collaboration.createServiceToken({
        ...input,
        instanceAdmin: true,
        scopes: undefined,
        grants: [],
        createdBy: actorId(principal),
      });
      this.collaboration.audit({
        principal,
        action: "token.create",
        resourceType: "service_token",
        resourceId: token.id,
        bookId: null,
        details: { name: token.name, grants: [], instanceAdmin: true },
      });
      return token;
    }
    const grants = input.grants ?? (input.bookIds?.length
      ? input.bookIds.map((bookId) => ({ bookId, permissions: input.scopes }))
      : undefined);
    for (const grant of grants ?? []) this.bookContext(grant.bookId);
    const bookId = grants?.[0]?.bookId ?? input.bookId ?? this.defaultBookId;
    const effectivePrincipal = principal?.kind === "user" && grants?.length
      ? {
        ...principal,
        memberships: grants.map((grant) => this.collaboration.principalForUser(principal.id, grant.bookId)?.membership).filter(Boolean),
      }
      : principal;
    return this.serviceForBook(bookId).createToken(effectivePrincipal, { ...input, instanceAdmin: false, grants });
  }

  listTokens(principal, options = {}) {
    if (!options?.bookId && instanceAdministrator(principal)) {
      return this.collaboration.listServiceTokens(null, { includeInstanceAdmin: true, includeAllBookGrants: true });
    }
    const bookId = options?.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "listTokens");
  }

  revokeToken(principal, id, { bookId = this.defaultBookId } = {}) {
    if (instanceAdministrator(principal)) {
      const token = this.collaboration.listServiceTokens(null, { includeInstanceAdmin: true, includeAllBookGrants: true })
        .find((candidate) => candidate.id === id);
      const revoked = this.collaboration.revokeServiceToken(id, null, { allowGlobal: true });
      if (revoked && token) {
        const bookIds = token.bookGrants.length ? token.bookGrants.map((grant) => grant.bookId) : [null];
        for (const bookId of bookIds) {
          this.collaboration.audit({ principal, action: "token.revoke", resourceType: "service_token", resourceId: id, bookId });
        }
      }
      return revoked;
    }
    return this.delegate(principal, bookId, "revokeToken", id);
  }

  listAudit(principal, options = {}) {
    const bookId = options?.bookId ?? this.defaultBookId;
    return this.delegate(principal, bookId, "listAudit", options);
  }

  async exportUserData(principal, userId) {
    if (userId === undefined) {
      if (principal?.kind !== "user") deny("Selvbetjent kontoeksport kræver en brugersession.");
      userId = principal.id;
    } else if (!userId || (principal?.kind !== "user" || userId !== principal.id) && !instanceAdministrator(principal)) deny();
    const account = this.collaboration.exportUserData(userId);
    const annotations = [];
    for (const book of this.catalog.listBooks({ includeArchived: true })) {
      const document = await this.serviceForBook(book.id, { includeArchived: true }).annotations.list();
      annotations.push(...document.annotations.filter((annotation) => annotation.author.id === userId || annotation.updatedBy.id === userId));
    }
    return { ...account, annotations };
  }

  async eraseUserData(principal, userId) {
    if (userId === undefined) {
      if (principal?.kind !== "user") deny("Selvbetjent kontosletning kræver en brugersession.");
      userId = principal.id;
    } else if (!userId || (principal?.kind !== "user" || userId !== principal.id) && !instanceAdministrator(principal)) deny();
    this.collaboration.audit({ principal, action: "user.erase", resourceType: "user", resourceId: userId, bookId: null });
    for (const book of this.catalog.listBooks({ includeArchived: true })) {
      await this.serviceForBook(book.id, { includeArchived: true }).annotations.anonymizeAuthor(userId);
    }
    return this.collaboration.eraseUserData(userId);
  }
}
