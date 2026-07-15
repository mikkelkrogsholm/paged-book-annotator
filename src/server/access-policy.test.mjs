import assert from "node:assert/strict";
import { test } from "bun:test";

import { permissionsForPrincipal, publicCapabilities, resolveAccessPolicy, validateScopes } from "./access-policy.mjs";

const guest = { kind: "guest", id: "guest-1" };
const reviewer = { kind: "user", id: "user-1", globalRole: "user", bookId: "book-1", role: "reviewer" };

test("all access presets expose the intended reader and reviewer capabilities", () => {
  const cases = {
    local: { guest: [true, true, true], reviewer: [true, true, true] },
    publicRead: { guest: [true, false, false], reviewer: [true, false, false] },
    publicOpenReview: { guest: [true, true, true], reviewer: [true, true, true] },
    publicMemberReview: { guest: [true, false, true], reviewer: [true, true, true] },
    publicInviteReview: { guest: [true, false, true], reviewer: [true, true, true] },
    privateRead: { guest: [false, false, false], reviewer: [true, false, false] },
    privateReview: { guest: [false, false, false], reviewer: [true, true, true] },
  };

  for (const [preset, expected] of Object.entries(cases)) {
    const policy = resolveAccessPolicy({ preset });
    for (const [name, principal] of Object.entries({ guest, reviewer })) {
      const capabilities = publicCapabilities(policy, principal, "book-1");
      assert.deepEqual(
        [capabilities.canRead, capabilities.canCreateAnnotations, capabilities.canViewAnnotations],
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
