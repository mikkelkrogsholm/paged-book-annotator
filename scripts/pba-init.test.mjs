import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { chooseDocument, slug } from "./pba-init.mjs";

test("init helpers choose the canonical book document and create stable ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pba-init-"));
  try {
    await writeFile(join(directory, "book.html"), "<!doctype html>");
    await writeFile(join(directory, "notes.xhtml"), "<html></html>");
    assert.equal(await chooseDocument(directory), "book.html");
    assert.equal(slug("Åben Bog — prøve"), "aben-bog-pr-ve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
