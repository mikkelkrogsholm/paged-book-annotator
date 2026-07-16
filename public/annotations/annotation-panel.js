import { closeSidePanel, openSidePanel, showUiToast } from "../ui-state.js";

const typeLabels = Object.freeze({
  text: "Tekst",
  element: "Element",
  page: "Side",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export class AnnotationPanel {
  constructor({ capabilities, principal, exportUrl = "/api/annotations/export" }) {
    this.capabilities = capabilities;
    this.principal = principal;
    this.panel = document.querySelector("#annotationPanel");
    this.panelButton = document.querySelector("#annotationPanelButton");
    this.browser = document.querySelector("#annotationBrowser");
    this.composer = document.querySelector("#annotationComposer");
    this.list = document.querySelector("#annotationList");
    this.empty = document.querySelector("#annotationEmpty");
    this.form = document.querySelector("#annotationForm");
    this.comment = document.querySelector("#annotationComment");
    this.category = document.querySelector("#annotationCategory");
    this.formError = document.querySelector("#annotationFormError");
    this.filter = "open";
    this.annotations = [];
    this.draft = null;
    this.editingId = null;
    this.composerIntentId = 0;
    this.saving = false;
    this.callbacks = {};
    this.returnFocus = null;
    document.querySelector("#importButton").hidden = !capabilities.canModerateAnnotations;
    const exportLink = document.querySelector("#annotationExportLink");
    exportLink.href = exportUrl;
    exportLink.hidden = !capabilities.canExportAnnotations;
    const emptyMessage = this.empty.querySelector("p");
    if (!capabilities.canCreateAnnotations) emptyMessage.textContent = "Der er ingen kommentarer, du har adgang til at se.";
    this.bindEvents();
  }

  canEdit(annotation) {
    return this.capabilities.canModerateAnnotations || annotation.author?.id === this.principal?.id;
  }

  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }

  bindEvents() {
    this.panelButton.addEventListener("click", () => this.toggle());
    document.querySelector("#annotationPanelClose").addEventListener("click", () => this.close());
    document.querySelector("#composerBack").addEventListener("click", () => this.showBrowser());
    document.querySelector("#cancelAnnotationButton").addEventListener("click", () => this.showBrowser());
    document.querySelector("#importButton").addEventListener("click", () => document.querySelector("#importInput").click());
    document.querySelector("#importInput").addEventListener("change", (event) => this.importFile(event));
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });

    document.querySelector(".filter-group").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-filter]");
      if (!button) return;
      this.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
      this.render();
    });

    this.list.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      const item = event.target.closest("[data-annotation-id]");
      if (!button || !item) return;
      const annotation = this.annotations.find((candidate) => candidate.id === item.dataset.annotationId);
      if (!annotation) return;
      const action = button.dataset.action;
      if (action === "navigate") this.callbacks.onNavigate?.(annotation);
      if (action === "edit") this.openComposer(annotation, annotation.id);
      if (action === "status") await this.runItemAction(button, () => this.callbacks.onUpdate?.(annotation.id, {
        status: annotation.status === "open" ? "resolved" : "open",
      }));
      if (action === "delete" && window.confirm("Vil du slette denne kommentar?")) {
        await this.runItemAction(button, () => this.callbacks.onDelete?.(annotation.id));
      }
    });

    this.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const comment = this.comment.value.trim();
      if (!comment) {
        this.showFormError("Skriv en kommentar, før du gemmer.");
        return;
      }
      const operation = { editingId: this.editingId, draft: this.draft, intentId: this.composerIntentId };
      const isCurrentOperation = () => this.composerIntentId === operation.intentId;
      this.setSaving(true);
      try {
        if (operation.editingId) await this.callbacks.onUpdate?.(operation.editingId, { comment, category: this.category.value });
        else await this.callbacks.onCreate?.({ ...operation.draft, comment, category: this.category.value });
        if (isCurrentOperation()) this.showBrowser();
      } catch (error) {
        if (isCurrentOperation()) this.showFormError(error.message);
      } finally {
        if (isCurrentOperation()) this.setSaving(false);
      }
    });
  }

  open() {
    this.returnFocus = openSidePanel(this.panel, this.panelButton, this.returnFocus);
    window.setTimeout(() => document.querySelector("#annotationPanelClose")?.focus(), 0);
  }

  close({ restoreFocus = true } = {}) {
    if (!this.saving) this.composerIntentId += 1;
    closeSidePanel(this.panel, this.panelButton, this.returnFocus, { restoreFocus });
  }

  toggle() {
    if (this.panel.classList.contains("is-open")) this.close();
    else this.open();
  }

  setAnnotations(annotations) {
    this.annotations = [...annotations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const openCount = annotations.filter((annotation) => annotation.status === "open").length;
    document.querySelector("#openAnnotationCount").textContent = String(openCount);
    this.render();
  }

  filteredAnnotations() {
    if (this.filter === "all") return this.annotations;
    if (this.filter === "orphaned") return this.annotations.filter((annotation) => annotation.anchorState === "orphaned");
    return this.annotations.filter((annotation) => annotation.status === this.filter);
  }

  render() {
    const annotations = this.filteredAnnotations();
    this.empty.hidden = annotations.length > 0;
    this.list.innerHTML = annotations.map((annotation) => {
      const quote = annotation.target.selector?.exact;
      const orphaned = annotation.anchorState === "orphaned";
      const editable = this.canEdit(annotation);
      return `
        <li class="annotation-item${annotation.status === "resolved" ? " is-resolved" : ""}${orphaned ? " is-orphaned" : ""}" data-annotation-id="${escapeHtml(annotation.id)}">
          <div class="annotation-item-meta">
            <span>${typeLabels[annotation.type]}</span>
            <span>Side ${annotation.target.pageNumber}</span>
            <span>${escapeHtml(annotation.author?.displayName ?? "Ukendt")}</span>
            <span>${escapeHtml(annotation.category ?? "general")}</span>
            ${orphaned ? "<strong>Skal genforankres</strong>" : ""}
          </div>
          <button class="annotation-target-button" type="button" data-action="navigate">
            <strong>${escapeHtml(annotation.target.label || annotation.target.scopeId || `Side ${annotation.target.pageNumber}`)}</strong>
            ${quote ? `<q>${escapeHtml(quote)}</q>` : ""}
          </button>
          <p>${escapeHtml(annotation.comment)}</p>
          <div class="annotation-item-footer">
            <time datetime="${escapeHtml(annotation.updatedAt)}">${formatDate(annotation.updatedAt)}</time>
            <div${editable ? "" : " hidden"}>
              <button type="button" data-action="edit">Redigér</button>
              <button type="button" data-action="status">${annotation.status === "open" ? "Løs" : "Genåbn"}</button>
              <button type="button" data-action="delete">Slet</button>
            </div>
          </div>
        </li>`;
    }).join("");
  }

  async runItemAction(button, action) {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      this.showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  focusAnnotation(id) {
    window.setTimeout(() => this.list.querySelector(`[data-annotation-id="${CSS.escape(id)}"] .annotation-target-button`)?.focus(), 0);
  }

  openComposer(draft, editingId = null) {
    if (!this.capabilities.canCreateAnnotations && !this.canEdit(draft)) return;
    this.composerIntentId += 1;
    this.draft = draft;
    this.editingId = editingId;
    const annotation = editingId ? draft : null;
    const target = draft.target;
    document.querySelector("#composerType").textContent = typeLabels[draft.type];
    document.querySelector("#composerTarget").textContent = target.label || target.scopeId || `Side ${target.pageNumber}`;
    document.querySelector("#composerHelp").textContent = draft.type === "page"
      ? "Kommentaren gemmes med sidetallet som hint og det nærmeste stabile boganker."
      : draft.type === "text"
        ? "Kommentaren gemmes med tekstposition, tekstcitat og et stabilt boganker."
        : "Kommentaren gemmes med det valgte element og et stabilt boganker.";
    const quote = document.querySelector("#composerQuote");
    quote.hidden = !target.selector?.exact;
    quote.textContent = target.selector?.exact ?? "";
    this.comment.value = annotation?.comment ?? "";
    this.category.value = annotation?.category ?? "general";
    this.formError.hidden = true;
    this.browser.hidden = true;
    this.composer.hidden = false;
    document.querySelector("#saveAnnotationButton").textContent = editingId ? "Gem ændring" : "Gem kommentar";
    this.setSaving(false);
    this.open();
    window.setTimeout(() => this.comment.focus(), 80);
  }

  showBrowser() {
    this.composerIntentId += 1;
    this.draft = null;
    this.editingId = null;
    this.composer.hidden = true;
    this.browser.hidden = false;
    this.form.reset();
    this.formError.hidden = true;
    this.setSaving(false);
  }

  showFormError(message) {
    this.formError.textContent = message;
    this.formError.hidden = false;
  }

  setSaving(saving) {
    this.saving = saving;
    document.querySelector("#saveAnnotationButton").disabled = saving;
    document.querySelector("#saveAnnotationButton").textContent = saving ? "Gemmer" : this.editingId ? "Gem ændring" : "Gem kommentar";
    this.comment.disabled = saving;
    this.category.disabled = saving;
    document.querySelector("#composerBack").disabled = saving;
    document.querySelector("#cancelAnnotationButton").disabled = saving;
  }

  async importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const document = JSON.parse(await file.text());
      await this.callbacks.onImport?.(document);
      this.showToast("Kommentarerne er importeret.");
    } catch (error) {
      this.showToast(error.message, true);
    }
  }

  showToast(message, isError = false) {
    showUiToast(message, { error: isError });
  }
}
