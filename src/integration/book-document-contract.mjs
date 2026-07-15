export function validateBookDocumentHtml(html) {
  if (typeof html !== "string" || html.length === 0) throw new TypeError("Bogdokumentet er tomt.");
  const anchorMatches = [...html.matchAll(/data-book-anchor="([^"]+)"/g)];
  if (anchorMatches.length === 0) throw new TypeError("Bogdokumentet har ingen data-book-anchor-attributter.");

  const counts = new Map();
  for (const match of anchorMatches) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([anchor]) => anchor);
  if (duplicates.length > 0) throw new TypeError(`Dublerede bogankre: ${duplicates.slice(0, 8).join(", ")}`);

  const annotatableTags = [...html.matchAll(/<[^>]+data-annotation-text[^>]*>/g)];
  const missingAnchors = annotatableTags.filter((match) => !match[0].includes("data-book-anchor="));
  if (missingAnchors.length > 0) {
    throw new TypeError(`${missingAnchors.length} tekstmål mangler data-book-anchor.`);
  }

  return {
    anchors: anchorMatches.length,
    textAnchors: annotatableTags.length,
    pageLabels: (html.match(/data-book-page-label=/g) ?? []).length,
  };
}
