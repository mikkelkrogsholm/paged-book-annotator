import { buildTextQuoteSelector, locateTextQuote, normalizeBookText } from "./text-anchor.js";

function requirePageNumber(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new TypeError("Annotationsmålet kræver et sidetal.");
  return pageNumber;
}

function requireScopeId(scopeId) {
  if (typeof scopeId !== "string" || !scopeId.trim()) throw new TypeError("Annotationsmålet kræver et stabilt scope-id.");
  return scopeId;
}

function createStableTargetDraft(type, { scopeId, pageNumber, label }) {
  return {
    type,
    target: {
      scopeId: requireScopeId(scopeId),
      pageNumber: requirePageNumber(pageNumber),
      label: String(label ?? ""),
    },
    status: "open",
    anchorState: "attached",
  };
}

export function createTextAnnotationDraft({
  scopeId,
  pageNumber,
  label,
  scopeText,
  selectedText,
  approximateStart,
}) {
  return {
    type: "text",
    target: {
      scopeId: requireScopeId(scopeId),
      pageNumber: requirePageNumber(pageNumber),
      label: String(label ?? ""),
      selector: buildTextQuoteSelector(scopeText, selectedText, approximateStart),
    },
    status: "open",
    anchorState: "attached",
  };
}

export function createElementAnnotationDraft({ scopeId, pageNumber, label }) {
  return createStableTargetDraft("element", { scopeId, pageNumber, label });
}

export function createPageAnnotationDraft({ scopeId, pageNumber, label }) {
  return createStableTargetDraft("page", { scopeId, pageNumber, label });
}

export function resolveTextAnnotationTarget(annotation, scopes) {
  const originalScope = scopes.find((scope) => scope.scopeId === annotation.target.scopeId);
  const originalLocation = originalScope
    ? locateTextQuote(originalScope.text, annotation.target.selector)
    : null;
  if (originalLocation) {
    const savedPosition = annotation.target.selector.position;
    const positionMoved = !savedPosition
      || savedPosition.start !== originalLocation.start
      || savedPosition.end !== originalLocation.end;
    return {
      scope: originalScope,
      location: originalLocation,
      moved: originalScope.pageNumber !== annotation.target.pageNumber || positionMoved,
    };
  }

  const quoteOnlySelector = { ...annotation.target.selector, position: undefined };
  const confidenceRank = { context: 2, quote: 1 };
  const candidates = scopes
    .map((scope) => ({ scope, location: locateTextQuote(scope.text, quoteOnlySelector) }))
    .filter((candidate) => candidate.location);
  candidates.sort((left, right) => (
    (confidenceRank[right.location.confidence] ?? 0) - (confidenceRank[left.location.confidence] ?? 0)
    || normalizeBookText(left.scope.text).length - normalizeBookText(right.scope.text).length
    || (right.scope.depth ?? 0) - (left.scope.depth ?? 0)
  ));
  if (candidates.length === 0) return null;
  const best = candidates[0];
  const equallySpecific = candidates[1]
    && candidates[1].location.confidence === best.location.confidence
    && normalizeBookText(candidates[1].scope.text).length === normalizeBookText(best.scope.text).length
    && (candidates[1].scope.depth ?? 0) === (best.scope.depth ?? 0);
  if (equallySpecific) return null;
  return { ...best, moved: true };
}

export function movedTextTarget(annotation, resolved) {
  return {
    ...annotation.target,
    scopeId: resolved.scope.scopeId,
    pageNumber: resolved.scope.pageNumber,
    label: resolved.scope.label,
    selector: {
      ...annotation.target.selector,
      position: { start: resolved.location.start, end: resolved.location.end },
    },
  };
}
