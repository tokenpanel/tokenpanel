/**
 * Unit tests for plan/subscription operations + addInterval arithmetic.
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  BudgetDoc,
  CustomerDoc,
  CustomerLimitDoc,
  OrganizationDoc,
  RateLimitRuleInput,
  SubscriptionDoc,
  SubscriptionPlanDoc,
} from "@tokenpanel/db";
import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
  PersistenceConflictError,
  PersistenceDuplicateKeyError,
  ValidationError,
} from "../../../errors/families.ts";
import { Clock, type ClockService } from "../../../runtime/services/clock.ts";
import { Crypto, type CryptoService } from "../../../runtime/services/crypto.ts";
import {
  CustomerRepository,
  type CustomerRepositoryService,
} from "../../ports/customer-repository.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import {
  PlanRepository,
  type NewPlanRecord,
  type NewSubscriptionRecord,
  type PlanRepositoryService,
} from "../../ports/plan-repository.ts";
import type { HexId, RepoError } from "../../ports/common.ts";
import {
  createPlan,
  deactivatePlan,
  getActiveSubscription,
  listCustomerBudgets,
  listCustomerLimits,
  subscribeCustomer,
  updatePlan,
} from "../operations.ts";
import { addInterval } from "../interval.ts";

const orgId = new ObjectId().toHexString();
const planId = new ObjectId().toHexString();
const customerId = new ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Doc factories
// ---------------------------------------------------------------------------

function planDoc(over: Partial<SubscriptionPlanDoc> = {}): SubscriptionPlanDoc {
  return {
    _id: new ObjectId(planId),
    organizationId: new ObjectId(orgId),
    name: "Pro",
    description: null,
    price: { amountMicros: 1990, currency: "EUR" },
    interval: "month",
    intervalCount: 1,
    includedCredit: { amountMicros: 0, currency: "EUR" },
    includedTokens: 0,
    rateLimits: [],
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function subscriptionDoc(
  over: Partial<SubscriptionDoc> = {},
): SubscriptionDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    customerId: new ObjectId(customerId),
    planId: new ObjectId(planId),
    status: "active",
    periodStart: new Date(0),
    periodEnd: new Date(0),
    canceledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function orgDoc(over: Partial<OrganizationDoc> = {}): OrganizationDoc {
  return {
    _id: new ObjectId(orgId),
    name: "Acme",
    slug: "acme",
    ownerId: new ObjectId(),
    defaultCurrency: "EUR",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function customerDoc(): CustomerDoc {
  return {
    _id: new ObjectId(customerId),
    organizationId: new ObjectId(orgId),
    externalId: null,
    name: "Cust",
    email: null,
    balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function limitDoc(over: Partial<CustomerLimitDoc> = {}): CustomerLimitDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    customerId: new ObjectId(customerId),
    rules: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function budgetDoc(over: Partial<BudgetDoc> = {}): BudgetDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    customerId: new ObjectId(customerId),
    periodStart: new Date(0),
    periodEnd: new Date(0),
    amountMicros: 5000,
    currency: "USD",
    alertThresholds: [50, 80, 100],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function ruleInput(over: Partial<RateLimitRuleInput> = {}): RateLimitRuleInput {
  return {
    windowSeconds: 60,
    dimension: "requests",
    capValue: 5,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fake layers
// ---------------------------------------------------------------------------

function planLayer(opts: {
  plan?: SubscriptionPlanDoc | null | undefined;
  activeSubscription?: SubscriptionDoc | null | undefined;
  insertPlanResult?: SubscriptionPlanDoc | undefined;
  updatePlanResult?: SubscriptionPlanDoc | null | undefined;
  deactivateResult?: boolean | undefined;
  insertSubscriptionResult?: SubscriptionDoc | undefined;
  insertSubscriptionError?: RepoError | undefined;
  limits?: readonly CustomerLimitDoc[] | undefined;
  budgets?: readonly BudgetDoc[] | undefined;
  onInsertPlan?: ((record: NewPlanRecord) => void) | undefined;
  onUpdatePlan?: ((patch: Record<string, unknown>) => void) | undefined;
  onDeactivate?:
    | ((organizationId: HexId, planId: HexId) => void)
    | undefined;
  onInsertSubscription?:
    | ((record: NewSubscriptionRecord) => void)
    | undefined;
  onListScoped?:
    | ((organizationId: HexId, customerId: HexId) => void)
    | undefined;
}): Layer.Layer<PlanRepository> {
  const service: PlanRepositoryService = {
    listPlans: () => Effect.succeed([]),
    findPlan: () => Effect.succeed(opts.plan ?? null),
    insertPlan: (record) => {
      opts.onInsertPlan?.(record);
      return Effect.succeed(opts.insertPlanResult ?? planDoc());
    },
    updatePlan: (_org, _planId, patch) => {
      opts.onUpdatePlan?.(patch);
      return Effect.succeed(
        opts.updatePlanResult !== undefined ? opts.updatePlanResult : planDoc(),
      );
    },
    deactivatePlan: (org, pid) => {
      opts.onDeactivate?.(org, pid);
      return Effect.succeed(opts.deactivateResult ?? false);
    },
    findActiveSubscription: () =>
      Effect.succeed(opts.activeSubscription ?? null),
    insertSubscription: (record) => {
      opts.onInsertSubscription?.(record);
      return opts.insertSubscriptionError
        ? Effect.fail(opts.insertSubscriptionError)
        : Effect.succeed(opts.insertSubscriptionResult ?? subscriptionDoc());
    },
    listCustomerLimits: (org, cust) => {
      opts.onListScoped?.(org, cust);
      return Effect.succeed(opts.limits ?? []);
    },
    listBudgets: (org, cust) => {
      opts.onListScoped?.(org, cust);
      return Effect.succeed(opts.budgets ?? []);
    },
  };
  return Layer.succeed(PlanRepository, service);
}

function organizationLayer(
  doc: OrganizationDoc | null,
): Layer.Layer<OrganizationRepository> {
  const service: OrganizationRepositoryService = {
    findById: () => Effect.succeed(doc),
    findByIds: () => Effect.succeed([]),
    findBySlug: () => Effect.succeed(null),
    slugTaken: () => Effect.succeed(false),
    insert: () => Effect.die("unused"),
    update: () => Effect.succeed(null),
    delete: () => Effect.succeed(undefined),
    countBusinessData: () =>
      Effect.succeed({
        providers: 0,
        customers: 0,
        models: 0,
        plans: 0,
        apiKeys: 0,
      }),
  };
  return Layer.succeed(OrganizationRepository, service);
}

function customerLayer(
  doc: CustomerDoc | null,
): Layer.Layer<CustomerRepository> {
  const service: CustomerRepositoryService = {
    list: () => Effect.succeed({ items: [], total: 0 }),
    findById: () => Effect.succeed(doc),
    findByCustomerId: () => Effect.succeed(null),
    findConflict: () => Effect.succeed(null),
    insertWithOpeningBalance: () => Effect.die("unused"),
    update: () => Effect.succeed(null),
    close: () => Effect.succeed(null),
    adjustBalance: () => Effect.die("unused"),
    listBalanceHistory: () => Effect.succeed({ items: [], total: 0 }),
  };
  return Layer.succeed(CustomerRepository, service);
}

const cryptoLayer = Layer.succeed(Crypto, {
  hashPassword: () => Effect.succeed("x"),
  verifyPassword: () => Effect.succeed(true),
  randomToken: () => Effect.succeed("0123456789abcdef"),
  hashToken: () => Effect.succeed("hash"),
  safeHashEqual: () => Effect.succeed(true),
  signJwt: () => Effect.succeed("jwt"),
  verifyJwt: () =>
    Effect.succeed({
      sub: "u",
      orgId,
      role: "admin",
      sid: "s1",
      exp: 0,
    }),
  encryptSecret: (p) => Effect.succeed(`enc:${p}`),
  decryptSecret: (e) => Effect.succeed(e),
  isDuplicateKeyError: () => false,
} satisfies CryptoService);

function clockLayer(now: Date): Layer.Layer<Clock> {
  return Layer.succeed(Clock, {
    now: () => now,
    nowMs: () => now.getTime(),
  } satisfies ClockService);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an effect, return the squashed typed error (fails the test on success). */
