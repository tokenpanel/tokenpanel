import { test, expect } from "bun:test";
import { tokenValidatedState } from "../bootstrap-state.ts";
import type { User } from "../AuthContext.tsx";

const sampleUser: User = {
  id: "507f1f77bcf86cd799439011",
  username: "admin",
  email: "admin@example.com",
  status: "active",
  role: "admin",
  memberships: [{ organizationId: "507f1f77bcf86cd799439012", role: "admin" }],
  activeOrganizationId: "507f1f77bcf86cd799439012",
};

// Regression for tokenpanel-1n3: the AuthContext bootstrap token-success path
// must set needsSetup to false (not leave it null). Previously it set user +
// loading=false but never set needsSetup, so RequireAuth (needsSetup === null)
// + RootRedirect rendered the full-screen Loading… forever on page refresh.
test("tokenValidatedState: token-success sets user non-null, loading=false, needsSetup=false (not null)", () => {
  const s = tokenValidatedState(sampleUser);
  expect(s.user).not.toBeNull();
  expect(s.user.id).toBe(sampleUser.id);
  expect(s.loading).toBe(false);
  // The core invariant: needsSetup is explicitly false, never null.
  expect(s.needsSetup).toBe(false);
  expect(s.needsSetup).not.toBeNull();
});

test("tokenValidatedState: always returns a fresh object with the invariant shape", () => {
  const a = tokenValidatedState(sampleUser);
  const b = tokenValidatedState(sampleUser);
  expect(a).not.toBe(b); // no shared mutable state
  expect(a.needsSetup).toBe(false);
  expect(b.needsSetup).toBe(false);
});
