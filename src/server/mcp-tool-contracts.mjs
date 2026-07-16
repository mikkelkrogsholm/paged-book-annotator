const STANDARD_ERRORS = Object.freeze([
  { code: "invalid_input", retryable: false, suggestedAction: "Ret argumenterne efter værktøjets inputSchema og kald igen." },
  { code: "forbidden", retryable: false, suggestedAction: "Brug et token med den krævede bogpermission, eller bed en administrator tildele den." },
  { code: "not_found", retryable: false, suggestedAction: "Kald listeværktøjet først og brug et aktuelt id." },
  { code: "conflict", retryable: false, suggestedAction: "Læs den aktuelle ressource, afstem ændringen og kald igen." },
  { code: "rate_limited", retryable: true, suggestedAction: "Vent til den oplyste grænse er frigivet, eller afslut/ryd eksisterende stagingarbejde, og prøv igen." },
  { code: "internal_error", retryable: true, suggestedAction: "Vent kort, kald én gang igen, og rapportér requestId hvis fejlen fortsætter." },
]);

const definitions = [
  ["list_books", ["books:read"], "Find tilgængelige bøger og deres stabile id'er.", {}, "start", "read"],
  ["get_book", ["books:read"], "Læs metadata for én bog.", { bookId: "book-id" }, "start", "read"],
  ["create_book", [], "Opret en tom bogpost før upload; kræver instansadministrator.", { title: "Min bog", language: "da" }, "book-upload", "create"],
  ["create_book_upload", ["books:upload"], "Opret en kortlivet upload-URL til en valideret tar.gz-bundle.", { bookId: "book-id", filename: "book.tar.gz", contentType: "application/gzip" }, "book-upload", "create"],
  ["validate_book_upload", ["books:upload"], "Validér en færdig upload og opret en immutable staged revision.", { bookId: "book-id", uploadId: "upload-id" }, "book-upload", "update"],
  ["list_book_revisions", ["books:read"], "List revisioner og deres lifecycle-status.", { bookId: "book-id" }, "book-upload", "read"],
  ["publish_book_revision", ["books:publish"], "Publicér atomisk en valideret revision.", { bookId: "book-id", revisionId: "revision-id" }, "book-upload", "update"],
  ["archive_book", ["books:settings"], "Arkivér en bog uden at slette reviewdata.", { bookId: "book-id" }, "book-lifecycle", "delete"],
  ["get_book_context", ["books:read"], "Læs bogmetadata og tokenets effektive capabilities.", { bookId: "book-id" }, "read", "read"],
  ["list_book_outline", ["books:read"], "Find stabile overskriftsankre før tekstlæsning eller surveyoprettelse.", { bookId: "book-id", limit: 25 }, "read", "read"],
  ["get_book_section", ["books:read"], "Læs normaliseret tekst ved et stabilt anker.", { bookId: "book-id", anchorId: "chapter-1" }, "read", "read"],
  ["search_book", ["books:read"], "Søg i bogens tekst og få stabile ankre.", { bookId: "book-id", query: "søgeord" }, "read", "read"],
  ["get_annotation_context", ["books:read", "annotations:read"], "Læs en annotation sammen med aktuel tekst ved dens anker.", { bookId: "book-id", annotationId: "annotation-id" }, "annotation-review", "read"],
  ["list_changes_since", ["books:read", "annotations:read"], "Synkronisér synlige annotation-upserts med stabil keyset-cursor; deletion tombstones kræver read:all eller moderation.", { bookId: "book-id", since: "2026-01-01T00:00:00.000Z", limit: 100 }, "annotation-review", "read"],
  ["list_annotations", ["books:read", "annotations:read"], "List og filtrér annotationer, som tokenet må se.", { bookId: "book-id", status: "open" }, "annotation-review", "read"],
  ["create_annotation", ["books:read", "annotations:write"], "Opret en attribueret annotation med stabilt anker og sidehint.", { bookId: "book-id", type: "page", target: { scopeId: "chapter-1", pageNumber: 1 }, comment: "Kommentar" }, "annotation-review", "create"],
  ["update_annotation", ["annotations:write"], "Opdatér en ejet annotation; moderation kræves for andres.", { bookId: "book-id", id: "annotation-id", changes: { status: "resolved" } }, "annotation-review", "update"],
  ["delete_annotation", ["annotations:write"], "Slet en ejet annotation; moderation kræves for andres.", { bookId: "book-id", id: "annotation-id" }, "annotation-review", "delete"],
  ["export_annotations", ["books:read", "annotations:read", "annotations:export"], "Eksportér synlige annotationer i et legacyformat.", { bookId: "book-id", format: "json" }, "annotation-review", "read"],
  ["import_annotations", ["annotations:moderate"], "Importér et valideret annotation-dokument.", { bookId: "book-id", document: { schemaVersion: 4, bookId: "book-id", updatedAt: "2026-01-01T00:00:00.000Z", annotations: [] }, mode: "merge" }, "annotation-review", "update"],
  ["get_reading_progress", ["books:read", "progress:read:self"], "Læs tokenaktørens aktuelle læseposition.", { bookId: "book-id" }, "progress", "read"],
  ["record_reading_progress", ["books:read", "progress:read:self"], "Gem et stabilt anker og afledte side/procent-hints; engaged-events øger besøgstælleren og er derfor ikke idempotente.", { bookId: "book-id", anchorId: "chapter-1", pageNumber: 1, percent: 10, event: "engaged" }, "progress", "update"],
  ["list_reader_progress", ["progress:read:all"], "List alle læseres position og besøgte ankre.", { bookId: "book-id" }, "progress", "read"],
  ["list_users", ["users:read"], "List installationsbrugere og valgfrit bogmedlemskab.", { bookId: "book-id" }, "administration", "read"],
  ["list_book_members", ["users:read"], "List medlemmer og effektive bogpermissions.", { bookId: "book-id" }, "administration", "read"],
  ["get_access_settings", ["access:manage"], "Læs bogens adgangs- og tilmeldingspolitik.", { bookId: "book-id" }, "administration", "read"],
  ["update_access_settings", ["access:manage"], "Skift adgangspreset eller eksplicitte policyfelter med lockout-beskyttelse.", { bookId: "book-id", preset: "privateReview", registration: "inviteOnly" }, "administration", "update"],
  ["create_user", ["users:invite"], "Opret en lokal identitet og valgfri bogadgang.", { email: "reader@example.test", displayName: "Reader", password: "minimum-ti-tegn", bookId: "book-id", bookRole: "reviewer" }, "administration", "create"],
  ["update_user_access", ["access:manage"], "Opdatér brugerstatus, global rolle eller bogmedlemskab.", { userId: "user-id", bookId: "book-id", bookRole: "reviewer" }, "administration", "update"],
  ["reset_user_password", ["access:manage"], "Nulstil et password og tilbagekald brugerens sessioner.", { userId: "user-id", newPassword: "nyt-hemmeligt-password" }, "administration", "update"],
  ["create_invitation", ["users:invite"], "Opret en udløbende invitation; hemmeligheden returneres én gang.", { bookId: "book-id", email: "reader@example.test", role: "reviewer" }, "enrollment", "create"],
  ["list_invitations", ["users:read"], "List invitationers metadata uden secrets.", { bookId: "book-id" }, "enrollment", "read"],
  ["revoke_invitation", ["users:invite"], "Tilbagekald en invitation.", { bookId: "book-id", id: "invitation-id" }, "enrollment", "delete"],
  ["create_access_code", ["users:invite"], "Opret en begrænset tilmeldingskode; koden returneres én gang.", { bookId: "book-id", name: "Prøvelæsere", role: "reviewer" }, "enrollment", "create"],
  ["list_access_codes", ["users:read"], "List adgangskodemetadata uden plaintext-koder.", { bookId: "book-id" }, "enrollment", "read"],
  ["revoke_access_code", ["users:invite"], "Tilbagekald en adgangskode straks.", { bookId: "book-id", id: "code-id" }, "enrollment", "delete"],
  ["create_service_token", ["tokens:manage"], "Opret et udløbende token med eksplicitte, eventuelt forskellige permissions per bog.", { name: "Redaktør-agent", grants: [{ bookId: "book-id", permissions: ["books:read", "annotations:read"] }] }, "tokens", "create"],
  ["list_service_tokens", ["tokens:manage"], "List tokenmetadata, grants og udløb uden secrets.", { bookId: "book-id" }, "tokens", "read"],
  ["revoke_service_token", ["tokens:manage"], "Tilbagekald et token; bogadministratorer skal angive den bog, der autoriserer handlingen.", { id: "token-id", bookId: "book-id" }, "tokens", "delete"],
  ["list_audit_events", ["audit:read"], "List pseudonymiserede mutationsevents uden PII/fritekstsvar.", { bookId: "book-id", limit: 100 }, "administration", "read"],
  ["list_active_surveys", ["books:read", "surveys:respond"], "List publicerede surveys for bogens aktive revision.", { bookId: "book-id" }, "survey-response", "read"],
  ["get_survey", ["books:read", "surveys:respond"], "Læs én aktiv survey med spørgsmål og stabilt mål.", { bookId: "book-id", surveyId: "survey-id" }, "survey-response", "read"],
  ["get_my_survey_response", ["books:read", "surveys:respond"], "Læs aktørens eget svar til den aktive surveyversion.", { bookId: "book-id", surveyId: "survey-id" }, "survey-response", "read"],
  ["submit_survey_response", ["books:read", "surveys:respond"], "Opret eller erstat aktørens ene svar til surveyversionen.", { bookId: "book-id", surveyId: "survey-id", answers: [{ questionId: "clarity", value: 5 }] }, "survey-response", "update"],
  ["list_surveys", ["surveys:manage"], "List alle surveykladder, publicerede versioner og lukkede surveys.", { bookId: "book-id" }, "survey-admin", "read"],
  ["create_survey", ["surveys:manage"], "Opret surveyversion 1 som kladde.", {
    bookId: "book-id",
    definition: {
      schemaVersion: 1, title: "Feedback", description: "",
      target: { kind: "section", anchorId: "chapter-1" }, trigger: { mode: "afterLeave" },
      questions: [{
        id: "clarity", type: "rating", prompt: "Hvor let var afsnittet at forstå?", required: true,
        scale: { min: 1, max: 5, minLabel: "Svært", maxLabel: "Let" },
      }],
    },
  }, "survey-admin", "create"],
  ["update_survey_draft", ["surveys:manage"], "Gem en fuld kladdedefinition; en publiceret survey får en ny draft-version.", {
    bookId: "book-id", surveyId: "survey-id",
    definition: {
      schemaVersion: 1, title: "Revideret feedback", description: "",
      target: { kind: "section", anchorId: "chapter-1" }, trigger: { mode: "afterLeave" },
      questions: [{
        id: "clarity", type: "rating", prompt: "Hvor let var afsnittet at forstå?", required: true,
        scale: { min: 1, max: 5, minLabel: "Svært", maxLabel: "Let" },
      }],
    },
  }, "survey-admin", "update"],
  ["publish_survey", ["surveys:manage"], "Publicér kladden immutabelt for den aktive bogrevision.", { bookId: "book-id", surveyId: "survey-id" }, "survey-admin", "update"],
  ["close_survey", ["surveys:manage"], "Luk en survey for nye eller ændrede svar.", { bookId: "book-id", surveyId: "survey-id" }, "survey-admin", "delete"],
  ["list_survey_responses", ["surveys:responses:read"], "List pseudonymiserede svar med surveyversion og revisionsanker.", { bookId: "book-id", surveyId: "survey-id" }, "survey-admin", "read"],
  ["export_review_bundle", ["annotations:read:all", "annotations:export", "surveys:export"], "Eksportér alle annotationer, surveydefinitioner/-svar og valgfri progression i review-export V1; includeProgress=true kræver også progress:read:all.", { bookId: "book-id", includeProgress: false }, "review-export", "read"],
];

