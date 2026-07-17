/**
 * Integration test for settleUsage against a live replica set.
 *
 * Verifies the settlement transaction: normal settle (balance debit +
 * adjustment + usage record + counter), exactly-once idempotency on
 * gatewayRequestId, and atomic guard failure (no partial charge when the
 * balance guard refuses). Skips when Mongo is unreachable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Exit, Layer } from "effect";
import { MongoClient, ObjectId } from "mongodb";
import {
  configureDb,
  getDb,
  getClient,
  getRawDb,
  closeDb,
} from "@tokenpanel/db";
import type { AppServices } from "../../runtime/layers/live.ts";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";
import { ValidatedRepositoriesLive } from "../../infrastructure/mongo/repositories/index.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../runtime/app-runtime.ts";
import {
  settleUsage as settleUsageEffect,
  SettlementGuardError,
  type SettlementActor,
  type SettleUsageParams,
} from "../../domains/settlement/settle.ts";
import type { ModelDoc, ModelEntryDoc, ProviderDoc } from "@tokenpanel/db";
import type { RateLimitRule } from "@tokenpanel/db";

/**
 * Run settleUsage on ManagedRuntime and surface typed failures (not FiberFailure)
 * so `instanceof SettlementGuardError` works in assertions.
 */
async function settleUsage(params: SettleUsageParams): Promise<void> {
  const exit = await getAppRuntime().runPromiseExit(settleUsageEffect(params));
  if (Exit.isSuccess(exit)) return;
  throw Cause.squash(exit.cause);
}

const TEST_DB = "tokenpanel_settle_test";
let connected = false;
let client: MongoClient | null = null;

async function ensureConnected(): Promise<boolean> {
  if (connected) return true;
  try {
    client = await new MongoClient(
      "mongodb://tokenpanel:tokenpanel_dev@localhost:27017/?directConnection=true&replicaSet=rs0&authSource=admin",
    ).connect();
    await client.db("admin").command({ ping: 1 });
    configureDb({
      uri: "mongodb://tokenpanel:tokenpanel_dev@localhost:27017/?directConnection=true&replicaSet=rs0&authSource=admin",
      databaseName: TEST_DB,
    });
    connected = true;
    return true;
  } catch {
    connected = false;
    return false;
  }
}

async function resetData(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.customers.deleteMany({}),
    db.organizations.deleteMany({}),
    db.usageRecords.deleteMany({}),
    db.balanceAdjustments.deleteMany({}),
    db.rateLimitCounters.deleteMany({}),
  ]);
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

beforeEach(async () => {
  if (!(await ensureConnected())) return;
  await resetData();
  // Unique gatewayRequestId index (sparse so nulls don't collide) — exercises
  // the in-transaction duplicate-key idempotency fallback.
  await getRawDb().collection("usage_records").createIndex(
    { gatewayRequestId: 1 },
    { unique: true, sparse: true, name: "ux_gatewayRequestId" },
  );
  await installRuntime();
});

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  if (connected) await resetData();
});

