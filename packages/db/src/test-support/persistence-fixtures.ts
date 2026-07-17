/**
 * Persistence fixtures for every MongoDB document shape consumed by application
 * code (task 1.3). Includes modern full docs and legacy/defaulted variants.
 *
 * Fixtures are pure data builders — no DB I/O. Decode tests verify schemas
 * accept these shapes; repositories will reuse them after Effect migration.
 */
import { ObjectId } from "mongodb";
import type { OrganizationDoc } from "../schemas/organization.ts";
import type { UserDoc, InviteDoc } from "../schemas/user.ts";
import type {
  CustomerDoc,
  BalanceAdjustmentDoc,
} from "../schemas/customer.ts";
import type {
  ProviderDoc,
  ModelDoc,
  ModelCatalogDoc,
} from "../schemas/model.ts";
import type {
  SubscriptionPlanDoc,
  SubscriptionDoc,
  CustomerLimitDoc,
  BudgetDoc,
} from "../schemas/limit.ts";
import type {
  UsageRecordDoc,
  RateLimitCounterDoc,
} from "../schemas/usage.ts";
import type { ApiKeyDoc } from "../schemas/apikey.ts";
import type { ManagementApiKeyDoc } from "../schemas/management-apikey.ts";
import type { SettlementOutboxDoc } from "../schemas/settlement-outbox.ts";

const d = (iso = "2026-01-15T12:00:00.000Z") => new Date(iso);

export function fixObjectId(hex?: string): ObjectId {
  return hex ? new ObjectId(hex) : new ObjectId();
}

/** Canonical IDs for cross-fixture references in integration tests. */
export const FIXTURE_IDS = {
  org: "507f1f77bcf86cd799439011",
  user: "507f1f77bcf86cd799439012",
  customer: "507f1f77bcf86cd799439013",
  provider: "507f1f77bcf86cd799439014",
  model: "507f1f77bcf86cd799439015",
  plan: "507f1f77bcf86cd799439016",
  apiKey: "507f1f77bcf86cd799439017",
  mgmtKey: "507f1f77bcf86cd799439018",
  usage: "507f1f77bcf86cd799439019",
  outbox: "507f1f77bcf86cd79943901a",
  invite: "507f1f77bcf86cd79943901b",
  subscription: "507f1f77bcf86cd79943901c",
  adjustment: "507f1f77bcf86cd79943901d",
  counter: "507f1f77bcf86cd79943901e",
  budget: "507f1f77bcf86cd79943901f",
  limit: "507f1f77bcf86cd799439020",
  catalog: "507f1f77bcf86cd799439021",
} as const;

export function organizationFixture(
  over: Partial<OrganizationDoc> = {},
): OrganizationDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.org),
    name: "Acme AI",
    slug: "acme-ai",
    ownerId: fixObjectId(FIXTURE_IDS.user),
    defaultCurrency: "USD",
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function userFixture(over: Partial<UserDoc> = {}): UserDoc {
  const orgId = fixObjectId(FIXTURE_IDS.org);
  return {
    _id: fixObjectId(FIXTURE_IDS.user),
    memberships: [{ organizationId: orgId, role: "admin", permissions: [] }],
    activeOrganizationId: orgId,
    username: "alice",
    email: "alice@example.com",
    passwordHash: "$argon2id$v=19$m=65536,t=2,p=1$placeholder",
    status: "active",
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

/** Legacy-shaped user missing explicit status (schema defaults to active). */
export function userLegacyFixture(): Record<string, unknown> {
  const u = userFixture();
  const { status: _s, ...rest } = u;
  return rest;
}

export function inviteFixture(over: Partial<InviteDoc> = {}): InviteDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.invite),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    invitedBy: fixObjectId(FIXTURE_IDS.user),
    email: "bob@example.com",
    role: "member",
    permissions: [],
    tokenHash: "hash-of-token",
    status: "pending",
    acceptedAt: null,
    expiresAt: d("2026-02-01T00:00:00.000Z"),
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function customerFixture(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.customer),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    externalId: "ext-1",
    name: "Bob Corp",
    email: "bob@corp.com",
    balance: { amountUnits: 10_000, reservedUnits: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

/** Legacy fixture: balance without reservedUnits field. */
export function customerLegacyBalanceFixture(): Record<string, unknown> {
  const c = customerFixture();
  return {
    ...c,
    balance: { amountUnits: 5000, currency: "USD" },
  };
}

export function balanceAdjustmentFixture(
  over: Partial<BalanceAdjustmentDoc> = {},
): BalanceAdjustmentDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.adjustment),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    amountUnits: 1000,
    currency: "USD",
    reason: "topup",
    usageRecordId: null,
    note: "initial",
    occurredAt: d(),
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function providerFixture(over: Partial<ProviderDoc> = {}): ProviderDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.provider),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc:test",
    baseUrl: "https://api.openai.com/v1",
    providerOrg: null,
    headers: {},
    httpTimeoutMs: null,
    metadata: {},
    active: true,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function modelCatalogFixture(
  over: Partial<ModelCatalogDoc> = {},
): ModelCatalogDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.catalog),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    providerId: fixObjectId(FIXTURE_IDS.provider),
    upstreamModelId: "gpt-4o",
    displayName: "GPT-4o",
    reasoning: false,
    toolCall: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limits: { context: 128000 },
    raw: {},
    discoveredAt: d(),
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function modelFixture(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.model),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    aliasId: "my-gpt",
    displayName: "My GPT",
    description: null,
    entries: [
      {
        id: "e1",
        providerId: fixObjectId(FIXTURE_IDS.provider),
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
      },
    ],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: Object.create(null) as Record<string, string>,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function subscriptionPlanFixture(
  over: Partial<SubscriptionPlanDoc> = {},
): SubscriptionPlanDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.plan),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    name: "Pro",
    description: null,
    price: { amountUnits: 2000, currency: "USD" },
    interval: "month",
    intervalCount: 1,
    includedCredit: { amountUnits: 1000, currency: "USD" },
    includedTokens: 0,
    rateLimits: [
      {
        id: "rl1",
        windowSeconds: 3600,
        dimension: "requests",
        capValue: 1000,
        scope: "customer",
        active: true,
      },
    ],
    active: true,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function subscriptionFixture(
  over: Partial<SubscriptionDoc> = {},
): SubscriptionDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.subscription),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    planId: fixObjectId(FIXTURE_IDS.plan),
    status: "active",
    periodStart: d("2026-01-01T00:00:00.000Z"),
    periodEnd: d("2026-02-01T00:00:00.000Z"),
    canceledAt: null,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function customerLimitFixture(
  over: Partial<CustomerLimitDoc> = {},
): CustomerLimitDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.limit),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    rules: [
      {
        id: "cl1",
        windowSeconds: 60,
        dimension: "requests",
        capValue: 10,
        scope: "customer",
        active: true,
      },
    ],
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function budgetFixture(over: Partial<BudgetDoc> = {}): BudgetDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.budget),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    periodStart: d("2026-01-01T00:00:00.000Z"),
    periodEnd: d("2026-02-01T00:00:00.000Z"),
    amountUnits: 50_000,
    currency: "USD",
    alertThresholds: [50, 80, 100],
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function usageRecordFixture(
  over: Partial<UsageRecordDoc> = {},
): UsageRecordDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.usage),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    apiKeyId: fixObjectId(FIXTURE_IDS.apiKey),
    actorKind: "customer_key",
    managementKeyId: null,
    customerEmail: null,
    modelAliasId: "my-gpt",
    providerId: fixObjectId(FIXTURE_IDS.provider),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUnits: 5,
    priceUnits: 10,
    currency: "USD",
    providerRequestId: "req_abc",
    gatewayRequestId: "gw_abc",
    billed: true,
    errorCode: null,
    status: 200,
    durationMs: 420,
    occurredAt: d(),
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