const outputKeysByName = Object.freeze({
  list_books: ["items"], get_book: ["book", "session"], create_book: ["book"], create_book_upload: ["upload"],
  validate_book_upload: ["revision"], list_book_revisions: ["items"], publish_book_revision: ["book", "revision"], archive_book: ["book"],
  get_book_context: ["book", "session"], list_book_outline: ["bookId", "buildId", "items", "nextCursor", "total"],
  get_book_section: ["section"], search_book: ["bookId", "buildId", "query", "items", "nextCursor", "total"],
  get_annotation_context: ["context"], list_changes_since: ["bookId", "buildId", "since", "items", "nextCursor"],
  list_annotations: ["schemaVersion", "bookId", "updatedAt", "annotations"],
  create_annotation: ["id", "bookId", "revisionId", "type", "target", "comment", "author", "createdAt", "updatedAt"],
  update_annotation: ["annotation"], delete_annotation: ["deleted"], export_annotations: ["contentType", "extension", "body"],
  import_annotations: ["schemaVersion", "bookId", "updatedAt", "annotations"], get_reading_progress: ["progress"],
  record_reading_progress: ["progress"], list_reader_progress: ["items"], list_users: ["items"], list_book_members: ["items"],
  get_access_settings: ["preset", "reading", "annotationCreate", "annotationView", "surveyResponse", "registration", "progressTracking", "localBypass"],
  update_access_settings: ["preset", "reading", "annotationCreate", "annotationView", "surveyResponse", "registration", "progressTracking", "localBypass"],
  create_user: ["id", "email", "displayName", "globalRole", "status", "membership"], update_user_access: ["id", "email", "displayName", "globalRole", "status", "membership"],
  reset_user_password: ["id", "email", "displayName", "globalRole", "status", "membership"], create_invitation: ["id", "secret", "bookId", "email", "role", "expiresAt"],
  list_invitations: ["items"], revoke_invitation: ["revoked"], create_access_code: ["id", "secret", "bookId", "name", "role", "expiresAt", "maxUses"],
  list_access_codes: ["items"], revoke_access_code: ["revoked"], create_service_token: ["id", "secret", "prefix", "bookGrants", "instanceAdmin", "expiresAt"],
  list_service_tokens: ["items"], revoke_service_token: ["revoked"], list_audit_events: ["items"],
  list_active_surveys: ["surveys"], get_survey: ["survey"], get_my_survey_response: ["response"], submit_survey_response: ["response"],
  list_surveys: ["surveys"], create_survey: ["survey"], update_survey_draft: ["survey"], publish_survey: ["survey"], close_survey: ["survey"],
  list_survey_responses: ["responses"], export_review_bundle: ["schemaVersion", "kind", "exportedAt", "book", "annotations", "surveys", "surveyResponses", "readingProgress"],
});

