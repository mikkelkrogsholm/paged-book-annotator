import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  currentNavigationEntry,
  matchingNavigationEntries,
  normalizedSearchText,
  targetFromHref,
} from "./navigation-controller.js";

const entries = [
  { label: "Vers 30 · Gæstens ret", path: ["At træde ind", "Vers 30 · Gæstens ret"], pageNumber: 76 },
  { label: "Vers 76 · Det, der ikke dør", path: ["Gaven og navnet", "Vers 76 · Det, der ikke dør"], pageNumber: 170 },
  { label: "Vers 79 · Når hovmodet vokser", path: ["Gaven og navnet", "Vers 79 · Når hovmodet vokser"], pageNumber: 176 },
];

test("navigation search matches titles, hierarchy and physical Paged.js pages", () => {
  assert.deepEqual(matchingNavigationEntries(entries, "vers 76"), [entries[1]]);
  assert.deepEqual(matchingNavigationEntries(entries, "side 76"), [entries[0]]);
  assert.deepEqual(matchingNavigationEntries(entries, "gæstens ret"), [entries[0]]);
  assert.deepEqual(matchingNavigationEntries(entries, "gaven og navnet"), [entries[1], entries[2]]);
});

test("current navigation follows the last logical target reached by a spread", () => {
  assert.equal(currentNavigationEntry(entries, [170, 171]), entries[1]);
  assert.equal(currentNavigationEntry(entries, [174, 175]), entries[1]);
  assert.equal(currentNavigationEntry(entries, [1]), null);
});

test("navigation helpers normalize Danish labels and stable fragments", () => {
  assert.equal(normalizedSearchText("  Hávamál · Gæst  "), "havamal gæst");
  assert.equal(targetFromHref("book.html#chapter-01"), "chapter-01");
});