async function failureOf<A, E>(effect: Effect.Effect<A, E, never>): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Failure") return Cause.squash(exit.cause) as E;
  throw new Error("expected effect to fail, got success");
}

// ---------------------------------------------------------------------------
// createPlan
// ---------------------------------------------------------------------------

test("createPlan: stamps org defaultCurrency onto price + includedCredit and applies defaults", async () => {
  const inserted: NewPlanRecord[] = [];
  const layer = Layer.mergeAll(
    planLayer({
      insertPlanResult: planDoc({ name: "Team" }),
      onInsertPlan: (record) => inserted.push(record),
    }),
    organizationLayer(orgDoc({ defaultCurrency: "EUR" })),
    cryptoLayer,
  );
  const doc = await Effect.runPromise(
    createPlan({
      organizationId: orgId,
      name: "Team",
      price: { amountMicros: 1990, currency: "USD" },
      interval: "month",
      intervalCount: 1,
    }).pipe(Effect.provide(layer)),
  );
  expect(doc.name).toBe("Team");
  expect(inserted).toHaveLength(1);
  const record = inserted[0]!;
  // Caller currency ignored; org currency stamped.
  expect(record.price).toEqual({ amountMicros: 1990, currency: "EUR" });
  // includedCredit defaults to zero with org currency; tokens default 0.
  expect(record.includedCredit).toEqual({ amountMicros: 0, currency: "EUR" });
  expect(record.includedTokens).toBe(0);
  expect(record.description).toBeNull();
  expect(record.rateLimits).toEqual([]);
  expect(record.active).toBe(true);
});