const idempotenceOverrides = Object.freeze({
  validate_book_upload: false,
  record_reading_progress: false,
  archive_book: false,
  update_survey_draft: false,
  publish_survey: false,
  close_survey: false,
  reset_user_password: false,
});

const authorizationDetails = Object.freeze({
  create_book: { requiresInstanceAdmin: true },
  list_users: { conditional: "Uden bookId kræves instansadministrator; med bookId kræves users:read for bogen." },
  create_user: { requiresInstanceAdmin: true, conditional: "bookRole kræver bookId; telefonnummer kræver et eksplicit phonePurpose." },
  update_user_access: { conditional: "Global rolle og kontostatus kræver instansadministrator. Bogrolle/permissions kræver bookId og må ikke overstige opretterens egne rettigheder." },
  reset_user_password: { requiresInstanceAdmin: true },
  create_invitation: { conditional: "Den tildelte rolle må ikke overstige opretterens egne rettigheder i bogen." },
  create_access_code: { conditional: "Den tildelte rolle må ikke overstige opretterens egne rettigheder i bogen." },
  create_service_token: { conditional: "Et instanceAdmin-token kræver instansadministrator. Boggrants må ikke overstige opretterens egne rettigheder." },
  list_service_tokens: { conditional: "Uden bookId kan kun en instansadministrator se alle tokens; med bookId kræves tokens:manage for bogen." },
  revoke_service_token: { conditional: "En instansadministrator kan tilbagekalde globalt. Ellers kræves bookId og tokens:manage i netop den bog." },
  list_audit_events: { conditional: "Uden bookId bruges installationens default-bog; angiv altid bookId medmindre tokenet er bevidst scoped til default-bogen." },
  get_survey: { alternativePermissions: ["surveys:manage"], conditional: "Aktive surveys kræver books:read + surveys:respond; surveyadministratorer kan også læse kladder via surveys:manage." },
  list_changes_since: { conditional: "annotation.upsert følger normal synlighed. annotation.deleted tombstones returneres kun med annotations:read:all eller annotations:moderate." },
  export_review_bundle: { additionalPermissions: { includeProgress: ["progress:read:all"] } },
});

