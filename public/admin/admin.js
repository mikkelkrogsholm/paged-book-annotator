import { confirmUiAction } from "../ui-state.js";
import { selectActiveBookId } from "./book-selection.js";
import { emptyRow, escapeHtml, formatDate, option, renderAccessCodes, renderAudit, renderInvitations, renderProgress, renderTokenTable } from "./admin-table-renderers.js";

async function api(path, options = {}) {
  const { json, ...requestOptions } = options;
  const headers = { Accept: "application/json", ...requestOptions.headers };
  let body = requestOptions.body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(path, { ...requestOptions, headers, body });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) throw new Error(payload?.error ?? payload?.message ?? `Kaldet fejlede (${response.status}).`);
  return payload;
}

async function optionalApi(path, fallback, options = {}) {
  try { return await api(path, options); } catch (error) {
    if (/\(404\)|ikke fundet|not found/i.test(error.message)) return fallback;
    throw error;
  }
}

function formObject(form) {
  return Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
}

function list(payload, key) { return Array.isArray(payload) ? payload : Array.isArray(payload?.[key]) ? payload[key] : Array.isArray(payload?.items) ? payload.items : []; }
function bookPath(segment = "", bookId = state.bookId) { return `/api/admin/books/${encodeURIComponent(bookId)}${segment ? `/${segment}` : ""}`; }
function readerPath(book = state.book) { return `/books/${encodeURIComponent(book?.slug ?? book?.id ?? state.bookId)}`; }
function suggestedSlug(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}
function tokenListPath() { return isInstanceAdmin() ? "/api/admin/tokens" : bookPath("tokens"); }
function tokenRevokePath(id) {
  const path = `/api/admin/tokens/${encodeURIComponent(id)}`;
  return isInstanceAdmin() ? path : `${path}?bookId=${encodeURIComponent(state.bookId)}`;
}

function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
}

function setFormBusy(form, busy) {
  form.toggleAttribute("aria-busy", busy);
  for (const button of form.querySelectorAll("button[type=submit], button:not([type])")) button.disabled = busy;
  if (busy) state.busyForms.add(form); else state.busyForms.delete(form);
  updateBookNavigationBusy();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
  else {
    const area = document.createElement("textarea"); area.value = value; document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
  }
  toast("Kopieret til udklipsholderen.");
}

const presetLabels = {
  local: "Kun lokalt · ejeradgang", publicRead: "Offentlig · kun læsning", publicOpenReview: "Offentlig · åben feedback",
  publicMemberReview: "Offentlig læsning · login for feedback", publicInviteReview: "Offentlig læsning · invitation for feedback",
  privateRead: "Privat · kun læsning", privateReview: "Privat · review med feedback",
};
const fallbackProfiles = {
  local: { reading: "public", annotationCreate: "public", annotationView: "public", surveyResponse: "public", registration: "disabled", progressTracking: "resume", localBypass: true },
  publicRead: { reading: "public", annotationCreate: "disabled", annotationView: "none", surveyResponse: "disabled", registration: "disabled", progressTracking: "off", localBypass: false },
  publicOpenReview: { reading: "public", annotationCreate: "public", annotationView: "public", surveyResponse: "public", registration: "disabled", progressTracking: "resume", localBypass: false },
  publicMemberReview: { reading: "public", annotationCreate: "authenticated", annotationView: "own", surveyResponse: "authenticated", registration: "open", progressTracking: "resume", localBypass: false },
  publicInviteReview: { reading: "public", annotationCreate: "invited", annotationView: "own", surveyResponse: "invited", registration: "inviteOnly", progressTracking: "resume", localBypass: false },
  privateRead: { reading: "invited", annotationCreate: "disabled", annotationView: "none", surveyResponse: "disabled", registration: "inviteOnly", progressTracking: "resume", localBypass: false },
  privateReview: { reading: "invited", annotationCreate: "invited", annotationView: "own", surveyResponse: "invited", registration: "inviteOnly", progressTracking: "resume", localBypass: false },
};
const capabilityLabels = { reading: "Læsning", annotationCreate: "Opret annotation", annotationView: "Se annotationer", surveyResponse: "Besvar surveys", registration: "Konto", progressTracking: "Læsestatus" };
const fallbackPermissions = [
  "books:read", "books:upload", "books:publish", "books:settings", "annotations:read", "annotations:read:self",
  "annotations:read:all", "annotations:write", "annotations:moderate", "annotations:export", "surveys:respond",
  "surveys:manage", "surveys:responses:read", "surveys:export", "progress:read:self", "progress:read:all",
  "users:read", "users:invite", "access:manage", "tokens:manage", "audit:read", "settings:manage",
];
const statusLabels = { draft: "Kladde", published: "Publiceret", archived: "Arkiveret", staged: "Modtaget", validating: "Validerer", ready: "Klar", failed: "Fejlet", active: "Aktiv", closed: "Lukket", superseded: "Afløst" };
const state = {
  books: [], book: null, bookId: null, metadata: null, annotations: [], surveys: [], surveyResponses: [], outline: [],
  editingSurveyId: null, invitationUrl: "", accessCode: "", session: null, permissions: new Set(),
  bookLoadController: null, loadGeneration: 0,
  loadingBook: false, busyForms: new Set(), busyActions: 0,
};

function updateBookNavigationBusy() {
  const busy = state.loadingBook || state.busyForms.size > 0 || state.busyActions > 0;
  const hasActiveBooks = state.books.some((book) => book.status !== "archived");
  document.querySelector("#bookSelector").disabled = busy || !hasActiveBooks;
  document.querySelector("#bookGrid").inert = busy;
}

function updateBookNavigationAvailability() {
  const hasActiveBook = Boolean(state.bookId);
  const message = "Opret eller vælg en aktiv bog for at bruge dette område.";
  for (const link of document.querySelectorAll("[data-requires-active-book]")) {
    link.setAttribute("data-unavailable", String(!hasActiveBook));
    if (hasActiveBook) {
      link.removeAttribute("aria-describedby");
      link.removeAttribute("title");
    } else {
      link.setAttribute("aria-describedby", "bookNavigationHint");
      link.title = message;
    }
  }
  document.querySelector("#bookNavigationHint").hidden = hasActiveBook;
  const readerLink = document.querySelector("#readerLink");
  readerLink.textContent = hasActiveBook ? "← Åbn aktiv bog" : "← Til læseren";
  if (!hasActiveBook && document.querySelector(`.sidebar nav a[href="${location.hash}"][data-requires-active-book]`)) {
    const url = new URL(location.href);
    url.hash = "library";
    history.replaceState(null, "", url);
  }
  updateBookNavigationBusy();
}

