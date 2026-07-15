const EPUB_TYPE_ATTRIBUTE = /(?:^|\s)epub:type\s*=\s*["']([^"']+)["']/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function navigationBlocks(xhtml) {
  return [...xhtml.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)].map((match) => ({
    types: (match[1].match(EPUB_TYPE_ATTRIBUTE)?.[1] ?? "").split(/\s+/).filter(Boolean),
    html: match[2],
  }));
}

function linksFromBlock(block) {
  return [...block.html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: match[1],
    label: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

function documentHasTarget(bookHtml, target) {
  const escaped = escapeRegExp(target);
  return new RegExp(`\\bid=["']${escaped}["']`).test(bookHtml)
    || new RegExp(`\\bdata-book-anchor=["']${escaped}["']`).test(bookHtml);
}

function validateLinks(links, { bookHtml, documentName, scope }) {
  if (links.length === 0) throw new TypeError(`${scope} indeholder ingen destinationslinks.`);
  const seen = new Set();
  for (const link of links) {
    if (!link.label) throw new TypeError(`${scope} indeholder et link uden læsbar titel.`);
    if (seen.has(link.href)) throw new TypeError(`${scope} indeholder destinationen flere gange: ${link.href}`);
    seen.add(link.href);

    const hashIndex = link.href.indexOf("#");
    if (hashIndex < 0 || hashIndex === link.href.length - 1) {
      throw new TypeError(`${scope} kræver et stabilt fragment i destinationen: ${link.href}`);
    }
    const path = link.href.slice(0, hashIndex);
    if (path && path !== documentName) {
      throw new TypeError(`${scope} må kun navigere i bogdokumentet ${documentName}: ${link.href}`);
    }
    const target = decodeURIComponent(link.href.slice(hashIndex + 1));
    if (!documentHasTarget(bookHtml, target)) {
      throw new TypeError(`${scope} peger på et ukendt boganker: ${target}`);
    }
  }
}

export function validateNavigationDocumentXhtml(xhtml, { bookHtml, documentName }) {
  if (typeof xhtml !== "string" || xhtml.length === 0) throw new TypeError("Navigationsdokumentet er tomt.");
  if (!/^\s*<\?xml[^>]*\?>\s*<!DOCTYPE html>/.test(xhtml)) {
    throw new TypeError("Navigationsdokumentet skal begynde med XML-deklaration og gyldig XHTML-DOCTYPE.");
  }
  if (!/xmlns:epub=["']http:\/\/www\.idpf\.org\/2007\/ops["']/.test(xhtml)) {
    throw new TypeError("Navigationsdokumentet mangler EPUB-namespace.");
  }

  const blocks = navigationBlocks(xhtml);
  const toc = blocks.find((block) => block.types.includes("toc"));
  const landmarks = blocks.find((block) => block.types.includes("landmarks"));
  if (!toc) throw new TypeError("Navigationsdokumentet mangler nav med epub:type=\"toc\".");
  if (!landmarks) throw new TypeError("Navigationsdokumentet mangler nav med epub:type=\"landmarks\".");
  if (!/<ol\b/i.test(toc.html)) throw new TypeError("Indholdsfortegnelsen mangler et hierarkisk ol-element.");

  const tocLinks = linksFromBlock(toc);
  const landmarkLinks = linksFromBlock(landmarks);
  validateLinks(tocLinks, { bookHtml, documentName, scope: "Indholdsfortegnelsen" });
  validateLinks(landmarkLinks, { bookHtml, documentName, scope: "Landemærkerne" });

  return {
    tocLinks: tocLinks.length,
    landmarkLinks: landmarkLinks.length,
  };
}
