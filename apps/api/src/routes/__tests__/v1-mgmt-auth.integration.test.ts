/**
 * Route-level integration coverage for tp_mgmt_ auth through /v1 chat context.
 *
 * Mirrors models-metadata.integration.test.ts: injected getDb fakes (no live
 * replica set). Exercises the full resolveChatContext → actor/billing mapping
 * used by /v1/chat/completions and /v1/messages before upstream calls.
 *
 * Scenarios from tokenpanel-nh5:
 *  - mgmt key without chat:write → 403 missing_scope
 *  - mgmt key + unknown customerEmail → 404 customer_not_found
 *  - mgmt key + active customer → management_attributed (billable)
 *  - mgmt key without email → management_internal (audit-only)
 *  - inactive customer → 403 customer_inactive
 *  - cross-org email cannot resolve (org-scoped lookup)
 */
import { test, expect, describe } from "bun:test";
import { ObjectId } from "mongodb";
import type { CustomerDoc, TypedDb } from "@tokenpanel/db";
import {
  resolveChatContext,
  actorForChatContext,
  billableCustomerId,
  modelWhitelistForContext,
  V1ChatError,
  type ChatContext,
} from "../../lib/v1-chat-context.ts";
import { formatOpenAIError } from "../public/openai.ts";
import type { PublicPrincipal } from "../../middleware/public-auth.ts";

