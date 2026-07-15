import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildTextQuoteSelector, locateTextQuote, normalizeBookText } from "./text-anchor.js";

test("quote selector reattaches after text moves within the same scope", () => {
  const original = "Før teksten. Det oldnordiske rum. Efter teksten.";
  const selector = buildTextQuoteSelector(original, "Det oldnordiske rum");
  const moved = "En ny begyndelse. Før teksten. Det oldnordiske rum. Efter teksten.";
  const located = locateTextQuote(moved, selector);
  assert.equal(moved.slice(located.start, located.end), "Det oldnordiske rum");
  assert.equal(located.confidence, "context");
});

test("quote selector refuses an ambiguous quote without matching context", () => {
  const selector = {
    type: "TextQuoteSelector",
    exact: "den åbne dør",
    prefix: "ukendt",
    suffix: "kontekst",
  };
  assert.equal(locateTextQuote("den åbne dør og senere den åbne dør", selector), null);
});

test("book text normalization collapses line breaks without changing words", () => {
  assert.equal(normalizeBookText("  Alle døre\n  skal man undersøge "), "Alle døre skal man undersøge");
});

test("quote context matches across normalized word-boundary whitespace", () => {
  const selector = buildTextQuoteSelector("Før. Alle døre skal undersøges. Efter.", "Alle døre", 6);
  const location = locateTextQuote("Ny indledning. Før. Alle   døre skal undersøges. Efter.", {
    ...selector,
    position: undefined,
  });
  assert.equal(location.confidence, "context");
});
