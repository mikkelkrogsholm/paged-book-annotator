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
  constructor() {
    this.panel = document.querySelector("#annotationPanel");
    this.panelButton = document.querySelector("#annotationPanelButton");
    this.browser = document.querySelector("#annotationBrowser");
    this.composer = document.querySelector("#annotationComposer");
    this.list = document.querySelector("#annotationList");
    this.empty = document.querySelector("#annotationEmpty");
    this.form = document.querySelector("#annotationForm");
    this.comment = document.querySelector("#annotationComment");
    this.formError = document.querySelector("#annotationFormError");
    this.filter = "open";
    this.annotations = [];
    this.draft = null;
    this.editingId = null;
    this.callbacks = {};
    this.bindEvents();
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
      if (action === "status") this.callbacks.onUpdate?.(annotation.id, {
        status: annotation.status === "open" ? "resolved" : "open",
      });
      if (action === "delete" && window.confirm("Vil du slette denne kommentar?")) {
        this.callbacks.onDelete?.(annotation.id);
      }
    });

    this.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const comment = this.comment.value.trim();
      if (!comment) {
        this.showFormError("Skriv en kommentar, før du gemmer.");
        return;
      }
      this.setSaving(true);
      try {
        if (this.editingId) await this.callbacks.onUpdate?.(this.editingId, { comment });
        else await this.callbacks.onCreate?.({ ...this.draft, comment });
        this.showBrowser();
      } catch (error) {
        this.showFormError(error.message);
      } finally {
        this.setSaving(false);
      }
    });
  }

  open() {
    this.panel.classList.add("is-open");
    this.panel.setAttribute("aria-hidden", "false");
    this.panelButton.setAttribute("aria-expanded", "true");
  }

  close() {
    this.panel.classList.remove("is-open");
    this.panel.setAttribute("aria-hidden", "true");
    this.panelButton.setAttribute("aria-expanded", "false");
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
      return `
        <li class="annotation-item${annotation.status === "resolved" ? " is-resolved" : ""}${orphaned ? " is-orphaned" : ""}" data-annotation-id="${escapeHtml(annotation.id)}">
          <div class="annotation-item-meta">
            <span>${typeLabels[annotation.type]}</span>
            <span>Side ${annotation.target.pageNumber}</span>
            ${orphaned ? "<strong>Skal genforankres</strong>" : ""}
          </div>
          <button class="annotation-target-button" type="button" data-action="navigate">
            <strong>${escapeHtml(annotation.target.label || annotation.target.scopeId || `Side ${annotation.target.pageNumber}`)}</strong>
            ${quote ? `<q>${escapeHtml(quote)}</q>` : ""}
          </button>
          <p>${escapeHtml(annotation.comment)}</p>
          <div class="annotation-item-footer">
            <time datetime="${escapeHtml(annotation.updatedAt)}">${formatDate(annotation.updatedAt)}</time>
            <div>
              <button type="button" data-action="edit">Redigér</button>
              <button type="button" data-action="status">${annotation.status === "open" ? "Løs" : "Genåbn"}</button>
              <button type="button" data-action="delete">Slet</button>
            </div>
          </div>
        </li>`;
    }).join("");
  }

  openComposer(draft, editingId = null) {
    this.draft = draft;
    this.editingId = editingId;
    const annotation = editingId ? draft : null;
    const target = draft.target;
    document.querySelector("#composerType").textContent = typeLabels[draft.type];
    document.querySelector("#composerTarget").textContent = target.label || target.scopeId || `Side ${target.pageNumber}`;
    const quote = document.querySelector("#composerQuote");
    quote.hidden = !target.selector?.exact;
    quote.textContent = target.selector?.exact ?? "";
    this.comment.value = annotation?.comment ?? "";
    this.formError.hidden = true;
    this.browser.hidden = true;
    this.composer.hidden = false;
    document.querySelector("#saveAnnotationButton").textContent = editingId ? "Gem ændring" : "Gem kommentar";
    this.open();
    window.setTimeout(() => this.comment.focus(), 80);
  }

  showBrowser() {
    this.draft = null;
    this.editingId = null;
    this.composer.hidden = true;
    this.browser.hidden = false;
    this.form.reset();
    this.formError.hidden = true;
  }

  showFormError(message) {
    this.formError.textContent = message;
    this.formError.hidden = false;
  }

  setSaving(saving) {
    document.querySelector("#saveAnnotationButton").disabled = saving;
    document.querySelector("#saveAnnotationButton").textContent = saving ? "Gemmer" : this.editingId ? "Gem ændring" : "Gem kommentar";
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
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.hidden = false;
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }
}