/** Aggregation-style usage projection used by admin/management usage endpoints. */
export type UsageByModelProjection = {
  modelAliasId: string;
  requests: number;
  tokens: number;
  costUnits: number;
  priceUnits: number;
};

export function usageByModelProjectionFixture(
  over: Partial<UsageByModelProjection> = {},
): UsageByModelProjection {
  return {
    modelAliasId: "my-gpt",
    requests: 12,
    tokens: 3400,
    costUnits: 40,
    priceUnits: 80,
    ...over,
  };
}

export function rateLimitCounterFixture(
  over: Partial<RateLimitCounterDoc> = {},
): RateLimitCounterDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.counter),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    dimension: "requests",
    windowSeconds: 3600,
    bucketStart: d("2026-01-15T12:00:00.000Z"),
    count: 42,
    scopeTarget: null,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function apiKeyFixture(over: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.apiKey),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    name: "prod",
    prefix: "tp_live_abcd1234",
    keyHash: "sha256-hash",
    modelWhitelist: [],
    status: "active",
    lastUsedAt: null,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function managementApiKeyFixture(
  over: Partial<ManagementApiKeyDoc> = {},
): ManagementApiKeyDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.mgmtKey),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    name: "s2s",
    prefix: "tp_mgmt_abcd1234",
    keyHash: "sha256-hash-mgmt",
    scopes: ["customers:read", "models:read", "chat:write"],
    status: "active",
    lastUsedAt: null,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

export function settlementOutboxFixture(
  over: Partial<SettlementOutboxDoc> = {},
): SettlementOutboxDoc {
  return {
    _id: fixObjectId(FIXTURE_IDS.outbox),
    organizationId: fixObjectId(FIXTURE_IDS.org),
    customerId: fixObjectId(FIXTURE_IDS.customer),
    gatewayRequestId: "gw_pending_1",
    reason: "missing_usage",
    modelAliasId: "my-gpt",
    providerId: fixObjectId(FIXTURE_IDS.provider),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    providerRequestId: "req_up",
    context: {
      actorKind: "customer_key",
      priceUnits: 10,
    },
    status: "pending",
    attempts: 0,
    createdAt: d(),
    updatedAt: d(),
    ...over,
  };
}

/** Registry of fixture builders for inventory tests. */
export const PERSISTENCE_FIXTURE_REGISTRY = {
  organization: organizationFixture,
  user: userFixture,
  invite: inviteFixture,
  customer: customerFixture,
  balanceAdjustment: balanceAdjustmentFixture,
  provider: providerFixture,
  modelCatalog: modelCatalogFixture,
  model: modelFixture,
  subscriptionPlan: subscriptionPlanFixture,
  subscription: subscriptionFixture,
  customerLimit: customerLimitFixture,
  budget: budgetFixture,
  usageRecord: usageRecordFixture,
  rateLimitCounter: rateLimitCounterFixture,
  apiKey: apiKeyFixture,
  managementApiKey: managementApiKeyFixture,
  settlementOutbox: settlementOutboxFixture,
  usageByModelProjection: usageByModelProjectionFixture,
} as const;

export type PersistenceFixtureName = keyof typeof PERSISTENCE_FIXTURE_REGISTRY;