function isInstanceAdmin() {
  const principal = state.session?.principal;
  return principal?.kind === "local" || principal?.globalRole === "instance_admin" || principal?.instanceAdmin === true;
}

function can(permission) {
  return isInstanceAdmin() || state.permissions.has(permission);
}

function hasAdminAccess() {
  return isInstanceAdmin() || [
    "books:upload", "books:publish", "books:settings", "annotations:read:all", "annotations:moderate",
    "annotations:export", "surveys:manage", "surveys:responses:read", "surveys:export",
    "progress:read:all", "users:read", "users:invite", "access:manage", "tokens:manage", "audit:read",
  ].some((permission) => state.permissions.has(permission));
}

function permissionsFromSession(session) {
  const permissions = session?.capabilities?.permissions;
  if (Array.isArray(permissions)) return new Set(permissions);
  return session?.capabilities?.canManageUsers ? new Set(state.metadata?.permissions ?? fallbackPermissions) : new Set();
}

function setSectionVisible(id, visible) {
  document.querySelector(`#${id}`).hidden = !visible;
  document.querySelector(`.sidebar nav a[href="#${id}"]`)?.toggleAttribute("hidden", !visible);
}

function applyPermissionVisibility() {
  setSectionVisible("overview", can("users:read") && can("annotations:read:all"));
  setSectionVisible("revisions", can("books:upload") || can("books:publish"));
  setSectionVisible("sharing", can("access:manage") || can("books:settings"));
  setSectionVisible("users", can("users:read"));
  setSectionVisible("invitations", can("users:read") || can("users:invite"));
  setSectionVisible("access-codes", can("users:read") || can("users:invite"));
  setSectionVisible("annotations", can("annotations:read:all") || can("annotations:moderate") || can("annotations:export"));
  setSectionVisible("progress", can("progress:read:all"));
  setSectionVisible("surveys", can("surveys:manage") || can("surveys:responses:read") || can("surveys:export"));
  setSectionVisible("tokens", can("tokens:manage"));
  setSectionVisible("audit", can("audit:read"));
  document.querySelector("#createBookForm").hidden = !isInstanceAdmin();
  document.querySelector("#createUserForm").hidden = !isInstanceAdmin();
  document.querySelector("#uploadForm").hidden = !can("books:upload");
  document.querySelector("#accessForm").hidden = !can("access:manage");
  document.querySelector("#bookLinkForm").hidden = !can("books:settings");
  document.querySelector("#inviteForm").hidden = !can("users:invite");
  document.querySelector("#invitationsTable").closest(".table-wrap").hidden = !can("users:read");
  document.querySelector("#accessCodeForm").hidden = !can("users:invite");
  document.querySelector("#accessCodesTable").closest(".table-wrap").hidden = !can("users:read");
  document.querySelector("#annotationFilters").hidden = !can("annotations:read:all");
  document.querySelector("#annotationsTable").closest(".table-wrap").hidden = !can("annotations:read:all");
  document.querySelector("#surveyBuilderForm").hidden = !can("surveys:manage");
  document.querySelector("#surveysTable").closest(".table-wrap").hidden = !can("surveys:manage");
  document.querySelector("#surveyResponsesHeading").hidden = !can("surveys:responses:read");
  document.querySelector("#surveyResponsesTable").closest(".table-wrap").hidden = !can("surveys:responses:read");
  document.querySelector("#reviewExportControls").hidden = !(
    can("surveys:export") && can("annotations:export") && can("annotations:read:all")
  );
  document.querySelectorAll("[data-export-format]").forEach((link) => {
    link.hidden = !can("annotations:export");
  });
  const instanceAdminToggle = document.querySelector("[name=instanceAdmin]");
  instanceAdminToggle.closest("label").hidden = !isInstanceAdmin();
  instanceAdminToggle.disabled = !isInstanceAdmin();
  updateTokenGrantAvailability();
}

function updateTokenGrantAvailability() {
  const instanceAdmin = isInstanceAdmin() && document.querySelector("[name=instanceAdmin]").checked;
  document.querySelector("#tokenPresets").hidden = instanceAdmin;
  document.querySelector("#instanceTokenHelp").hidden = !instanceAdmin;
  for (const fieldset of document.querySelectorAll("#tokenBookGrants, #tokenPermissionGrants")) {
    fieldset.hidden = instanceAdmin;
    fieldset.disabled = instanceAdmin;
  }
}

function ignoreAbort(error) {
  if (error?.name !== "AbortError") toast(error.message);
}

function renderBooks() {
  const activeBooks = state.books.filter((book) => book.status !== "archived");
  document.querySelector("#bookSelector").innerHTML = activeBooks.length
    ? activeBooks.map((book) => option(book.id, state.bookId, `${book.title ?? book.id} · ${statusLabels[book.status] ?? book.status ?? "Kladde"}`)).join("")
    : '<option value="" selected disabled>Ingen aktive bøger</option>';
  document.querySelector("#bookGrid").innerHTML = state.books.map((book) => {
    const active = book.id === state.bookId ? " active" : "";
    const revision = book.activeRevisionId ? `Aktiv revision ${book.activeRevisionId}` : "Intet publiceret bundle";
    const archive = book.status !== "archived" && book.id === state.bookId && can("books:settings") ? '<button class="quiet-danger" data-action="archive-book">Arkivér</button>' : "";
    const select = book.status !== "archived" ? '<button class="secondary" data-action="select-book">Administrér</button>' : "";
    return `<article class="book-card${active}" data-book-id="${escapeHtml(book.id)}">
      <span>${escapeHtml(statusLabels[book.status] ?? book.status ?? "Kladde")}</span>
      <h3>${escapeHtml(book.title ?? book.id)}</h3><p>${escapeHtml(book.subtitle ?? revision)}</p>
      <small>${escapeHtml(revision)}</small><div class="row-actions">
        ${select}${archive}
      </div>
    </article>`;
  }).join("") || '<p class="empty-library">Biblioteket er tomt. Opret den første bog ovenfor.</p>';
  document.querySelector("#tokenBookGrid").innerHTML = state.books.filter((book) => book.status !== "archived").map((book) => `<label><input type="checkbox" name="tokenBook" value="${escapeHtml(book.id)}"${book.id === state.bookId ? " checked" : ""}>${escapeHtml(book.title ?? book.id)}</label>`).join("");
  updateTokenGrantAvailability();
}