export const MCP_TOOL_CONTRACTS = Object.freeze(Object.fromEntries(definitions.map(([
  name, requiredPermissions, purpose, exampleArguments, workflow, effect,
]) => [name, Object.freeze({
  contractVersion: 1,
  purpose,
  requiredPermissions,
  effect,
  idempotent: idempotenceOverrides[name] ?? (effect === "read" || effect === "update" || effect === "delete"),
  authorization: authorizationDetails[name] ?? undefined,
  workflow,
  exampleArguments,
  output: { type: "object", topLevelKeys: outputKeysByName[name] },
  errors: STANDARD_ERRORS,
})])));

export function mcpToolError(error, { requestId } = {}) {
  const status = Number(error?.status ?? 0);
  const suppliedCode = error?.code == null ? null : String(error.code);
  let code = "internal_error";
  if (STANDARD_ERRORS.some((candidate) => candidate.code === suppliedCode)) code = suppliedCode;
  else if (error instanceof TypeError || [400, 413, 422].includes(status)) code = "invalid_input";
  else if (status === 429) code = "rate_limited";
  else if (status === 401 || status === 403) code = "forbidden";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 409) code = "conflict";
  const documented = STANDARD_ERRORS.find((candidate) => candidate.code === code)
    ?? { code: String(code), retryable: status >= 500, suggestedAction: "Læs fejlen, ret forudsætningen og kald igen." };
  return {
    error: {
      code: documented.code,
      message: documented.code === "internal_error"
        ? "Intern serverfejl. Rapportér requestId, hvis fejlen fortsætter."
        : error instanceof Error ? error.message : "Værktøjet fejlede.",
      retryable: documented.retryable,
      suggestedAction: documented.suggestedAction,
      requestId,
      causeCode: suppliedCode && suppliedCode !== code ? suppliedCode : undefined,
    },
  };
}