test("createPlan: falls back to USD when org missing and keeps provided amounts", async () => {
  const inserted: NewPlanRecord[] = [];
  const layer = Layer.mergeAll(
    planLayer({ onInsertPlan: (record) => inserted.push(record) }),
    organizationLayer(null),
    cryptoLayer,
  );
  await Effect.runPromise(
    createPlan({
      organizationId: orgId,
      name: "Team",
      description: "desc",
      price: { amountMicros: 1990, currency: "GBP" },
      interval: "year",
      intervalCount: 1,
      includedCredit: { amountMicros: 500, currency: "GBP" },
      includedTokens: 1000,
    }).pipe(Effect.provide(layer)),
  );
  const record = inserted[0]!;
  expect(record.price).toEqual({ amountMicros: 1990, currency: "USD" });
  expect(record.includedCredit).toEqual({ amountMicros: 500, currency: "USD" });
  expect(record.includedTokens).toBe(1000);
  expect(record.description).toBe("desc");
  expect(record.interval).toBe("year");
});

test("createPlan: stamps missing rule ids from Crypto and applies rule defaults", async () => {
  const inserted: NewPlanRecord[] = [];
  const layer = Layer.mergeAll(
    planLayer({ onInsertPlan: (record) => inserted.push(record) }),
    organizationLayer(orgDoc()),
    cryptoLayer,
  );
  await Effect.runPromise(
    createPlan({
      organizationId: orgId,
      name: "Team",
      price: { amountMicros: 1990, currency: "EUR" },
      interval: "month",
      intervalCount: 1,
      rateLimits: [
        ruleInput(),
        ruleInput({
          id: "custom-id",
          windowSeconds: 3600,
          dimension: "tokens",
          capValue: 100000,
          scope: "model",
          scopeTarget: "gpt-4o",
          active: false,
        }),
      ],
    }).pipe(Effect.provide(layer)),
  );
  const rules = inserted[0]!.rateLimits;
  expect(rules).toHaveLength(2);
  // randomToken "0123456789abcdef" sliced to 12 hex chars.
  expect(rules[0]).toEqual({
    id: "0123456789ab",
    windowSeconds: 60,
    dimension: "requests",
    capValue: 5,
    scope: "customer",
    scopeTarget: null,
    active: true,
  });
  expect(rules[1]!.id).toBe("custom-id");
  expect(rules[1]!.scope).toBe("model");
  expect(rules[1]!.scopeTarget).toBe("gpt-4o");
  expect(rules[1]!.active).toBe(false);
});

