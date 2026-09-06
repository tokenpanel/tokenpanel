/**
 * Generation cancellation integration.
 *
 * Proves interruption stays control flow end to end with a REAL held
 * reservation against the live replica set: pre-commit disconnect releases
 * the hold; post-commit disconnect with reported usage settles (debit + release
 * hold) rather than free-billing or leaking the reservation.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Layer } from "effect";
import { ObjectId } from "mongodb";
import {
  getDb,
  getClient,
  getRawDb,
} from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
} from "@tokenpanel/db/test-support/memory-server";
import type { AppServices } from "../runtime/layers/live.ts";
import { MongoDb, type MongoDbService } from "../runtime/services/mongo-db.ts";
import { ValidatedRepositoriesLive } from "../infrastructure/mongo/repositories/index.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
} from "../runtime/app-runtime.ts";
import { finalizeStreamGeneration } from "../domains/providers/generation.ts";
import {
  initialStreamState,
  transitionStream,
} from "../domains/providers/stream-lifecycle.ts";
import { emptyStreamUsage } from "../domains/providers/generation.ts";
import type { ModelDoc, ModelEntryDoc, ProviderDoc } from "@tokenpanel/db";

const TEST_DB = "tokenpanel_cancel_test";

async function resetData(): Promise<void> {
  await resetTestCollections(
    "customers",
    "organizations",
    "usageRecords",
    "balanceAdjustments",
    "rateLimitCounters",
  );
}

async function installRuntime(): Promise<void> {
  const mongo: MongoDbService = {
    db: await getDb(),
    client: getClient(),
    rawDb: getRawDb(),
    close: async () => undefined,
  };
  const base = Layer.succeed(MongoDb, mongo);
  const layer = Layer.provideMerge(ValidatedRepositoriesLive, base) as unknown as Layer.Layer<
    AppServices,
    never,
    never
  >;
  createAppRuntime(layer, { install: true });
}

async function seedOrgCustomer(
  balanceMicros: number,
  reservedMicros: number,
): Promise<{ orgId: ObjectId; customerId: ObjectId }> {
  const orgId = new ObjectId();
  const customerId = new ObjectId();
  const db = await getDb();
  await db.organizations.insertOne({
    _id: orgId,
    name: "cancel-org",
    slug: "cancel-org",
    ownerId: new ObjectId(),
    defaultCurrency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  await db.customers.insertOne({
    _id: customerId,
    organizationId: orgId,
    externalId: "cc",
    name: "cc",
    email: null,
    balance: { amountMicros: balanceMicros, currency: "USD", reservedMicros },
    status: "active",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  return { orgId, customerId };
}

function modelStub(orgId: ObjectId): {
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
} {
  const providerId = new ObjectId();
  const provider: ProviderDoc = {
    _id: providerId,
    organizationId: orgId,
    name: "p",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "x",
    baseUrl: "https://example.invalid",
    providerOrg: null,
    headers: {},
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ProviderDoc;
  const entry: ModelEntryDoc = {
    id: "e1",
    providerId,
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
    price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  } as unknown as ModelEntryDoc;
  const model: ModelDoc = {
    _id: new ObjectId(),
    organizationId: orgId,
    aliasId: "gpt-4o",
    displayName: "g",
    description: null,
    entries: [entry],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ModelDoc;
  return { model, entry, provider };
}

async function reservedMicrosOf(customerId: ObjectId): Promise<number> {
  const db = await getDb();
  const c = await db.customers.findOne({ _id: customerId });
  return (c?.balance as { reservedMicros?: number } | null)?.reservedMicros ?? 0;
}

async function amountMicrosOf(customerId: ObjectId): Promise<number> {
  const db = await getDb();
  const c = await db.customers.findOne({ _id: customerId });
  return (c?.balance as { amountMicros?: number } | null)?.amountMicros ?? 0;
}

beforeAll(() => startTestDb({ databaseName: TEST_DB }), TEST_DB_START_TIMEOUT_MS);
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  await installRuntime();
});

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  await resetData();
});

describe("generation cancellation (live replica set)", () => {
  test("pre-commit disconnect releases the held reservation", async () => {
    const { orgId, customerId } = await seedOrgCustomer(10_000, 500);
    expect(await reservedMicrosOf(customerId)).toBe(500);

    const { model } = modelStub(orgId);
    const preCommitInterrupted = transitionStream(
      initialStreamState(),
      { type: "interrupt" },
    ).state;

    const result = await finalizeStreamGeneration({
      orgId,
      actor: {
        actorKind: "customer_key",
        customerId,
        apiKeyId: null,
        managementKeyId: null,
        customerEmail: null,
      },
      model,
      protocol: "openai",
      gatewayRequestId: "gw_cancel_pre",
      reservedMicros: 500,
      reservation: { reservedMicros: 500, customerId, organizationId: orgId },
      rules: [],
      startedAtMs: Date.now(),
      lifecycle: preCommitInterrupted,
      activeEntry: null,
      activeProvider: null,
      usage: emptyStreamUsage("openai"),
    });

    expect(result.action).toBe("released");
    // Hold fully returned; cash balance untouched.
    expect(await reservedMicrosOf(customerId)).toBe(0);
    expect(await amountMicrosOf(customerId)).toBe(10_000);
  });

  test("post-commit disconnect with reported usage settles (debit + release hold)", async () => {
    const { orgId, customerId } = await seedOrgCustomer(10_000, 500);
    const { model, entry, provider } = modelStub(orgId);

    // Commit the stream, then interrupt → post-commit disconnect.
    let s = transitionStream(initialStreamState(), { type: "delta", entryId: entry.id }).state;
    s = transitionStream(s, { type: "interrupt" }).state;
    expect(s.tag).toBe("interrupted");

    const usage = emptyStreamUsage("openai");
    usage.promptTokens = 100;
    usage.completionTokens = 50;
    usage.reportedTotalTokens = 150;
    usage.streamComplete = true;

    const result = await finalizeStreamGeneration({
      orgId,
      actor: {
        actorKind: "customer_key",
        customerId,
        apiKeyId: null,
        managementKeyId: null,
        customerEmail: null,
      },
      model,
      protocol: "openai",
      gatewayRequestId: "gw_cancel_post",
      reservedMicros: 500,
      reservation: { reservedMicros: 500, customerId, organizationId: orgId },
      rules: [],
      startedAtMs: Date.now(),
      lifecycle: s,
      activeEntry: entry,
      activeProvider: provider,
      usage,
      priceMicrosOverride: 300,
    });

    // Post-commit with reported usage → settle path (not free-bill, not leaked).
    expect(result.action).toBe("settled");
    expect(await reservedMicrosOf(customerId)).toBe(0);
    expect(await amountMicrosOf(customerId)).toBe(9700); // 10000 - 300 price

    const db = await getDb();
    const usageRows = await db.usageRecords
      .find({ gatewayRequestId: "gw_cancel_post" })
      .toArray();
    expect(usageRows).toHaveLength(1);
  });
});

