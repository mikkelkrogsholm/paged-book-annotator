import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ANNOTATION_SCHEMA_VERSION = 4;
export const ANNOTATION_TYPES = Object.freeze(["text", "element", "page"]);
export const ANNOTATION_STATUSES = Object.freeze(["open", "resolved", "accepted", "rejected"]);
export const ANNOTATION_CATEGORIES = Object.freeze(["general", "language", "structure", "fact", "design"]);
export const ANCHOR_STATES = Object.freeze(["attached", "orphaned"]);
export const ANNOTATION_VISIBILITIES = Object.freeze(["private", "reviewGroup", "public"]);
export const ANNOTATION_LIMITS = Object.freeze({
  maxAnnotations: 10_000,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxCommentLength: 16_384,
  maxExactLength: 65_536,
  maxContextLength: 2_048,
  maxScopeIdLength: 512,
  maxLabelLength: 512,
  maxIdentifierLength: 256,
  maxDisplayNameLength: 200,
  maxTimestampLength: 64,
});

const DEFAULT_LOCAL_ACTOR = Object.freeze({
  id: "local-owner",
  displayName: "Lokal ejer",
  kind: "local",
});

function requireString(value, field, { allowEmpty = false, maximumLength = null } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  }
  const normalized = value.trim();
  if (maximumLength && normalized.length > maximumLength) {
    throw new TypeError(`${field} må højst være ${maximumLength} tegn.`);
  }
  return normalized;
}

function optionalString(value, field, { maximumLength = null } = {}) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError(`${field} skal være tekst.`);
  if (maximumLength && value.length > maximumLength) throw new TypeError(`${field} må højst være ${maximumLength} tegn.`);
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} skal være et positivt heltal.`);
  }
  return value;
}

function validateTextSelector(selector) {
  if (!selector || selector.type !== "TextQuoteSelector") {
    throw new TypeError("Tekstannotationer kræver en TextQuoteSelector.");
  }

  const exact = requireString(selector.exact, "target.selector.exact", { maximumLength: ANNOTATION_LIMITS.maxExactLength });
  const validated = {
    type: "TextQuoteSelector",
    exact,
    prefix: optionalString(selector.prefix, "target.selector.prefix", { maximumLength: ANNOTATION_LIMITS.maxContextLength }),
    suffix: optionalString(selector.suffix, "target.selector.suffix", { maximumLength: ANNOTATION_LIMITS.maxContextLength }),
  };

  if (selector.position != null) {
    const start = Number(selector.position.start);
    const end = Number(selector.position.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw new TypeError("Tekstpositionen skal have gyldige start- og slutværdier.");
    }
    validated.position = { start, end };
  }

  return validated;
}

export function validateAnnotationTarget(type, target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new TypeError("target skal være et objekt.");
  }

  const validated = {
    pageNumber: requirePositiveInteger(target.pageNumber, "target.pageNumber"),
    label: optionalString(target.label, "target.label", { maximumLength: ANNOTATION_LIMITS.maxLabelLength }).trim(),
  };

  if (type === "page") {
    validated.scopeId = requireString(target.scopeId, "target.scopeId", { maximumLength: ANNOTATION_LIMITS.maxScopeIdLength });
    return validated;
  }

  validated.scopeId = requireString(target.scopeId, "target.scopeId", { maximumLength: ANNOTATION_LIMITS.maxScopeIdLength });
  if (type === "text") validated.selector = validateTextSelector(target.selector);
  return validated;
}

export function validateAnnotationDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Annotationen skal være et objekt.");
  }

  const type = requireString(input.type, "type");
  if (!ANNOTATION_TYPES.includes(type)) {
    throw new TypeError(`Ukendt annotationstype: ${type}`);
  }

  const status = input.status ?? "open";
  if (!ANNOTATION_STATUSES.includes(status)) {
    throw new TypeError(`Ukendt annotationsstatus: ${status}`);
  }

  const anchorState = input.anchorState ?? "attached";
  if (!ANCHOR_STATES.includes(anchorState)) {
    throw new TypeError(`Ukendt ankertilstand: ${anchorState}`);
  }

  const visibility = input.visibility ?? "reviewGroup";
  if (!ANNOTATION_VISIBILITIES.includes(visibility)) {
    throw new TypeError(`Ukendt annotationssynlighed: ${visibility}`);
  }

  const category = input.category ?? "general";
  if (!ANNOTATION_CATEGORIES.includes(category)) {
    throw new TypeError(`Ukendt annotationskategori: ${category}`);
  }

  return {
    type,
    target: validateAnnotationTarget(type, input.target),
    comment: requireString(input.comment, "comment", { maximumLength: ANNOTATION_LIMITS.maxCommentLength }),
    status,
    anchorState,
    visibility,
    category,
  };
}

function validateActor(input, field = "author") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} skal være et aktørobjekt.`);
  }
  return {
    id: requireString(input.id, `${field}.id`, { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength }),
    displayName: requireString(input.displayName, `${field}.displayName`, { maximumLength: ANNOTATION_LIMITS.maxDisplayNameLength }),
    kind: requireString(input.kind, `${field}.kind`, { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength }),
  };
}