test("createPlan: duplicate stream → ValidationError, nothing inserted", async () => {
  let insertCalls = 0;
  const layer = Layer.mergeAll(
    planLayer({
      onInsertPlan: () => {
        insertCalls += 1;
      },
    }),
    organizationLayer(orgDoc()),
    cryptoLayer,
  );
  const err = await failureOf(
    createPlan({
      organizationId: orgId,
      name: "Team",
      price: { amountMicros: 1990, currency: "USD" },
      interval: "month",
      intervalCount: 1,
      rateLimits: [ruleInput(), ruleInput({ capValue: 1 })],
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(ValidationError);
  if (!(err instanceof ValidationError)) throw new Error("unreachable");
  expect(err.code).toBe("validation_error");
  expect(err.message).toContain("Duplicate rate limit stream");
  expect(err.message).toContain("requests / 60s window");
  expect(err.details?.rateLimits).toHaveLength(1);
  expect(insertCalls).toBe(0);
});

test("createPlan: inactive rule does not collide on the same stream", async () => {
  const inserted: NewPlanRecord[] = [];
  const layer = Layer.mergeAll(
    planLayer({ onInsertPlan: (record) => inserted.push(record) }),
    organizationLayer(orgDoc()),
    cryptoLayer,
  );
  await Effect.runPromise(
    createPlan({
      organizationId: orgId,
      name: "Team",
      price: { amountMicros: 1990, currency: "USD" },
      interval: "month",
      intervalCount: 1,
      rateLimits: [ruleInput(), ruleInput({ active: false })],
    }).pipe(Effect.provide(layer)),
  );
  expect(inserted[0]!.rateLimits).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// updatePlan
// ---------------------------------------------------------------------------

test("updatePlan: missing plan → NotFoundError without hitting the repo update", async () => {
  const patched: Record<string, unknown>[] = [];
  const layer = Layer.merge(
    planLayer({
      plan: null,
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  const err = await failureOf(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: { name: "New" },
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("plan");
  expect(err.id).toBe(planId);
  expect(patched).toHaveLength(0);
});

test("updatePlan: stamps price currency to the EXISTING plan currency", async () => {
  const patched: Record<string, unknown>[] = [];
  const updated = planDoc({ price: { amountMicros: 5000, currency: "EUR" } });
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      updatePlanResult: updated,
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  const doc = await Effect.runPromise(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: { price: { amountMicros: 5000, currency: "USD" } },
    }).pipe(Effect.provide(layer)),
  );
  expect(doc).toEqual(updated);
  expect(patched).toHaveLength(1);
  expect(patched[0]!.price).toEqual({ amountMicros: 5000, currency: "EUR" });
});

test("updatePlan: merges price/includedCredit with existing amountMicros fallback", async () => {
  const patched: Record<string, unknown>[] = [];
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  await Effect.runPromise(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: {
        price: { currency: "USD" },
        includedCredit: { amountMicros: 700 },
      },
    }).pipe(Effect.provide(layer)),
  );
  const patch = patched[0]!;
  // amountMicros falls back to the existing plan; currency stays org-stamped.
  expect(patch.price).toEqual({ amountMicros: 1990, currency: "EUR" });
  expect(patch.includedCredit).toEqual({ amountMicros: 700, currency: "EUR" });
});

test("updatePlan: plain patch keys pass through untouched", async () => {
  const patched: Record<string, unknown>[] = [];
  const updated = planDoc({ name: "Pro Max" });
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      updatePlanResult: updated,
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  const doc = await Effect.runPromise(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: { name: "Pro Max" },
    }).pipe(Effect.provide(layer)),
  );
  expect(doc).toEqual(updated);
  const patch = patched[0]!;
  expect(patch.name).toBe("Pro Max");
  expect("price" in patch).toBe(false);
  expect("includedCredit" in patch).toBe(false);
});

test("updatePlan: non-array rateLimits in patch → InvalidStateError", async () => {
  const patched: Record<string, unknown>[] = [];
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  const err = await failureOf(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: { rateLimits: "all" },
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(InvalidStateError);
  if (!(err instanceof InvalidStateError)) throw new Error("unreachable");
  expect(err.code).toBe("invalid_state");
  expect(err.message).toBe("rateLimits must be an array");
  expect(err.resource).toBe("plan");
  expect(patched).toHaveLength(0);
});

test("updatePlan: rateLimits array is id-stamped and normalized before persist", async () => {
  const patched: Record<string, unknown>[] = [];
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  await Effect.runPromise(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: {},
      rateLimits: [ruleInput()],
    }).pipe(Effect.provide(layer)),
  );
  const patch = patched[0]!;
  expect(patch.rateLimits).toEqual([
    {
      id: "0123456789ab",
      windowSeconds: 60,
      dimension: "requests",
      capValue: 5,
      scope: "customer",
      scopeTarget: null,
      active: true,
    },
  ]);
});

test("updatePlan: duplicate stamped streams → ValidationError, nothing persisted", async () => {
  const patched: Record<string, unknown>[] = [];
  const layer = Layer.merge(
    planLayer({
      plan: planDoc(),
      onUpdatePlan: (patch) => patched.push(patch),
    }),
    cryptoLayer,
  );
  const err = await failureOf(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: {},
      rateLimits: [ruleInput(), ruleInput({ scope: "plan" })],
    }).pipe(Effect.provide(layer)),
  );
  // `plan` scope normalizes onto the customer-global stream → collision.
  expect(err).toBeInstanceOf(ValidationError);
  if (!(err instanceof ValidationError)) throw new Error("unreachable");
  expect(err.message).toContain("Duplicate rate limit stream");
  expect(patched).toHaveLength(0);
});