function renderAccess(policy) {
  const resolved = { ...(state.metadata?.accessProfiles?.[policy?.preset] ?? fallbackProfiles[policy?.preset] ?? {}), ...policy };
  document.querySelector("#accessPreset").textContent = presetLabels[resolved.preset] ?? resolved.preset ?? "Ikke konfigureret";
  document.querySelector("#accessSummary").textContent = `Læsning: ${resolved.reading ?? "—"} · annotation: ${resolved.annotationCreate ?? "—"} · survey: ${resolved.surveyResponse ?? "—"} · tilmelding: ${resolved.enrollment ?? resolved.registration ?? "—"}`;
  document.querySelector("#accessProfile").value = resolved.preset ?? "privateReview";
  document.querySelector("#enrollmentMode").value = resolved.registration ?? "closed";
  document.querySelector("#capabilityPreview").innerHTML = Object.entries(capabilityLabels).map(([field, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(resolved[field] ?? "—")}</dd></div>`).join("");
  document.querySelector("#shareWarning").textContent = resolved.localBypass ? "Kun til lokal brug." : resolved.reading === "public" ? "Linket kan åbne bogen uden invitation." : "Linket kræver en bogspecifik adgang.";
}

function renderRevisions(revisions) {
  document.querySelector("#revisionsTable").innerHTML = revisions.map((revision) => {
    const status = revision.state ?? revision.status ?? revision.validation?.status ?? "staged";
    const details = revision.validation?.errors?.length ? `${revision.validation.errors.length} fejl` : revision.validation?.warnings?.length ? `${revision.validation.warnings.length} advarsler` : statusLabels[status] ?? status;
    const active = revision.id === state.book?.activeRevisionId;
    const action = status === "ready" && !active && can("books:publish")
      ? `<button class="secondary" data-action="publish-revision" data-id="${escapeHtml(revision.id)}">Publicér</button>`
      : active ? "Aktiv" : "";
    return `<tr><td><strong>${escapeHtml(revision.id)}</strong><small>${active ? "Aktiv" : escapeHtml(statusLabels[status] ?? status)}</small></td><td>${escapeHtml(revision.filename ?? revision.bundleHash ?? "—")}</td><td>${escapeHtml(details)}</td><td>${formatDate(revision.createdAt)}</td><td>${action}</td></tr>`;
  }).join("") || emptyRow(5, "Der er endnu ingen revisioner.");
}

function renderUsers(users) {
  document.querySelector("#usersTable").innerHTML = users.map((entry) => {
    const user = entry.user ?? entry;
    const membership = entry.membership ?? user.membership ?? entry;
    const role = membership.bookRole ?? membership.role ?? "";
    const globalRole = isInstanceAdmin()
      ? `<select data-field="globalRole" aria-label="Global rolle for ${escapeHtml(user.displayName)}">${option("user", user.globalRole, "Bruger")}${option("instance_admin", user.globalRole, "Administrator")}</select>`
      : escapeHtml(user.globalRole === "instance_admin" ? "Administrator" : "Bruger");
    const status = isInstanceAdmin()
      ? `<select data-field="status" aria-label="Kontostatus for ${escapeHtml(user.displayName)}">${option("active", user.status, "Aktiv")}${option("disabled", user.status, "Deaktiveret")}</select>`
      : escapeHtml(user.status === "disabled" ? "Deaktiveret" : "Aktiv");
    const reset = isInstanceAdmin() ? '<button class="secondary" data-action="show-password-reset">Nyt password</button>' : "";
    const resetForm = isInstanceAdmin() ? '<div class="password-reset" hidden><input data-field="newPassword" type="password" minlength="10" placeholder="Mindst 10 tegn" aria-label="Nyt password"><button data-action="reset-password">Nulstil</button></div>' : "";
    return `<tr data-user-id="${escapeHtml(user.id)}" data-original-global-role="${escapeHtml(user.globalRole)}"
      data-original-status="${escapeHtml(user.status)}" data-original-book-role="${escapeHtml(role)}">
      <td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)}</small>
        ${user.phone ? `<small>Telefon registreret · ${escapeHtml(user.phonePurpose ?? "formål ikke vist")}</small>` : ""}
      </td><td>${globalRole}</td><td>
        <select data-field="bookRole" aria-label="Bogrolle for ${escapeHtml(user.displayName)}">
          ${option("", role, "Ingen")}${option("reader", role, "Læser")}${option("reviewer", role, "Prøvelæser")}
          ${option("editor", role, "Redaktør")}${option("publisher", role, "Udgiver")}${option("book_admin", role, "Bogadministrator")}
        </select>
      </td><td>${status}</td><td><div class="row-actions">
        <button class="secondary" data-action="save-user">Gem</button>${reset}
      </div>${resetForm}</td>
    </tr>`;
  }).join("") || emptyRow(5, "Ingen brugere har adgang til denne bog.");
}

function renderTokens(tokens) {
  renderTokenTable(tokens, { activeBookId: state.bookId, instanceAdmin: isInstanceAdmin() });
}

function renderAnnotations(annotations) {
  state.annotations = annotations;
  const filters = formObject(document.querySelector("#annotationFilters"));
  const query = String(filters.query ?? "").trim().toLocaleLowerCase();
  const visible = annotations.filter((note) => (!filters.status || note.status === filters.status) && (!filters.category || note.category === filters.category) && (!query || `${note.comment} ${note.target?.label} ${note.target?.scopeId} ${note.author?.displayName}`.toLocaleLowerCase().includes(query)));
  document.querySelector("#annotationsTable").innerHTML = visible.map((note) => {
    const target = escapeHtml(note.target?.label || note.target?.scopeId || `Side ${note.target?.pageNumber}`);
    const orphaned = note.anchorState === "orphaned" ? " · uforankret" : "";
    const statusOptions = option("open", note.status, "Åben") + option("accepted", note.status, "Accepteret") + option("rejected", note.status, "Afvist") + option("resolved", note.status, "Løst");
    const categoryOptions = option("general", note.category, "Generel") + option("language", note.category, "Sprog") + option("structure", note.category, "Struktur") + option("fact", note.category, "Fakta") + option("design", note.category, "Design");
    const triage = can("annotations:moderate")
      ? `<select data-field="annotationStatus" aria-label="Status">${statusOptions}</select>
        <select data-field="annotationCategory" aria-label="Kategori">${categoryOptions}</select>
        <button class="secondary" data-action="save-annotation">Gem</button>`
      : `${escapeHtml(statusLabels[note.status] ?? note.status)}<small>${escapeHtml(note.category ?? "general")}</small>`;
    return `<tr data-annotation-id="${escapeHtml(note.id)}">
      <td>${escapeHtml(note.author?.displayName ?? "Ukendt")}</td>
      <td><a href="${readerPath()}?annotation=${encodeURIComponent(note.id)}">${target}</a>
        <small>Side ${note.target?.pageNumber ?? "—"} · ${escapeHtml(note.type)}${orphaned}</small>
      </td><td>${escapeHtml(note.comment)}</td><td>${triage}</td><td>${formatDate(note.updatedAt)}</td>
    </tr>`;
  }).join("") || emptyRow(5, annotations.length ? "Ingen annotationer matcher filtrene." : "Der er endnu ingen annotationer.");
}

function surveyDefinition(survey) { return survey.draft?.definition ?? survey.published?.definition ?? null; }

function questionEditor(question = {}, index = 0) {
  const type = question.type ?? "rating";
  const options = (question.options ?? [{ id: "structure", label: "Struktur" }, { id: "language", label: "Sprog" }, { id: "nothing", label: "Intet" }]).map((item) => `${item.id}: ${item.label}`).join("\n");
  return `<fieldset class="survey-question-editor" data-question-index="${index}">
    <legend>Spørgsmål ${index + 1}</legend>
    <input data-question="id" value="${escapeHtml(question.id ?? `question-${index + 1}`)}" placeholder="Stabilt id" aria-label="Stabilt spørgsmåls-id" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]*">
    <select data-question="type" aria-label="Spørgsmålstype">${option("rating", type, "1–5 rating")}${option("singleChoice", type, "Ét valg")}${option("shortText", type, "Kort tekst")}${option("longText", type, "Lang tekst")}</select>
    <input class="question-prompt" data-question="prompt" value="${escapeHtml(question.prompt ?? "")}" placeholder="Ét præcist spørgsmål" aria-label="Spørgsmål" required>
    <input data-question="helpText" value="${escapeHtml(question.helpText ?? "")}" placeholder="Hjælpetekst (valgfri)" aria-label="Hjælpetekst (valgfri)">
    <label class="question-required"><input data-question="required" type="checkbox"${question.required === false ? "" : " checked"}> Krævet</label>
    <div class="question-rating-fields"${type === "rating" ? "" : " hidden"}><input data-question="minLabel" value="${escapeHtml(question.scale?.minLabel ?? "Svært")}" placeholder="Label ved 1" aria-label="Label ved laveste rating"><input data-question="maxLabel" value="${escapeHtml(question.scale?.maxLabel ?? "Let")}" placeholder="Label ved 5" aria-label="Label ved højeste rating"></div>
    <textarea class="question-choice-fields" data-question="options" rows="3" placeholder="id: Svarmulighed — én per linje" aria-label="Svarmuligheder, én per linje"${type === "singleChoice" ? "" : " hidden"}>${escapeHtml(options)}</textarea>
    <input class="question-text-fields" data-question="maxLength" type="number" min="1" max="4000" value="${question.maxLength ?? (type === "shortText" ? 300 : 2000)}" aria-label="Maksimal tekstlængde"${type === "shortText" || type === "longText" ? "" : " hidden"}>
    <button class="secondary" type="button" data-action="remove-survey-question">Fjern</button>
  </fieldset>`;
}

function renderQuestionBuilder(questions = []) {
  const normalized = questions.length ? questions : [{ id: "clarity", type: "rating", prompt: "Hvor let var dette afsnit at forstå?", required: true, scale: { min: 1, max: 5, minLabel: "Meget svært", maxLabel: "Meget let" } }];
  document.querySelector("#surveyQuestionBuilder").innerHTML = normalized.map(questionEditor).join("");
}

function readSurveyDefinition(form) {
  const input = formObject(form);
  const questions = [...document.querySelectorAll(".survey-question-editor")].map((row) => {
    const get = (field) => row.querySelector(`[data-question=${field}]`);
    const type = get("type").value;
    const question = { id: get("id").value, type, prompt: get("prompt").value, helpText: get("helpText").value, required: get("required").checked };
    if (type === "rating") question.scale = { min: 1, max: 5, minLabel: get("minLabel").value, maxLabel: get("maxLabel").value };
    if (type === "singleChoice") question.options = get("options").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [id, ...label] = line.split(":"); return { id: id.trim(), label: label.join(":").trim() }; });
    if (type === "shortText" || type === "longText") question.maxLength = Number(get("maxLength").value);
    return question;
  });
  return { schemaVersion: 1, title: input.title, description: input.description ?? "", target: { kind: input.targetKind, anchorId: input.anchorId, pageNumberHint: input.pageNumberHint ? Number(input.pageNumberHint) : undefined, label: input.targetLabel ?? "" }, trigger: { mode: input.triggerMode }, questions };
}

function resetSurveyBuilder() {
  state.editingSurveyId = null;
  document.querySelector("#surveyBuilderForm").reset();
  renderQuestionBuilder();
  document.querySelector("#saveSurveyDraft").textContent = "Opret kladde";
  document.querySelector("#cancelSurveyEdit").hidden = true;
}

function editSurvey(survey) {
  const definition = surveyDefinition(survey);
  if (!definition) return;
  state.editingSurveyId = survey.id;
  const form = document.querySelector("#surveyBuilderForm");
  for (const [name, value] of Object.entries({ title: definition.title, description: definition.description, targetKind: definition.target.kind, anchorId: definition.target.anchorId, pageNumberHint: definition.target.pageNumberHint ?? "", targetLabel: definition.target.label, triggerMode: definition.trigger.mode })) {
    if (form.elements[name]) form.elements[name].value = value ?? "";
  }
  renderQuestionBuilder(definition.questions);
  document.querySelector("#saveSurveyDraft").textContent = "Gem kladde";
  document.querySelector("#cancelSurveyEdit").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSurveys(surveys, responses) {
  state.surveys = surveys; state.surveyResponses = responses;
  document.querySelector("#surveysTable").innerHTML = surveys.map((survey) => {
    const definition = surveyDefinition(survey); const surveyResponses = responses.filter((response) => response.surveyId === survey.id);
    const ratings = surveyResponses.flatMap((response) => response.answers.filter((answer) => typeof answer.value === "number").map((answer) => answer.value));
    const average = ratings.length ? ` · rating ${(ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)}` : "";
    const actions = [
      survey.status !== "closed" ? `<button class="secondary" data-action="edit-survey" data-id="${escapeHtml(survey.id)}">Redigér</button>` : "",
      survey.draft ? `<button class="secondary" data-action="publish-survey" data-id="${escapeHtml(survey.id)}">Publicér kladde</button>` : "",
      survey.status === "published" ? `<button class="secondary" data-action="close-survey" data-id="${escapeHtml(survey.id)}">Luk</button>` : "",
    ].join("");
    return `<tr><td><strong>${escapeHtml(definition?.title ?? survey.id)}</strong>
      <small>v${survey.publishedVersion ?? "—"}${survey.draftVersion ? ` · kladde v${survey.draftVersion}` : ""}</small></td>
      <td>${escapeHtml(definition?.target?.label || definition?.target?.anchorId || "—")}
        <small>${escapeHtml(definition?.target?.kind ?? "")}${definition?.target?.pageNumberHint ? ` · side ${definition.target.pageNumberHint}` : ""}</small>
      </td><td>${escapeHtml(statusLabels[survey.status] ?? survey.status)}</td>
      <td>${surveyResponses.length}${average}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join("") || emptyRow(5, "Der er endnu ingen surveys.");

  document.querySelector("#surveyResponsesTable").innerHTML = responses.map((response) => {
    const survey = surveys.find((candidate) => candidate.id === response.surveyId);
    const version = survey?.versions?.find((candidate) => candidate.version === response.surveyVersion);
    const questions = new Map((version?.definition?.questions ?? []).map((question) => [question.id, question.prompt]));
    const answers = response.answers.map((answer) => `<strong>${escapeHtml(questions.get(answer.questionId) ?? answer.questionId)}</strong>: ${escapeHtml(answer.value)}`).join("<br>");
    return `<tr>
      <td>${escapeHtml(response.respondent?.displayName ?? response.respondent?.ref ?? "Anonymiseret")}</td>
      <td>${escapeHtml(version?.definition?.title ?? response.surveyId)}<small>v${response.surveyVersion}</small></td>
      <td>${answers}</td><td>${escapeHtml(response.revisionId)}
        <small>${escapeHtml(response.target?.anchorId ?? "")}</small>
      </td><td>${formatDate(response.updatedAt)}</td>
    </tr>`;
  }).join("") || emptyRow(5, "Der er endnu ingen surveybesvarelser.");
}

