function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function requireLimit(value, fallback = 20) {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("limit skal være et heltal mellem 1 og 50.");
  return limit;
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const offset = Number(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid");
    return offset;
  } catch {
    throw new TypeError("cursor er ugyldig.");
  }
}

function encodeCursor(offset, length) {
  return offset < length ? Buffer.from(String(offset)).toString("base64url") : null;
}

function page(items, { cursor, limit } = {}) {
  const offset = decodeCursor(cursor);
  const pageSize = requireLimit(limit);
  const selected = items.slice(offset, offset + pageSize);
  return { items: selected, nextCursor: encodeCursor(offset + selected.length, items.length), total: items.length };
}

export class BookContentIndex {
  constructor({ filePath, bookId, buildId = "" }) {
    this.filePath = filePath;
    this.bookId = bookId;
    this.buildId = buildId;
    this.cached = null;
  }

  async load() {
    if (this.cached) return this.cached;
    const sections = [];
    const stack = [];
    const rewriter = new HTMLRewriter().on("[data-book-anchor]", {
      element(element) {
        const section = {
          anchorId: element.getAttribute("data-book-anchor"),
          label: element.getAttribute("aria-label") || element.getAttribute("data-book-label") || "",
          tagName: element.tagName,
          textParts: [],
        };
        sections.push(section);
        stack.push(section);
        element.onEndTag(() => { stack.pop(); });
      },
      text(text) {
        // A stable section anchor remains a valid target when its readable
        // text lives in nested, independently anchored headings or paragraphs.
        // Record text for every open anchored ancestor, not only the leaf.
        for (const section of stack) section.textParts.push(text.text);
      },
    });
    await rewriter.transform(new Response(Bun.file(this.filePath))).text();
    const normalized = sections.map((section) => {
      const text = normalizeText(section.textParts.join(" "));
      return { anchorId: section.anchorId, label: normalizeText(section.label) || text.slice(0, 100), tagName: section.tagName, text };
    }).filter((section) => section.anchorId && section.text);
    this.cached = {
      bookId: this.bookId,
      buildId: this.buildId,
      sections: normalized,
      byAnchor: new Map(normalized.map((section) => [section.anchorId, section])),
    };
    return this.cached;
  }

  async outline(options) {
    const index = await this.load();
    const headings = index.sections.filter((section) => /^h[1-6]$/.test(section.tagName));
    return { bookId: this.bookId, buildId: this.buildId, ...page(headings.map(({ text, ...heading }) => ({ ...heading, title: text })), options) };
  }

  async section(anchorId) {
    const index = await this.load();
    return index.byAnchor.get(String(anchorId)) ?? null;
  }

  async search(query, options) {
    const search = normalizeText(query).toLocaleLowerCase();
    if (search.length < 2) throw new TypeError("query skal være mindst 2 tegn.");
    const index = await this.load();
    const matches = index.sections.filter((section) => `${section.label} ${section.text}`.toLocaleLowerCase().includes(search));
    return { bookId: this.bookId, buildId: this.buildId, query: normalizeText(query), ...page(matches, options) };
  }
}