test("updatePlan: repo update miss after found → NotFoundError", async () => {
  const layer = Layer.merge(
    planLayer({ plan: planDoc(), updatePlanResult: null }),
    cryptoLayer,
  );
  const err = await failureOf(
    updatePlan({
      organizationId: orgId,
      planId,
      patch: { name: "New" },
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.id).toBe(planId);
});

// ---------------------------------------------------------------------------
// deactivatePlan
// ---------------------------------------------------------------------------

test("deactivatePlan: repo false → NotFoundError", async () => {
  const layer = planLayer({ deactivateResult: false });
  const err = await failureOf(
    deactivatePlan({ organizationId: orgId, planId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("plan");
  expect(err.id).toBe(planId);
});

test("deactivatePlan: repo true → { ok: true } with ids forwarded", async () => {
  const calls: Array<[HexId, HexId]> = [];
  const layer = planLayer({
    deactivateResult: true,
    onDeactivate: (org, pid) => {
      calls.push([org, pid]);
    },
  });
  const result = await Effect.runPromise(
    deactivatePlan({ organizationId: orgId, planId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result).toEqual({ ok: true });
  expect(calls).toEqual([[orgId, planId]]);
});

// ---------------------------------------------------------------------------
// subscribeCustomer
// ---------------------------------------------------------------------------

test("subscribeCustomer: unknown customer → NotFoundError (resource customer)", async () => {
  const layer = Layer.mergeAll(
    planLayer({}),
    customerLayer(null),
    clockLayer(new Date(0)),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("customer");
  expect(err.id).toBe(customerId);
});

test("subscribeCustomer: unknown plan → NotFoundError code plan_not_found", async () => {
  const layer = Layer.mergeAll(
    planLayer({ plan: null }),
    customerLayer(customerDoc()),
    clockLayer(new Date(0)),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.code).toBe("plan_not_found");
});

test("subscribeCustomer: inactive plan → InvalidStateError code plan_not_active", async () => {
  const layer = Layer.mergeAll(
    planLayer({ plan: planDoc({ active: false }) }),
    customerLayer(customerDoc()),
    clockLayer(new Date(0)),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(InvalidStateError);
  if (!(err instanceof InvalidStateError)) throw new Error("unreachable");
  expect(err.code).toBe("plan_not_active");
});

test("subscribeCustomer: existing active subscription → ConflictError, nothing inserted", async () => {
  let insertCalls = 0;
  const layer = Layer.mergeAll(
    planLayer({
      plan: planDoc(),
      activeSubscription: subscriptionDoc(),
      onInsertSubscription: () => {
        insertCalls += 1;
      },
    }),
    customerLayer(customerDoc()),
    clockLayer(new Date(0)),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(ConflictError);
  if (!(err instanceof ConflictError)) throw new Error("unreachable");
  expect(err.code).toBe("subscription_already_active");
  expect(insertCalls).toBe(0);
});

test("subscribeCustomer: happy path derives periodEnd via addInterval", async () => {
  const now = new Date(Date.UTC(2026, 0, 31));
  const inserted: NewSubscriptionRecord[] = [];
  const subscription = subscriptionDoc({
    periodStart: now,
    periodEnd: new Date(Date.UTC(2026, 2, 3)),
  });
  const layer = Layer.mergeAll(
    planLayer({
      plan: planDoc(),
      insertSubscriptionResult: subscription,
      onInsertSubscription: (record) => inserted.push(record),
    }),
    customerLayer(customerDoc()),
    clockLayer(now),
  );
  const doc = await Effect.runPromise(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(doc).toEqual(subscription);
  expect(inserted).toHaveLength(1);
  // Jan 31 + 1 month overflows February → Mar 3 2026.
  expect(inserted[0]).toEqual({
    organizationId: orgId,
    customerId,
    planId,
    status: "active",
    periodStart: now,
    periodEnd: new Date(Date.UTC(2026, 2, 3)),
  });
});

test("subscribeCustomer: duplicate-key insert → ConflictError subscription_already_active", async () => {
  const layer = Layer.mergeAll(
    planLayer({
      plan: planDoc(),
      insertSubscriptionError: new PersistenceDuplicateKeyError({
        code: "persistence_duplicate_key",
        message: "E11000 unique subscription",
        retryClass: "never",
      }),
    }),
    customerLayer(customerDoc()),
    clockLayer(new Date(Date.UTC(2026, 0, 1))),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBeInstanceOf(ConflictError);
  if (!(err instanceof ConflictError)) throw new Error("unreachable");
  expect(err.code).toBe("subscription_already_active");
  expect(err.message).toBe("Customer already has an active subscription");
});

test("subscribeCustomer: non-duplicate repo error passes through unmapped", async () => {
  const repoErr = new PersistenceConflictError({
    code: "persistence_conflict",
    message: "write conflict",
    retryClass: "transient",
  });
  const layer = Layer.mergeAll(
    planLayer({ plan: planDoc(), insertSubscriptionError: repoErr }),
    customerLayer(customerDoc()),
    clockLayer(new Date(0)),
  );
  const err = await failureOf(
    subscribeCustomer({
      organizationId: orgId,
      customerId,
      planId,
    }).pipe(Effect.provide(layer)),
  );
  expect(err).toBe(repoErr);
});

// ---------------------------------------------------------------------------
// addInterval (pure)
// ---------------------------------------------------------------------------

test("addInterval: day and week arithmetic in UTC", () => {
  const base = new Date(Date.UTC(2026, 0, 1, 12, 30, 0));
  expect(addInterval(base, "day", 3).toISOString()).toBe(
    "2026-01-04T12:30:00.000Z",
  );
  expect(addInterval(base, "week", 1).toISOString()).toBe(
    "2026-01-08T12:30:00.000Z",
  );
  expect(addInterval(base, "week", 2).toISOString()).toBe(
    "2026-01-15T12:30:00.000Z",
  );
});

test("addInterval: month rollover Jan-31 + 1 month → Mar-3, + 2 months → Mar-31", () => {
  const jan31 = new Date(Date.UTC(2026, 0, 31));
  expect(addInterval(jan31, "month", 1).toISOString()).toBe(
    "2026-03-03T00:00:00.000Z",
  );
  expect(addInterval(jan31, "month", 2).toISOString()).toBe(
    "2026-03-31T00:00:00.000Z",
  );
});

test("addInterval: leap-day year arithmetic Feb-29-2028 + 1y → Mar-1-2029", () => {
  const leapDay = new Date(Date.UTC(2028, 1, 29));
  expect(addInterval(leapDay, "year", 1).toISOString()).toBe(
    "2029-03-01T00:00:00.000Z",
  );
});

test("addInterval: unknown interval returns an unchanged copy", () => {
  const base = new Date(Date.UTC(2026, 5, 15, 8, 0, 0));
  const out = addInterval(base, "fortnight", 1);
  expect(out.getTime()).toBe(base.getTime());
  expect(out).not.toBe(base);
});

// ---------------------------------------------------------------------------
// getActiveSubscription
// ---------------------------------------------------------------------------

test("getActiveSubscription: no active subscription → NotFoundError", async () => {
  const layer = planLayer({ activeSubscription: null });
  const err = await failureOf(
    getActiveSubscription({ organizationId: orgId, customerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("subscription");
  expect(err.message).toBe("No active subscription");
});

test("getActiveSubscription: returns subscription with its plan", async () => {
  const subscription = subscriptionDoc();
  const plan = planDoc();
  const layer = planLayer({ activeSubscription: subscription, plan });
  const result = await Effect.runPromise(
    getActiveSubscription({ organizationId: orgId, customerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result.subscription).toBe(subscription);
  expect(result.plan).toBe(plan);
});

test("getActiveSubscription: deleted plan tolerated as null", async () => {
  const subscription = subscriptionDoc();
  const layer = planLayer({
    activeSubscription: subscription,
    plan: null,
  });
  const result = await Effect.runPromise(
    getActiveSubscription({ organizationId: orgId, customerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result.subscription).toBe(subscription);
  expect(result.plan).toBeNull();
});

// ---------------------------------------------------------------------------
// listCustomerLimits / listCustomerBudgets
// ---------------------------------------------------------------------------

test("listCustomerLimits: passes through repo rows with scoped ids", async () => {
  const limits = [limitDoc(), limitDoc()];
  const scoped: Array<[HexId, HexId]> = [];
  const layer = planLayer({
    limits,
    onListScoped: (org, cust) => {
      scoped.push([org, cust]);
    },
  });
  const result = await Effect.runPromise(
    listCustomerLimits({ organizationId: orgId, customerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result).toBe(limits);
  expect(scoped).toEqual([[orgId, customerId]]);
});

test("listCustomerBudgets: passes through repo rows with scoped ids", async () => {
  const budgets = [budgetDoc()];
  const scoped: Array<[HexId, HexId]> = [];
  const layer = planLayer({
    budgets,
    onListScoped: (org, cust) => {
      scoped.push([org, cust]);
    },
  });
  const result = await Effect.runPromise(
    listCustomerBudgets({ organizationId: orgId, customerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result).toBe(budgets);
  expect(scoped).toEqual([[orgId, customerId]]);
});
