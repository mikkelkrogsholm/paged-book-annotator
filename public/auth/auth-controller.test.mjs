import assert from "node:assert/strict";
import test from "node:test";

import { consumeCredentialQuery } from "./auth-controller.js";

test("credential query values are consumed without remaining in browser history", () => {
  const replacements = [];
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?invite=secret-invite&code=secret-code&annotation=a-1#page=2" },
    { replaceState: (_state, _title, value) => replacements.push(value) },
  );

  assert.deepEqual(credentials, { invitation: "secret-invite", accessCode: "secret-code" });
  assert.deepEqual(replacements, ["/books/poems?annotation=a-1#page=2"]);
});

test("ordinary reader URLs do not create redundant history entries", () => {
  let replacements = 0;
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?annotation=a-1" },
    { replaceState: () => { replacements += 1; } },
  );

  assert.deepEqual(credentials, { invitation: null, accessCode: null });
  assert.equal(replacements, 0);
});

test("empty credential parameters are still removed from browser history", () => {
  const replacements = [];
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?invite=&annotation=a-1" },
    { replaceState: (_state, _title, value) => replacements.push(value) },
  );

  assert.deepEqual(credentials, { invitation: "", accessCode: null });
  assert.deepEqual(replacements, ["/books/poems?annotation=a-1"]);
});
