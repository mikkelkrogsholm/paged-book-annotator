import * as z from "zod/v4";

const nonEmptyString = z.string().trim().min(1);
const isoTimestamp = z.iso.datetime();

export const bookIdSchema = nonEmptyString.describe("Stable book id from list_books.");
export const annotationIdSchema = nonEmptyString;

const annotationTargetBase = {
  pageNumber: z.number().int().positive().describe("Page hint; never the stable identity."),
  label: z.string().optional(),
};

export const textQuoteSelectorSchema = z.object({
  type: z.literal("TextQuoteSelector"),
  exact: nonEmptyString,
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  position: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }).refine(({ start, end }) => end > start, "position.end must be greater than position.start").optional(),
});

export const pageAnnotationTargetSchema = z.strictObject({
  ...annotationTargetBase,
  scopeId: nonEmptyString.describe("Stable page-content anchor; pageNumber is only a hint."),
});

export const elementAnnotationTargetSchema = z.strictObject({
  ...annotationTargetBase,
  scopeId: nonEmptyString,
});

export const textAnnotationTargetSchema = z.strictObject({
  ...annotationTargetBase,
  scopeId: nonEmptyString,
  selector: textQuoteSelectorSchema,
});

const annotationDraftBase = {
  bookId: bookIdSchema,
  comment: nonEmptyString,
  status: z.enum(["open", "resolved", "accepted", "rejected"]).optional(),
  category: z.enum(["general", "language", "structure", "fact", "design"]).optional(),
  anchorState: z.enum(["attached", "orphaned"]).optional(),
  visibility: z.enum(["private", "reviewGroup", "public"]).optional(),
};

export const createAnnotationInputSchema = z.discriminatedUnion("type", [
  z.object({ ...annotationDraftBase, type: z.literal("page"), target: pageAnnotationTargetSchema }),
  z.object({ ...annotationDraftBase, type: z.literal("element"), target: elementAnnotationTargetSchema }),
  z.object({ ...annotationDraftBase, type: z.literal("text"), target: textAnnotationTargetSchema }),
]);

export const annotationTargetSchema = z.union([
  textAnnotationTargetSchema,
  elementAnnotationTargetSchema,
  pageAnnotationTargetSchema,
]);

export const surveyIdSchema = nonEmptyString.describe("Stable survey id from list_active_surveys or list_surveys.");
export const surveyTargetInputSchema = z.object({
  kind: z.enum(["page", "section"]),
  anchorId: nonEmptyString.describe("Stable data-book-anchor; page number alone is never sufficient."),
  contextStartAnchorId: nonEmptyString.optional(),
  pageNumberHint: z.number().int().positive().optional(),
  revisionId: nonEmptyString.optional(),
  label: z.string().trim().max(240).optional(),
});

const questionBase = {
  id: nonEmptyString,
  prompt: nonEmptyString,
  helpText: z.string().default(""),
  required: z.boolean().default(true),
};

export const surveyQuestionInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...questionBase,
    type: z.literal("rating"),
    scale: z.object({ min: z.literal(1), max: z.literal(5), minLabel: nonEmptyString, maxLabel: nonEmptyString }),
  }),
  z.object({
    ...questionBase,
    type: z.literal("singleChoice"),
    options: z.array(z.object({ id: nonEmptyString, label: nonEmptyString })).min(2).max(7),
  }),
  z.object({
    ...questionBase,
    type: z.literal("shortText"),
    maxLength: z.number().int().min(1).max(500).default(300),
  }),
  z.object({
    ...questionBase,
    type: z.literal("longText"),
    maxLength: z.number().int().min(1).max(4_000).default(2_000),
  }),
]);

export const surveyDefinitionInputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  target: surveyTargetInputSchema,
  trigger: z.object({ mode: z.enum(["afterLeave", "manual"]) }).default({ mode: "afterLeave" }),
  questions: z.array(surveyQuestionInputSchema).min(1).max(5),
});

export const surveyAnswersInputSchema = z.array(z.object({
  questionId: nonEmptyString,
  value: z.union([z.string(), z.number().int().min(1).max(5)]),
})).max(5);

const actorSchema = z.looseObject({
  kind: z.enum(["anonymous", "guest", "user", "token", "local", "erased"]),
  id: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
});

