// agent-lint: disable-file=AR002 -- Controller and colocated tests intentionally import the same public target API.
import {
  buildNormalizedTextIndex,
  createRangeFromTextPosition,
  normalizeBookText,
  selectionStartInScope,
} from "./text-anchor.js";
import {
  createElementAnnotationDraft,
  createPageAnnotationDraft,
  createTextAnnotationDraft,
  movedTextTarget,
  resolveTextAnnotationTarget,
} from "./annotation-target.js";
import {
  annotationAnchor,
  annotationLabel,
  closestAnnotatableElement,
  prepareAnnotatableElements,
  viewerAnchorSelector,
  viewerTextScopeSelector,
} from "./annotatable-elements.js";

function sharedAnchorForRange(range) {
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
  let candidate = start?.closest?.(viewerAnchorSelector);
  while (candidate) {
    if (candidate.contains(end)) return candidate;
    candidate = candidate.parentElement?.closest?.(viewerAnchorSelector);
  }
  return null;
}

export class AnnotationController {
  constructor({ api, panel, reader, bookId }) {
    this.api = api;
    this.panel = panel;
    this.reader = reader;
    this.bookId = bookId;
    this.annotations = [];
    this.elementMode = false;
    this.hoverElement = null;
    this.pendingSelection = null;
    this.selectionAction = document.querySelector("#selectionAction");
  }

  async start() {
    prepareAnnotatableElements(this.reader.pages);
    this.panel.setCallbacks({
      onCreate: (draft) => this.create(draft),
      onUpdate: (id, changes) => this.update(id, changes),
      onDelete: (id) => this.delete(id),
      onNavigate: (annotation) => this.navigate(annotation),
      onImport: (document) => this.import(document),
    });
    this.bindAnnotationActions();
    await this.reload();
  }

