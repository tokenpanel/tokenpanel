import { test, expect } from "bun:test";
import { collections, type TypedDb } from "../index.ts";

test("collections registry has all 17 collection names", () => {
  const keys = Object.keys(collections);
  expect(keys).toHaveLength(17);
  expect(collections.organizations).toBe("organizations");
  expect(collections.balanceAdjustments).toBe("balance_adjustments");
  expect(collections.modelCatalog).toBe("model_catalog");
  expect(collections.subscriptionPlans).toBe("subscription_plans");
  expect(collections.customerLimits).toBe("customer_limits");
  expect(collections.usageRecords).toBe("usage_records");
  expect(collections.rateLimitCounters).toBe("rate_limit_counters");
  expect(collections.apiKeys).toBe("api_keys");
  expect(collections.managementApiKeys).toBe("management_api_keys");
  expect(collections.settlementOutbox).toBe("settlement_outbox");
});

test("collections keys match TypedDb keys (compile-time + runtime structural check)", () => {
  const collectionKeys = new Set(Object.keys(collections));
  const typedDbKeys: (keyof TypedDb)[] = [
    "organizations",
    "users",
    "invites",
    "customers",
    "balanceAdjustments",
    "providers",
    "modelCatalog",
    "models",
    "subscriptionPlans",
    "subscriptions",
    "customerLimits",
    "budgets",
    "usageRecords",
    "rateLimitCounters",
    "apiKeys",
    "managementApiKeys",
    "settlementOutbox",
  ];
  for (const k of typedDbKeys) {
    expect(collectionKeys.has(k)).toBe(true);
  }
});