const annotationSchema = z.looseObject({
  id: nonEmptyString,
  bookId: nonEmptyString,
  revisionId: z.string().nullable().optional(),
  type: z.enum(["text", "element", "page"]),
  target: annotationTargetSchema,
  comment: z.string(),
  author: actorSchema,
  status: z.enum(["open", "resolved", "accepted", "rejected"]),
  category: z.enum(["general", "language", "structure", "fact", "design"]),
  anchorState: z.enum(["attached", "orphaned"]),
  visibility: z.enum(["private", "reviewGroup", "public"]),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

const surveyTargetOutputSchema = z.looseObject({
  kind: z.enum(["page", "section"]),
  anchorId: nonEmptyString,
  contextStartAnchorId: z.string().nullable(),
  pageNumberHint: z.number().int().positive().nullable(),
  revisionId: z.string().nullable(),
  label: z.string(),
});

const surveyQuestionOutputSchema = z.discriminatedUnion("type", [
  z.looseObject({ ...questionBase, type: z.literal("rating"), scale: z.object({ min: z.literal(1), max: z.literal(5), minLabel: nonEmptyString, maxLabel: nonEmptyString }) }),
  z.looseObject({ ...questionBase, type: z.literal("singleChoice"), options: z.array(z.object({ id: nonEmptyString, label: nonEmptyString })).min(2).max(7) }),
  z.looseObject({ ...questionBase, type: z.literal("shortText"), maxLength: z.number().int().positive() }),
  z.looseObject({ ...questionBase, type: z.literal("longText"), maxLength: z.number().int().positive() }),
]);

const surveyDefinitionOutputSchema = z.looseObject({
  schemaVersion: z.literal(1),
  title: nonEmptyString,
  description: z.string(),
  target: surveyTargetOutputSchema,
  trigger: z.object({ mode: z.enum(["afterLeave", "manual"]) }),
  questions: z.array(surveyQuestionOutputSchema).min(1).max(5),
});

const surveyVersionSchema = z.looseObject({
  version: z.number().int().positive(),
  state: z.enum(["draft", "published", "superseded"]),
  definition: surveyDefinitionOutputSchema,
  createdAt: isoTimestamp,
  publishedAt: isoTimestamp.nullable(),
});

export const surveySchema = z.looseObject({
  id: nonEmptyString,
  bookId: nonEmptyString,
  status: z.enum(["draft", "published", "closed"]),
  publishedVersion: z.number().int().positive().nullable(),
  draftVersion: z.number().int().positive().nullable(),
  published: surveyVersionSchema.nullable(),
  draft: surveyVersionSchema.nullable(),
  versions: z.array(surveyVersionSchema),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  publishedAt: isoTimestamp.nullable(),
  closedAt: isoTimestamp.nullable(),
});

export const surveyResponseSchema = z.looseObject({
  id: nonEmptyString,
  surveyId: nonEmptyString,
  surveyVersion: z.number().int().positive(),
  bookId: nonEmptyString,
  revisionId: z.string().nullable(),
  respondent: z.looseObject({
    kind: z.enum(["anonymous", "guest", "user", "token", "local", "erased"]),
    ref: nonEmptyString,
    userId: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  target: surveyTargetOutputSchema,
  answers: z.array(z.object({ questionId: nonEmptyString, value: z.union([z.string(), z.number()]) })),
  submittedAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

const bookSchema = z.looseObject({
  id: nonEmptyString,
  title: z.string().optional(),
  status: z.enum(["draft", "active", "published", "archived"]).optional(),
  activeRevisionId: z.string().nullable().optional(),
});

const sessionSchema = z.looseObject({
  bookId: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  principal: z.looseObject({
    kind: z.enum(["anonymous", "guest", "user", "token", "local"]),
    id: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }).nullable().optional(),
  capabilities: z.looseObject({
    authenticated: z.boolean(),
    principalKind: z.enum(["anonymous", "guest", "user", "token", "local"]),
    canRead: z.boolean(),
    canViewAnnotations: z.boolean(),
    canCreateAnnotations: z.boolean(),
    canModerateAnnotations: z.boolean(),
    canExportAnnotations: z.boolean(),
    canRespondToSurveys: z.boolean(),
    canManageSurveys: z.boolean(),
    canReadSurveyResponses: z.boolean(),
    canExportReviews: z.boolean(),
    canManageUsers: z.boolean(),
    canManageTokens: z.boolean(),
    canViewAllProgress: z.boolean(),
    canViewAudit: z.boolean(),
    progressTracking: z.enum(["off", "resume", "analytics"]),
    registration: z.enum(["disabled", "closed", "open", "inviteOnly", "code"]),
    permissions: z.array(z.string()),
  }).optional(),
});

const progressSchema = z.looseObject({
  bookId: nonEmptyString,
  anchorId: z.string().nullable(),
  pageNumber: z.number().int().positive().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  visitedAnchors: z.array(z.string()).optional(),
});

export const reviewExportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  kind: z.literal("paged-book-review-export"),
  exportedAt: isoTimestamp,
  book: z.looseObject({
    id: nonEmptyString,
    title: z.string(),
    revisionId: z.string().nullable(),
    buildId: z.string().nullable(),
  }),
  annotations: z.looseObject({
    schemaVersion: z.number().int().positive(),
    updatedAt: isoTimestamp,
    items: z.array(annotationSchema),
  }),
  surveys: z.array(surveySchema),
  surveyResponses: z.array(surveyResponseSchema),
  readingProgress: z.looseObject({
    included: z.boolean(),
    items: z.array(progressSchema),
  }),
});

const toolErrorSchema = z.looseObject({
  code: z.enum(["invalid_input", "forbidden", "not_found", "conflict", "rate_limited", "internal_error"]),
  message: z.string(),
  retryable: z.boolean(),
  suggestedAction: z.string(),
  requestId: nonEmptyString,
  causeCode: z.string().optional(),
});

function toolOutput(successSchema) {
  const successKeys = Object.keys(successSchema.shape);
  return successSchema.partial().extend({ error: toolErrorSchema.optional() }).refine(
    (value) => value.error !== undefined || successKeys.every((key) => value[key] !== undefined),
    "Output must contain either every success field or a structured error.",
  );
}

const recordSchema = z.looseObject({});
const nullableRecordSchema = recordSchema.nullable();
const annotationDocumentSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  bookId: nonEmptyString,
  updatedAt: isoTimestamp,
  annotations: z.array(annotationSchema),
});
const accessSettingsSchema = z.looseObject({
  preset: z.enum(["local", "publicRead", "publicOpenReview", "publicMemberReview", "publicInviteReview", "privateRead", "privateReview"]),
  reading: z.enum(["public", "authenticated", "invited"]),
  annotationCreate: z.enum(["disabled", "public", "authenticated", "invited"]),
  annotationView: z.enum(["none", "own", "reviewGroup", "public"]),
  surveyResponse: z.enum(["disabled", "public", "authenticated", "invited"]),
  registration: z.enum(["disabled", "closed", "open", "inviteOnly", "code"]),
  progressTracking: z.enum(["off", "resume", "analytics"]),
  localBypass: z.boolean(),
});
const userSchema = z.looseObject({
  id: nonEmptyString,
  email: z.email(),
  displayName: nonEmptyString,
  globalRole: z.enum(["instance_admin", "user"]),
  status: z.enum(["active", "disabled", "erased"]),
  membership: nullableRecordSchema.optional(),
});
const uploadSchema = z.looseObject({
  id: nonEmptyString,
  bookId: nonEmptyString,
  filename: nonEmptyString,
  uploadUrl: nonEmptyString,
  expiresAt: isoTimestamp,
});
const revisionSchema = z.looseObject({ id: nonEmptyString, state: nonEmptyString });
const annotationChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("annotation.upsert"), changedAt: isoTimestamp, annotation: annotationSchema }),
  z.object({ type: z.literal("annotation.deleted"), changedAt: isoTimestamp, annotationId: nonEmptyString }),
]);
const pagedTextResultSchema = z.object({
  bookId: nonEmptyString,
  buildId: z.string().nullable(),
  items: z.array(recordSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
});

export const MCP_TOOL_OUTPUT_SCHEMAS = Object.freeze({
  list_books: toolOutput(z.object({ items: z.array(bookSchema) })),
  get_book: toolOutput(z.object({ book: bookSchema, session: sessionSchema })),
  create_book: toolOutput(z.object({ book: bookSchema })),
  create_book_upload: toolOutput(z.object({ upload: uploadSchema })),
  validate_book_upload: toolOutput(z.object({ revision: revisionSchema })),
  list_book_revisions: toolOutput(z.object({ items: z.array(revisionSchema) })),
  publish_book_revision: toolOutput(z.object({ book: bookSchema, revision: revisionSchema })),
  archive_book: toolOutput(z.object({ book: bookSchema })),
  get_book_context: toolOutput(z.object({ book: bookSchema, session: sessionSchema })),
  list_book_outline: toolOutput(pagedTextResultSchema.extend({ total: z.number().int().nonnegative() })),
  get_book_section: toolOutput(z.object({ section: nullableRecordSchema })),
  search_book: toolOutput(pagedTextResultSchema.extend({ query: z.string(), total: z.number().int().nonnegative() })),
  get_annotation_context: toolOutput(z.object({ context: nullableRecordSchema })),
  list_changes_since: toolOutput(z.object({
    bookId: nonEmptyString,
    buildId: z.string().nullable(),
    since: isoTimestamp,
    items: z.array(annotationChangeSchema),
    nextCursor: z.string().nullable(),
  })),
  list_annotations: toolOutput(annotationDocumentSchema),
  create_annotation: toolOutput(annotationSchema),
  update_annotation: toolOutput(z.object({ annotation: annotationSchema.nullable() })),
  delete_annotation: toolOutput(z.object({ deleted: z.boolean() })),
  export_annotations: toolOutput(z.object({ contentType: nonEmptyString, extension: nonEmptyString, body: z.string() })),
  import_annotations: toolOutput(annotationDocumentSchema),
  get_reading_progress: toolOutput(z.object({ progress: progressSchema.nullable() })),
  record_reading_progress: toolOutput(z.object({ progress: progressSchema.nullable() })),
  list_reader_progress: toolOutput(z.object({ items: z.array(progressSchema) })),
  list_users: toolOutput(z.object({ items: z.array(userSchema) })),
  list_book_members: toolOutput(z.object({ items: z.array(userSchema) })),
  get_access_settings: toolOutput(accessSettingsSchema),
  update_access_settings: toolOutput(accessSettingsSchema),
  create_user: toolOutput(userSchema),
  update_user_access: toolOutput(userSchema),
  reset_user_password: toolOutput(userSchema),
  create_invitation: toolOutput(z.object({
    id: nonEmptyString, secret: nonEmptyString, bookId: nonEmptyString, email: z.email(),
    role: nonEmptyString, expiresAt: isoTimestamp,
  })),
  list_invitations: toolOutput(z.object({ items: z.array(recordSchema) })),
  revoke_invitation: toolOutput(z.object({ revoked: z.boolean() })),
  create_access_code: toolOutput(z.object({
    id: nonEmptyString, secret: nonEmptyString, bookId: nonEmptyString, name: nonEmptyString,
    role: nonEmptyString, expiresAt: isoTimestamp, maxUses: z.number().int().positive().nullable(),
  })),
  list_access_codes: toolOutput(z.object({ items: z.array(recordSchema) })),
  revoke_access_code: toolOutput(z.object({ revoked: z.boolean() })),
  create_service_token: toolOutput(z.object({
    id: nonEmptyString, secret: nonEmptyString, prefix: nonEmptyString, bookGrants: z.array(recordSchema),
    instanceAdmin: z.boolean(), expiresAt: isoTimestamp,
  })),
  list_service_tokens: toolOutput(z.object({ items: z.array(recordSchema) })),
  revoke_service_token: toolOutput(z.object({ revoked: z.boolean() })),
  list_audit_events: toolOutput(z.object({ items: z.array(recordSchema) })),
  list_active_surveys: toolOutput(z.object({ surveys: z.array(surveySchema) })),
  get_survey: toolOutput(z.object({ survey: surveySchema.nullable() })),
  get_my_survey_response: toolOutput(z.object({ response: surveyResponseSchema.nullable() })),
  submit_survey_response: toolOutput(z.object({ response: surveyResponseSchema })),
  list_surveys: toolOutput(z.object({ surveys: z.array(surveySchema) })),
  create_survey: toolOutput(z.object({ survey: surveySchema })),
  update_survey_draft: toolOutput(z.object({ survey: surveySchema })),
  publish_survey: toolOutput(z.object({ survey: surveySchema })),
  close_survey: toolOutput(z.object({ survey: surveySchema })),
  list_survey_responses: toolOutput(z.object({ responses: z.array(surveyResponseSchema) })),
  export_review_bundle: toolOutput(reviewExportSchema),
});
