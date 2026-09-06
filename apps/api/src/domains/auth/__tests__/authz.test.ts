/**
 * Authorization decisions: requireRole, requirePermission, principalHasPermission,
 * requireManagementScope, hasManagementScope, roleForOrganization. Pure module —
 * no repository layers; assertion style matches admin-session.test.ts.
 */
import { test, expect } from "bun:test";
import { Cause, Effect } from "effect";
import type { ManagementScope } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import {
  requireRole,
  requirePermission,
  principalHasPermission,
  requireManagementScope,
  hasManagementScope,
  roleForOrganization,
} from "../authz.ts";
import type { AuthzPrincipal } from "../types.ts";

function adminPrincipal(
  over: Partial<
    Extract<AuthzPrincipal, { kind: "admin_user" }>
  > = {},
): AuthzPrincipal {
  return {
    kind: "admin_user",
    userId: "user-1",
    organizationId: "org-1",
    role: "admin",
    permissions: [],
    status: "active",
    ...over,
  };
}

function mgmtPrincipal(
  over: Partial<
    Extract<AuthzPrincipal, { kind: "management_key" }>
  > = {},
): AuthzPrincipal {
  return {
    kind: "management_key",
    keyId: "key-1",
    organizationId: "org-1",
    scopes: ["balances:read" as ManagementScope],
    status: "active",
    ...over,
  };
}

async function run<E>(
  program: Effect.Effect<void, E>,
): Promise<E | undefined> {
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") {
    return undefined;
  }
  return Cause.squash(exit.cause) as E;
}

test("requireRole: matching admin role passes", async () => {
  const err = await run(
    requireRole({ principal: adminPrincipal(), role: "admin" }),
  );
  expect(err).toBeUndefined();
});

test("requireRole: member principal for admin role → forbidden role_mismatch", async () => {
  const err = await run(
    requireRole({ principal: adminPrincipal({ role: "member" }), role: "admin" }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err._tag).toBe("AuthorizationError");
  expect(err.code).toBe("forbidden");
  expect(err.reason).toBe("role_mismatch");
});

test("requireRole: management key principal → forbidden wrong_principal_kind", async () => {
  const err = await run(
    requireRole({ principal: mgmtPrincipal(), role: "admin" }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err._tag).toBe("AuthorizationError");
  expect(err.reason).toBe("wrong_principal_kind");
});

test("requireRole: disabled user → user_disabled before role check", async () => {
  const err = await run(
    requireRole({
      principal: adminPrincipal({ status: "disabled", role: "member" }),
      role: "member",
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err._tag).toBe("AuthorizationError");
  expect(err.code).toBe("user_disabled");
});

test("requirePermission: admin passes even with empty stored permissions", async () => {
  const err = await run(
    requirePermission({
      principal: adminPrincipal(),
      permission: "balances:write" as PanelPermission,
    }),
  );
  expect(err).toBeUndefined();
});

test("requirePermission: member with explicit grant passes", async () => {
  const err = await run(
    requirePermission({
      principal: adminPrincipal({
        role: "member",
        permissions: ["balances:read" as PanelPermission],
      }),
      permission: "balances:read" as PanelPermission,
    }),
  );
  expect(err).toBeUndefined();
});

test("requirePermission: member without grant → forbidden missing_permission with scope", async () => {
  const err = await run(
    requirePermission({
      principal: adminPrincipal({ role: "member", permissions: [] }),
      permission: "balances:write" as PanelPermission,
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err._tag).toBe("AuthorizationError");
  if (err._tag !== "AuthorizationError") {
    throw new Error("expected AuthorizationError");
  }
  expect(err.reason).toBe("missing_permission");
  expect(err.scope).toBe("balances:write");
});

test("requirePermission: disabled member holding grant still fails user_disabled first", async () => {
  const err = await run(
    requirePermission({
      principal: adminPrincipal({
        role: "member",
        permissions: ["balances:read" as PanelPermission],
        status: "disabled",
      }),
      permission: "balances:read" as PanelPermission,
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err.code).toBe("user_disabled");
});

test("principalHasPermission: admin active true; disabled or wrong kind false", () => {
  expect(principalHasPermission(adminPrincipal(), "models:read" as PanelPermission)).toBe(true);
  expect(
    principalHasPermission(
      adminPrincipal({ status: "disabled" }),
      "models:read" as PanelPermission,
    ),
  ).toBe(false);
  expect(
    principalHasPermission(mgmtPrincipal(), "models:read" as PanelPermission),
  ).toBe(false);
});

test("principalHasPermission: write implies read, read does not imply write", () => {
  const member = adminPrincipal({
    role: "member",
    permissions: ["balances:write" as PanelPermission],
  });
  expect(principalHasPermission(member, "balances:read" as PanelPermission)).toBe(true);
  const reader = adminPrincipal({
    role: "member",
    permissions: ["balances:read" as PanelPermission],
  });
  expect(principalHasPermission(reader, "balances:write" as PanelPermission)).toBe(false);
});

test("requireManagementScope: holding scope passes", async () => {
  const err = await run(
    requireManagementScope({ principal: mgmtPrincipal(), scope: "balances:read" }),
  );
  expect(err).toBeUndefined();
});

test("requireManagementScope: admin_user principal → forbidden wrong_principal_kind", async () => {
  const err = await run(
    requireManagementScope({
      principal: adminPrincipal(),
      scope: "balances:read",
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err._tag).toBe("AuthorizationError");
  expect(err.reason).toBe("wrong_principal_kind");
});

test("requireManagementScope: revoked key → forbidden key_revoked before scope check", async () => {
  const err = await run(
    requireManagementScope({
      principal: mgmtPrincipal({ status: "revoked", scopes: [] }),
      scope: "balances:read",
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err.code).toBe("forbidden");
  expect(err.reason).toBe("key_revoked");
});

test("requireManagementScope: missing scope → missing_scope with echoed scope", async () => {
  const err = await run(
    requireManagementScope({
      principal: mgmtPrincipal({ scopes: [] }),
      scope: "balances:read",
    }),
  );
  expect(err).toBeDefined();
  if (!err) return;
  expect(err.code).toBe("missing_scope");
  expect(err.scope).toBe("balances:read");
});

test("hasManagementScope: pure inclusion check", () => {
  expect(hasManagementScope(["balances:read"], "balances:read")).toBe(true);
  expect(hasManagementScope(["models:read"], "balances:read")).toBe(false);
});

test("roleForOrganization: matches by ObjectId hex or plain string", () => {
  type Membership = Parameters<typeof roleForOrganization>[0][number];
  const memberships: readonly Membership[] = [
    { organizationId: { toHexString: () => "org-a" }, role: "admin" },
    {
      organizationId: "org-b" as unknown as Membership["organizationId"],
      role: "member",
    },
  ];
  expect(roleForOrganization(memberships, "org-a")).toBe("admin");
  expect(roleForOrganization(memberships, "org-b")).toBe("member");
  expect(roleForOrganization(memberships, "org-z")).toBeNull();
});
