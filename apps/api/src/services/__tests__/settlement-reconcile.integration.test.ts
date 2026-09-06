/**
 * Integration tests for the settlement reconciliation worker
 * (services/settlement-reconcile.ts) against the in-memory replica set.
 *
 * Covered end-to-end with real Mongo semantics (no mocks):
 *  - reconcileOutboxRow success: settles usage, debits the customer balance,
 *    writes the usage_debit adjustment, and marks the outbox row reconciled.
 *  - Exactly-once idempotency: a row whose gatewayRequestId already has a
 *    settled usage record reconciles without a second settle.
 *  - Guard-failure retry: attempts+1, exponential backoff nextAttemptAt,
 *    row released back to pending, claim fencing token cleared.
 *  - Max attempts: the claim after OUTBOX_MAX_ATTEMPTS abandons the row.
 *  - processSettlementOutboxBatch: batch size respected, per-row outcomes,
 *    and the empty (no eligible rows) no-op.
 *  - Stale-claim fencing: replaying a settled row with a stale token yields
 *    "stale_claim" and never double-settles.
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
import { Cause, Exit, Layer } from "effect";
import { ObjectId } from "mongodb";
import { getDb, getClient, getRawDb } from "@tokenpanel/db";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  SettlementOutboxDoc,
} from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
} from "@tokenpanel/db/test-support/memory-server";
import {
  customerFixture,
  FIXTURE_IDS,
  settlementOutboxFixture,
} from "@tokenpanel/db/test-support/persistence-fixtures";
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
  processSettlementOutboxBatch,
  reconcileOutboxRow,
  type ReconcileResult,
} from "../settlement-reconcile.ts";
import {
  claimDueOutboxRows,
  claimFromRow,
  OUTBOX_MAX_ATTEMPTS,
  type OutboxClaim,
} from "../settlement-outbox.ts";
import {
  settleUsage as settleUsageEffect,
  type SettlementActor,
  type SettleUsageParams,
} from "../../domains/settlement/settle.ts";

const TEST_DB = "tokenpanel_reconcile_test";

interface RawOutboxRow {
  status?: unknown;
  attempts?: unknown;
  claimToken?: unknown;
  claimedAt?: unknown;
  nextAttemptAt?: unknown;
  context?: Record<string, unknown> | null;
}

/** Run a batch on the installed ManagedRuntime; typed failures surface as throws. */
async function runBatch(
  limit: number,
): Promise<{ claimed: number; reconciled: number; abandoned: number }> {
  const exit = await getAppRuntime().runPromiseExit(
    processSettlementOutboxBatch(limit),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Run one row reconcile on the installed ManagedRuntime. */
async function runReconcile(
  row: SettlementOutboxDoc,
  claim: OutboxClaim,
): Promise<ReconcileResult> {
  const exit = await getAppRuntime().runPromiseExit(
    reconcileOutboxRow(row, claim),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Claim due rows through the real service (adds claim tokens to the docs). */
async function claimAll(limit: number): Promise<SettlementOutboxDoc[]> {
  const exit = await getAppRuntime().runPromiseExit(claimDueOutboxRows(limit));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Settle directly via the domain service (used to pre-seed usage records). */
async function settleOnce(params: SettleUsageParams): Promise<void> {
  const exit = await getAppRuntime().runPromiseExit(settleUsageEffect(params));
  if (Exit.isSuccess(exit)) return;
  throw Cause.squash(exit.cause);
}

async function resetData(): Promise<void> {
  await resetTestCollections(
    "settlementOutbox",
    "usageRecords",
    "customers",
    "organizations",
    "balanceAdjustments",
    "rateLimitCounters",
    "models",
    "providers",
    "modelCatalog",
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

beforeAll(() => startTestDb({ databaseName: TEST_DB }), TEST_DB_START_TIMEOUT_MS);
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  // Unique gatewayRequestId index — the reconcile idempotency path relies on it.
  await getRawDb().collection("usage_records").createIndex(
    { gatewayRequestId: 1 },
    { unique: true, sparse: true, name: "ux_gatewayRequestId" },
  );
  await installRuntime();
});

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  await resetData();
});

/** Seed an org + active customer with the given balance (micros). */
async function seedCustomer(
  balanceMicros: number,
): Promise<{ orgId: ObjectId; customerId: ObjectId }> {
  // Canonical fixture ids: settlementOutboxFixture defaults organizationId /
  // customerId to these, so outbox rows always reference the seeded pair.
  const orgId = new ObjectId(FIXTURE_IDS.org);
  const customerId = new ObjectId(FIXTURE_IDS.customer);
  const db = await getDb();
  await db.organizations.insertOne({
    _id: orgId,
    name: "recon-org",
    slug: `recon-org-${orgId.toHexString()}`,
    ownerId: new ObjectId(),
    defaultCurrency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  await db.customers.insertOne(
    customerFixture({
      _id: customerId,
      organizationId: orgId,
      externalId: `recon-${customerId.toHexString()}`,
      balance: { amountMicros: balanceMicros, reservedMicros: 0, currency: "USD" },
    }) as never,
  );
  return { orgId, customerId };
}

/** Insert one outbox row (unique _id + gatewayRequestId per call). */
async function insertRow(
  over: Partial<SettlementOutboxDoc> & { context: Record<string, unknown> },
): Promise<SettlementOutboxDoc> {
  const doc = settlementOutboxFixture(over);
  await (await getDb()).settlementOutbox.insertOne(doc as never);
  return doc;
}

async function rawOutboxRow(
  gatewayRequestId: string,
): Promise<RawOutboxRow | null> {
  const doc = await getRawDb()
    .collection("settlement_outbox")
    .findOne({ gatewayRequestId });
  return doc === null ? null : (doc as unknown as RawOutboxRow);
}
function ctxOf(row: RawOutboxRow | null): Record<string, unknown> {
  return row?.context ?? {};
}

async function customerBalance(customerId: ObjectId): Promise<number> {
  const doc = await (await getDb()).customers.findOne({ _id: customerId });
  if (!doc) throw new Error(`customer ${customerId.toHexString()} missing`);
  return doc.balance.amountMicros;
}

async function usageCount(gatewayRequestId?: string): Promise<number> {
  const db = await getDb();
  return gatewayRequestId === undefined
    ? db.usageRecords.countDocuments({})
    : db.usageRecords.countDocuments({ gatewayRequestId });
}

/** Minimal model/provider/entry trio for direct settleUsage pre-seeding. */
function makeSettleRefs(orgId: ObjectId): {
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
} {
  const providerId = new ObjectId();
  const entry = {
    id: "e1",
    providerId,
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
  } as unknown as ModelEntryDoc;
  const provider = {
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
  const model = {
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
  const actor: SettlementActor = {
    actorKind: "customer_key",
    customerId: null,
    apiKeyId: null,
    managementKeyId: null,
    customerEmail: null,
  };
  return { actor, model, entry, provider };
}

/** Analytics-only settle (price 0, no debit) that persists the usage record. */
async function preSettleUsage(
  orgId: ObjectId,
  gatewayRequestId: string,
): Promise<void> {
  const { actor, model, entry, provider } = makeSettleRefs(orgId);
  await settleOnce({
    orgId,
    actor,
    model,
    entry,
    provider,
    protocol: "openai",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    costMicros: 0,
    priceMicros: 0,
    currency: "USD",
    gatewayRequestId,
    status: 200,
    durationMs: 1,
    rules: [],
  });
}

const SETTLE_USAGE = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

describe("settlement reconcile (live replica set)", () => {
  test("missing usage context abandons the row without settling", async () => {
    const { customerId } = await seedCustomer(10_000);
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_abandon_missing",
      customerId,
      reason: "missing_usage",
      context: { actorKind: "customer_key", priceMicros: 300 },
    });

    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 1, reconciled: 0, abandoned: 1 });
    const row = await rawOutboxRow("gw_abandon_missing");
    expect(row?.status).toBe("abandoned");
    expect(row?.context?.abandonReason).toBe("missing_usage");
    expect(row?.claimToken).toBeUndefined();
    // Nothing settled: no usage record, no balance movement.
    expect(await usageCount()).toBe(0);
    expect(await customerBalance(customerId)).toBe(10_000);
  });

  test("success: frozen-context row settles usage, debits balance, marks reconciled", async () => {
    const { customerId } = await seedCustomer(10_000);
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_recon_frozen",
      customerId,
      context: {
        actorKind: "customer_key",
        priceMicros: 300,
        currency: "USD",
        status: 200,
        durationMs: 5,
        usage: SETTLE_USAGE,
      },
    });

    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 1, reconciled: 1, abandoned: 0 });
    // Usage settled exactly once with the frozen price.
    const db = await getDb();
    const usage = await db.usageRecords
      .find({ gatewayRequestId: "gw_recon_frozen" })
      .toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.priceMicros).toBe(300);
    expect(usage[0]?.totalTokens).toBe(150);
    // Balance direction: debit of the frozen price.
    expect(await customerBalance(customerId)).toBe(9_700);
    const adjustments = await db.balanceAdjustments
      .find({ customerId })
      .toArray();
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.amountMicros).toBe(-300);
    expect(adjustments[0]?.reason).toBe("usage_debit");
    // Row is settled and the fencing claim is cleared.
    const row = await rawOutboxRow("gw_recon_frozen");
    expect(row?.status).toBe("reconciled");
    expect(row?.claimToken).toBeUndefined();
    expect(row?.claimedAt).toBeUndefined();
  });

  test("exactly-once: already-settled gatewayRequestId reconciles without re-settling", async () => {
    const { orgId, customerId } = await seedCustomer(10_000);
    await preSettleUsage(orgId, "gw_recon_idem");
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_recon_idem",
      customerId,
      context: {
        actorKind: "customer_key",
        priceMicros: 300,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });

    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 1, reconciled: 1, abandoned: 0 });
    // The pre-existing usage record is reused — no second settle, no debit.
    expect(await usageCount("gw_recon_idem")).toBe(1);
    expect(await customerBalance(customerId)).toBe(10_000);
    const row = await rawOutboxRow("gw_recon_idem");
    expect(row?.status).toBe("reconciled");
    expect(row?.claimToken).toBeUndefined();
  });

  test("guard failure: attempts+1, backoff nextAttemptAt, row stays pending", async () => {
    const { customerId } = await seedCustomer(1_000);
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_retry_backoff",
      customerId,
      context: {
        actorKind: "customer_key",
        priceMicros: 50_000,
        usage: SETTLE_USAGE,
      },
    });

    const batchStartedAt = new Date();
    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 1, reconciled: 0, abandoned: 0 });
    const row = await rawOutboxRow("gw_retry_backoff");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.claimToken).toBeUndefined();
    expect(String(ctxOf(row).lastError)).toBe("settlement_guard_failed");
    // Backoff: claim.attempts=1 -> 5s * 2^1 = 10s in the future.
    const nextAt = row?.nextAttemptAt;
    if (!(nextAt instanceof Date)) throw new Error("expected nextAttemptAt");
    expect(nextAt.getTime()).toBeGreaterThanOrEqual(
      batchStartedAt.getTime() + 9_500,
    );
    expect(nextAt.getTime()).toBeLessThanOrEqual(Date.now() + 11_000);
    // Failed settle left no trace, and the row is not immediately re-claimable.
    expect(await usageCount()).toBe(0);
    expect(await customerBalance(customerId)).toBe(1_000);
    const again = await runBatch(10);
    expect(again).toEqual({ claimed: 0, reconciled: 0, abandoned: 0 });
  });

  test("claim exceeding max attempts abandons instead of retrying", async () => {
    const { customerId } = await seedCustomer(1_000);
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_max_attempts",
      customerId,
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
      context: {
        actorKind: "customer_key",
        priceMicros: 50_000,
        usage: SETTLE_USAGE,
      },
    });

    const result = await runBatch(10);

    // Claim bumps 19 -> 20 (= OUTBOX_MAX_ATTEMPTS). The failed settle then
    // releases via releaseOutboxAfterFailure, whose max-attempts branch
    // abandons the row (reconcileOutboxRow itself reports "retry", so the
    // batch's abandoned counter does not tick) — the row state is authoritative.
    expect(result).toEqual({ claimed: 1, reconciled: 0, abandoned: 0 });
    const row = await rawOutboxRow("gw_max_attempts");
    expect(row?.status).toBe("abandoned");
    expect(row?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(String(ctxOf(row).abandonReason)).toContain("max_attempts:");
    expect(await usageCount()).toBe(0);
  });

  test("batch size is respected: only limit rows are processed per pass", async () => {
    const { customerId } = await seedCustomer(10_000);
    const base = Date.now() - 60_000;
    for (let i = 0; i < 4; i++) {
      await insertRow({
        _id: new ObjectId(),
        gatewayRequestId: `gw_batch_${i}`,
        customerId,
        // Distinct createdAt fixes claimDue ordering deterministically.
        createdAt: new Date(base + i * 1000),
        updatedAt: new Date(base + i * 1000),
        context: { actorKind: "customer_key", priceMicros: 300 },
      });
    }

    const first = await runBatch(2);
    expect(first).toEqual({ claimed: 2, reconciled: 0, abandoned: 2 });
    // Rows 0 and 1 abandoned; rows 2 and 3 untouched (still pending, unclaimed).
    expect((await rawOutboxRow("gw_batch_0"))?.status).toBe("abandoned");
    expect((await rawOutboxRow("gw_batch_1"))?.status).toBe("abandoned");
    for (const gw of ["gw_batch_2", "gw_batch_3"]) {
      const row = await rawOutboxRow(gw);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
      expect(row?.claimToken).toBeUndefined();
    }

    const second = await runBatch(10);
    expect(second).toEqual({ claimed: 2, reconciled: 0, abandoned: 2 });
    expect((await rawOutboxRow("gw_batch_2"))?.status).toBe("abandoned");
    expect((await rawOutboxRow("gw_batch_3"))?.status).toBe("abandoned");
  });

  test("per-row outcomes in one batch: abandoned, reconciled, retried", async () => {
    const { orgId, customerId } = await seedCustomer(10_000);
    await preSettleUsage(orgId, "gw_mixed_ok");
    const base = Date.now() - 60_000;
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_mixed_abandon",
      customerId,
      createdAt: new Date(base),
      updatedAt: new Date(base),
      context: { actorKind: "customer_key", priceMicros: 300 },
    });
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_mixed_ok",
      customerId,
      createdAt: new Date(base + 1000),
      updatedAt: new Date(base + 1000),
      context: {
        actorKind: "customer_key",
        priceMicros: 300,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_mixed_retry",
      customerId,
      createdAt: new Date(base + 2000),
      updatedAt: new Date(base + 2000),
      context: {
        actorKind: "customer_key",
        priceMicros: 50_000,
        usage: SETTLE_USAGE,
      },
    });

    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 3, reconciled: 1, abandoned: 1 });
    expect((await rawOutboxRow("gw_mixed_abandon"))?.status).toBe("abandoned");
    expect((await rawOutboxRow("gw_mixed_ok"))?.status).toBe("reconciled");
    const retried = await rawOutboxRow("gw_mixed_retry");
    expect(retried?.status).toBe("pending");
    expect(retried?.attempts).toBe(1);
    // Only the pre-seeded usage record exists; the retried settle rolled back
    // and the price-0 reconcile debited nothing.
    expect(await usageCount("gw_mixed_ok")).toBe(1);
    expect(await customerBalance(customerId)).toBe(10_000);
  });

  test("no eligible rows: empty result and no writes", async () => {
    const { customerId } = await seedCustomer(10_000);
    await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_future",
      customerId,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
      context: { actorKind: "customer_key", priceMicros: 300 },
    });

    const result = await runBatch(10);

    expect(result).toEqual({ claimed: 0, reconciled: 0, abandoned: 0 });
    const row = await rawOutboxRow("gw_future");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.claimToken).toBeUndefined();
    // A terminal row is equally ineligible.
    await (await getDb()).settlementOutbox.updateOne(
      { gatewayRequestId: "gw_future" },
      { $set: { status: "reconciled" } } as never,
    );
    const terminal = await runBatch(10);
    expect(terminal).toEqual({ claimed: 0, reconciled: 0, abandoned: 0 });
  });

  test("stale claim is fenced: replay yields stale_claim without double-settle", async () => {
    const { customerId } = await seedCustomer(10_000);
    const row = await insertRow({
      _id: new ObjectId(),
      gatewayRequestId: "gw_direct_fence",
      customerId,
      context: {
        actorKind: "customer_key",
        priceMicros: 300,
        usage: SETTLE_USAGE,
      },
    });

    // First pass: claim through the real service, reconcile with the live claim.
    const claimed = await claimAll(10);
    expect(claimed).toHaveLength(1);
    const claim = claimFromRow(claimed[0]!);
    if (!claim) throw new Error("expected claim token on claimed row");
    expect(await runReconcile(row, claim)).toBe("reconciled");
    expect(await customerBalance(customerId)).toBe(9_700);

    // Replay the same row with a stale fencing token: no double settle.
    const stale: OutboxClaim = { attempts: claim.attempts, claimToken: "stale" };
    expect(await runReconcile(row, claim)).toBe("stale_claim");
    expect(await runReconcile(row, stale)).toBe("stale_claim");
    expect(await usageCount("gw_direct_fence")).toBe(1);
    expect(await customerBalance(customerId)).toBe(9_700);
    const raw = await rawOutboxRow("gw_direct_fence");
    expect(raw?.status).toBe("reconciled");
  });
});

