// agent-lint: disable-file=AR002 -- Presets are declarative domain data; keeping every combination explicit prevents policy drift.
export const ACCESS_PRESETS = Object.freeze({
  local: Object.freeze({
    reading: "public",
    annotationCreate: "public",
    annotationView: "public",
    surveyResponse: "public",
    registration: "disabled",
    progressTracking: "resume",
    localBypass: true,
  }),
  publicRead: Object.freeze({
    reading: "public",
    annotationCreate: "disabled",
    annotationView: "none",
    surveyResponse: "disabled",
    registration: "disabled",
    progressTracking: "off",
    localBypass: false,
  }),
  publicOpenReview: Object.freeze({
    reading: "public",
    annotationCreate: "public",
    annotationView: "public",
    surveyResponse: "public",
    registration: "disabled",
    progressTracking: "resume",
    localBypass: false,
  }),
  publicMemberReview: Object.freeze({
    reading: "public",
    annotationCreate: "authenticated",
    annotationView: "own",
    surveyResponse: "authenticated",
    registration: "open",
    progressTracking: "resume",
    localBypass: false,
  }),
  publicInviteReview: Object.freeze({
    reading: "public",
    annotationCreate: "invited",
    annotationView: "own",
    surveyResponse: "invited",
    registration: "inviteOnly",
    progressTracking: "resume",
    localBypass: false,
  }),
  privateRead: Object.freeze({
    reading: "invited",
    annotationCreate: "disabled",
    annotationView: "none",
    surveyResponse: "disabled",
    registration: "inviteOnly",
    progressTracking: "resume",
    localBypass: false,
  }),
  privateReview: Object.freeze({
    reading: "invited",
    annotationCreate: "invited",
    annotationView: "own",
    surveyResponse: "invited",
    registration: "inviteOnly",
    progressTracking: "resume",
    localBypass: false,
  }),
});

export const PERMISSIONS = Object.freeze([
  "books:read",
  "books:upload",
  "books:publish",
  "books:settings",
  "annotations:read",
  "annotations:read:self",
  "annotations:read:all",
  "annotations:write",
  "annotations:moderate",
  "annotations:export",
  "surveys:respond",
  "surveys:manage",
  "surveys:responses:read",
  "surveys:export",
  "progress:read:self",
  "progress:read:all",
  "users:read",
  "users:invite",
  "access:manage",
  "tokens:manage",
  "audit:read",
  "settings:manage",
]);

const ADMIN_PERMISSIONS = Object.freeze([...PERMISSIONS]);

export const ROLE_PERMISSIONS = Object.freeze({
  instance_admin: ADMIN_PERMISSIONS,
  book_admin: ADMIN_PERMISSIONS,
  reviewer: Object.freeze([
    "books:read",
    "annotations:read",
    "annotations:read:self",
    "annotations:write",
    "annotations:export",
    "surveys:respond",
    "progress:read:self",
  ]),
  reader: Object.freeze(["books:read", "surveys:respond", "progress:read:self"]),
  editor: Object.freeze([
    "books:read",
    "annotations:read",
    "annotations:read:all",
    "annotations:write",
    "annotations:moderate",
    "annotations:export",
    "surveys:respond",
    "surveys:manage",
    "surveys:responses:read",
    "surveys:export",
    "progress:read:all",
  ]),
  publisher: Object.freeze([
    "books:read",
    "books:upload",
    "books:publish",
    "books:settings",
  ]),
});

const ACCESS_VALUES = Object.freeze({
  reading: new Set(["public", "authenticated", "invited"]),
  annotationCreate: new Set(["disabled", "public", "authenticated", "invited"]),
  annotationView: new Set(["none", "own", "reviewGroup", "public"]),
  surveyResponse: new Set(["disabled", "public", "authenticated", "invited"]),
  registration: new Set(["disabled", "closed", "open", "inviteOnly", "code"]),
  progressTracking: new Set(["off", "resume", "analytics"]),
});

export function resolveAccessPolicy(raw = {}) {
  const preset = String(raw.preset ?? "local");
  const base = ACCESS_PRESETS[preset];
  if (!base) throw new TypeError(`Ukendt access.preset: ${preset}`);
  const policy = {
    preset,
    reading: raw.reading ?? base.reading,
    annotationCreate: raw.annotationCreate ?? base.annotationCreate,
    annotationView: raw.annotationView ?? base.annotationView,
    surveyResponse: raw.surveyResponse ?? base.surveyResponse,
    registration: raw.registration ?? base.registration,
    progressTracking: raw.progressTracking ?? base.progressTracking,
    localBypass: raw.localBypass ?? base.localBypass,
  };

  for (const [field, values] of Object.entries(ACCESS_VALUES)) {
    if (!values.has(policy[field])) throw new TypeError(`Ugyldig access.${field}: ${policy[field]}`);
  }
  if (typeof policy.localBypass !== "boolean") throw new TypeError("access.localBypass skal være boolesk.");
  return Object.freeze(policy);
}