function actorFromPrincipal(principal) {
  if (!principal) return { ...DEFAULT_LOCAL_ACTOR };
  return validateActor({
    id: principal.actorUserId ?? principal.id,
    displayName: principal.displayName ?? principal.email ?? "Ukendt",
    kind: principal.kind,
  });
}

function erasedActor() {
  const reference = randomBytes(8).toString("hex");
  return { id: `erased-${reference}`, displayName: "Slettet bruger", kind: "erased" };
}

export function validateStoredAnnotation(input, expectedBookId) {
  const draft = validateAnnotationDraft(input);
  const bookId = requireString(input.bookId, "bookId", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
  if (bookId !== expectedBookId) {
    throw new TypeError(`Annotationen tilhører ${bookId}, ikke ${expectedBookId}.`);
  }

  return {
    id: requireString(input.id, "id", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength }),
    bookId,
    revisionId: requireString(input.revisionId, "revisionId", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength }),
    ...draft,
    author: validateActor(input.author),
    updatedBy: validateActor(input.updatedBy ?? input.author, "updatedBy"),
    createdAt: requireString(input.createdAt, "createdAt", { maximumLength: ANNOTATION_LIMITS.maxTimestampLength }),
    updatedAt: requireString(input.updatedAt, "updatedAt", { maximumLength: ANNOTATION_LIMITS.maxTimestampLength }),
  };
}

export function migrateAnnotationDocument(input, expectedBookId) {
  if (!input || typeof input !== "object" || input.bookId !== expectedBookId || !Array.isArray(input.annotations)) {
    throw new TypeError("Annotationsfilen matcher ikke den konfigurerede bog.");
  }
  assertAnnotationCount(input.annotations);
  if (input.schemaVersion === ANNOTATION_SCHEMA_VERSION) return input;
  if (![1, 2, 3].includes(input.schemaVersion)) {
    throw new TypeError(`Annotationsfilen bruger schema ${input.schemaVersion}; forventede ${ANNOTATION_SCHEMA_VERSION}.`);
  }
  const versionTwo = input.schemaVersion === 1 ? {
    ...input, schemaVersion: 2, annotations: input.annotations.map((annotation) => ({
      ...annotation,
      visibility: "reviewGroup",
      author: { ...DEFAULT_LOCAL_ACTOR },
      updatedBy: { ...DEFAULT_LOCAL_ACTOR },
    })),
  } : input;
  const versionThree = versionTwo.schemaVersion === 2 ? {
    ...versionTwo,
    schemaVersion: 3,
    annotations: versionTwo.annotations.map((annotation) => ({ ...annotation, category: "general" })),
  } : versionTwo;
  return {
    ...versionThree,
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    annotations: versionThree.annotations.map((annotation) => ({
      ...annotation,
      revisionId: annotation.revisionId ?? "legacy",
    })),
  };
}

function assertAnnotationCount(annotations) {
  if (annotations.length > ANNOTATION_LIMITS.maxAnnotations) {
    throw new TypeError(`Annotationsfilen må højst indeholde ${ANNOTATION_LIMITS.maxAnnotations} annotationer.`);
  }
}

function serializedDocument(document) {
  assertAnnotationCount(document.annotations);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > ANNOTATION_LIMITS.maxDocumentBytes) {
    throw new TypeError(`Annotationsfilen må højst fylde ${ANNOTATION_LIMITS.maxDocumentBytes} bytes.`);
  }
  return serialized;
}

function emptyDocument(bookId, now) {
  return {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    bookId,
    updatedAt: now,
    annotations: [],
  };
}

