import assert from "node:assert/strict";
import test from "node:test";

import { readerShortcutIsBlocked } from "./book-reader.js";

function eventFor(selector = null, overrides = {}) {
  return {
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target: { closest: () => selector ? {} : null },
    ...overrides,
  };
}

test("reader shortcuts never hijack controls, modifiers, or an open auth dialog", () => {
  const noDialog = { querySelector: () => null };
  const openDialog = { querySelector: () => ({ open: true }) };
  assert.equal(readerShortcutIsBlocked(eventFor("button"), noDialog), true);
  assert.equal(readerShortcutIsBlocked(eventFor(null, { ctrlKey: true }), noDialog), true);
  assert.equal(readerShortcutIsBlocked(eventFor(), openDialog), true);
  assert.equal(readerShortcutIsBlocked(eventFor(), noDialog), false);
});