function renderMetadataControls() {
  state.metadata.accessProfiles ??= fallbackProfiles;
  const presets = state.metadata.accessPresets ?? Object.keys(state.metadata.accessProfiles);
  document.querySelector("#accessProfile").innerHTML = presets.map((preset) => option(preset, "", presetLabels[preset] ?? preset)).join("");
  const permissions = state.metadata.permissions ?? fallbackPermissions;
  document.querySelector("#scopeGrid").innerHTML = permissions.map((permission) => `<label><input type="checkbox" name="scope" value="${escapeHtml(permission)}">${escapeHtml(permission)}</label>`).join("");
}

async function loadMetadata(signal) {
  if (state.metadata.loaded || (!can("access:manage") && !can("tokens:manage"))) return;
  try {
    const metadataPath = state.bookId ? `/api/admin/metadata?bookId=${encodeURIComponent(state.bookId)}` : "/api/admin/metadata";
    state.metadata = { ...state.metadata, ...await api(metadataPath, { signal }), loaded: true };
    renderMetadataControls();
  } catch (error) {
    if (error.name === "AbortError") throw error;
    toast(`Metadata kunne ikke opdateres: ${error.message}`);
  }
}

async function featureApi(allowed, path, fallback, signal, label) {
  if (!allowed) return fallback;
  try { return await optionalApi(path, fallback, { signal }); }
  catch (error) {
    if (error.name === "AbortError") throw error;
    toast(`${label} kunne ikke indlæses: ${error.message}`);
    return fallback;
  }
}

