import assert from "node:assert/strict";
import test from "node:test";

import { consumeCredentialQuery } from "./auth-controller.js";

test("credential query values are consumed without remaining in browser history", () => {
  const replacements = [];
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?invite=secret-invite&code=secret-code&annotation=a-1#page=2" },
    { replaceState: (_state, _title, value) => replacements.push(value) },
  );

  assert.deepEqual(credentials, { invitation: "secret-invite", accessCode: "secret-code", loginRequested: false, next: null });
  assert.deepEqual(replacements, ["/books/poems?annotation=a-1#page=2"]);
});

test("ordinary reader URLs do not create redundant history entries", () => {
  let replacements = 0;
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?annotation=a-1" },
    { replaceState: () => { replacements += 1; } },
  );

  assert.deepEqual(credentials, { invitation: null, accessCode: null, loginRequested: false, next: null });
  assert.equal(replacements, 0);
});

test("empty credential parameters are still removed from browser history", () => {
  const replacements = [];
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/books/poems?invite=&annotation=a-1" },
    { replaceState: (_state, _title, value) => replacements.push(value) },
  );

  assert.deepEqual(credentials, { invitation: "", accessCode: null, loginRequested: false, next: null });
  assert.deepEqual(replacements, ["/books/poems?annotation=a-1"]);
});

test("admin login requests retain only a same-origin return path", () => {
  const replacements = [];
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/?login=1&next=%2Fadmin%3Fbook%3Ddraft" },
    { replaceState: (_state, _title, value) => replacements.push(value) },
  );
  assert.deepEqual(credentials, { invitation: null, accessCode: null, loginRequested: true, next: "/admin?book=draft" });
  assert.deepEqual(replacements, ["/"]);
});

test("admin login requests reject cross-origin return paths", () => {
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/?login=1&next=https%3A%2F%2Fevil.test%2Fsteal" },
    { replaceState: () => {} },
  );
  assert.equal(credentials.next, null);
});

test("admin login requests tolerate malformed return paths", () => {
  const credentials = consumeCredentialQuery(
    { href: "https://reader.test/?login=1&next=%2F%2F%5B" },
    { replaceState: () => {} },
  );
  assert.equal(credentials.next, null);
});