function managementPrincipal(
  over: Partial<{ orgId: ObjectId; scopes: string[] }> = {},
): Extract<PublicPrincipal, { kind: "management" }> {
  const orgId = over.orgId ?? new ObjectId();
  return {
    kind: "management",
    orgId,
    managementKey: {
      _id: new ObjectId(),
      organizationId: orgId,
      name: "ci",
      prefix: "tp_mgmt_abcd",
      keyHash: "h",
      scopes: (over.scopes ?? ["chat:write"]) as PublicPrincipal extends {
        kind: "management";
      }
        ? Extract<PublicPrincipal, { kind: "management" }>["managementKey"]["scopes"]
        : never,
      status: "active",
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function makeCustomer(
  over: Partial<CustomerDoc> & { organizationId: ObjectId; email: string },
): CustomerDoc {
  return {
    _id: over._id ?? new ObjectId(),
    organizationId: over.organizationId,
    externalId: over.externalId ?? null,
    name: over.name ?? "Alice",
    email: over.email,
    balance: {
      amountMinor: over.balance?.amountMinor ?? 10_000,
      reservedMinor: over.balance?.reservedMinor ?? 0,
      currency: over.balance?.currency ?? "USD",
    },
    status: over.status ?? "active",
    metadata: over.metadata ?? {},
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

function makeGetDb(customers: CustomerDoc[]) {
  return async (): Promise<TypedDb> =>
    ({
      customers: {
        async findOne(filter: {
          organizationId?: ObjectId;
          email?: string;
        }) {
          return (
            customers.find((c) => {
              if (
                filter.organizationId &&
                !c.organizationId.equals(filter.organizationId)
              ) {
                return false;
              }
              if (filter.email !== undefined && c.email !== filter.email) {
                return false;
              }
              return true;
            }) ?? null
          );
        },
      },
    }) as unknown as TypedDb;
}

/** Map V1ChatError the same way /v1/chat/completions does. */
function toRouteError(err: unknown): { status: number; body: ReturnType<typeof formatOpenAIError> } {
  if (err instanceof V1ChatError) {
    return {
      status: err.status,
      body: formatOpenAIError(err.code, err.message),
    };
  }
  throw err;
}

describe("tp_mgmt_ auth through /v1 chat context", () => {
  test("mgmt key without chat:write → 403 missing_scope", async () => {
    const principal = managementPrincipal({ scopes: ["models:read"] });
    try {
      await resolveChatContext({ principal });
      expect.unreachable("should have thrown");
    } catch (err) {
      const route = toRouteError(err);
      expect(route.status).toBe(403);
      expect(route.body.error.code).toBe("missing_scope");
    }
  });

  test("mgmt key without customerEmail → management_internal (audit-only)", async () => {
    const principal = managementPrincipal();
    const ctx = await resolveChatContext({ principal });
    expect(ctx.kind).toBe("management_internal");
    if (ctx.kind !== "management_internal") throw new Error("unreachable");

    expect(billableCustomerId(ctx)).toBeNull();
    expect(modelWhitelistForContext(ctx)).toEqual([]);

    const actor = actorForChatContext(ctx);
    expect(actor.actorKind).toBe("management_key");
    expect(actor.customerId).toBeNull();
    expect(actor.managementKeyId).toEqual(principal.managementKey._id);
    // Route stamps priceMinor 0 for management_internal — no balance debit.
  });

  test("mgmt key + unknown customerEmail → 404 customer_not_found", async () => {
    const principal = managementPrincipal();
    const getDb = makeGetDb([]);
    try {
      await resolveChatContext({
        principal,
        customerEmail: "nobody@example.com",
        getDb,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const route = toRouteError(err);
      expect(route.status).toBe(404);
      expect(route.body.error.code).toBe("customer_not_found");
      expect(route.body.error.type).toBe("invalid_request_error");
    }
  });

  test("mgmt key + active customer → management_attributed (billable)", async () => {
    const orgId = new ObjectId();
    const principal = managementPrincipal({ orgId });
    const customer = makeCustomer({
      organizationId: orgId,
      email: "alice@example.com",
      balance: { amountMinor: 5_000, reservedMinor: 0, currency: "USD" },
    });
    const getDb = makeGetDb([customer]);

    const ctx = await resolveChatContext({
      principal,
      customerEmail: "Alice@Example.com", // case-insensitive
      getDb,
    });
    expect(ctx.kind).toBe("management_attributed");
    if (ctx.kind !== "management_attributed") throw new Error("unreachable");

    expect(ctx.customer._id.equals(customer._id)).toBe(true);
    expect(ctx.customerEmail).toBe("alice@example.com");
    expect(billableCustomerId(ctx)?.equals(customer._id)).toBe(true);

    const actor = actorForChatContext(ctx);
    expect(actor.actorKind).toBe("management_key");
    expect(actor.customerId?.equals(customer._id)).toBe(true);
    expect(actor.managementKeyId).toEqual(principal.managementKey._id);
    expect(actor.customerEmail).toBe("alice@example.com");
  });

  test("mgmt key + inactive customer → 403 customer_inactive", async () => {
    const orgId = new ObjectId();
    const principal = managementPrincipal({ orgId });
    const customer = makeCustomer({
      organizationId: orgId,
      email: "paused@example.com",
      status: "suspended",
    });
    const getDb = makeGetDb([customer]);
    try {
      await resolveChatContext({
        principal,
        customerEmail: "paused@example.com",
        getDb,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const route = toRouteError(err);
      expect(route.status).toBe(403);
      expect(route.body.error.code).toBe("customer_inactive");
    }
  });

  test("cross-org email cannot resolve (org-scoped lookup)", async () => {
    const orgA = new ObjectId();
    const orgB = new ObjectId();
    const principal = managementPrincipal({ orgId: orgA });
    // Customer lives in org B only.
    const foreign = makeCustomer({
      organizationId: orgB,
      email: "shared@example.com",
    });
    const getDb = makeGetDb([foreign]);
    try {
      await resolveChatContext({
        principal,
        customerEmail: "shared@example.com",
        getDb,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const route = toRouteError(err);
      expect(route.status).toBe(404);
      expect(route.body.error.code).toBe("customer_not_found");
    }
  });

  test("billing intent matrix: internal skips debit; attributed bills customer", () => {
    const orgId = new ObjectId();
    const customer = makeCustomer({
      organizationId: orgId,
      email: "bill@example.com",
    });
    const internal: ChatContext = {
      kind: "management_internal",
      orgId,
      managementKeyId: new ObjectId(),
    };
    const attributed: ChatContext = {
      kind: "management_attributed",
      orgId,
      managementKeyId: new ObjectId(),
      customer,
      customerEmail: "bill@example.com",
    };
    // Matches openai.ts: priceMinor = ctx.kind === "management_internal" ? 0 : charges
    expect(billableCustomerId(internal)).toBeNull();
    expect(billableCustomerId(attributed)?.equals(customer._id)).toBe(true);
  });
});
