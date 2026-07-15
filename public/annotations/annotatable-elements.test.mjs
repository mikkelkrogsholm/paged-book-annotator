import assert from "node:assert/strict";
import { test } from "bun:test";

import { createDerivedAnchor, labelFromElementMetadata } from "./annotatable-elements.js";

test("explicit book anchors remain the canonical runtime identity", () => {
  assert.equal(createDerivedAnchor({
    explicitAnchor: "stanza-001.old-norse.line-01",
    nearestBookAnchor: "stanza-001.old-norse",
    pageAnchor: "stanza-001.poem",
    path: "p",
  }), "stanza-001.old-norse.line-01");
});

test("unmarked book elements receive stable paths below their nearest book anchor", () => {
  assert.equal(createDerivedAnchor({
    nearestBookAnchor: "stanza-001.poem",
    pageAnchor: "stanza-001.poem",
    path: "div.poem-index",
  }), "viewer:stanza-001.poem::div.poem-index");
  assert.equal(labelFromElementMetadata({ text: "001", className: "poem-index", pageNumber: 14 }), "Tekst: “001”");
});

test("running heads and folios use page furniture identities and useful labels", () => {
  assert.equal(createDerivedAnchor({
    pageAnchor: "stanza-001.poem",
    marginRole: "top-left",
    path: "div/div",
  }), "viewer:stanza-001.poem::page-furniture:top-left::div/div");
  assert.equal(labelFromElementMetadata({
    text: "DEN HØJES TALE",
    marginRole: "top-left",
    pageNumber: 14,
  }), "Sidehoved, venstre: “DEN HØJES TALE”");
  assert.equal(labelFromElementMetadata({
    text: "14",
    marginRole: "bottom-left",
    pageNumber: 14,
  }), "Sidetal eller sidefod, venstre: “14”");
});

test("generated Paged.js elements may omit every optional label", () => {
  assert.equal(labelFromElementMetadata({
    bookLabel: null,
    ariaLabel: null,
    text: null,
    marginRole: "",
    className: null,
    tagName: "div",
    pageNumber: 14,
  }), "div på side 14");
});
