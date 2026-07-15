function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("da-DK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

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

async function optionalApi(path, fallback) {
  try { return await api(path); } catch (error) {
    if (/\(404\)|ikke fundet|not found/i.test(error.message)) return fallback;
    throw error;
  }
}

function formObject(form) {
  return Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
}

function option(value, current, label = value) {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty-cell">${escapeHtml(message)}</td></tr>`; }
function list(payload, key) { return Array.isArray(payload) ? payload : Array.isArray(payload?.[key]) ? payload[key] : Array.isArray(payload?.items) ? payload.items : []; }
function bookPath(segment = "") { return `/api/admin/books/${encodeURIComponent(state.bookId)}${segment ? `/${segment}` : ""}`; }
function readerPath(book = state.book) { return `/books/${encodeURIComponent(book?.slug ?? book?.id ?? state.bookId)}`; }

function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
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
  local: { reading: "local", annotationCreate: "local", annotationView: "own", registration: "closed", progressTracking: "optional", localBypass: true },
  publicRead: { reading: "public", annotationCreate: "none", annotationView: "none", registration: "closed", progressTracking: "optional" },
  publicOpenReview: { reading: "public", annotationCreate: "public", annotationView: "public", registration: "open", progressTracking: "optional" },
  publicMemberReview: { reading: "public", annotationCreate: "member", annotationView: "own", registration: "open", progressTracking: "optional" },
  publicInviteReview: { reading: "public", annotationCreate: "member", annotationView: "reviewGroup", registration: "invite", progressTracking: "optional" },
  privateRead: { reading: "member", annotationCreate: "none", annotationView: "none", registration: "invite", progressTracking: "optional" },
  privateReview: { reading: "member", annotationCreate: "member", annotationView: "reviewGroup", registration: "invite", progressTracking: "optional" },
};
const capabilityLabels = { reading: "Læsning", annotationCreate: "Opret feedback", annotationView: "Se feedback", registration: "Konto", progressTracking: "Læsestatus" };
const fallbackPermissions = ["book:read", "annotations:read", "annotations:write", "annotations:moderate", "annotations:export", "progress:read:self", "progress:read:all", "members:manage", "invitations:manage"];
const state = { books: [], book: null, bookId: null, metadata: null, annotations: [], invitationUrl: "", accessCode: "" };

function renderBooks() {
  document.querySelector("#bookSelector").innerHTML = state.books.map((book) => option(book.id, state.bookId, `${book.title ?? book.id} · ${book.status ?? "draft"}`)).join("");
  document.querySelector("#bookGrid").innerHTML = state.books.map((book) => {
    const active = book.id === state.bookId ? " active" : "";
    const revision = book.activeRevisionId ? `Aktiv revision ${book.activeRevisionId}` : "Intet publiceret bundle";
    return `<article class="book-card${active}" data-book-id="${escapeHtml(book.id)}"><span>${escapeHtml(book.status ?? "draft")}</span><h3>${escapeHtml(book.title ?? book.id)}</h3><p>${escapeHtml(book.subtitle ?? revision)}</p><small>${escapeHtml(revision)}</small><div class="row-actions"><button class="secondary" data-action="select-book">Administrér</button>${book.status === "archived" ? "" : '<button class="quiet-danger" data-action="archive-book">Arkivér</button>'}</div></article>`;
  }).join("") || '<p class="empty-library">Biblioteket er tomt. Opret den første bog ovenfor.</p>';
  document.querySelector("#tokenBookGrid").innerHTML = state.books.filter((book) => book.status !== "archived").map((book) => `<label><input type="checkbox" name="tokenBook" value="${escapeHtml(book.id)}"${book.id === state.bookId ? " checked" : ""}>${escapeHtml(book.title ?? book.id)}</label>`).join("");
}

function renderAccess(policy) {
  const resolved = { ...(state.metadata?.accessProfiles?.[policy?.preset] ?? fallbackProfiles[policy?.preset] ?? {}), ...policy };
  document.querySelector("#accessPreset").textContent = presetLabels[resolved.preset] ?? resolved.preset ?? "Ikke konfigureret";
  document.querySelector("#accessSummary").textContent = `Læsning: ${resolved.reading ?? "—"} · annotation: ${resolved.annotationCreate ?? "—"} · tilmelding: ${resolved.enrollment ?? resolved.registration ?? "—"}`;
  document.querySelector("#accessProfile").value = resolved.preset ?? "privateReview";
  document.querySelector("#enrollmentMode").value = resolved.registration ?? "closed";
  document.querySelector("#capabilityPreview").innerHTML = Object.entries(capabilityLabels).map(([field, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(resolved[field] ?? "—")}</dd></div>`).join("");
  document.querySelector("#shareWarning").textContent = resolved.localBypass ? "Kun til lokal brug." : resolved.reading === "public" ? "Linket kan åbne bogen uden invitation." : "Linket kræver en bogspecifik adgang.";
}

function renderRevisions(revisions) {
  document.querySelector("#revisionsTable").innerHTML = revisions.map((revision) => {
    const status = revision.status ?? revision.validation?.status ?? "staged";
    const details = revision.validation?.errors?.length ? `${revision.validation.errors.length} fejl` : revision.validation?.warnings?.length ? `${revision.validation.warnings.length} advarsler` : status;
    const active = revision.id === state.book?.activeRevisionId;
    const action = status === "ready" && !active ? `<button class="secondary" data-action="publish-revision" data-id="${escapeHtml(revision.id)}">Publicér</button>` : active ? "Aktiv" : "";
    return `<tr><td><strong>${escapeHtml(revision.id)}</strong><small>${active ? "Aktiv" : escapeHtml(status)}</small></td><td>${escapeHtml(revision.filename ?? revision.bundleHash ?? "—")}</td><td>${escapeHtml(details)}</td><td>${formatDate(revision.createdAt)}</td><td>${action}</td></tr>`;
  }).join("") || emptyRow(5, "Der er endnu ingen revisioner.");
}

function renderUsers(users) {
  document.querySelector("#usersTable").innerHTML = users.map((entry) => {
    const user = entry.user ?? entry;
    const membership = entry.membership ?? user.membership ?? entry;
    const role = membership.bookRole ?? membership.role ?? "";
    return `<tr data-user-id="${escapeHtml(user.id)}"><td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)}</small>${user.phone ? `<small>Telefon registreret · ${escapeHtml(user.phonePurpose ?? "formål ikke vist")}</small>` : ""}</td><td><select data-field="globalRole">${option("user", user.globalRole, "Bruger")}${option("instance_admin", user.globalRole, "Administrator")}</select></td><td><select data-field="bookRole">${option("", role, "Ingen")}${option("reader", role, "Læser")}${option("reviewer", role, "Prøvelæser")}${option("editor", role, "Redaktør")}${option("publisher", role, "Udgiver")}${option("book_admin", role, "Bogadministrator")}</select></td><td><select data-field="status">${option("active", user.status, "Aktiv")}${option("disabled", user.status, "Deaktiveret")}</select></td><td><div class="row-actions"><button class="secondary" data-action="save-user">Gem</button><button class="secondary" data-action="show-password-reset">Nyt password</button></div><div class="password-reset" hidden><input data-field="newPassword" type="password" minlength="10" placeholder="Mindst 10 tegn"><button data-action="reset-password">Nulstil</button></div></td></tr>`;
  }).join("") || emptyRow(5, "Ingen brugere har adgang til denne bog.");
}

function renderInvitations(invitations) {
  document.querySelector("#invitationsTable").innerHTML = invitations.map((invite) => {
    const status = invite.acceptedAt ? "Accepteret" : invite.revokedAt ? "Tilbagekaldt" : "Åben";
    const revoke = invite.acceptedAt || invite.revokedAt ? "" : `<button class="secondary" data-action="revoke-invite" data-id="${escapeHtml(invite.id)}">Tilbagekald</button>`;
    return `<tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.role)}</td><td>${formatDate(invite.expiresAt)}</td><td>${status}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, "Der er ingen invitationer til denne bog.");
}

