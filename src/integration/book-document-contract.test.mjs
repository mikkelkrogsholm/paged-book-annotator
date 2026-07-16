import assert from "node:assert/strict";
import { test } from "bun:test";

import { validateBookDocumentHtml } from "./book-document-contract.mjs";

test("book contract reports stable and annotatable anchors", () => {
  const result = validateBookDocumentHtml(`
    <section data-book-anchor="chapter-1" data-book-page-label="Kapitel 1">
      <p data-book-anchor="chapter-1.paragraph-1" data-annotation-text>Tekst</p>
    </section>`);
  assert.deepEqual(result, { anchors: 2, textAnchors: 1, pageLabels: 1 });
});

test("book contract rejects duplicate anchors", () => {
  assert.throws(() => validateBookDocumentHtml(`
    <p data-book-anchor="same">Et</p>
    <p data-book-anchor="same">To</p>`), /Dublerede bogankre/);
});

test("book contract accepts single-quoted anchors and flexible equals spacing", () => {
  const result = validateBookDocumentHtml(`
    <section data-book-anchor = 'chapter-1'>
      <p data-annotation-text data-book-anchor='chapter-1.paragraph-1'>Tekst</p>
    </section>`);

  assert.deepEqual(result, { anchors: 2, textAnchors: 1, pageLabels: 0 });
});

test("book contract detects duplicates across single and double quotes", () => {
  assert.throws(() => validateBookDocumentHtml(`
    <p data-book-anchor='same'>Et</p>
    <p data-book-anchor="same">To</p>`), /Dublerede bogankre/);
});
