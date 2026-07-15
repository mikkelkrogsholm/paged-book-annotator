function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("da-DK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Kaldet fejlede (${response.status}).`);
  return payload;
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function option(value, current, label = value) { return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`; }
function toast(message) { const node = document.querySelector("#toast"); node.textContent = message; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3500); }
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
const capabilityLabels = { reading: "Læsning", annotationCreate: "Opret feedback", annotationView: "Se feedback", registration: "Oprettelse", progressTracking: "Læsestatus" };
const state = { metadata: null, invitationUrl: "", annotations: [] };

function renderAccess(policy) {
  document.querySelector("#accessPreset").textContent = presetLabels[policy.preset] ?? policy.preset;
  document.querySelector("#accessSummary").textContent = `Læsning: ${policy.reading} · annotation: ${policy.annotationCreate} · visning: ${policy.annotationView} · registrering: ${policy.registration}`;
  document.querySelector("#accessProfile").value = policy.preset;
  document.querySelector("#capabilityPreview").innerHTML = Object.entries(capabilityLabels)
    .map(([field, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(policy[field])}</dd></div>`).join("");
  const warning = document.querySelector("#shareWarning");
  warning.textContent = policy.localBypass ? "Denne profil er kun til lokal brug. Vælg en anden profil før deling." : policy.reading === "public" ? "Linket åbner bogen uden invitation." : "Linket viser login; opret en invitation til hver læser.";
}

function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty-cell">${escapeHtml(message)}</td></tr>`; }

function renderUsers(users) {
  document.querySelector("#usersTable").innerHTML = users.map((user) => `<tr data-user-id="${escapeHtml(user.id)}">
    <td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)}</small></td>
    <td><select data-field="globalRole">${option("user", user.globalRole, "Bruger")}${option("instance_admin", user.globalRole, "Administrator")}</select></td>
    <td><select data-field="bookRole">${option("", user.membership?.role ?? "", "Ingen")}${option("reader", user.membership?.role, "Læser")}${option("reviewer", user.membership?.role, "Prøvelæser")}${option("book_admin", user.membership?.role, "Bogadministrator")}</select></td>
    <td><select data-field="status">${option("active", user.status, "Aktiv")}${option("disabled", user.status, "Deaktiveret")}</select></td>
    <td>
      <div class="row-actions"><button class="secondary" data-action="save-user">Gem</button><button class="secondary" data-action="show-password-reset">Nyt password</button></div>
      <div class="password-reset" hidden><input data-field="newPassword" type="password" minlength="10" placeholder="Mindst 10 tegn"><button data-action="reset-password">Nulstil</button></div>
    </td></tr>`).join("") || emptyRow(5, "Der er endnu ingen brugere.");
}

