import assert from "node:assert/strict";
import { test } from "bun:test";

import { permissionsForPrincipal, publicCapabilities, resolveAccessPolicy, validateScopes } from "./access-policy.mjs";

const guest = { kind: "guest", id: "guest-1" };
const reviewer = { kind: "user", id: "user-1", globalRole: "user", bookId: "book-1", role: "reviewer" };

test("all access presets expose the intended reader and reviewer capabilities", () => {
  const cases = {
    local: { guest: [true, true, true, true], reviewer: [true, true, true, true] },
    publicRead: { guest: [true, false, false, false], reviewer: [true, false, false, false] },
    publicOpenReview: { guest: [true, true, true, true], reviewer: [true, true, true, true] },
    publicMemberReview: { guest: [true, false, true, false], reviewer: [true, true, true, true] },
    publicInviteReview: { guest: [true, false, true, false], reviewer: [true, true, true, true] },
    privateRead: { guest: [false, false, false, false], reviewer: [true, false, false, false] },
    privateReview: { guest: [false, false, false, false], reviewer: [true, true, true, true] },
  };

  for (const [preset, expected] of Object.entries(cases)) {
    const policy = resolveAccessPolicy({ preset });
    for (const [name, principal] of Object.entries({ guest, reviewer })) {
      const capabilities = publicCapabilities(policy, principal, "book-1");
      assert.deepEqual(
        [capabilities.canRead, capabilities.canCreateAnnotations, capabilities.canViewAnnotations, capabilities.canRespondToSurveys],
        expected[name],
        `${preset}/${name}`,
      );
    }
  }
});

test("custom policies, token book boundaries and scope validation fail closed", () => {
  const custom = resolveAccessPolicy({ preset: "publicRead", reading: "authenticated" });
  assert.equal(publicCapabilities(custom, guest, "book-1").canRead, false);
  assert.equal(publicCapabilities(custom, reviewer, "book-1").canRead, true);
  const foreignToken = { kind: "token", bookId: "book-2", scopes: ["books:read", "annotations:write"] };
  assert.deepEqual([...permissionsForPrincipal(foreignToken, "book-1")], []);
  assert.deepEqual(validateScopes(["books:read", "books:read"]), ["books:read"]);
  assert.throws(() => resolveAccessPolicy({ preset: "missing" }), /Ukendt access.preset/);
  assert.throws(() => resolveAccessPolicy({ preset: "local", progressTracking: "always" }), /access.progressTracking/);
  assert.throws(() => validateScopes(["root"]), /Ukendte token-permissions/);
});

test("explicit per-book grants and instance-admin tokens do not bleed across books", () => {
  const multiBookUser = {
    kind: "user",
    id: "user-2",
    globalRole: "user",
    memberships: [
      { bookId: "book-a", role: "reader", permissions: ["annotations:write"] },
      { bookId: "book-b", role: "publisher", permissions: [] },
    ],
  };
  assert.deepEqual(
    [...permissionsForPrincipal(multiBookUser, "book-a")].sort(),
    ["annotations:write", "books:read", "progress:read:self", "surveys:respond"].sort(),
  );
  assert.equal(permissionsForPrincipal(multiBookUser, "book-b").has("books:publish"), true);
  assert.deepEqual([...permissionsForPrincipal(multiBookUser, "book-c")], []);

  const multiBookToken = {
    kind: "token",
    instanceAdmin: false,
    bookGrants: [
      { bookId: "book-a", permissions: ["books:read"] },
      { bookId: "book-b", permissions: ["annotations:write"] },
    ],
  };
  assert.deepEqual([...permissionsForPrincipal(multiBookToken, "book-a")], ["books:read"]);
  assert.deepEqual([...permissionsForPrincipal(multiBookToken, "book-c")], []);
  assert.equal(permissionsForPrincipal({ kind: "token", instanceAdmin: true }, "book-c").has("access:manage"), true);
  assert.equal(resolveAccessPolicy({ preset: "publicRead", registration: "code" }).registration, "code");
  assert.equal(resolveAccessPolicy({ preset: "publicRead", registration: "closed" }).registration, "closed");
});
