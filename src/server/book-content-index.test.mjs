import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { BookContentIndex } from "./book-content-index.mjs";

test("book content index exposes stable outline, section text, search and cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "book-content-index-"));
  const filePath = join(directory, "book.html");
  await writeFile(filePath, `<!doctype html><main>
    <h1 data-book-anchor="chapter-1">Første kapitel</h1>
    <p data-book-anchor="chapter-1.p-1">Et præcist prøveafsnit om nordiske rum.</p>
    <section data-book-anchor="chapter-1.review" data-book-label="Kapitelreview">
      <h2 data-book-anchor="chapter-1.review.title">Indlejret overskrift</h2>
      <p data-book-anchor="chapter-1.review.p-1">Indlejret brødtekst.</p>
    </section>
    <h2 data-book-anchor="chapter-2">Andet kapitel</h2>
  </main>`);
  try {
    const index = new BookContentIndex({ filePath, bookId: "book-1", buildId: "build-a" });
    const first = await index.outline({ limit: 1 });
    assert.equal(first.items[0].anchorId, "chapter-1");
    assert.ok(first.nextCursor);
    const second = await index.outline({ cursor: first.nextCursor, limit: 1 });
    assert.equal(second.items[0].anchorId, "chapter-1.review.title");
    assert.equal((await index.outline({ cursor: second.nextCursor, limit: 1 })).items[0].anchorId, "chapter-2");
    assert.equal((await index.section("chapter-1.p-1")).text, "Et præcist prøveafsnit om nordiske rum.");
    assert.equal((await index.section("chapter-1.review")).text, "Indlejret overskrift Indlejret brødtekst.");
    assert.equal((await index.search("nordiske")).items[0].anchorId, "chapter-1.p-1");
    await assert.rejects(() => index.search("x"), /mindst 2/);
    await assert.rejects(() => index.outline({ cursor: "ikke-en-cursor" }), /cursor/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