function renderInvitations(invitations) {
  document.querySelector("#invitationsTable").innerHTML = invitations.map((invite) => {
    const status = invite.acceptedAt ? "Accepteret" : invite.revokedAt ? "Tilbagekaldt" : "Åben";
    const revoke = invite.acceptedAt || invite.revokedAt
      ? ""
      : `<button class="secondary" data-action="revoke-invite" data-id="${escapeHtml(invite.id)}">Tilbagekald</button>`;
    return `<tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.role)}</td><td>${formatDate(invite.expiresAt)}</td><td>${status}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, "Der er ingen invitationer endnu.");
}

function renderTokens(tokens) {
  document.querySelector("#tokensTable").innerHTML = tokens.map((token) => {
    const revoke = token.revokedAt
      ? ""
      : `<button class="secondary" data-action="revoke-token" data-id="${escapeHtml(token.id)}">Tilbagekald</button>`;
    const expires = `${formatDate(token.expiresAt)}${token.revokedAt ? " · tilbagekaldt" : ""}`;
    return `<tr><td>${escapeHtml(token.name)}</td><td><code>${escapeHtml(token.prefix)}</code></td><td>${token.scopes.map(escapeHtml).join("<br>")}</td><td>${expires}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, "Der er ingen aktive eller tidligere tokens.");
}

function renderAnnotations(annotations) {
  state.annotations = annotations;
  const filters = formObject(document.querySelector("#annotationFilters"));
  const query = String(filters.query ?? "").trim().toLocaleLowerCase();
  const visible = annotations.filter((note) => (!filters.status || note.status === filters.status) && (!filters.category || note.category === filters.category) && (!query || `${note.comment} ${note.target.label} ${note.target.scopeId} ${note.author?.displayName}`.toLocaleLowerCase().includes(query)));
  document.querySelector("#annotationsTable").innerHTML = visible.map((note) => {
    const target = escapeHtml(note.target.label || note.target.scopeId || `Side ${note.target.pageNumber}`);
    const orphaned = note.anchorState === "orphaned" ? " · uforankret" : "";
    const statusOptions = option("open", note.status, "Åben") + option("accepted", note.status, "Accepteret")
      + option("rejected", note.status, "Afvist") + option("resolved", note.status, "Løst");
    const categoryOptions = option("general", note.category, "Generel") + option("language", note.category, "Sprog")
      + option("structure", note.category, "Struktur") + option("fact", note.category, "Fakta") + option("design", note.category, "Design");
    return `<tr data-annotation-id="${escapeHtml(note.id)}">
      <td>${escapeHtml(note.author?.displayName ?? "Ukendt")}</td>
      <td><a href="/?annotation=${encodeURIComponent(note.id)}">${target}</a><small>Side ${note.target.pageNumber} · ${note.type}${orphaned}</small></td>
      <td>${escapeHtml(note.comment)}</td>
      <td><select data-field="annotationStatus">${statusOptions}</select><select data-field="annotationCategory">${categoryOptions}</select><button class="secondary" data-action="save-annotation">Gem</button></td>
      <td>${formatDate(note.updatedAt)}</td>
    </tr>`;
  }).join("") || emptyRow(5, annotations.length ? "Ingen annotationer matcher filtrene." : "Der er endnu ingen annotationer.");
}

function renderProgress(progress) {
  document.querySelector("#progressTable").innerHTML = progress.map((item) => {
    const readAnchors = item.readPages.map((page) => escapeHtml(page.anchorId)).join(", ");
    const completion = item.completedAt ? " · færdig" : "";
    return `<tr><td>${escapeHtml(item.displayName)}<small>${escapeHtml(item.email)}</small></td><td>${escapeHtml(item.anchorId)}<small>Side ${item.pageNumber}</small></td><td>${item.engagedPercent}% engageret<small>Seneste position ${item.percent}%${completion}</small></td><td>${item.readPages.length}<small>${readAnchors}</small></td><td>${formatDate(item.updatedAt)}</td></tr>`;
  }).join("") || emptyRow(5, "Ingen læsere har delt læsestatus.");
}

function renderAudit(events) {
  document.querySelector("#auditTable").innerHTML = events.map((event) => `<tr><td>${formatDate(event.createdAt)}</td><td>${escapeHtml(event.actorType)}<small>${escapeHtml(event.actorId)}</small></td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.resourceType)}<small>${escapeHtml(event.resourceId ?? "")}</small></td></tr>`).join("") || emptyRow(4, "Auditloggen er tom.");
}

async function load() {
  const config = await api("/api/config");
  document.querySelector("#bookTitle").textContent = config.book.title;
  document.querySelector("#bookMark").textContent = config.book.mark;
  document.title = `Administration · ${config.book.title}`;
  if (!config.session.capabilities.canManageUsers) {
    document.querySelector("#locked").hidden = false;
    return;
  }
  document.querySelector("#workspace").hidden = false;
  document.querySelector("#adminName").textContent = config.session.principal?.displayName ?? "Administrator";
  document.querySelector("#account").hidden = config.session.principal?.kind !== "user";
  const [metadata, overview, users, invitations, tokens, annotations, progress, audit] = await Promise.all([
    api("/api/admin/metadata"), api("/api/admin/overview"), api("/api/admin/users"), api("/api/admin/invitations"),
    api("/api/admin/tokens"), api("/api/admin/annotations"), api("/api/admin/progress"), api("/api/admin/audit"),
  ]);
  state.metadata = metadata;
  document.querySelector("#accessProfile").innerHTML = metadata.accessPresets.map((preset) => option(preset, metadata.activeAccess.preset, presetLabels[preset] ?? preset)).join("");
  document.querySelector("#readerUrl").textContent = `${location.origin}/`;
  renderAccess(metadata.activeAccess);
  document.querySelector("#metrics").innerHTML = [[overview.users,"Brugere"],[overview.annotations,"Annotationer"],[overview.openAnnotations,"Åbne noter"]].map(([value,label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  document.querySelector("#metrics").removeAttribute("aria-busy");
  document.querySelector("#scopeGrid").innerHTML = metadata.permissions.map((permission) => `<label><input type="checkbox" name="scope" value="${escapeHtml(permission)}">${escapeHtml(permission)}</label>`).join("");
  renderUsers(users.users); renderInvitations(invitations.invitations); renderTokens(tokens.tokens); renderAnnotations(annotations.annotations); renderProgress(progress.progress); renderAudit(audit.events);
}

document.querySelector("#createUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); toast("Brugeren er oprettet."); event.currentTarget.reset(); renderUsers((await api("/api/admin/users")).users); } catch (error) { toast(error.message); }
});
document.querySelector("#accessProfile").addEventListener("change", (event) => renderAccess({ preset: event.currentTarget.value, ...state.metadata.accessProfiles[event.currentTarget.value] }));
document.querySelector("#accessForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const errorNode = document.querySelector("#accessError"); errorNode.hidden = true;
  try {
    const { access } = await api("/api/admin/access", { method: "PUT", body: JSON.stringify({ preset: event.currentTarget.preset.value }) });
    state.metadata.activeAccess = access; renderAccess(access); toast("Adgangsprofilen er gemt og aktiv.");
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
});
document.querySelector("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const body = JSON.stringify(formObject(event.currentTarget));
    const { invitation } = await api("/api/admin/invitations", { method: "POST", body });
    const url = `${location.origin}/?invite=${encodeURIComponent(invitation.secret)}`;
    state.invitationUrl = url;
    document.querySelector("#invitationSecret").textContent = url;
    document.querySelector("#invitationOutput").hidden = false;
    renderInvitations((await api("/api/admin/invitations")).invitations);
  } catch (error) {
    toast(error.message);
  }
});
document.querySelector("#tokenForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = formObject(event.currentTarget); input.scopes = [...event.currentTarget.querySelectorAll("[name=scope]:checked")].map((node) => node.value);
  try { const { token } = await api("/api/admin/tokens", { method: "POST", body: JSON.stringify(input) }); const output = document.querySelector("#tokenOutput"); output.textContent = `Kopiér nu — tokenet vises ikke igen: ${token.secret}`; output.hidden = false; renderTokens((await api("/api/admin/tokens")).tokens); } catch (error) { toast(error.message); }
});
document.querySelector("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api("/api/auth/password", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) }); toast("Passwordet er ændret. Log ind igen."); window.setTimeout(() => location.assign("/"), 800); } catch (error) { toast(error.message); }
});
document.querySelector("#annotationFilters").addEventListener("input", () => renderAnnotations(state.annotations));
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]"); if (!button) return;
  try {
    if (button.dataset.action === "save-user") { const row = button.closest("[data-user-id]"); const value = (field) => row.querySelector(`[data-field=${field}]`).value; await api(`/api/admin/users/${row.dataset.userId}`, { method: "PATCH", body: JSON.stringify({ globalRole: value("globalRole"), bookRole: value("bookRole") || null, status: value("status") }) }); toast("Adgangen er opdateret."); }
    if (button.dataset.action === "show-password-reset") { button.closest("td").querySelector(".password-reset").hidden = false; }
    if (button.dataset.action === "reset-password") {
      const row = button.closest("[data-user-id]");
      const input = row.querySelector("[data-field=newPassword]");
      await api(`/api/admin/users/${row.dataset.userId}/password`, { method: "PUT", body: JSON.stringify({ newPassword: input.value }) });
      input.value = ""; button.closest(".password-reset").hidden = true;
      toast("Passwordet er nulstillet; brugerens sessioner er lukket.");
    }
    if (button.dataset.action === "save-annotation") {
      const row = button.closest("[data-annotation-id]");
      const changes = { status: row.querySelector("[data-field=annotationStatus]").value, category: row.querySelector("[data-field=annotationCategory]").value };
      const updated = await api(`/api/annotations/${row.dataset.annotationId}`, { method: "PUT", body: JSON.stringify(changes) });
      state.annotations = state.annotations.map((note) => note.id === updated.id ? updated : note);
      renderAnnotations(state.annotations); toast("Annotationens triage er gemt.");
    }
    if (button.dataset.action === "copy-reader-link") await copyText(`${location.origin}/`);
    if (button.dataset.action === "copy-invitation-link") await copyText(state.invitationUrl);
    if (button.dataset.action === "revoke-invite") { await api(`/api/admin/invitations/${button.dataset.id}`, { method: "DELETE" }); renderInvitations((await api("/api/admin/invitations")).invitations); }
    if (button.dataset.action === "revoke-token") { await api(`/api/admin/tokens/${button.dataset.id}`, { method: "DELETE" }); renderTokens((await api("/api/admin/tokens")).tokens); }
  } catch (error) { toast(error.message); }
});

load().catch((error) => { document.querySelector("#locked").hidden = false; document.querySelector("#locked p").textContent = error.message; });
