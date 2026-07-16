export function validateBookDocumentHtml(html, { requirePagination = false } = {}) {
  if (typeof html !== "string" || html.length === 0) throw new TypeError("Bogdokumentet er tomt.");
  if (requirePagination) {
    const hasPageContainer = /class=["'][^"']*\bpagedjs_pages\b[^"']*["']/i.test(html);
    const hasPage = /class=["'][^"']*\bpagedjs_page\b[^"']*["']/i.test(html);
    const pagedComplete = /<html\b[^>]*\bdata-paged-complete=["']true["']/i.test(html);
    const prePaginated = /<body\b[^>]*\bdata-pre-paginated=["']true["']/i.test(html);
    if (!hasPageContainer || !hasPage || (!pagedComplete && !prePaginated)) {
      throw new TypeError("Bogdokumentet skal indeholde Paged.js-sider og markere fuldført eller præpagineret output.");
    }
  }
  const anchorMatches = [...html.matchAll(/\bdata-book-anchor\s*=\s*(["'])(.*?)\1/gi)];
  if (anchorMatches.length === 0) throw new TypeError("Bogdokumentet har ingen data-book-anchor-attributter.");

  const counts = new Map();
  for (const match of anchorMatches) counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([anchor]) => anchor);
  if (duplicates.length > 0) throw new TypeError(`Dublerede bogankre: ${duplicates.slice(0, 8).join(", ")}`);

  const annotatableTags = [...html.matchAll(/<[^>]+\bdata-annotation-text\b[^>]*>/gi)];
  const missingAnchors = annotatableTags.filter((match) => !/\bdata-book-anchor\s*=\s*(["']).*?\1/i.test(match[0]));
  if (missingAnchors.length > 0) {
    throw new TypeError(`${missingAnchors.length} tekstmål mangler data-book-anchor.`);
  }

  return {
    anchors: anchorMatches.length,
    textAnchors: annotatableTags.length,
    pageLabels: (html.match(/data-book-page-label=/g) ?? []).length,
  };
}
