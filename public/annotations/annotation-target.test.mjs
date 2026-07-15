import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createElementAnnotationDraft,
  createPageAnnotationDraft,
  createTextAnnotationDraft,
  movedTextTarget,
  resolveTextAnnotationTarget,
} from "./annotation-target.js";

test("draft builders preserve precise text, element and page targets", () => {
  const text = createTextAnnotationDraft({
    scopeId: "stanza-001.companion.paragraph-04",
    pageNumber: 15,
    label: "Ledsager 001, afsnit 4",
    scopeText: "Før. Det oldnordiske rum. Efter.",
    selectedText: "Det oldnordiske rum",
    approximateStart: 5,
  });
  assert.equal(text.target.selector.exact, "Det oldnordiske rum");
  assert.deepEqual(text.target.selector.position, { start: 5, end: 24 });

  const element = createElementAnnotationDraft({ scopeId: "stanza-001.companion.title", pageNumber: 15, label: "Titel" });
  assert.equal(element.type, "element");
  assert.equal(element.target.scopeId, "stanza-001.companion.title");

  const page = createPageAnnotationDraft({ scopeId: "stanza-001.poem", pageNumber: 14, label: "Side 14" });
  assert.equal(page.type, "page");
  assert.equal(page.target.pageNumber, 14);
});

test("a single visible character can be a text annotation", () => {
  const draft = createTextAnnotationDraft({
    scopeId: "viewer:cover::page-number",
    pageNumber: 1,
    label: "Sidetal: 1",
    scopeText: "1",
    selectedText: "1",
    approximateStart: 0,
  });
  assert.equal(draft.target.selector.exact, "1");
});

test("text target reattaches uniquely after its stable scope changes", () => {
  const annotation = {
    ...createTextAnnotationDraft({
      scopeId: "old-scope",
      pageNumber: 15,
      label: "Gammelt afsnit",
      scopeText: "Før. Det oldnordiske rum. Efter.",
      selectedText: "Det oldnordiske rum",
      approximateStart: 5,
    }),
    comment: "Test",
  };
  const resolved = resolveTextAnnotationTarget(annotation, [
    { scopeId: "unrelated", pageNumber: 14, label: "Andet", text: "En anden tekst." },
    { scopeId: "new-scope", pageNumber: 16, label: "Nyt afsnit", text: "Ny begyndelse. Før. Det oldnordiske rum. Efter." },
  ]);
  assert.equal(resolved.scope.scopeId, "new-scope");
  assert.equal(resolved.moved, true);
  assert.equal(movedTextTarget(annotation, resolved).pageNumber, 16);
});

test("text target refreshes its position after text moves inside the same scope", () => {
  const annotation = {
    ...createTextAnnotationDraft({
      scopeId: "same-scope",
      pageNumber: 15,
      label: "Afsnit",
      scopeText: "Før. Det oldnordiske rum. Efter.",
      selectedText: "Det oldnordiske rum",
      approximateStart: 5,
    }),
    comment: "Test",
  };
  const resolved = resolveTextAnnotationTarget(annotation, [{
    scopeId: "same-scope",
    pageNumber: 15,
    label: "Afsnit",
    text: "Ny begyndelse. Før. Det oldnordiske rum. Efter.",
  }]);
  assert.equal(resolved.moved, true);
  assert.deepEqual(movedTextTarget(annotation, resolved).selector.position, { start: 20, end: 39 });
});

test("text target becomes orphaned rather than choosing an ambiguous match", () => {
  const annotation = {
    ...createTextAnnotationDraft({
      scopeId: "missing",
      pageNumber: 15,
      label: "Mangler",
      scopeText: "Det oldnordiske rum",
      selectedText: "Det oldnordiske rum",
      approximateStart: 0,
    }),
    comment: "Test",
  };
  const resolved = resolveTextAnnotationTarget(annotation, [
    { scopeId: "one", pageNumber: 20, label: "Et", text: "Det oldnordiske rum" },
    { scopeId: "two", pageNumber: 21, label: "To", text: "Det oldnordiske rum" },
  ]);
  assert.equal(resolved, null);
});

test("text target prefers the most specific nested scope for one physical quote", () => {
  const annotation = {
    ...createTextAnnotationDraft({
      scopeId: "missing",
      pageNumber: 14,
      label: "Gammelt mål",
      scopeText: "Alle døre skal man undersøge",
      selectedText: "Alle døre",
      approximateStart: 0,
    }),
    comment: "Test",
  };
  const resolved = resolveTextAnnotationTarget(annotation, [
    { scopeId: "whole-page", pageNumber: 14, label: "Side", text: "001 Alle døre skal man undersøge", depth: 3 },
    { scopeId: "poem", pageNumber: 14, label: "Digt", text: "Alle døre skal man undersøge", depth: 8 },
    { scopeId: "line", pageNumber: 14, label: "Linje", text: "Alle døre", depth: 11 },
  ]);
  assert.equal(resolved.scope.scopeId, "poem");
});
