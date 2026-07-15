export function normalizeBookText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function locateTextQuote(text, selector) {
  const normalizedText = normalizeBookText(text);
  const exact = normalizeBookText(selector?.exact);
  if (!exact) return null;

  const savedPosition = selector.position;
  if (savedPosition && normalizedText.slice(savedPosition.start, savedPosition.end) === exact) {
    return { start: savedPosition.start, end: savedPosition.end, confidence: "position" };
  }

  const candidates = [];
  let fromIndex = 0;
  while (fromIndex <= normalizedText.length - exact.length) {
    const start = normalizedText.indexOf(exact, fromIndex);
    if (start < 0) break;
    const end = start + exact.length;
    let score = 0;
    const prefix = normalizeBookText(selector.prefix);
    const suffix = normalizeBookText(selector.suffix);
    const textBefore = normalizeBookText(normalizedText.slice(0, start));
    const textAfter = normalizeBookText(normalizedText.slice(end));
    if (prefix && textBefore.endsWith(prefix)) score += 2;
    if (suffix && textAfter.startsWith(suffix)) score += 2;
    candidates.push({ start, end, score });
    fromIndex = start + 1;
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score || left.start - right.start);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score && candidates[0].score === 0) return null;
  return { start: candidates[0].start, end: candidates[0].end, confidence: candidates[0].score ? "context" : "quote" };
}

export function buildTextQuoteSelector(scopeText, exactText, approximateStart = null) {
  const text = normalizeBookText(scopeText);
  const exact = normalizeBookText(exactText);
  if (!exact) throw new TypeError("En tekstannotation kræver markeret tekst.");

  let start = Number.isInteger(approximateStart) ? approximateStart : text.indexOf(exact);
  if (text.slice(start, start + exact.length) !== exact) start = text.indexOf(exact);
  if (start < 0) throw new TypeError("Den markerede tekst findes ikke i annotationsmålet.");
  const end = start + exact.length;
  return {
    type: "TextQuoteSelector",
    exact,
    prefix: text.slice(Math.max(0, start - 48), start),
    suffix: text.slice(end, Math.min(text.length, end + 48)),
    position: { start, end },
  };
}

export function buildNormalizedTextIndex(root) {
  const document = root.ownerDocument;
  const showText = document.defaultView.NodeFilter.SHOW_TEXT;
  const walker = document.createTreeWalker(root, showText);
  const characters = [];
  const positions = [];
  let previousWasSpace = true;
  let node = walker.nextNode();

  while (node) {
    for (let offset = 0; offset < node.data.length; offset += 1) {
      const character = node.data[offset];
      const isSpace = /\s/.test(character);
      if (isSpace) {
        if (!previousWasSpace) {
          characters.push(" ");
          positions.push({ node, startOffset: offset, endOffset: offset + 1 });
        }
        previousWasSpace = true;
      } else {
        characters.push(character);
        positions.push({ node, startOffset: offset, endOffset: offset + 1 });
        previousWasSpace = false;
      }
    }
    node = walker.nextNode();
  }

  if (characters.at(-1) === " ") {
    characters.pop();
    positions.pop();
  }
  return { text: characters.join(""), positions };
}

export function createRangeFromTextPosition(scope, position) {
  const index = buildNormalizedTextIndex(scope);
  if (position.start < 0 || position.end > index.positions.length || position.end <= position.start) return null;
  const first = index.positions[position.start];
  const last = index.positions[position.end - 1];
  if (!first || !last) return null;
  const range = scope.ownerDocument.createRange();
  range.setStart(first.node, first.startOffset);
  range.setEnd(last.node, last.endOffset);
  return range;
}

export function selectionStartInScope(scope, selectionRange) {
  const index = buildNormalizedTextIndex(scope);
  const startNode = selectionRange.startContainer;
  const startOffset = selectionRange.startOffset;
  const indexPosition = index.positions.findIndex((position) => (
    position.node === startNode && position.endOffset > startOffset
  ));
  return indexPosition >= 0 ? indexPosition : null;
}
