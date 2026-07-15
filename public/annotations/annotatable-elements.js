import { normalizeBookText } from "./text-anchor.js";

export const viewerAnchorSelector = "[data-viewer-anchor]";
export const viewerTextScopeSelector = "[data-viewer-anchor][data-viewer-text-scope]";

const marginLabels = Object.freeze({
  "top-left": "Sidehoved, venstre",
  "top-center": "Sidehoved, midt",
  "top-right": "Sidehoved, højre",
  "bottom-left": "Sidetal eller sidefod, venstre",
  "bottom-center": "Sidetal eller sidefod, midt",
  "bottom-right": "Sidetal eller sidefod, højre",
  "left-top": "Venstre sidemargen, øverst",
  "left-middle": "Venstre sidemargen, midt",
  "left-bottom": "Venstre sidemargen, nederst",
  "right-top": "Højre sidemargen, øverst",
  "right-middle": "Højre sidemargen, midt",
  "right-bottom": "Højre sidemargen, nederst",
});

function normalizedClassNames(element) {
  return [...element.classList]
    .filter((name) => !name.startsWith("has-") && !name.startsWith("is-annotation-"))
    .sort();
}

function elementSegmentBase(element) {
  const stableClasses = normalizedClassNames(element)
    .filter((name) => !name.startsWith("pagedjs_"))
    .slice(0, 2);
  return `${element.localName || "element"}${stableClasses.map((name) => `.${name}`).join("")}`;
}

function elementSegment(element) {
  const base = elementSegmentBase(element);
  const siblings = [...(element.parentElement?.children ?? [])]
    .filter((candidate) => elementSegmentBase(candidate) === base);
  if (siblings.length < 2) return base;
  return `${base}[${siblings.indexOf(element) + 1}]`;
}

function structuralPath(element, boundary) {
  const segments = [];
  let current = element;
  while (current && current !== boundary && segments.length < 16) {
    segments.unshift(elementSegment(current));
    current = current.parentElement;
  }
  return segments.join("/") || "element";
}

function marginContextForElement(element, page) {
  let current = element;
  while (current && current !== page) {
    const marginClass = [...current.classList].find((name) => /^pagedjs_margin-(?:top|bottom|left|right)(?:-|$)/.test(name));
    if (marginClass) {
      const role = marginClass
        .slice("pagedjs_margin-".length)
        .replace(/-corner(?:-holder)?$/, "")
        .replace(/-holder$/, "");
      if (role) return { role, container: current };
    }
    current = current.parentElement;
  }
  return { role: "", container: null };
}

function pageContentAnchor(page, pageNumber) {
  const content = page.querySelector(".pagedjs_area") ?? page;
  const pageComponent = content.querySelector("[data-book-page-label][data-book-anchor]");
  const firstStableElement = pageComponent ?? content.querySelector("[data-book-anchor]");
  return firstStableElement?.dataset.bookAnchor || `page-${pageNumber}`;
}

export function createDerivedAnchor({
  explicitAnchor = "",
  nearestBookAnchor = "",
  pageAnchor,
  marginRole = "",
  path,
}) {
  if (explicitAnchor) return explicitAnchor;
  if (marginRole) return `viewer:${pageAnchor}::page-furniture:${marginRole}::${path}`;
  if (nearestBookAnchor) return `viewer:${nearestBookAnchor}::${path}`;
  return `viewer:${pageAnchor}::page-structure:${path}`;
}

export function labelFromElementMetadata({
  bookLabel = "",
  ariaLabel = "",
  text = "",
  marginRole = "",
  className = "",
  tagName = "element",
  pageNumber,
}) {
  const normalizedBookLabel = String(bookLabel ?? "").trim();
  const normalizedAriaLabel = String(ariaLabel ?? "").trim();
  const normalizedClassName = String(className ?? "").trim();
  const normalizedTagName = String(tagName ?? "element").toLowerCase();
  if (normalizedBookLabel) return normalizedBookLabel;
  if (normalizedAriaLabel) return normalizedAriaLabel;
  const normalizedText = normalizeBookText(text);
  const marginLabel = marginLabels[marginRole] ?? (marginRole ? "Sideelement" : "");
  if (marginLabel && normalizedText) return `${marginLabel}: “${normalizedText.slice(0, 64)}”`;
  if (marginLabel) return marginLabel;
  if (normalizedText) return `Tekst: “${normalizedText.slice(0, 72)}${normalizedText.length > 72 ? "…" : ""}”`;
  if (normalizedClassName) return `Element .${normalizedClassName.split(/\s+/).slice(0, 2).join(".")}`;
  return `${normalizedTagName} på side ${pageNumber}`;
}

function uniqueAnchor(baseAnchor, seenAnchors) {
  const occurrence = (seenAnchors.get(baseAnchor) ?? 0) + 1;
  seenAnchors.set(baseAnchor, occurrence);
  return occurrence === 1 ? baseAnchor : `${baseAnchor}::instance-${occurrence}`;
}

function decorateElement(element, page, pageNumber, pageAnchor, seenAnchors) {
  const explicitAnchor = element.dataset.bookAnchor ?? "";
  const nearestStableParent = element.parentElement?.closest("[data-book-anchor]");
  const marginContext = marginContextForElement(element, page);
  const marginRole = marginContext.role;
  const boundary = marginContext.container?.parentElement ?? nearestStableParent ?? page;
  const path = structuralPath(element, boundary || page);
  const baseAnchor = createDerivedAnchor({
    explicitAnchor,
    nearestBookAnchor: nearestStableParent?.dataset.bookAnchor ?? "",
    pageAnchor,
    marginRole,
    path,
  });
  element.dataset.viewerAnchor = uniqueAnchor(baseAnchor, seenAnchors);
  element.dataset.viewerPageNumber = String(pageNumber);
  element.dataset.viewerLabel = labelFromElementMetadata({
    bookLabel: element.dataset.bookLabel,
    ariaLabel: element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title"),
    text: element.textContent,
    marginRole,
    className: normalizedClassNames(element).join(" "),
    tagName: element.localName,
    pageNumber,
  });
  if (normalizeBookText(element.textContent)) element.dataset.viewerTextScope = "";
}

export function prepareAnnotatableElements(pages) {
  const seenAnchors = new Map();
  pages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const pageAnchor = pageContentAnchor(page, pageNumber);
    for (const element of [page, ...page.querySelectorAll("*")]) {
      decorateElement(element, page, pageNumber, pageAnchor, seenAnchors);
    }
  });
}

export function annotationAnchor(element) {
  return element?.dataset?.viewerAnchor ?? element?.dataset?.bookAnchor ?? "";
}

export function annotationLabel(element) {
  return element?.dataset?.viewerLabel
    || element?.dataset?.bookLabel
    || element?.getAttribute?.("aria-label")
    || annotationAnchor(element)
    || "Element";
}

export function closestAnnotatableElement(element) {
  return element?.closest?.(viewerAnchorSelector) ?? null;
}