async function refreshLibrary(preferredBookId) {
  const payload = await api("/api/admin/books");
  state.books = list(payload, "books");
  const requested = preferredBookId ?? new URL(location.href).searchParams.get("book");
  state.bookId = selectActiveBookId(state.books, requested);
  state.book = state.books.find((book) => book.id === state.bookId) ?? null;
  renderBooks();
  updateBookNavigationAvailability();
  document.querySelector("#bookWorkspace").hidden = !state.bookId;
  if (state.bookId) await loadBook(state.bookId);
  else {
    const url = new URL(location.href);
    url.searchParams.delete("book");
    history.replaceState(null, "", url);
    document.querySelector("#pageTitle").textContent = "Bogbibliotek";
    document.querySelector("#bookTitle").textContent = "Bogbibliotek";
    document.querySelector("#bookMark").textContent = "PB";
    document.querySelector("#readerLink").href = "/";
    applyPermissionVisibility();
    await loadMetadata();
    if (isInstanceAdmin()) renderTokens(list(await api("/api/admin/tokens"), "tokens"));
  }
}

async function loadBook(bookId) {
  state.bookLoadController?.abort();
  const controller = new AbortController();
  const generation = ++state.loadGeneration;
  state.bookLoadController = controller;
  const workspace = document.querySelector("#bookWorkspace");
  workspace.hidden = false;
  workspace.setAttribute("aria-busy", "true");
  workspace.inert = true;
  state.loadingBook = true;
  updateBookNavigationBusy();
  state.bookId = bookId;
  state.book = state.books.find((book) => book.id === bookId) ?? { id: bookId, title: bookId };
  const path = (segment = "") => bookPath(segment, bookId);
  const url = new URL(location.href); url.searchParams.set("book", bookId); history.replaceState(null, "", url);
  renderBooks();
  try {
    const bookDetails = await api(path(), { signal: controller.signal });
    if (generation !== state.loadGeneration) return;
    state.book = bookDetails.book ?? bookDetails;
    state.session = bookDetails.session ?? state.session;
    state.permissions = permissionsFromSession(state.session);
    applyPermissionVisibility();
    renderBooks();
    await loadMetadata(controller.signal);

    document.querySelector("#pageTitle").textContent = state.book.title ?? state.book.id;
    document.querySelector("#bookTitle").textContent = state.book.title ?? "Bogbibliotek";
    document.querySelector("#bookMark").textContent = String(state.book.title ?? "B").slice(0, 2).toUpperCase();
    document.querySelector("#readerLink").href = readerPath();
    document.querySelector("#readerUrl").textContent = `${location.origin}${readerPath()}`;
    document.querySelector("#bookSlug").value = state.book.slug ?? "";
    for (const link of document.querySelectorAll("[data-export-format]")) link.href = `${path("annotations/export")}?format=${link.dataset.exportFormat}`;
    document.querySelector("#reviewExportLink").href = path("review-export");

    const [overview, revisions, members, invitations, codes, tokens, annotations, progress, audit, surveys, surveyResponses, outline] = await Promise.all([
      featureApi(can("users:read") && can("annotations:read:all"), path("overview"), {}, controller.signal, "Overblik"),
      featureApi(can("books:upload") || can("books:publish"), path("revisions"), { revisions: [] }, controller.signal, "Revisioner"),
      featureApi(can("users:read"), path("members"), { members: [] }, controller.signal, "Brugere"),
      featureApi(can("users:read"), path("invitations"), { invitations: [] }, controller.signal, "Invitationer"),
      featureApi(can("users:read"), path("access-codes"), { accessCodes: [] }, controller.signal, "Adgangskoder"),
      featureApi(can("tokens:manage"), tokenListPath(), { tokens: [] }, controller.signal, "Tokens"),
      featureApi(can("annotations:read:all"), path("annotations"), { annotations: [] }, controller.signal, "Annotationer"),
      featureApi(can("progress:read:all"), path("progress"), { progress: [] }, controller.signal, "Læsestatus"),
      featureApi(can("audit:read"), path("audit"), { events: [] }, controller.signal, "Auditlog"),
      featureApi(can("surveys:manage"), path("surveys"), { surveys: [] }, controller.signal, "Surveys"),
      featureApi(can("surveys:responses:read"), path("survey-responses"), { responses: [] }, controller.signal, "Surveybesvarelser"),
      // A draft book has no document to derive anchors from yet. Avoid a noisy
      // 503 in the browser until its first validated revision is published.
      featureApi(can("surveys:manage") && Boolean(state.book.activeRevisionId), path("outline"), { items: [] }, controller.signal, "Bogankre"),
    ]);
    if (generation !== state.loadGeneration) return;
    if (!document.querySelector("#sharing").hidden) renderAccess(bookDetails.access ?? state.book.access ?? { preset: "privateReview", registration: "inviteOnly" });
    document.querySelector("#metrics").innerHTML = [[overview.members ?? overview.users ?? 0, "Prøvelæsere"], [overview.annotations ?? 0, "Annotationer"], [overview.openAnnotations ?? 0, "Åbne noter"], [list(revisions, "revisions").length, "Revisioner"]].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
    document.querySelector("#metrics").removeAttribute("aria-busy");
    renderRevisions(list(revisions, "revisions")); renderUsers(list(members, "members")); renderInvitations(list(invitations, "invitations"));
    renderAccessCodes(list(codes, "accessCodes")); renderTokens(list(tokens, "tokens")); renderAnnotations(list(annotations, "annotations")); renderProgress(list(progress, "progress")); renderAudit(list(audit, "events"));
    state.outline = list(outline, "items");
    document.querySelector("#anchorOptions").innerHTML = state.outline.map((item) => `<option value="${escapeHtml(item.anchorId)}">${escapeHtml(item.label || item.title || item.anchorId)}</option>`).join("");
    renderSurveys(list(surveys, "surveys"), list(surveyResponses, "responses"));
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    if (generation === state.loadGeneration) {
      workspace.removeAttribute("aria-busy");
      workspace.inert = false;
      state.loadingBook = false;
      updateBookNavigationBusy();
    }
  }
}

