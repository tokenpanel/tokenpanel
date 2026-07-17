/**
 * Generation cancellation integration.
 *
 * Proves interruption stays control flow end to end with a REAL held
 * reservation against the live replica set: pre-commit disconnect releases
 * the hold; post-commit disconnect with reported usage settles (debit + release
 * hold) rather than free-billing or leaking the reservation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Layer } from "effect";
import { ObjectId } from "mongodb";
import {
  configureDb,
  getDb,
  getClient,
  getRawDb,
  closeDb,
} from "@tokenpanel/db";
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
let connected = false;

async function ensureConnected(): Promise<boolean> {
  if (connected) return true;
  try {
    const uri =
      "mongodb://tokenpanel:tokenpanel_dev@localhost:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
    await import("mongodb").then(({ MongoClient }) =>
      new MongoClient(uri).connect().then((c) => c.db("admin").command({ ping: 1 })),
    );
    configureDb({ uri, databaseName: TEST_DB });
    connected = true;
    return true;
  } catch {
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

async function seedOrgCustomer(
  balanceUnits: number,
  reservedUnits: number,
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
    balance: { amountUnits: balanceUnits, currency: "USD", reservedUnits },
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
    price: { inputUnitsPerMillion: 0, outputUnitsPerMillion: 0 },
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
    price: { inputUnitsPerMillion: 0, outputUnitsPerMillion: 0 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ModelDoc;
  return { model, entry, provider };
}

async function reservedUnitsOf(customerId: ObjectId): Promise<number> {
  const db = await getDb();
  const c = await db.customers.findOne({ _id: customerId });
  return (c?.balance as { reservedUnits?: number } | null)?.reservedUnits ?? 0;
}

async function amountUnitsOf(customerId: ObjectId): Promise<number> {
  const db = await getDb();
  const c = await db.customers.findOne({ _id: customerId });
  return (c?.balance as { amountUnits?: number } | null)?.amountUnits ?? 0;
}

beforeEach(async () => {
  if (!(await ensureConnected())) return;
  await resetData();
  await installRuntime();
});

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  if (connected) await resetData();
});

describe("generation cancellation (live replica set)", () => {
  test("skips when mongo is unreachable", async () => {
    if (!connected) {
      console.log("  (skipped: live mongo not available)");
      return;
    }
  });

  test("pre-commit disconnect releases the held reservation", async () => {
    if (!connected) return;
    const { orgId, customerId } = await seedOrgCustomer(10_000, 500);
    expect(await reservedUnitsOf(customerId)).toBe(500);

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
      reservedUnits: 500,
      reservation: { reservedUnits: 500, customerId, organizationId: orgId },
      rules: [],
      startedAtMs: Date.now(),
      lifecycle: preCommitInterrupted,
      activeEntry: null,
      activeProvider: null,
      usage: emptyStreamUsage("openai"),
    });

    expect(result.action).toBe("released");
    // Hold fully returned; cash balance untouched.
    expect(await reservedUnitsOf(customerId)).toBe(0);
    expect(await amountUnitsOf(customerId)).toBe(10_000);
  });

  test("post-commit disconnect with reported usage settles (debit + release hold)", async () => {
    if (!connected) return;
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
      reservedUnits: 500,
      reservation: { reservedUnits: 500, customerId, organizationId: orgId },
      rules: [],
      startedAtMs: Date.now(),
      lifecycle: s,
      activeEntry: entry,
      activeProvider: provider,
      usage,
      priceUnitsOverride: 300,
    });

    // Post-commit with reported usage → settle path (not free-bill, not leaked).
    expect(result.action).toBe("settled");
    expect(await reservedUnitsOf(customerId)).toBe(0);
    expect(await amountUnitsOf(customerId)).toBe(9700); // 10000 - 300 price

    const db = await getDb();
    const usageRows = await db.usageRecords
      .find({ gatewayRequestId: "gw_cancel_post" })
      .toArray();
    expect(usageRows).toHaveLength(1);
  });
});

process.on("exit", () => {
  void (async () => {
    await closeDb().catch(() => undefined);
  })();
});
