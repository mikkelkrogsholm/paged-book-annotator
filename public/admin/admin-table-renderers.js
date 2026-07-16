export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("da-DK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function option(value, current, label = value) {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export function emptyRow(columns, message) {
  return `<tr><td colspan="${columns}" class="empty-cell">${escapeHtml(message)}</td></tr>`;
}

export function renderInvitations(invitations) {
  document.querySelector("#invitationsTable").innerHTML = invitations.map((invite) => {
    const status = invite.acceptedAt ? "Accepteret" : invite.revokedAt ? "Tilbagekaldt" : "Åben";
    const revoke = invite.acceptedAt || invite.revokedAt ? "" : `<button class="secondary" data-action="revoke-invite" data-id="${escapeHtml(invite.id)}">Tilbagekald</button>`;
    return `<tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.role)}</td><td>${formatDate(invite.expiresAt)}</td><td>${status}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, "Der er ingen invitationer til denne bog.");
}

export function renderAccessCodes(codes) {
  document.querySelector("#accessCodesTable").innerHTML = codes.map((code) => `<tr>
    <td>${escapeHtml(code.name)}</td><td>${escapeHtml(code.role)}</td>
    <td>${code.useCount ?? 0} / ${code.maxUses ?? "∞"}</td><td>${formatDate(code.expiresAt)}</td>
    <td>${code.revokedAt ? "Tilbagekaldt" : `<button class="secondary" data-action="revoke-code" data-id="${escapeHtml(code.id)}">Tilbagekald</button>`}</td>
  </tr>`).join("") || emptyRow(5, "Der er ingen adgangskoder til denne bog.");
}

export function renderTokenTable(tokens, { activeBookId, instanceAdmin }) {
  document.querySelector("#tokensTable").innerHTML = tokens.map((token) => {
    const revoke = token.revokedAt ? "" : `<button class="secondary" data-action="revoke-token" data-id="${escapeHtml(token.id)}">Tilbagekald</button>`;
    const bookGrants = token.bookGrants ?? token.grants ?? [];
    const grants = token.instanceAdmin ? "Instansadministrator" : bookGrants.map((grant) => `${grant.bookId}: ${(grant.permissions ?? []).join(", ")}`).join(" · ") || activeBookId;
    return `<tr><td>${escapeHtml(token.name)}</td><td><code>${escapeHtml(token.prefix)}</code></td><td><small>${escapeHtml(grants)}</small></td><td>${formatDate(token.expiresAt)}${token.revokedAt ? " · tilbagekaldt" : ""}</td><td>${revoke}</td></tr>`;
  }).join("") || emptyRow(5, instanceAdmin ? "Der er ingen service-tokens på installationen." : "Der er ingen tokens med adgang til denne bog.");
}

export function renderProgress(progress) {
  document.querySelector("#progressTable").innerHTML = progress.map((item) => {
    const pages = item.readPages ?? [];
    const readAnchors = pages.map((page) => escapeHtml(page.anchorId)).join(", ");
    return `<tr>
      <td>${escapeHtml(item.displayName)}<small>${escapeHtml(item.email)}</small></td>
      <td>${escapeHtml(item.anchorId)}<small>Side ${item.pageNumber ?? "—"}</small></td>
      <td>${item.engagedPercent ?? 0}% engageret
        <small>Seneste position ${item.percent ?? 0}%${item.completedAt ? " · færdig" : ""}</small>
      </td><td>${pages.length}<small>${readAnchors}</small></td><td>${formatDate(item.updatedAt)}</td>
    </tr>`;
  }).join("") || emptyRow(5, "Ingen læsere har delt læsestatus.");
}

export function renderAudit(events) {
  document.querySelector("#auditTable").innerHTML = events.map((event) => `<tr><td>${formatDate(event.createdAt)}</td><td>${escapeHtml(event.actorType)}<small>${escapeHtml(event.actorId)}</small></td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.resourceType)}<small>${escapeHtml(event.resourceId ?? "")}</small></td></tr>`).join("") || emptyRow(4, "Auditloggen er tom.");
}