export function permissionsForPrincipal(principal, bookId) {
  if (!principal) return new Set();
  if (principal.kind === "local") return new Set(ADMIN_PERMISSIONS);
  if (principal.kind === "token") {
    if (principal.instanceAdmin === true) return new Set(ADMIN_PERMISSIONS);
    if (Array.isArray(principal.bookGrants)) {
      const grant = principal.bookGrants.find((candidate) => candidate.bookId === bookId);
      return new Set(grant?.permissions ?? []);
    }
    if (principal.bookId && principal.bookId !== bookId) return new Set();
    return new Set(principal.scopes ?? []);
  }
  if (principal.kind !== "user") return new Set();
  if (principal.globalRole === "instance_admin") return new Set(ADMIN_PERMISSIONS);
  const membership = principal.memberships?.find((candidate) => candidate.bookId === bookId)
    ?? (principal.bookId === bookId ? {
      role: principal.role,
      permissions: principal.permissions,
    } : null);
  if (!membership) return new Set();
  return new Set([
    ...(ROLE_PERMISSIONS[membership.role] ?? []),
    ...(membership.permissions ?? []),
  ]);
}

export function hasPermission(principal, permission, bookId) {
  return permissionsForPrincipal(principal, bookId).has(permission);
}

export function isAdministrator(principal, bookId) {
  return hasPermission(principal, "access:manage", bookId);
}

export function canReadBook(policy, principal, bookId) {
  if (policy.localBypass && principal?.kind === "local") return true;
  if (principal?.kind === "token") return hasPermission(principal, "books:read", bookId);
  if (policy.reading === "public") return true;
  if (policy.reading === "authenticated") return principal?.kind === "user";
  return hasPermission(principal, "books:read", bookId);
}

export function canCreateAnnotation(policy, principal, bookId) {
  if (policy.localBypass && principal?.kind === "local") return true;
  if (principal?.kind === "token") return hasPermission(principal, "annotations:write", bookId);
  if (policy.annotationCreate === "disabled") return false;
  if (policy.annotationCreate === "public") return principal?.kind === "guest" || principal?.kind === "user";
  if (policy.annotationCreate === "authenticated") return principal?.kind === "user";
  return hasPermission(principal, "annotations:write", bookId);
}

export function canReadAnnotations(policy, principal, bookId) {
  if (policy.localBypass && principal?.kind === "local") return true;
  if (!canReadBook(policy, principal, bookId)) return false;
  if (principal?.kind === "token") return hasPermission(principal, "annotations:read", bookId);
  if (isAdministrator(principal, bookId)) return true;
  if (policy.annotationView === "public") return canReadBook(policy, principal, bookId);
  if (policy.annotationView === "none") return false;
  return Boolean(principal && (principal.kind === "user" || principal.kind === "guest"));
}

export function canRespondToSurveys(policy, principal, bookId) {
  if (policy.localBypass && principal?.kind === "local") return true;
  if (principal?.kind === "token") return hasPermission(principal, "surveys:respond", bookId);
  if (policy.surveyResponse === "disabled") return false;
  if (policy.surveyResponse === "public") return principal?.kind === "guest" || principal?.kind === "user";
  if (policy.surveyResponse === "authenticated") return principal?.kind === "user";
  return hasPermission(principal, "surveys:respond", bookId);
}

export function canSeeAnnotation(policy, principal, annotation, bookId) {
  if (!canReadAnnotations(policy, principal, bookId)) return false;
  if (annotation.author?.id === principal?.id
    || isAdministrator(principal, bookId)
    || hasPermission(principal, "annotations:read:all", bookId)
    || hasPermission(principal, "annotations:moderate", bookId)) return true;
  if (annotation.visibility === "private") return false;
  if (annotation.visibility === "public") return policy.annotationView !== "none";
  return ["reviewGroup", "public"].includes(policy.annotationView)
    && hasPermission(principal, "annotations:read", bookId);
}

export function publicCapabilities(policy, principal, bookId) {
  const permissions = permissionsForPrincipal(principal, bookId);
  const canRead = canReadBook(policy, principal, bookId);
  return {
    authenticated: principal?.kind === "user" || principal?.kind === "token" || principal?.kind === "local",
    principalKind: principal?.kind ?? "anonymous",
    canRead,
    canViewAnnotations: canReadAnnotations(policy, principal, bookId),
    canCreateAnnotations: canCreateAnnotation(policy, principal, bookId),
    canModerateAnnotations: permissions.has("annotations:moderate"),
    canExportAnnotations: canRead && (permissions.has("annotations:export")
      || (principal?.kind !== "token" && policy.annotationView === "public")),
    canRespondToSurveys: canRespondToSurveys(policy, principal, bookId),
    canManageSurveys: permissions.has("surveys:manage"),
    canReadSurveyResponses: permissions.has("surveys:responses:read"),
    canExportReviews: permissions.has("surveys:export")
      && permissions.has("annotations:export")
      && permissions.has("annotations:read:all"),
    canManageUsers: permissions.has("access:manage"),
    canManageTokens: permissions.has("tokens:manage"),
    canViewAllProgress: permissions.has("progress:read:all"),
    canViewAudit: permissions.has("audit:read"),
    progressTracking: policy.progressTracking,
    registration: policy.registration,
    permissions: [...permissions].sort(),
  };
}

export function validateScopes(scopes, { allowEmpty = false } = {}) {
  if (!Array.isArray(scopes) || (!allowEmpty && scopes.length === 0)) {
    throw new TypeError("Et token kræver mindst én permission.");
  }
  const unique = [...new Set(scopes.map(String))];
  const invalid = unique.filter((scope) => !PERMISSIONS.includes(scope));
  if (invalid.length > 0) throw new TypeError(`Ukendte token-permissions: ${invalid.join(", ")}`);
  return unique;
}
