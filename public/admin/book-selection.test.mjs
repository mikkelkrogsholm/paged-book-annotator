import assert from "node:assert/strict";
import test from "node:test";

import { selectActiveBookId } from "./book-selection.js";

test("admin book selection never promotes an archived book to the active workspace", () => {
  const books = [
    { id: "archived", status: "archived" },
    { id: "draft", status: "draft" },
    { id: "published", status: "published" },
  ];

  assert.equal(selectActiveBookId(books, "archived"), "draft");
  assert.equal(selectActiveBookId(books, "published"), "published");
  assert.equal(selectActiveBookId(books, "missing"), "draft");
  assert.equal(selectActiveBookId([{ id: "archived", status: "archived" }], "archived"), null);
  assert.equal(selectActiveBookId([], null), null);
});
