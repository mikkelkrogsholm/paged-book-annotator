import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const ANNOTATION_SCHEMA_VERSION = 1;
export const ANNOTATION_TYPES = Object.freeze(["text", "element", "page"]);
export const ANNOTATION_STATUSES = Object.freeze(["open", "resolved"]);
export const ANCHOR_STATES = Object.freeze(["attached", "orphaned"]);

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

  return {
    type,
    target: validateAnnotationTarget(type, input.target),
    comment: requireString(input.comment, "comment"),
    status,
    anchorState,
  };
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
    ...draft,
    createdAt: requireString(input.createdAt, "createdAt"),
    updatedAt: requireString(input.updatedAt, "updatedAt"),
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
  constructor({ filePath, bookId, clock = () => new Date(), createId = () => `annotation-${Bun.randomUUIDv7()}` }) {
    this.filePath = filePath;
    this.bookId = bookId;
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
    if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
      throw new TypeError(`Annotationsfilen bruger schema ${parsed.schemaVersion}; forventede ${ANNOTATION_SCHEMA_VERSION}.`);
    }
    if (parsed.bookId !== this.bookId || !Array.isArray(parsed.annotations)) {
      throw new TypeError("Annotationsfilen matcher ikke den konfigurerede bog.");
    }
    return {
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      bookId: this.bookId,
      updatedAt: requireString(parsed.updatedAt, "updatedAt"),
      annotations: parsed.annotations.map((annotation) => validateStoredAnnotation(annotation, this.bookId)),
    };
  }

  async persistDocument(document) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
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

  async create(input) {
    return this.enqueueMutation(async () => {
      const document = await this.readDocument();
      const timestamp = this.now();
      const annotation = {
        id: this.createId(),
        bookId: this.bookId,
        ...validateAnnotationDraft(input),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      document.annotations.push(annotation);
      document.updatedAt = timestamp;
      await this.persistDocument(document);
      return annotation;
    });
  }

  async update(id, input) {
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
      const annotation = { ...existing, ...candidate, updatedAt };
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

  async importDocument(input, mode = "merge") {
    if (!["merge", "replace"].includes(mode)) throw new TypeError(`Ukendt importtilstand: ${mode}`);
    if (!input || input.schemaVersion !== ANNOTATION_SCHEMA_VERSION || input.bookId !== this.bookId) {
      throw new TypeError("Importfilen har forkert schema eller bog-id.");
    }
    if (!Array.isArray(input.annotations)) throw new TypeError("Importfilen mangler annotationslisten.");
    const imported = input.annotations.map((annotation) => validateStoredAnnotation(annotation, this.bookId));
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
