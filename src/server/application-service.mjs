import {
  canCreateAnnotation,
  canReadAnnotations,
  canReadBook,
  canSeeAnnotation,
  canRespondToSurveys,
  hasPermission,
  permissionsForPrincipal,
  publicCapabilities,
  ROLE_PERMISSIONS,
  resolveAccessPolicy,
  validateScopes,
} from "./access-policy.mjs";
import { ANNOTATION_SCHEMA_VERSION } from "./annotation-repository.mjs";
import { createReviewExport } from "./survey-contract.mjs";

export class ApplicationError extends Error {
  constructor(status, message, code = "application_error") {
    super(message);
    this.name = "ApplicationError";
    this.status = status;
    this.code = code;
  }
}

function deny(message = "Du har ikke adgang til denne handling.") {
  throw new ApplicationError(403, message, "forbidden");
}

function actorId(principal) {
  return principal?.actorUserId ?? principal?.id ?? null;
}

function instanceAdministrator(principal) {
  return principal?.kind === "local"
    || (principal?.kind === "user" && principal.globalRole === "instance_admin")
    || (principal?.kind === "token" && principal.instanceAdmin === true);
}

function assertDelegableBookAccess(principal, bookId, role, permissions = []) {
  const requested = new Set([
    ...(ROLE_PERMISSIONS[role] ?? []),
    ...validateScopes(permissions, { allowEmpty: true }),
  ]);
  const delegable = permissionsForPrincipal(principal, bookId);
  if ([...requested].some((permission) => !delegable.has(permission))) {
    deny("Du kan ikke tildele en rolle eller rettighed, som du ikke selv har.");
  }
}

export function principalSummary(principal) {
  if (!principal) return null;
  return {
    kind: principal.kind,
    id: principal.id,
    displayName: principal.displayName ?? "",
    email: principal.kind === "user" ? principal.email : undefined,
    globalRole: principal.kind === "user" ? principal.globalRole : undefined,
    role: principal.kind === "user" ? principal.role : undefined,
  };
}