describe("settleUsage (live replica set)", () => {
  test("skips when mongo is unreachable", async () => {
    if (!connected) {
      console.log("  (skipped: live mongo not available)");
      return;
    }
  });

  test("normal settle debits balance, writes usage + adjustment + counter", async () => {
    if (!connected) return;
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const db = await getDb();
    await db.organizations.insertOne({
      _id: orgId,
      name: "o",
      slug: "o",
      ownerId: new ObjectId(),
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await db.customers.insertOne({
      _id: customerId,
      organizationId: orgId,
      externalId: "c1",
      name: "c",
      email: null,
      balance: { amountMinor: 10_000, currency: "USD", reservedMinor: 0 },
      status: "active",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

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
      price: { inputMinorPerMillion: 0, outputMinorPerMillion: 0 },
      marginBps: 0,
      currency: "USD",
      active: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ModelDoc;

    const actor: SettlementActor = {
      actorKind: "customer_key",
      customerId,
      apiKeyId: null,
      managementKeyId: null,
      customerEmail: null,
    };
    const rule: RateLimitRule = {
      id: "r1",
      windowSeconds: 3600,
      dimension: "tokens",
      capValue: 1_000_000,
      scope: "customer",
      scopeTarget: null,
      currency: null,
      active: true,
    };

    await settleUsage({
      orgId,
      actor,
      model,
      entry,
      provider,
      protocol: "openai",
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      costMinor: 0,
      priceMinor: 400,
      currency: "USD",
      gatewayRequestId: "gw_settle_normal",
      status: 200,
      durationMs: 10,
      rules: [rule],
    });

    const customerAfter = await db.customers.findOne({ _id: customerId });
    expect(customerAfter?.balance.amountMinor).toBe(9600);
    const usageRows = await db.usageRecords.find({ gatewayRequestId: "gw_settle_normal" }).toArray();
    expect(usageRows).toHaveLength(1);
    const adjustments = await db.balanceAdjustments.find({ customerId }).toArray();
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.amountMinor).toBe(-400);
    // usage_debit adjustments historically carry no usageRecordId link and no
    // note; the repo port preserves that (null, schema-compliant).
    expect(adjustments[0]?.usageRecordId).toBeNull();
    expect(adjustments[0]?.note).toBeNull();
    const counters = await db.rateLimitCounters.find({ customerId }).toArray();
    expect(counters).toHaveLength(1);
    expect(counters[0]?.count).toBe(150);
  });

  test("exactly-once: second settle with same gatewayRequestId is a no-op", async () => {
    if (!connected) return;
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const db = await getDb();
    await db.organizations.insertOne({
      _id: orgId,
      name: "o2",
      slug: "o2",
      ownerId: new ObjectId(),
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await db.customers.insertOne({
      _id: customerId,
      organizationId: orgId,
      externalId: "c2",
      name: "c",
      email: null,
      balance: { amountMinor: 10_000, currency: "USD", reservedMinor: 0 },
      status: "active",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const provider: ProviderDoc = {
      _id: new ObjectId(),
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
      providerId: provider._id,
      upstreamModelId: "gpt-4o",
      priority: 0,
      active: true,
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
      price: { inputMinorPerMillion: 0, outputMinorPerMillion: 0 },
      marginBps: 0,
      currency: "USD",
      active: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ModelDoc;

    const base = {
      orgId,
      actor: {
        actorKind: "customer_key" as const,
        customerId,
        apiKeyId: null,
        managementKeyId: null,
        customerEmail: null,
      },
      model,
      entry,
      provider,
      protocol: "openai" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costMinor: 0,
      priceMinor: 300,
      currency: "USD",
      gatewayRequestId: "gw_settle_idem",
      status: 200,
      durationMs: 5,
      rules: [] as RateLimitRule[],
    };

    await settleUsage(base);
    await settleUsage(base);

    const customerAfter = await db.customers.findOne({ _id: customerId });
    expect(customerAfter?.balance.amountMinor).toBe(9700);
    const usageRows = await db.usageRecords.find({ gatewayRequestId: "gw_settle_idem" }).toArray();
    expect(usageRows).toHaveLength(1);
  });

  test("guard failure: insufficient balance aborts with no partial charge", async () => {
    if (!connected) return;
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const db = await getDb();
    await db.organizations.insertOne({
      _id: orgId,
      name: "o3",
      slug: "o3",
      ownerId: new ObjectId(),
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await db.customers.insertOne({
      _id: customerId,
      organizationId: orgId,
      externalId: "c3",
      name: "c",
      email: null,
      balance: { amountMinor: 100, currency: "USD", reservedMinor: 0 },
      status: "active",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const provider: ProviderDoc = {
      _id: new ObjectId(),
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
      providerId: provider._id,
      upstreamModelId: "gpt-4o",
      priority: 0,
      active: true,
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
      price: { inputMinorPerMillion: 0, outputMinorPerMillion: 0 },
      marginBps: 0,
      currency: "USD",
      active: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ModelDoc;

    await expect(
      settleUsage({
        orgId,
        actor: {
          actorKind: "customer_key",
          customerId,
          apiKeyId: null,
          managementKeyId: null,
          customerEmail: null,
        },
        model,
        entry,
        provider,
        protocol: "openai",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        costMinor: 0,
        priceMinor: 5000, // exceeds 100 minor balance
        currency: "USD",
        gatewayRequestId: "gw_settle_guard",
        status: 200,
        durationMs: 5,
        rules: [],
        rethrowGuardFailure: true,
      }),
    ).rejects.toBeInstanceOf(SettlementGuardError);

    // No partial charge: balance unchanged, no usage record, no adjustment.
    const customerAfter = await db.customers.findOne({ _id: customerId });
    expect(customerAfter?.balance.amountMinor).toBe(100);
    const usageRows = await db.usageRecords.find({ gatewayRequestId: "gw_settle_guard" }).toArray();
    expect(usageRows).toHaveLength(0);
    const adjustments = await db.balanceAdjustments.find({ customerId }).toArray();
    expect(adjustments).toHaveLength(0);
  });
});

// Keep the shared client alive for the suite; close on process exit.
process.on("exit", () => {
  void (async () => {
    if (client) await client.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
  })();
});