function renderAccessCodes(codes) {
  document.querySelector("#accessCodesTable").innerHTML = codes.map((code) => `<tr><td>${escapeHtml(code.name)}</td><td>${escapeHtml(code.role)}</td><td>${code.useCount ?? 0} / ${code.maxUses ?? "∞"}</td><td>${formatDate(code.expiresAt)}</td><td>${code.revokedAt ? "Tilbagekaldt" : `<button class="secondary" data-action="revoke-code" data-id="${escapeHtml(code.id)}">Tilbagekald</button>`}</td></tr>`).join("") || emptyRow(5, "Der er ingen adgangskoder til denne bog.");
}

function renderTokens(tokens) {
  document.querySelector("#tokensTable").innerHTML = tokens.map((token) => {
    const revoke = token.revokedAt ? "" : `<button class="secondary" data-action="revoke-token" data-id="${escapeHtml(token.id)}">Tilbagekald</button>`;
    const bookGrants = token.bookGrants ?? token.grants ?? [];
    const grants = token.instanceAdmin ? "Instansadministrator" : bookGrants.map((grant) => `${grant.bookId}: ${(grant.permissions ?? []).join(", ")}`).join(" · ") || state.bookId;
    return `<tr><td>${escapeHtml(token.name)}</td><td><code>${escapeHtml(token.prefix)}</code></td><td><small>${escapeHtml(grants)}</small></td><td>${formatDate(token.expiresAt)}${token.revokedAt ? " · tilbagekaldt" : ""}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, "Der er ingen tokens med adgang til denne bog.");
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
    return `<tr data-annotation-id="${escapeHtml(note.id)}"><td>${escapeHtml(note.author?.displayName ?? "Ukendt")}</td><td><a href="${readerPath()}?annotation=${encodeURIComponent(note.id)}">${target}</a><small>Side ${note.target?.pageNumber ?? "—"} · ${escapeHtml(note.type)}${orphaned}</small></td><td>${escapeHtml(note.comment)}</td><td><select data-field="annotationStatus">${statusOptions}</select><select data-field="annotationCategory">${categoryOptions}</select><button class="secondary" data-action="save-annotation">Gem</button></td><td>${formatDate(note.updatedAt)}</td></tr>`;
  }).join("") || emptyRow(5, annotations.length ? "Ingen annotationer matcher filtrene." : "Der er endnu ingen annotationer.");
}

function renderProgress(progress) {
  document.querySelector("#progressTable").innerHTML = progress.map((item) => {
    const pages = item.readPages ?? [];
    const readAnchors = pages.map((page) => escapeHtml(page.anchorId)).join(", ");
    return `<tr><td>${escapeHtml(item.displayName)}<small>${escapeHtml(item.email)}</small></td><td>${escapeHtml(item.anchorId)}<small>Side ${item.pageNumber ?? "—"}</small></td><td>${item.engagedPercent ?? 0}% engageret<small>Seneste position ${item.percent ?? 0}%${item.completedAt ? " · færdig" : ""}</small></td><td>${pages.length}<small>${readAnchors}</small></td><td>${formatDate(item.updatedAt)}</td></tr>`;
  }).join("") || emptyRow(5, "Ingen læsere har delt læsestatus.");
}

function renderAudit(events) {
  document.querySelector("#auditTable").innerHTML = events.map((event) => `<tr><td>${formatDate(event.createdAt)}</td><td>${escapeHtml(event.actorType)}<small>${escapeHtml(event.actorId)}</small></td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.resourceType)}<small>${escapeHtml(event.resourceId ?? "")}</small></td></tr>`).join("") || emptyRow(4, "Auditloggen er tom.");
}

async function refreshLibrary(preferredBookId) {
  const payload = await api("/api/admin/books");
  state.books = list(payload, "books");
  const requested = preferredBookId ?? new URL(location.href).searchParams.get("book");
  state.bookId = state.books.some((book) => book.id === requested) ? requested : state.books.find((book) => book.status !== "archived")?.id ?? state.books[0]?.id ?? null;
  state.book = state.books.find((book) => book.id === state.bookId) ?? null;
  renderBooks();
  document.querySelector("#bookWorkspace").hidden = !state.bookId;
  if (state.bookId) await loadBook(state.bookId);
}

async function loadBook(bookId) {
  state.bookId = bookId;
  state.book = state.books.find((book) => book.id === bookId) ?? await api(bookPath());
  const url = new URL(location.href); url.searchParams.set("book", bookId); history.replaceState(null, "", url);
  renderBooks();
  document.querySelector("#pageTitle").textContent = state.book.title ?? state.book.id;
  document.querySelector("#bookTitle").textContent = state.book.title ?? "Bogbibliotek";
  document.querySelector("#bookMark").textContent = String(state.book.title ?? "B").slice(0, 2).toUpperCase();
  document.querySelector("#readerLink").href = readerPath();
  document.querySelector("#readerUrl").textContent = `${location.origin}${readerPath()}`;
  for (const link of document.querySelectorAll("[data-export-format]")) link.href = `${bookPath("annotations/export")}?format=${link.dataset.exportFormat}`;

  const [bookDetails, overview, revisions, members, invitations, codes, tokens, annotations, progress, audit] = await Promise.all([
    optionalApi(bookPath(), state.book), optionalApi(bookPath("overview"), {}), optionalApi(bookPath("revisions"), { revisions: [] }),
    optionalApi(bookPath("members"), { members: [] }), optionalApi(bookPath("invitations"), { invitations: [] }), optionalApi(bookPath("access-codes"), { accessCodes: [] }),
    optionalApi(bookPath("tokens"), { tokens: [] }), optionalApi(bookPath("annotations"), { annotations: [] }), optionalApi(bookPath("progress"), { progress: [] }), optionalApi(bookPath("audit"), { events: [] }),
  ]);
  state.book = bookDetails.book ?? bookDetails;
  const access = bookDetails.access ?? state.book.access ?? { preset: "privateReview", enrollment: "invite" };
  renderAccess(access);
  document.querySelector("#metrics").innerHTML = [[overview.members ?? overview.users ?? 0, "Prøvelæsere"], [overview.annotations ?? 0, "Annotationer"], [overview.openAnnotations ?? 0, "Åbne noter"], [list(revisions, "revisions").length, "Revisioner"]].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  document.querySelector("#metrics").removeAttribute("aria-busy");
  renderRevisions(list(revisions, "revisions")); renderUsers(list(members, "members")); renderInvitations(list(invitations, "invitations"));
  renderAccessCodes(list(codes, "accessCodes")); renderTokens(list(tokens, "tokens")); renderAnnotations(list(annotations, "annotations")); renderProgress(list(progress, "progress")); renderAudit(list(audit, "events"));
}

async function load() {
  const config = await api("/api/config");
  if (!config.session?.capabilities?.canManageUsers && config.session?.principal?.globalRole !== "instance_admin") {
    document.querySelector("#locked").hidden = false;
    return;
  }
  document.querySelector("#workspace").hidden = false;
  document.querySelector("#adminName").textContent = config.session.principal?.displayName ?? "Administrator";
  document.querySelector("#account").hidden = config.session.principal?.kind !== "user";
  state.metadata = await optionalApi("/api/admin/metadata", { accessProfiles: fallbackProfiles, accessPresets: Object.keys(fallbackProfiles), permissions: fallbackPermissions });
  state.metadata.accessProfiles ??= fallbackProfiles;
  const presets = state.metadata.accessPresets ?? Object.keys(state.metadata.accessProfiles);
  document.querySelector("#accessProfile").innerHTML = presets.map((preset) => option(preset, "", presetLabels[preset] ?? preset)).join("");
  const permissions = state.metadata.permissions ?? fallbackPermissions;
  document.querySelector("#scopeGrid").innerHTML = permissions.map((permission) => `<label><input type="checkbox" name="scope" value="${escapeHtml(permission)}">${escapeHtml(permission)}</label>`).join("");
  await refreshLibrary();
}

document.querySelector("#bookSelector").addEventListener("change", (event) => loadBook(event.currentTarget.value).catch((error) => toast(error.message)));
document.querySelector("#createBookForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { const payload = await api("/api/admin/books", { method: "POST", json: formObject(event.currentTarget) }); event.currentTarget.reset(); await refreshLibrary(payload.book?.id); toast("Bogen er oprettet som kladde."); } catch (error) { toast(error.message); }
});
document.querySelector("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = event.currentTarget.bundle.files[0];
  if (!file?.name.endsWith(".tar.gz")) return toast("Vælg et .tar.gz-bundle.");
  const progress = document.querySelector("#uploadProgress"); const status = document.querySelector("#uploadStatus");
  try {
    progress.hidden = false; progress.value = 10; status.textContent = "Opretter sikker upload …";
    const created = await api(bookPath("uploads"), { method: "POST", json: { filename: file.name, contentType: "application/gzip", sizeBytes: file.size } });
    const upload = created.upload ?? created; progress.value = 30; status.textContent = "Uploader bundle …";
    await api(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: file });
    progress.value = 75; status.textContent = "Validerer manifest, filer og ankre …";
    await api(`${bookPath("uploads")}/${encodeURIComponent(upload.id)}/validate`, { method: "POST", json: {} });
    progress.value = 100; status.textContent = "Upload valideret. Publicér den nye revision, når du er klar.";
    const revisions = await api(bookPath("revisions")); renderRevisions(list(revisions, "revisions")); event.currentTarget.reset();
  } catch (error) { status.textContent = error.message; toast(error.message); } finally { setTimeout(() => { progress.hidden = true; }, 1200); }
});
document.querySelector("#accessProfile").addEventListener("change", (event) => renderAccess({ preset: event.currentTarget.value, ...state.metadata.accessProfiles[event.currentTarget.value], registration: document.querySelector("#enrollmentMode").value }));
document.querySelector("#accessForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const errorNode = document.querySelector("#accessError"); errorNode.hidden = true;
  try { const payload = await api(bookPath("access"), { method: "PUT", json: formObject(event.currentTarget) }); renderAccess(payload.access ?? payload); toast("Bogens adgang er gemt."); } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
});
document.querySelector("#createUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = { ...formObject(event.currentTarget), bookId: state.bookId };
  if (input.phone && !input.phonePurpose) return toast("Angiv formålet, hvis du gemmer telefonnummeret.");
  try { await api("/api/admin/users", { method: "POST", json: input }); event.currentTarget.reset(); renderUsers(list(await api(bookPath("members")), "members")); toast("Brugeren er oprettet og har fået bogadgang."); } catch (error) { toast(error.message); }
});
document.querySelector("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { const payload = await api(bookPath("invitations"), { method: "POST", json: formObject(event.currentTarget) }); const invitation = payload.invitation ?? payload; state.invitationUrl = `${location.origin}${readerPath()}?invite=${encodeURIComponent(invitation.secret)}`; document.querySelector("#invitationSecret").textContent = state.invitationUrl; document.querySelector("#invitationOutput").hidden = false; renderInvitations(list(await api(bookPath("invitations")), "invitations")); } catch (error) { toast(error.message); }
});
document.querySelector("#accessCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { const payload = await api(bookPath("access-codes"), { method: "POST", json: formObject(event.currentTarget) }); const code = payload.accessCode ?? payload.code ?? payload; state.accessCode = code.secret; const output = document.querySelector("#accessCodeOutput"); output.textContent = `Kopiér nu — koden vises ikke igen: ${code.secret}`; output.hidden = false; renderAccessCodes(list(await api(bookPath("access-codes")), "accessCodes")); } catch (error) { toast(error.message); }
});
document.querySelector("#tokenForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = { ...formObject(event.currentTarget), bookIds: [...event.currentTarget.querySelectorAll("[name=tokenBook]:checked")].map((node) => node.value), scopes: [...event.currentTarget.querySelectorAll("[name=scope]:checked")].map((node) => node.value) };
  try { const payload = await api("/api/admin/tokens", { method: "POST", json: input }); const token = payload.token ?? payload; const output = document.querySelector("#tokenOutput"); output.textContent = `Kopiér nu — tokenet vises ikke igen: ${token.secret}`; output.hidden = false; renderTokens(list(await api(bookPath("tokens")), "tokens")); } catch (error) { toast(error.message); }
});
document.querySelector("#passwordForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/auth/password", { method: "POST", json: formObject(event.currentTarget) }); toast("Passwordet er ændret. Log ind igen."); setTimeout(() => location.assign("/"), 800); } catch (error) { toast(error.message); } });
document.querySelector("#annotationFilters").addEventListener("input", () => renderAnnotations(state.annotations));

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]"); if (!button) return;
  try {
    if (button.dataset.action === "select-book") await loadBook(button.closest("[data-book-id]").dataset.bookId);
    if (button.dataset.action === "archive-book") { const bookId = button.closest("[data-book-id]").dataset.bookId; if (confirm("Arkivér bogen? Læsere mister adgang, men data bevares.")) { await api(`/api/admin/books/${encodeURIComponent(bookId)}`, { method: "DELETE" }); await refreshLibrary(); } }
    if (button.dataset.action === "publish-revision") { if (confirm("Publicér denne validerede revision for alle læsere?")) { await api(`${bookPath("revisions")}/${encodeURIComponent(button.dataset.id)}/publish`, { method: "POST", json: {} }); await refreshLibrary(state.bookId); toast("Revisionen er publiceret atomisk."); } }
    if (button.dataset.action === "save-user") { const row = button.closest("[data-user-id]"); const value = (field) => row.querySelector(`[data-field=${field}]`).value; await Promise.all([api(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}`, { method: "PATCH", json: { globalRole: value("globalRole"), status: value("status") } }), api(`${bookPath("members")}/${encodeURIComponent(row.dataset.userId)}`, { method: "PUT", json: { role: value("bookRole") || null } })]); toast("Brugerens adgang er opdateret."); }
    if (button.dataset.action === "show-password-reset") button.closest("td").querySelector(".password-reset").hidden = false;
    if (button.dataset.action === "reset-password") { const row = button.closest("[data-user-id]"); const input = row.querySelector("[data-field=newPassword]"); await api(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}/password`, { method: "PUT", json: { newPassword: input.value } }); input.value = ""; button.closest(".password-reset").hidden = true; toast("Password nulstillet; sessioner er lukket."); }
    if (button.dataset.action === "save-annotation") { const row = button.closest("[data-annotation-id]"); const changes = { status: row.querySelector("[data-field=annotationStatus]").value, category: row.querySelector("[data-field=annotationCategory]").value }; const payload = await api(`${bookPath("annotations")}/${encodeURIComponent(row.dataset.annotationId)}`, { method: "PUT", json: changes }); const updated = payload.annotation ?? payload; state.annotations = state.annotations.map((note) => note.id === updated.id ? updated : note); renderAnnotations(state.annotations); toast("Annotationens triage er gemt."); }
    if (button.dataset.action === "copy-reader-link") await copyText(`${location.origin}${readerPath()}`);
    if (button.dataset.action === "copy-invitation-link") await copyText(state.invitationUrl);
    if (button.dataset.action === "revoke-invite") { await api(`${bookPath("invitations")}/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); renderInvitations(list(await api(bookPath("invitations")), "invitations")); }
    if (button.dataset.action === "revoke-code") { await api(`${bookPath("access-codes")}/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); renderAccessCodes(list(await api(bookPath("access-codes")), "accessCodes")); }
    if (button.dataset.action === "revoke-token") { await api(`/api/admin/tokens/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); renderTokens(list(await api(bookPath("tokens")), "tokens")); }
  } catch (error) { toast(error.message); }
});

load().catch((error) => { document.querySelector("#locked").hidden = false; document.querySelector("#locked p").textContent = error.message; });