function escapeCsv(value) {
  const raw = String(value ?? "");
  const text = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function annotationCsv(document) {
  const fields = ["id", "type", "status", "category", "visibility", "author", "comment", "anchorId", "pageNumber", "createdAt", "updatedAt"];
  const rows = document.annotations.map((annotation) => [
    annotation.id,
    annotation.type,
    annotation.status,
    annotation.category,
    annotation.visibility,
    annotation.author.displayName,
    annotation.comment,
    annotation.target.scopeId ?? "",
    annotation.target.pageNumber,
    annotation.createdAt,
    annotation.updatedAt,
  ].map(escapeCsv).join(","));
  return `${fields.join(",")}\n${rows.join("\n")}\n`;
}

function annotationMarkdown(document) {
  const notes = document.annotations.map((annotation) => [
    `## ${annotation.author.displayName} · side ${annotation.target.pageNumber}`,
    "",
    `- Status: ${annotation.status}`,
    `- Kategori: ${annotation.category}`,
    `- Type: ${annotation.type}`,
    `- Anker: ${annotation.target.scopeId || "side"}`,
    `- Oprettet: ${annotation.createdAt}`,
    "",
    annotation.comment,
  ].join("\n"));
  return `# Annotationer til ${document.bookId}\n\n${notes.join("\n\n")}\n`;
}

export class BookCollaboration {
  constructor({ config, annotationRepository, collaborationRepository, bookContentIndex = null }) {
    this.config = config;
    this.bookId = config.book.id;
    this.annotations = annotationRepository;
    this.collaboration = collaborationRepository;
    this.bookContent = bookContentIndex;
  }

  get policy() {
    return this.collaboration.getAccessPolicy(this.config.access, this.bookId);
  }

  get revisionId() {
    return this.config.book.revisionId ?? "legacy";
  }

  audit(input) {
    return this.collaboration.audit({ ...input, bookId: this.bookId });
  }

  async resolvePrincipal({ sessionSecret = "", bearerToken = "", guestId = "" } = {}) {
    if (bearerToken) {
      const token = await this.collaboration.resolveServiceToken(bearerToken);
      if (!token) throw new ApplicationError(401, "Tokenet er ugyldigt, udløbet eller tilbagekaldt.", "invalid_token");
      return token;
    }
    if (this.policy.localBypass) {
      return { kind: "local", id: "local-owner", displayName: "Lokal ejer", bookId: this.bookId };
    }
    if (sessionSecret) {
      const user = await this.collaboration.resolveSession(sessionSecret, this.bookId);
      if (user) return user;
    }
    return guestId ? { kind: "guest", id: guestId, displayName: "Gæstelæser", bookId: this.bookId } : null;
  }

  session(principal) {
    return {
      principal: principalSummary(principal),
      capabilities: publicCapabilities(this.policy, principal, this.bookId),
    };
  }

  async health() {
    let annotations = "ok";
    try { await this.annotations.list(); } catch { annotations = "unavailable"; }
    return { collaboration: this.collaboration.health() ? "ok" : "unavailable", annotations };
  }

  assertCanRead(principal) {
    if (!canReadBook(this.policy, principal, this.bookId)) deny("Log ind med adgang til bogen for at læse den.");
  }

  assertPermission(principal, permission) {
    if (!hasPermission(principal, permission, this.bookId)) deny();
  }

  assertBookContentAvailable() {
    if (!this.bookContent) throw new ApplicationError(503, "Bogens tekstindeks er ikke tilgængeligt.", "book_content_unavailable");
  }

  async listBookOutline(principal, options) {
    this.assertCanRead(principal);
    this.assertBookContentAvailable();
    return this.bookContent.outline(options);
  }

  async getBookSection(principal, anchorId) {
    this.assertCanRead(principal);
    this.assertBookContentAvailable();
    return this.bookContent.section(anchorId);
  }

  async searchBook(principal, query, options) {
    this.assertCanRead(principal);
    this.assertBookContentAvailable();
    return this.bookContent.search(query, options);
  }

  async getAnnotationContext(principal, annotationId) {
    const document = await this.listAnnotations(principal);
    const annotation = document.annotations.find((note) => note.id === annotationId);
    if (!annotation) return null;
    const section = annotation.target.scopeId && this.bookContent ? await this.bookContent.section(annotation.target.scopeId) : null;
    return { annotation, section };
  }

  async listChangesSince(principal, { since, cursor = "", limit = 25 } = {}) {
    const document = await this.listAnnotations(principal);
    const timestamp = new Date(since ?? 0);
    if (Number.isNaN(timestamp.getTime())) throw new TypeError("since skal være et gyldigt tidspunkt.");
    const pageSize = Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("limit skal være mellem 1 og 100.");
    let after = null;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); } catch {}
      if (!after || typeof after.changedAt !== "string" || typeof after.sortId !== "string") {
        throw new TypeError("cursor er ugyldig.");
      }
    }
    const changes = document.annotations
      .filter((note) => new Date(note.updatedAt) > timestamp)
      .map((annotation) => ({ type: "annotation.upsert", changedAt: annotation.updatedAt, sortId: `a:${annotation.id}`, annotation }));
    if (hasPermission(principal, "annotations:read:all", this.bookId)
      || hasPermission(principal, "annotations:moderate", this.bookId)) {
      changes.push(...this.collaboration.listAnnotationDeletionsSince(timestamp, this.bookId).map((deletion) => ({
        type: "annotation.deleted",
        changedAt: deletion.changedAt,
        sortId: `d:${deletion.eventId}`,
        annotationId: deletion.annotationId,
      })));
    }
    changes.sort((left, right) => left.changedAt.localeCompare(right.changedAt) || left.sortId.localeCompare(right.sortId));
    const remaining = after ? changes.filter((change) => change.changedAt > after.changedAt
      || (change.changedAt === after.changedAt && change.sortId > after.sortId)) : changes;
    const page = remaining.slice(0, pageSize + 1);
    const items = page.slice(0, pageSize).map(({ sortId: _sortId, ...item }) => item);
    const last = pageSize < page.length ? page[pageSize - 1] : null;
    const nextCursor = last ? Buffer.from(JSON.stringify({ changedAt: last.changedAt, sortId: last.sortId })).toString("base64url") : null;
    return { bookId: this.bookId, buildId: this.config.book.buildId ?? null, since: timestamp.toISOString(), items, nextCursor };
  }

  async login({ email, password }) {
    const principal = await this.collaboration.authenticate(email, password, this.bookId);
    if (!principal) throw new ApplicationError(401, "E-mail eller password er forkert.", "invalid_credentials");
    const session = await this.collaboration.createSession(principal.id);
    this.audit({ principal, action: "session.login", resourceType: "session" });
    return { ...session, principal: this.collaboration.principalForUser(principal.id, this.bookId) };
  }

  async logout(sessionSecret, principal) {
    const revoked = await this.collaboration.revokeSession(sessionSecret);
    if (revoked) this.audit({ principal, action: "session.logout", resourceType: "session" });
    return revoked;
  }

  async changeOwnPassword(principal, input) {
    if (principal?.kind !== "user") deny("Log ind som bruger for at ændre password.");
    const user = await this.collaboration.changePassword(principal.id, input);
    this.audit({ principal, action: "user.password.change", resourceType: "user", resourceId: principal.id });
    return user;
  }

  async register(input) {
    if (this.policy.registration !== "open") deny("Selvregistrering er ikke åben.");
    const user = await this.collaboration.createUser({ ...input, bookId: this.bookId, bookRole: "reviewer" });
    if (input.phone) this.collaboration.saveReviewerProfile(user.id, { bookId: this.bookId, phone: input.phone, phonePurpose: input.phonePurpose });
    const principal = this.collaboration.principalForUser(user.id, this.bookId);
    const session = await this.collaboration.createSession(user.id);
    this.audit({ principal, action: "user.register", resourceType: "user", resourceId: user.id });
    return { ...session, principal };
  }

  async acceptInvitation(input) {
    if (this.policy.registration !== "inviteOnly") deny("Invitationstilmelding er ikke aktiveret for bogen.");
    const user = await this.collaboration.acceptInvitation({ ...input, bookId: this.bookId });
    if (input.phone) this.collaboration.saveReviewerProfile(user.id, { bookId: this.bookId, phone: input.phone, phonePurpose: input.phonePurpose });
    const principal = this.collaboration.principalForUser(user.id, this.bookId);
    const session = await this.collaboration.createSession(user.id);
    this.audit({ principal, action: "invitation.accept", resourceType: "user", resourceId: user.id });
    return { ...session, principal };
  }

  async listAnnotations(principal) {
    this.assertCanRead(principal);
    if (!canReadAnnotations(this.policy, principal, this.bookId)) {
      return { schemaVersion: ANNOTATION_SCHEMA_VERSION, bookId: this.bookId, updatedAt: new Date(0).toISOString(), annotations: [] };
    }
    const document = await this.annotations.list();
    return { ...document, annotations: document.annotations.filter((annotation) => canSeeAnnotation(this.policy, principal, annotation, this.bookId)) };
  }

  async createAnnotation(principal, input) {
    this.assertCanRead(principal);
    if (!canCreateAnnotation(this.policy, principal, this.bookId)) deny("Log ind med annotationsadgang for at oprette en note.");
    const annotation = await this.annotations.create({
      ...input,
      visibility: input.visibility ?? (this.policy.annotationView === "public" ? "public" : "reviewGroup"),
    }, { principal });
    this.audit({ principal, action: "annotation.create", resourceType: "annotation", resourceId: annotation.id });
    return annotation;
  }

  async updateAnnotation(principal, id, input) {
    const current = (await this.annotations.list()).annotations.find((annotation) => annotation.id === id);
    if (!current) return null;
    const owns = current.author.id === actorId(principal);
    if (!owns && !hasPermission(principal, "annotations:moderate", this.bookId)) deny();
    if (!canCreateAnnotation(this.policy, principal, this.bookId) && !hasPermission(principal, "annotations:moderate", this.bookId)) deny();
    const annotation = await this.annotations.update(id, input, { principal });
    this.audit({ principal, action: "annotation.update", resourceType: "annotation", resourceId: id });
    return annotation;
  }

  async deleteAnnotation(principal, id) {
    const current = (await this.annotations.list()).annotations.find((annotation) => annotation.id === id);
    if (!current) return false;
    if (current.author.id !== actorId(principal) && !hasPermission(principal, "annotations:moderate", this.bookId)) deny();
    const deleted = await this.annotations.delete(id);
    if (deleted) this.audit({ principal, action: "annotation.delete", resourceType: "annotation", resourceId: id });
    return deleted;
  }

  async importAnnotations(principal, document, mode) {
    this.assertPermission(principal, "annotations:moderate");
    const previousIds = mode === "replace"
      ? new Set((await this.annotations.list()).annotations.map((annotation) => annotation.id))
      : new Set();
    const result = await this.annotations.importDocument(document, mode);
    if (mode === "replace") {
      const retainedIds = new Set(result.annotations.map((annotation) => annotation.id));
      for (const annotationId of previousIds) {
        if (!retainedIds.has(annotationId)) {
          this.audit({ principal, action: "annotation.delete", resourceType: "annotation", resourceId: annotationId, details: { source: "replace_import" } });
        }
      }
    }
    this.audit({ principal, action: "annotation.import", resourceType: "annotation_document", details: { mode, count: result.annotations.length } });
    return result;
  }

  async exportAnnotations(principal, format = "json") {
    const capabilities = publicCapabilities(this.policy, principal, this.bookId);
    if (!capabilities.canExportAnnotations) deny();
    const document = await this.listAnnotations(principal);
    if (format === "json") return { contentType: "application/json; charset=utf-8", extension: "json", body: `${JSON.stringify(document, null, 2)}\n` };
    if (format === "csv") return { contentType: "text/csv; charset=utf-8", extension: "csv", body: annotationCsv(document) };
    if (format === "markdown" || format === "md") return { contentType: "text/markdown; charset=utf-8", extension: "md", body: annotationMarkdown(document) };
    throw new TypeError(`Ukendt eksportformat: ${format}`);
  }

  listActiveSurveys(principal) {
    this.assertCanRead(principal);
    if (!canRespondToSurveys(this.policy, principal, this.bookId)) return [];
    return this.collaboration.listActiveSurveys(this.bookId, this.revisionId);
  }

  getSurvey(principal, id) {
    this.assertCanRead(principal);
    const survey = this.collaboration.survey(id, this.bookId);
    if (!survey) return null;
    if (hasPermission(principal, "surveys:manage", this.bookId)) return survey;
    if (!canRespondToSurveys(this.policy, principal, this.bookId)
      || survey.status !== "published"
      || survey.published?.definition?.target?.revisionId !== this.revisionId) return null;
    return { ...survey, draft: null, versions: [survey.published] };
  }

  getMySurveyResponse(principal, surveyId) {
    this.assertCanRead(principal);
    const survey = this.getSurvey(principal, surveyId);
    if (!survey?.published || !principal?.id) return null;
    return this.collaboration.getSurveyResponse({
      surveyId,
      surveyVersion: survey.publishedVersion,
      revisionId: this.revisionId,
      principal,
      bookId: this.bookId,
    });
  }

  submitSurveyResponse(principal, surveyId, answers) {
    this.assertCanRead(principal);
    if (!canRespondToSurveys(this.policy, principal, this.bookId)) deny("Log ind med surveyadgang for at besvare spørgsmålene.");
    const response = this.collaboration.submitSurveyResponse({
      surveyId,
      answers,
      revisionId: this.revisionId,
      principal,
      bookId: this.bookId,
    });
    this.audit({
      principal,
      action: "survey_response.submit",
      resourceType: "survey_response",
      resourceId: response.id,
      details: { surveyId, surveyVersion: response.surveyVersion },
    });
    return response;
  }

  listSurveys(principal, options) {
    this.assertPermission(principal, "surveys:manage");
    return this.collaboration.listSurveys(this.bookId, options);
  }

  createSurvey(principal, definition) {
    this.assertPermission(principal, "surveys:manage");
    const survey = this.collaboration.createSurvey({ bookId: this.bookId, definition, principal });
    this.audit({ principal, action: "survey.create", resourceType: "survey", resourceId: survey.id });
    return survey;
  }

  updateSurveyDraft(principal, id, definition) {
    this.assertPermission(principal, "surveys:manage");
    const survey = this.collaboration.updateSurveyDraft(id, definition, this.bookId);
    if (!survey) throw new ApplicationError(404, "Surveyen findes ikke.", "survey_not_found");
    this.audit({ principal, action: "survey.update", resourceType: "survey", resourceId: id });
    return survey;
  }

  async publishSurvey(principal, id) {
    this.assertPermission(principal, "surveys:manage");
    const pending = this.collaboration.survey(id, this.bookId);
    if (!pending) throw new ApplicationError(404, "Surveyen findes ikke.", "survey_not_found");
    if (!pending.draft) throw new TypeError("Surveyen har ingen kladde at publicere.");
    this.assertBookContentAvailable();
    const anchorId = pending.draft.definition.target.anchorId;
    if (!await this.bookContent.section(anchorId)) {
      throw new ApplicationError(422, `Surveyens anker findes ikke i den aktive revision: ${anchorId}`, "survey_anchor_not_found");
    }
    const survey = this.collaboration.publishSurvey(id, { bookId: this.bookId, revisionId: this.revisionId });
    if (survey) this.audit({
      principal,
      action: "survey.publish",
      resourceType: "survey",
      resourceId: id,
      details: { surveyVersion: survey.publishedVersion, revisionId: this.revisionId },
    });
    return survey;
  }

  closeSurvey(principal, id) {
    this.assertPermission(principal, "surveys:manage");
    const survey = this.collaboration.closeSurvey(id, this.bookId);
    if (!survey) throw new ApplicationError(404, "Surveyen findes ikke.", "survey_not_found");
    this.audit({ principal, action: "survey.close", resourceType: "survey", resourceId: id });
    return survey;
  }

  listSurveyResponses(principal, options = {}) {
    this.assertPermission(principal, "surveys:responses:read");
    return this.collaboration.listSurveyResponses(this.bookId, options);
  }

  async exportReviewBundle(principal, { includeProgress = false } = {}) {
    this.assertPermission(principal, "surveys:export");
    this.assertPermission(principal, "annotations:export");
    this.assertPermission(principal, "annotations:read:all");
    if (includeProgress) this.assertPermission(principal, "progress:read:all");
    const annotations = await this.annotations.list();
    const document = createReviewExport({
      book: {
        id: this.bookId,
        title: this.config.book.title,
        revisionId: this.revisionId,
        buildId: this.config.book.buildId,
      },
      annotations,
      surveys: this.collaboration.listSurveys(this.bookId),
      surveyResponses: this.collaboration.listSurveyResponses(this.bookId),
      readingProgress: includeProgress ? this.collaboration.listProgress(this.bookId) : null,
    });
    this.audit({
      principal,
      action: "review_export.create",
      resourceType: "review_export",
      resourceId: this.bookId,
      details: {
        annotationCount: document.annotations.items.length,
        surveyCount: document.surveys.length,
        responseCount: document.surveyResponses.length,
        includeProgress: document.readingProgress.included,
      },
    });
    return {
      contentType: "application/json; charset=utf-8",
      extension: "review-export.v1.json",
      body: `${JSON.stringify(document, null, 2)}\n`,
      document,
    };
  }

  saveProgress(principal, input) {
    this.assertCanRead(principal);
    if (principal?.kind === "token") this.assertPermission(principal, "progress:read:self");
    if (this.policy.progressTracking === "off") return null;
    const id = actorId(principal);
    if (!id) deny("Læseprogression kræver en stabil læseridentitet.");
    const progress = this.collaboration.saveProgress(id, input, this.bookId);
    if (!progress) return null;
    this.audit({ principal, action: "progress.update", resourceType: "reading_progress", resourceId: id, details: { anchorId: progress.anchorId, percent: progress.percent } });
    return progress;
  }

  getProgress(principal) {
    this.assertCanRead(principal);
    if (principal?.kind === "token") this.assertPermission(principal, "progress:read:self");
    const id = actorId(principal);
    if (!id || this.policy.progressTracking === "off") return null;
    return this.collaboration.getProgress(id, this.bookId);
  }

  getProgressPreference(principal) {
    const id = actorId(principal);
    if (!id || this.policy.progressTracking === "off") return { trackingEnabled: false, updatedAt: null };
    return this.collaboration.readingPreference(id, this.bookId);
  }

  setProgressPreference(principal, trackingEnabled) {
    this.assertCanRead(principal);
    const id = actorId(principal);
    if (!id) deny("Privatlivsindstillinger kræver en stabil læseridentitet.");
    const preference = this.collaboration.setReadingPreference(id, trackingEnabled, this.bookId);
    this.audit({ principal, action: "progress.preference.update", resourceType: "reading_preference", resourceId: id, details: preference });
    return preference;
  }

  listAllProgress(principal) {
    this.assertPermission(principal, "progress:read:all");
    return this.collaboration.listProgress(this.bookId);
  }

  listUsers(principal) {
    this.assertPermission(principal, "users:read");
    return this.collaboration.listUsers(this.bookId);
  }

  accessSettings(principal) {
    this.assertPermission(principal, "access:manage");
    return this.policy;
  }

  updateAccessSettings(principal, input) {
    this.assertPermission(principal, "access:manage");
    const nextPolicy = resolveAccessPolicy(input);
    if (this.policy.localBypass && !nextPolicy.localBypass && this.collaboration.activeAdministratorCount() === 0) {
      throw new ApplicationError(409, "Opret mindst én aktiv administrator, før lokal ejeradgang slås fra.", "administrator_required");
    }
    const policy = this.collaboration.saveAccessPolicy(nextPolicy, actorId(principal), this.bookId);
    this.audit({ principal, action: "access.update", resourceType: "book_settings", resourceId: this.bookId, details: policy });
    return policy;
  }

  async createUser(principal, input) {
    if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan oprette globale brugerkonti.");
    const user = await this.collaboration.createUser({ ...input, bookId: input.bookId ?? this.bookId });
    if (input.phone) this.collaboration.saveReviewerProfile(user.id, { bookId: input.bookId ?? this.bookId, phone: input.phone, phonePurpose: input.phonePurpose });
    this.audit({ principal, action: "user.create", resourceType: "user", resourceId: user.id });
    return user;
  }

  updateUser(principal, userId, input) {
    this.assertPermission(principal, "access:manage");
    if ((input.globalRole !== undefined || input.status !== undefined) && !instanceAdministrator(principal)) {
      deny("Kun en instansadministrator kan ændre globale kontooplysninger.");
    }
    if (input.bookRole) assertDelegableBookAccess(principal, this.bookId, input.bookRole, input.permissions);
    if (input.globalRole) this.collaboration.setGlobalRole(userId, input.globalRole);
    if (input.status) this.collaboration.setUserStatus(userId, input.status);
    if (input.bookRole === null) this.collaboration.removeMembership(userId, this.bookId);
    else if (input.bookRole) this.collaboration.setMembership(userId, input.bookRole, { bookId: this.bookId, permissions: input.permissions });
    if (input.phone !== undefined || input.phonePurpose !== undefined) {
      this.collaboration.saveReviewerProfile(userId, { bookId: this.bookId, phone: input.phone, phonePurpose: input.phonePurpose });
    }
    const user = this.collaboration.getUser(userId, this.bookId);
    this.audit({ principal, action: "user.update", resourceType: "user", resourceId: userId, details: { globalRole: input.globalRole, status: input.status, bookRole: input.bookRole, permissions: input.permissions } });
    return user;
  }

  async resetUserPassword(principal, userId, newPassword) {
    if (!instanceAdministrator(principal)) deny("Kun en instansadministrator kan nulstille andre brugeres passwords.");
    const user = await this.collaboration.changePassword(userId, { newPassword, requireCurrent: false });
    this.audit({ principal, action: "user.password.reset", resourceType: "user", resourceId: userId });
    return user;
  }

  async createInvitation(principal, input) {
    this.assertPermission(principal, "users:invite");
    assertDelegableBookAccess(principal, this.bookId, input.role ?? "reviewer", input.permissions);
    const invitation = await this.collaboration.createInvitation({ ...input, bookId: this.bookId, createdBy: actorId(principal) });
    this.audit({ principal, action: "invitation.create", resourceType: "invitation", resourceId: invitation.id, details: { role: invitation.role } });
    return invitation;
  }

  listInvitations(principal) {
    this.assertPermission(principal, "users:read");
    return this.collaboration.listInvitations(this.bookId);
  }

  revokeInvitation(principal, id) {
    this.assertPermission(principal, "users:invite");
    const revoked = this.collaboration.revokeInvitation(id, this.bookId);
    if (revoked) this.audit({ principal, action: "invitation.revoke", resourceType: "invitation", resourceId: id });
    return revoked;
  }

  async createToken(principal, input) {
    this.assertPermission(principal, "tokens:manage");
    if (input.actorUserId != null && (principal?.kind !== "user" || input.actorUserId !== principal.id)) {
      deny("Et token kan kun bindes til den bruger, der opretter det.");
    }
    const grants = (input.instanceAdmin ? [] : input.grants ?? [{ bookId: this.bookId, permissions: input.scopes }]).map((grant) => ({
      bookId: grant.bookId,
      permissions: validateScopes(grant.permissions),
    }));
    for (const grant of grants) {
      if (!hasPermission(principal, "tokens:manage", grant.bookId)) {
        deny("Tokenopretteren skal kunne administrere tokens i hver tildelt bog.");
      }
      const delegable = permissionsForPrincipal(principal, grant.bookId);
      if (grant.permissions.some((permission) => !delegable.has(permission))) {
        deny("Et token kan ikke få rettigheder, som opretteren ikke selv har.");
      }
    }
    if (input.instanceAdmin && !instanceAdministrator(principal)) deny();
    const token = await this.collaboration.createServiceToken({ ...input, scopes: undefined, grants, createdBy: actorId(principal) });
    this.audit({ principal, action: "token.create", resourceType: "service_token", resourceId: token.id, details: { name: token.name, grants, instanceAdmin: token.instanceAdmin } });
    return token;
  }

  listTokens(principal) {
    this.assertPermission(principal, "tokens:manage");
    return this.collaboration.listServiceTokens(this.bookId, { includeInstanceAdmin: instanceAdministrator(principal) });
  }

  revokeToken(principal, id) {
    this.assertPermission(principal, "tokens:manage");
    const revoked = this.collaboration.revokeServiceToken(id, this.bookId, { allowInstanceAdmin: instanceAdministrator(principal) });
    if (revoked) this.audit({ principal, action: "token.revoke", resourceType: "service_token", resourceId: id });
    return revoked;
  }

  listAudit(principal, options) {
    this.assertPermission(principal, "audit:read");
    return this.collaboration.listAudit({ ...options, bookId: this.bookId });
  }

  async createAccessCode(principal, input) {
    this.assertPermission(principal, "users:invite");
    assertDelegableBookAccess(principal, this.bookId, input.role ?? "reviewer", input.permissions);
    const accessCode = await this.collaboration.createAccessCode({ ...input, bookId: this.bookId, createdBy: actorId(principal) });
    this.audit({ principal, action: "access_code.create", resourceType: "access_code", resourceId: accessCode.id, details: { role: accessCode.role, maxUses: accessCode.maxUses } });
    return accessCode;
  }

  listAccessCodes(principal) {
    this.assertPermission(principal, "users:read");
    return this.collaboration.listAccessCodes(this.bookId);
  }

  revokeAccessCode(principal, id) {
    this.assertPermission(principal, "users:invite");
    const revoked = this.collaboration.revokeAccessCode(id, this.bookId);
    if (revoked) this.audit({ principal, action: "access_code.revoke", resourceType: "access_code", resourceId: id });
    return revoked;
  }

  reviewerProfile(principal, userId = actorId(principal)) {
    if (userId !== actorId(principal)) this.assertPermission(principal, "users:read");
    return this.collaboration.getReviewerProfile(userId, this.bookId);
  }

  saveReviewerProfile(principal, userId, input) {
    if (userId !== actorId(principal)) this.assertPermission(principal, "access:manage");
    return this.collaboration.saveReviewerProfile(userId, { ...input, bookId: this.bookId });
  }

  async exportUserData(principal, userId) {
    if (userId === undefined) {
      if (principal?.kind !== "user") deny("Selvbetjent kontoeksport kræver en brugersession.");
      userId = principal.id;
    } else if (principal?.kind !== "user" || userId !== principal.id) {
      if (!instanceAdministrator(principal)) deny();
    }
    const account = this.collaboration.exportUserData(userId);
    const annotations = (await this.annotations.list()).annotations.filter((annotation) => annotation.author.id === userId || annotation.updatedBy.id === userId);
    return { ...account, annotations };
  }

  async eraseUserData(principal, userId) {
    if (userId === undefined) {
      if (principal?.kind !== "user") deny("Selvbetjent kontosletning kræver en brugersession.");
      userId = principal.id;
    } else if (principal?.kind !== "user" || userId !== principal.id) {
      if (!instanceAdministrator(principal)) deny();
    }
    this.audit({ principal, action: "user.erase", resourceType: "user", resourceId: userId });
    await this.annotations.anonymizeAuthor(userId);
    return this.collaboration.eraseUserData(userId);
  }
}
