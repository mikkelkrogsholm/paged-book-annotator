import { createHash } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const ANNOTATION_SCHEMA_VERSION = 4;
export const ANNOTATION_TYPES = Object.freeze(["text", "element", "page"]);
export const ANNOTATION_STATUSES = Object.freeze(["open", "resolved", "accepted", "rejected"]);
export const ANNOTATION_CATEGORIES = Object.freeze(["general", "language", "structure", "fact", "design"]);
export const ANCHOR_STATES = Object.freeze(["attached", "orphaned"]);
export const ANNOTATION_VISIBILITIES = Object.freeze(["private", "reviewGroup", "public"]);

const DEFAULT_LOCAL_ACTOR = Object.freeze({
  id: "local-owner",
  displayName: "Lokal ejer",
  kind: "local",
});

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError(`${field} skal være tekst.`);
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} skal være et positivt heltal.`);
  }
  return value;
}

function validateTextSelector(selector) {
  if (!selector || selector.type !== "TextQuoteSelector") {
    throw new TypeError("Tekstannotationer kræver en TextQuoteSelector.");
  }

  const exact = requireString(selector.exact, "target.selector.exact");
  const validated = {
    type: "TextQuoteSelector",
    exact,
    prefix: optionalString(selector.prefix, "target.selector.prefix"),
    suffix: optionalString(selector.suffix, "target.selector.suffix"),
  };

  if (selector.position != null) {
    const start = Number(selector.position.start);
    const end = Number(selector.position.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
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
    label: optionalString(target.label, "target.label").trim(),
  };

  if (type === "page") {
    validated.scopeId = optionalString(target.scopeId, "target.scopeId").trim();
    return validated;
  }

  validated.scopeId = requireString(target.scopeId, "target.scopeId");
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
    comment: requireString(input.comment, "comment"),
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
    id: requireString(input.id, `${field}.id`),
    displayName: requireString(input.displayName, `${field}.displayName`),
    kind: requireString(input.kind, `${field}.kind`),
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

function erasedActor(userId) {
  const reference = createHash("sha256").update(String(userId)).digest("hex").slice(0, 16);
  return { id: `erased-${reference}`, displayName: "Slettet bruger", kind: "erased" };
}

export function validateStoredAnnotation(input, expectedBookId) {
  const draft = validateAnnotationDraft(input);
  const bookId = requireString(input.bookId, "bookId");
  if (bookId !== expectedBookId) {
    throw new TypeError(`Annotationen tilhører ${bookId}, ikke ${expectedBookId}.`);
  }

  return {
    id: requireString(input.id, "id"),
    bookId,
    revisionId: requireString(input.revisionId, "revisionId"),
    ...draft,
    author: validateActor(input.author),
    updatedBy: validateActor(input.updatedBy ?? input.author, "updatedBy"),
    createdAt: requireString(input.createdAt, "createdAt"),
    updatedAt: requireString(input.updatedAt, "updatedAt"),
  };
}

export function migrateAnnotationDocument(input, expectedBookId) {
  if (!input || typeof input !== "object" || input.bookId !== expectedBookId || !Array.isArray(input.annotations)) {
    throw new TypeError("Annotationsfilen matcher ikke den konfigurerede bog.");
  }
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
    this.bookId = bookId;
    this.revisionId = requireString(revisionId, "revisionId");
    this.clock = clock;
    this.createId = createId;
    this.mutationQueue = Promise.resolve();
  }

  now() {
    return this.clock().toISOString();
  }

  async readDocument() {
    const file = Bun.file(this.filePath);
    if (!await file.exists()) return emptyDocument(this.bookId, this.now());
    const parsed = await file.json();
    const migrated = migrateAnnotationDocument(parsed, this.bookId);
    const document = {
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      bookId: this.bookId,
      updatedAt: requireString(migrated.updatedAt, "updatedAt"),
      annotations: migrated.annotations.map((annotation) => validateStoredAnnotation(annotation, this.bookId)),
    };
    if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) await this.persistDocument(document);
    return document;
  }

  async persistDocument(document) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${Bun.randomUUIDv7()}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporaryPath, this.filePath);
    return document;
  }

  enqueueMutation(operation) {
    this.mutationQueue = this.mutationQueue.then(operation, operation);
    return this.mutationQueue;
  }

  async list() {
    return this.readDocument();
  }

  async create(input, { principal } = {}) {
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const timestamp = this.now();
      const actor = actorFromPrincipal(principal);
      const annotation = {
        id: this.createId(),
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
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const index = document.annotations.findIndex((annotation) => annotation.id === id);
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
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const next = document.annotations.filter((annotation) => annotation.id !== id);
      if (next.length === document.annotations.length) return false;
      document.annotations = next;
      document.updatedAt = this.now();
      await this.persistDocument(document);
      return true;
    });
  }

  async anonymizeAuthor(userId) {
    const id = requireString(userId, "userId");
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const replacement = erasedActor(id);
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
      const current = mode === "replace" ? emptyDocument(this.bookId, this.now()) : await this.readDocument();
      const byId = new Map(current.annotations.map((annotation) => [annotation.id, annotation]));
      for (const annotation of imported) byId.set(annotation.id, annotation);
      current.annotations = [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      current.updatedAt = this.now();
      await this.persistDocument(current);
      return current;
    });
  }
}