export class AnnotationRepository {
  constructor({ filePath, bookId, revisionId = "legacy", clock = () => new Date(), createId = () => `annotation-${Bun.randomUUIDv7()}` }) {
    this.filePath = filePath;
    this.bookId = requireString(bookId, "bookId", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
    this.revisionId = requireString(revisionId, "revisionId", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
    this.clock = clock;
    this.createId = createId;
    this.mutationQueue = Promise.resolve();
  }

  now() {
    return this.clock().toISOString();
  }

  async readDocument() {
    const fileStat = await lstat(this.filePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!fileStat) return emptyDocument(this.bookId, this.now());
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new TypeError("Annotationsstien skal være en regulær fil.");
    const file = Bun.file(this.filePath);
    await chmod(dirname(this.filePath), 0o700);
    await chmod(this.filePath, 0o600);
    if (file.size > ANNOTATION_LIMITS.maxDocumentBytes) {
      throw new TypeError(`Annotationsfilen må højst fylde ${ANNOTATION_LIMITS.maxDocumentBytes} bytes.`);
    }
    const parsed = await file.json();
    const migrated = migrateAnnotationDocument(parsed, this.bookId);
    const document = {
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      bookId: this.bookId,
      updatedAt: requireString(migrated.updatedAt, "updatedAt", { maximumLength: ANNOTATION_LIMITS.maxTimestampLength }),
      annotations: migrated.annotations.map((annotation) => validateStoredAnnotation(annotation, this.bookId)),
    };
    if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) await this.persistDocument(document);
    return document;
  }

  async persistDocument(document) {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${Bun.randomUUIDv7()}.tmp`;
    const serialized = serializedDocument(document);
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return document;
  }

  async withFileLock(operation) {
    const directory = dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    const ownerPath = `${lockPath}/owner`;
    const owner = `${process.pid}:${Bun.randomUUIDv7()}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(ownerPath, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const lockStat = await stat(lockPath).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > 30 * 60_000) {
          let ownsRecovery = false;
          try {
            await mkdir(recoveryPath, { mode: 0o700 });
            ownsRecovery = true;
            const confirmed = await stat(lockPath).catch(() => null);
            if (confirmed && confirmed.mtimeMs === lockStat.mtimeMs) {
              await rm(lockPath, { recursive: true, force: true });
            }
          } catch (recoveryError) {
            if (recoveryError?.code !== "EEXIST") throw recoveryError;
          } finally {
            if (ownsRecovery) await rm(recoveryPath, { recursive: true, force: true }).catch(() => {});
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Annotationsfilen er låst af en anden proces.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      const currentOwner = await Bun.file(ownerPath).text().catch(() => "");
      if (currentOwner === owner) await rm(lockPath, { recursive: true, force: true });
    }
  }

  enqueueMutation(operation) {
    const lockedOperation = () => this.withFileLock(operation);
    this.mutationQueue = this.mutationQueue.then(lockedOperation, lockedOperation);
    return this.mutationQueue;
  }

  async list() {
    return this.enqueueMutation(() => this.readDocument());
  }

  async create(input, { principal } = {}) {
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const timestamp = this.now();
      const actor = actorFromPrincipal(principal);
      if (document.annotations.length >= ANNOTATION_LIMITS.maxAnnotations) {
        throw new TypeError(`Annotationsfilen må højst indeholde ${ANNOTATION_LIMITS.maxAnnotations} annotationer.`);
      }
      const annotation = {
        id: requireString(this.createId(), "id", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength }),
        bookId: this.bookId,
        revisionId: this.revisionId,
        ...validateAnnotationDraft(input),
        author: actor,
        updatedBy: actor,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      document.annotations.push(annotation);
      document.updatedAt = timestamp;
      await this.persistDocument(document);
      return annotation;
    });
  }

  async update(id, input, { principal } = {}) {
    const annotationId = requireString(id, "id", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const index = document.annotations.findIndex((annotation) => annotation.id === annotationId);
      if (index < 0) return null;

      const existing = document.annotations[index];
      const candidate = validateAnnotationDraft({
        ...existing,
        ...input,
        target: input.target ?? existing.target,
      });
      const updatedAt = this.now();
      const annotation = { ...existing, ...candidate, updatedBy: actorFromPrincipal(principal), updatedAt };
      document.annotations[index] = annotation;
      document.updatedAt = updatedAt;
      await this.persistDocument(document);
      return annotation;
    });
  }

  async delete(id) {
    const annotationId = requireString(id, "id", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const next = document.annotations.filter((annotation) => annotation.id !== annotationId);
      if (next.length === document.annotations.length) return false;
      document.annotations = next;
      document.updatedAt = this.now();
      await this.persistDocument(document);
      return true;
    });
  }

  async anonymizeAuthor(userId) {
    const id = requireString(userId, "userId", { maximumLength: ANNOTATION_LIMITS.maxIdentifierLength });
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const replacement = erasedActor();
      let changed = 0;
      document.annotations = document.annotations.map((annotation) => {
        const replacesAuthor = annotation.author.id === id;
        const replacesUpdater = annotation.updatedBy.id === id;
        if (!replacesAuthor && !replacesUpdater) return annotation;
        changed += 1;
        return {
          ...annotation,
          author: replacesAuthor ? replacement : annotation.author,
          updatedBy: replacesUpdater ? replacement : annotation.updatedBy,
        };
      });
      if (changed > 0) {
        document.updatedAt = this.now();
        await this.persistDocument(document);
      }
      return { changed, actor: replacement };
    });
  }

  async importDocument(input, mode = "merge") {
    if (!["merge", "replace"].includes(mode)) throw new TypeError(`Ukendt importtilstand: ${mode}`);
    const migrated = migrateAnnotationDocument(input, this.bookId);
    const imported = migrated.annotations.map((annotation) => validateStoredAnnotation(annotation, this.bookId));
    return this.enqueueMutation(async () => {
      const timestamp = this.now();
      const current = mode === "replace" ? emptyDocument(this.bookId, timestamp) : await this.readDocument();
      const byId = new Map(current.annotations.map((annotation) => [annotation.id, annotation]));
      for (const annotation of imported) byId.set(annotation.id, { ...annotation, updatedAt: timestamp });
      current.annotations = [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      current.updatedAt = timestamp;
      await this.persistDocument(current);
      return current;
    });
  }
}
