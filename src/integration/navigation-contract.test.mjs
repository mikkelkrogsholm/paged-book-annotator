import assert from "node:assert/strict";
import { test } from "bun:test";

import { validateNavigationDocumentXhtml } from "./navigation-contract.mjs";

const bookHtml = `
  <section id="cover" data-book-anchor="cover"></section>
  <section id="chapter-1" data-book-anchor="chapter-1"></section>
  <section id="chapter-2" data-book-anchor="chapter-2"></section>`;

const navigationXhtml = `<?xml version="1.0" encoding="utf-8"?>
  <!DOCTYPE html>
  <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
    <body>
      <nav epub:type="toc"><ol>
        <li><a href="book.html#chapter-1">Kapitel 1</a></li>
        <li><a href="book.html#chapter-2">Kapitel 2</a></li>
      </ol></nav>
      <nav epub:type="landmarks"><ol>
        <li><a href="book.html#cover">Forside</a></li>
      </ol></nav>
    </body>
  </html>`;

test("navigation contract accepts a generic EPUB-inspired hierarchy", () => {
  assert.deepEqual(
    validateNavigationDocumentXhtml(navigationXhtml, { bookHtml, documentName: "book.html" }),
    { tocLinks: 2, landmarkLinks: 1 },
  );
});

test("navigation contract rejects missing book targets", () => {
  assert.throws(
    () => validateNavigationDocumentXhtml(
      navigationXhtml.replace("#chapter-2", "#missing"),
      { bookHtml, documentName: "book.html" },
    ),
    /ukendt boganker: missing/,
  );
});

test("navigation contract rejects an XML-invalid lowercase doctype", () => {
  assert.throws(
    () => validateNavigationDocumentXhtml(
      navigationXhtml.replace("<!DOCTYPE html>", "<!doctype html>"),
      { bookHtml, documentName: "book.html" },
    ),
    /gyldig XHTML-DOCTYPE/,
  );
});