async function load() {
  const config = await api("/api/config");
  state.session = config.session;
  state.permissions = permissionsFromSession(state.session);
  state.metadata = { accessProfiles: fallbackProfiles, accessPresets: Object.keys(fallbackProfiles), permissions: fallbackPermissions, loaded: false };
  renderMetadataControls();
  renderQuestionBuilder();
  document.querySelector("#adminName").textContent = config.session.principal?.displayName ?? "Administrator";
  if (!hasAdminAccess()) {
    document.querySelector("#workspace").hidden = true;
    document.querySelector("#locked").hidden = false;
    document.querySelector(".sidebar").classList.add("is-locked");
    return;
  }
  applyPermissionVisibility();
  document.querySelector("#workspace").hidden = false;
  document.querySelector("#account").hidden = config.session.principal?.kind !== "user";
  await refreshLibrary();
}

document.querySelector("#bookSelector").addEventListener("change", (event) => loadBook(event.currentTarget.value).catch(ignoreAbort));
document.querySelector(".sidebar nav").addEventListener("click", (event) => {
  const link = event.target.closest("[data-requires-active-book]");
  if (!link || state.bookId) return;
  event.preventDefault();
  const url = new URL(location.href);
  url.hash = "library";
  history.replaceState(null, "", url);
  document.querySelector("#library").scrollIntoView();
  document.querySelector("#createBookForm [name=title]")?.focus();
  toast("Opret eller vælg en aktiv bog for at bruge dette område.");
});
document.querySelector("#createBookForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setFormBusy(form, true);
  try { const payload = await api("/api/admin/books", { method: "POST", json: formObject(form) }); form.reset(); form.slug.dataset.edited = "false"; await refreshLibrary(payload.book?.id); toast("Bogen er oprettet som kladde."); } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
const createBookTitle = document.querySelector("#createBookForm [name=title]");
const createBookSlug = document.querySelector("#createBookForm [name=slug]");
createBookTitle.addEventListener("input", () => {
  if (createBookSlug.dataset.edited !== "true") createBookSlug.value = suggestedSlug(createBookTitle.value);
});
createBookSlug.addEventListener("input", () => { createBookSlug.dataset.edited = "true"; });
document.querySelector("#bookLinkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const bookId = state.bookId;
  setFormBusy(form, true);
  try {
    const payload = await api(bookPath("", bookId), { method: "PATCH", json: formObject(form) });
    if (state.bookId !== bookId) return;
    state.book = payload.book ?? payload;
    state.books = state.books.map((book) => book.id === bookId ? { ...book, ...state.book } : book);
    renderBooks();
    document.querySelector("#readerLink").href = readerPath();
    document.querySelector("#readerUrl").textContent = `${location.origin}${readerPath()}`;
    toast("Boglinket er opdateret. Gamle links viderestilles fortsat.");
  } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.bundle.files[0];
  const bookId = state.bookId;
  if (!file?.name.endsWith(".tar.gz")) return toast("Vælg et .tar.gz-bundle.");
  setFormBusy(form, true);
  const progress = document.querySelector("#uploadProgress"); const status = document.querySelector("#uploadStatus");
  try {
    progress.hidden = false; progress.value = 10; status.textContent = "Opretter sikker upload …";
    const created = await api(bookPath("uploads", bookId), { method: "POST", json: { filename: file.name, contentType: "application/gzip", sizeBytes: file.size } });
    const upload = created.upload ?? created; progress.value = 30; status.textContent = "Uploader bundle …";
    await api(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: file });
    progress.value = 75; status.textContent = "Validerer manifest, filer og ankre …";
    await api(`${bookPath("uploads", bookId)}/${encodeURIComponent(upload.id)}/validate`, { method: "POST", json: {} });
    progress.value = 100; status.textContent = "Upload valideret. Publicér den nye revision, når du er klar.";
    const revisions = await api(bookPath("revisions", bookId));
    if (state.bookId === bookId) renderRevisions(list(revisions, "revisions"));
    form.reset();
  } catch (error) { status.textContent = error.message; toast(error.message); } finally { setFormBusy(form, false); setTimeout(() => { progress.hidden = true; }, 1200); }
});
function previewSelectedAccess() {
  const preset = document.querySelector("#accessProfile").value;
  renderAccess({ preset, ...state.metadata.accessProfiles[preset], registration: document.querySelector("#enrollmentMode").value });
}
document.querySelector("#accessProfile").addEventListener("change", previewSelectedAccess);
document.querySelector("#enrollmentMode").addEventListener("change", previewSelectedAccess);
document.querySelector("#accessForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const errorNode = document.querySelector("#accessError"); errorNode.hidden = true;
  setFormBusy(form, true);
  try { const payload = await api(bookPath("access"), { method: "PUT", json: formObject(form) }); renderAccess(payload.access ?? payload); toast("Bogens adgang er gemt."); } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
  finally { setFormBusy(form, false); }
});
document.querySelector("#createUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const bookId = state.bookId;
  const input = { ...formObject(form), bookId };
  if (input.phone && !input.phonePurpose) return toast("Angiv formålet, hvis du gemmer telefonnummeret.");
  setFormBusy(form, true);
  try { await api("/api/admin/users", { method: "POST", json: input }); form.reset(); const members = await api(bookPath("members", bookId)); if (state.bookId === bookId) renderUsers(list(members, "members")); toast("Brugeren er oprettet og har fået bogadgang."); } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const bookId = state.bookId;
  const book = state.book;
  setFormBusy(form, true);
  try {
    const payload = await api(bookPath("invitations", bookId), { method: "POST", json: formObject(form) });
    const invitation = payload.invitation ?? payload;
    state.invitationUrl = `${location.origin}${readerPath(book)}?invite=${encodeURIComponent(invitation.secret)}`;
    document.querySelector("#invitationSecret").textContent = state.invitationUrl;
    document.querySelector("#invitationOutput").hidden = false;
    if (can("users:read")) { const invitations = await api(bookPath("invitations", bookId)); if (state.bookId === bookId) renderInvitations(list(invitations, "invitations")); }
  } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("#accessCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setFormBusy(form, true);
  try {
    const payload = await api(bookPath("access-codes"), { method: "POST", json: formObject(form) });
    const code = payload.accessCode ?? payload.code ?? payload;
    state.accessCode = code.secret;
    const output = document.querySelector("#accessCodeOutput");
    output.textContent = `Kopiér nu — koden vises ikke igen: ${code.secret}`;
    output.hidden = false;
    if (can("users:read")) renderAccessCodes(list(await api(bookPath("access-codes")), "accessCodes"));
  } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("#tokenForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const input = { ...formObject(form), bookIds: [...form.querySelectorAll("[name=tokenBook]:checked")].map((node) => node.value), scopes: [...form.querySelectorAll("[name=scope]:checked")].map((node) => node.value) };
  if (!input.instanceAdmin && (!input.bookIds.length || !input.scopes.length)) return toast("Vælg mindst én bog og én permission.");
  setFormBusy(form, true);
  try { const payload = await api("/api/admin/tokens", { method: "POST", json: input }); const token = payload.token ?? payload; const output = document.querySelector("#tokenOutput"); output.textContent = `Kopiér nu — tokenet vises ikke igen: ${token.secret}`; output.hidden = false; renderTokens(list(await api(tokenListPath()), "tokens")); } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("[name=instanceAdmin]").addEventListener("change", updateTokenGrantAvailability);
document.querySelector("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setFormBusy(form, true);
  try {
    await api("/api/auth/password", { method: "POST", json: formObject(form) });
    toast("Passwordet er ændret. Log ind igen.");
    setTimeout(() => location.assign("/"), 800);
  } catch (error) {
    toast(error.message);
    setFormBusy(form, false);
  }
});
document.querySelector("#annotationFilters").addEventListener("input", () => renderAnnotations(state.annotations));
document.querySelector("#addSurveyQuestion").addEventListener("click", () => {
  const rows = document.querySelectorAll(".survey-question-editor");
  if (rows.length >= 5) return toast("V1 understøtter højst fem spørgsmål.");
  document.querySelector("#surveyQuestionBuilder").insertAdjacentHTML("beforeend", questionEditor({}, rows.length));
});
document.querySelector("#cancelSurveyEdit").addEventListener("click", resetSurveyBuilder);
document.querySelector("#surveyQuestionBuilder").addEventListener("change", (event) => {
  const select = event.target.closest("[data-question=type]");
  if (!select) return;
  const row = select.closest(".survey-question-editor");
  row.querySelector(".question-rating-fields").hidden = select.value !== "rating";
  row.querySelector(".question-choice-fields").hidden = select.value !== "singleChoice";
  row.querySelector(".question-text-fields").hidden = !["shortText", "longText"].includes(select.value);
  row.querySelector("[data-question=maxLength]").value = select.value === "shortText" ? 300 : 2000;
});
document.querySelector("#surveyBuilderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const bookId = state.bookId;
  const editingSurveyId = state.editingSurveyId;
  setFormBusy(form, true);
  try {
    const definition = readSurveyDefinition(form);
    const path = editingSurveyId ? `${bookPath("surveys", bookId)}/${encodeURIComponent(editingSurveyId)}` : bookPath("surveys", bookId);
    await api(path, { method: editingSurveyId ? "PUT" : "POST", json: definition });
    const payload = await api(bookPath("surveys", bookId));
    if (state.bookId === bookId) { renderSurveys(list(payload, "surveys"), state.surveyResponses); resetSurveyBuilder(); }
    toast("Surveykladden er gemt.");
  } catch (error) { toast(error.message); }
  finally { setFormBusy(form, false); }
});
document.querySelector("#includeProgressExport").addEventListener("change", (event) => {
  document.querySelector("#reviewExportLink").href = `${bookPath("review-export")}?includeProgress=${event.currentTarget.checked}`;
});
document.querySelectorAll("[data-token-preset]").forEach((button) => button.addEventListener("click", () => {
  const presets = {
    "reader-agent": ["books:read", "progress:read:self", "surveys:respond"],
    "review-agent": ["books:read", "annotations:read", "annotations:write", "annotations:export", "surveys:respond"],
    "survey-admin": ["books:read", "annotations:read", "annotations:read:all", "annotations:export", "surveys:manage", "surveys:responses:read", "surveys:export"],
  };
  const selected = new Set(presets[button.dataset.tokenPreset] ?? []);
  document.querySelectorAll("#scopeGrid [name=scope]").forEach((input) => { input.checked = selected.has(input.value); });
  toast("Tokenpreset valgt — gennemgå rettighederne før oprettelse.");
}));

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]"); if (!button) return;
  const actionBookId = state.bookId;
  const tracksBookMutation = button.dataset.action !== "select-book";
  if (tracksBookMutation) { state.busyActions += 1; updateBookNavigationBusy(); }
  button.disabled = true;
  try {
    if (button.dataset.action === "select-book") await loadBook(button.closest("[data-book-id]").dataset.bookId);
    if (button.dataset.action === "archive-book") { const bookId = button.closest("[data-book-id]").dataset.bookId; if (await confirmUiAction("Arkivér bogen? Læsere mister adgang, men data bevares.")) { await api(`/api/admin/books/${encodeURIComponent(bookId)}`, { method: "DELETE" }); await refreshLibrary(); } }
    if (button.dataset.action === "publish-revision") { if (await confirmUiAction("Publicér denne validerede revision for alle læsere?")) { await api(`${bookPath("revisions", actionBookId)}/${encodeURIComponent(button.dataset.id)}/publish`, { method: "POST", json: {} }); await refreshLibrary(actionBookId); toast("Revisionen er publiceret atomisk."); } }
    if (button.dataset.action === "save-user") {
      const row = button.closest("[data-user-id]");
      const bookRole = row.querySelector("[data-field=bookRole]").value;
      if (isInstanceAdmin()) {
        const globalRole = row.querySelector("[data-field=globalRole]").value;
        const status = row.querySelector("[data-field=status]").value;
        if (globalRole !== row.dataset.originalGlobalRole || status !== row.dataset.originalStatus) {
          await api(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}`, { method: "PATCH", json: { globalRole, status } });
        }
      }
      if (bookRole !== row.dataset.originalBookRole) {
        await api(`${bookPath("members", actionBookId)}/${encodeURIComponent(row.dataset.userId)}`, { method: "PUT", json: { role: bookRole || null } });
      }
      const members = await api(bookPath("members", actionBookId));
      if (state.bookId === actionBookId) renderUsers(list(members, "members"));
      toast("Brugerens adgang er opdateret.");
    }
    if (button.dataset.action === "show-password-reset") { const reset = button.closest("td").querySelector(".password-reset"); reset.hidden = false; reset.querySelector("input").focus(); }
    if (button.dataset.action === "reset-password") {
      const row = button.closest("[data-user-id]");
      const input = row.querySelector("[data-field=newPassword]");
      if (input.value.length < 10) throw new Error("Det nye password skal være mindst 10 tegn.");
      await api(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}/password`, {
        method: "PUT", json: { newPassword: input.value },
      });
      input.value = "";
      button.closest(".password-reset").hidden = true;
      toast("Password nulstillet; sessioner er lukket.");
    }
    if (button.dataset.action === "save-annotation") {
      const row = button.closest("[data-annotation-id]");
      const changes = {
        status: row.querySelector("[data-field=annotationStatus]").value,
        category: row.querySelector("[data-field=annotationCategory]").value,
      };
      const payload = await api(`${bookPath("annotations")}/${encodeURIComponent(row.dataset.annotationId)}`, {
        method: "PUT", json: changes,
      });
      const updated = payload.annotation ?? payload;
      state.annotations = state.annotations.map((note) => note.id === updated.id ? updated : note);
      renderAnnotations(state.annotations);
      toast("Annotationens triage er gemt.");
    }
    if (button.dataset.action === "copy-reader-link") await copyText(`${location.origin}${readerPath()}`);
    if (button.dataset.action === "copy-invitation-link") await copyText(state.invitationUrl);
    if (button.dataset.action === "revoke-invite" && await confirmUiAction("Tilbagekald invitationen? Linket stopper med at virke med det samme.")) { await api(`${bookPath("invitations")}/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); renderInvitations(list(await api(bookPath("invitations")), "invitations")); }
    if (button.dataset.action === "revoke-code" && await confirmUiAction("Tilbagekald adgangskoden? Den stopper med at virke med det samme.")) { await api(`${bookPath("access-codes")}/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); renderAccessCodes(list(await api(bookPath("access-codes")), "accessCodes")); }
    if (button.dataset.action === "revoke-token" && await confirmUiAction("Tilbagekald tokenet? Agenter, der bruger det, mister adgang med det samme.")) { await api(tokenRevokePath(button.dataset.id), { method: "DELETE" }); renderTokens(list(await api(tokenListPath()), "tokens")); }
    if (button.dataset.action === "remove-survey-question") {
      if (document.querySelectorAll(".survey-question-editor").length <= 1) return toast("En survey skal have mindst ét spørgsmål.");
      button.closest(".survey-question-editor").remove();
    }
    if (button.dataset.action === "edit-survey") editSurvey(state.surveys.find((survey) => survey.id === button.dataset.id));
    if (button.dataset.action === "publish-survey") {
      if (await confirmUiAction("Publicér kladden for bogens aktive revision? Versionen kan ikke ændres bagefter.")) {
        await api(`${bookPath("surveys")}/${encodeURIComponent(button.dataset.id)}/publish`, { method: "POST", json: {} });
        const [surveys, responses] = await Promise.all([api(bookPath("surveys")), api(bookPath("survey-responses"))]);
        renderSurveys(list(surveys, "surveys"), list(responses, "responses"));
        toast("Surveyen er publiceret.");
      }
    }
    if (button.dataset.action === "close-survey") {
      if (await confirmUiAction("Luk surveyen? Eksisterende svar bevares, men nye svar afvises.")) {
        await api(`${bookPath("surveys")}/${encodeURIComponent(button.dataset.id)}/close`, { method: "POST", json: {} });
        renderSurveys(list(await api(bookPath("surveys")), "surveys"), state.surveyResponses);
        toast("Surveyen er lukket.");
      }
    }
  } catch (error) { toast(error.message); }
  finally {
    if (button.isConnected) button.disabled = false;
    if (tracksBookMutation) { state.busyActions -= 1; updateBookNavigationBusy(); }
  }
});

load().catch((error) => {
  if (error.name === "AbortError") return;
  document.querySelector("#workspace").hidden = true;
  document.querySelector("#locked").hidden = false;
  document.querySelector("#locked p").textContent = error.message;
});