  bindAnnotationActions() {
    this.reader.document.addEventListener("mouseup", () => this.captureSelection());
    this.reader.document.addEventListener("click", (event) => this.captureElement(event), true);
    this.reader.document.addEventListener("pointermove", (event) => this.previewElementTarget(event));
    this.reader.document.addEventListener("pointerleave", () => this.setHoverElement(null));
    this.selectionAction.addEventListener("click", () => {
      if (!this.pendingSelection) return;
      this.panel.openComposer(this.pendingSelection);
      this.hideSelectionAction();
    });
    document.querySelector("#elementModeButton").addEventListener("click", () => this.setElementMode(!this.elementMode));
    document.querySelector("#pageAnnotationButton").addEventListener("click", () => this.annotateCurrentPage());
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#selectionAction")) this.hideSelectionAction();
    });
  }

  async reload() {
    const document = await this.api.list();
    this.annotations = document.annotations;
    await this.renderAnchors();
    this.panel.setAnnotations(this.annotations);
  }

  async create(draft) {
    const created = await this.api.create(draft);
    this.annotations.push(created);
    await this.renderAnchors();
    this.panel.setAnnotations(this.annotations);
    this.panel.showToast("Kommentaren er gemt.");
  }

  async update(id, changes) {
    const updated = await this.api.update(id, changes);
    this.annotations = this.annotations.map((annotation) => annotation.id === id ? updated : annotation);
    await this.renderAnchors();
    this.panel.setAnnotations(this.annotations);
    this.panel.showToast(updated.status === "resolved" ? "Kommentaren er løst." : "Kommentaren er opdateret.");
  }

  async delete(id) {
    await this.api.delete(id);
    this.annotations = this.annotations.filter((annotation) => annotation.id !== id);
    await this.renderAnchors();
    this.panel.setAnnotations(this.annotations);
    this.panel.showToast("Kommentaren er slettet.");
  }

  async import(document) {
    const imported = await this.api.import(document, "merge");
    this.annotations = imported.annotations;
    await this.renderAnchors();
    this.panel.setAnnotations(this.annotations);
  }

  setElementMode(enabled) {
    this.elementMode = enabled;
    if (!enabled) this.setHoverElement(null);
    this.reader.document.body.classList.toggle("is-element-annotation-mode", enabled);
    const button = document.querySelector("#elementModeButton");
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("is-active", enabled);
    this.panel.showToast(enabled ? "Klik på det element, du vil kommentere." : "Elementvalg er slået fra.");
  }

  setHoverElement(element) {
    if (element === this.hoverElement) return;
    this.hoverElement?.classList.remove("is-annotation-hover-target");
    this.hoverElement = element;
    this.hoverElement?.classList.add("is-annotation-hover-target");
  }

  previewElementTarget(event) {
    if (!this.elementMode) return;
    this.setHoverElement(closestAnnotatableElement(event.target));
  }

  captureSelection() {
    if (this.elementMode) return;
    const selection = this.reader.document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const scope = sharedAnchorForRange(range);
    const exact = normalizeBookText(selection.toString());
    if (!scope || !exact) return;

    const scopeIndex = buildNormalizedTextIndex(scope);
    const approximateStart = selectionStartInScope(scope, range);
    const pageNumber = this.reader.pageNumberForElement(scope);
    this.pendingSelection = createTextAnnotationDraft({
      scopeId: annotationAnchor(scope),
      pageNumber,
      label: annotationLabel(scope),
      scopeText: scopeIndex.text,
      selectedText: exact,
      approximateStart,
    });

    const rect = range.getBoundingClientRect();
    const frameRect = this.reader.frame.getBoundingClientRect();
    this.selectionAction.style.left = `${Math.min(window.innerWidth - 190, Math.max(14, frameRect.left + rect.left + rect.width / 2))}px`;
    this.selectionAction.style.top = `${Math.max(74, frameRect.top + rect.top - 10)}px`;
    this.selectionAction.hidden = false;
  }

  hideSelectionAction() {
    this.selectionAction.hidden = true;
  }

  captureElement(event) {
    if (!this.elementMode) return;
    const target = closestAnnotatableElement(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    this.setElementMode(false);
    this.panel.openComposer(createElementAnnotationDraft({
      scopeId: annotationAnchor(target),
      pageNumber: this.reader.pageNumberForElement(target),
      label: annotationLabel(target),
    }));
  }

  annotateCurrentPage() {
    const pageNumbers = this.reader.currentPageNumbers();
    const label = pageNumbers.length > 1 ? `Opslag side ${pageNumbers[0]}–${pageNumbers.at(-1)}` : `Side ${pageNumbers[0]}`;
    const firstPage = this.reader.getPageByNumber(pageNumbers[0]);
    const stablePageContent = firstPage?.querySelector("[data-book-page-label][data-viewer-anchor], [data-book-anchor][data-viewer-anchor]")
      ?? firstPage?.querySelector(viewerAnchorSelector);
    this.panel.openComposer(createPageAnnotationDraft({
      scopeId: annotationAnchor(stablePageContent),
      pageNumber: pageNumbers[0],
      label,
    }));
  }

  async renderAnchors() {
    const document = this.reader.document;
    document.querySelectorAll(".has-element-annotation").forEach((element) => element.classList.remove("has-element-annotation"));
    document.querySelectorAll(".has-page-annotation").forEach((element) => element.classList.remove("has-page-annotation"));
    document.querySelectorAll("[data-book-annotation-count]").forEach((element) => element.removeAttribute("data-book-annotation-count"));
    const highlightRanges = [];
    const stateChanges = [];
    const pendingStateUpdateIds = new Set();
    const textScopeElements = new Map();
    const textScopes = [...document.querySelectorAll(viewerTextScopeSelector)].map((element) => {
      const scope = {
        scopeId: annotationAnchor(element),
        pageNumber: this.reader.pageNumberForElement(element),
        label: annotationLabel(element),
        text: element.textContent,
        depth: this.elementDepthWithinPage(element),
      };
      textScopeElements.set(scope.scopeId, element);
      return scope;
    });

    for (const annotation of this.annotations) {
      let attached = false;
      let attachedScope = null;
      if (annotation.type === "page") {
        attachedScope = annotation.target.scopeId
          ? document.querySelector(`[data-viewer-anchor="${CSS.escape(annotation.target.scopeId)}"]`)
          : null;
        const page = attachedScope?.closest(".pagedjs_page") ?? this.reader.getPageByNumber(annotation.target.pageNumber);
        if (page) {
          attached = true;
          if (annotation.status === "open") page.classList.add("has-page-annotation");
          const currentPageNumber = this.reader.pageNumber(page);
          if (attachedScope && currentPageNumber !== annotation.target.pageNumber) {
            pendingStateUpdateIds.add(annotation.id);
            stateChanges.push(this.api.update(annotation.id, {
              target: { ...annotation.target, pageNumber: currentPageNumber },
              anchorState: "attached",
            }));
          }
        }
      } else if (annotation.type === "element") {
        attachedScope = document.querySelector(`[data-viewer-anchor="${CSS.escape(annotation.target.scopeId)}"]`);
        attached = Boolean(attachedScope);
        if (attached && annotation.status === "open") attachedScope.classList.add("has-element-annotation");
      } else {
        const result = this.reattachTextAnnotation(annotation, textScopes, textScopeElements);
        attached = Boolean(result);
        attachedScope = result?.scope ?? null;
        if (result?.range && annotation.status === "open") highlightRanges.push(result.range);
        if (result?.movedTarget) {
          pendingStateUpdateIds.add(annotation.id);
          stateChanges.push(this.api.update(annotation.id, {
            target: result.movedTarget,
            anchorState: "attached",
          }));
        }
      }

      const nextAnchorState = attached ? "attached" : "orphaned";
      if (nextAnchorState !== annotation.anchorState && !pendingStateUpdateIds.has(annotation.id)) {
        pendingStateUpdateIds.add(annotation.id);
        stateChanges.push(this.api.update(annotation.id, { anchorState: nextAnchorState }));
      }
      if (attachedScope) attachedScope.dataset.bookAnnotationCount = String(
        Number(attachedScope.dataset.bookAnnotationCount ?? 0) + 1,
      );
    }

    const view = document.defaultView;
    if (view.CSS?.highlights && view.Highlight) {
      view.CSS.highlights.delete("book-annotations");
      if (highlightRanges.length > 0) view.CSS.highlights.set("book-annotations", new view.Highlight(...highlightRanges));
    }

    if (stateChanges.length > 0) {
      const updated = await Promise.all(stateChanges);
      const byId = new Map(updated.map((annotation) => [annotation.id, annotation]));
      this.annotations = this.annotations.map((annotation) => byId.get(annotation.id) ?? annotation);
    }
  }

  reattachTextAnnotation(annotation, textScopes, textScopeElements) {
    const resolved = resolveTextAnnotationTarget(annotation, textScopes);
    if (!resolved) return null;
    const scope = textScopeElements.get(resolved.scope.scopeId);
    const range = createRangeFromTextPosition(scope, resolved.location);
    if (!range) return null;
    return {
      scope,
      range,
      movedTarget: resolved.moved ? movedTextTarget(annotation, resolved) : null,
    };
  }

  elementDepthWithinPage(element) {
    let depth = 0;
    let current = element;
    while (current?.parentElement && !current.classList.contains("pagedjs_page")) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  navigate(annotation) {
    let pageNumber = annotation.target.pageNumber;
    if (annotation.target.scopeId) {
      const scope = this.reader.document.querySelector(`[data-viewer-anchor="${CSS.escape(annotation.target.scopeId)}"]`);
      pageNumber = this.reader.pageNumberForElement(scope) ?? pageNumber;
    }
    this.reader.goToPageNumber(pageNumber);
    this.panel.close();
  }
}
