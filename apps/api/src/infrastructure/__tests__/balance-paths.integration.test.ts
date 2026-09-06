/**
 * Integration tests for the dual-path balance helpers (mongo/balance-paths.ts)
 * against the in-memory replica set. Proves the money path on real documents:
 *
 * - effectiveAmountExpr feeds amountGteExpr: a guarded debit decrements the
 *   balance exactly and commits its ledger (balance_adjustments) entry in the
 *   same transaction — or rolls both back.
 * - Guard refusals are no-ops: balance byte-identical, no ledger write.
 * - balanceDualIncPipeline is atomic per findOneAndUpdate, so concurrent
 *   guarded debits land on an exact final balance (never a lost update,
 *   never negative) with Micros + Units dual-write consistent.
 * - availableGteExpr refuses when existing holds consume the balance.
 *
 * All assertions are exact micros arithmetic (USD factor 10^4 for Units).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Cause, Effect, Exit } from "effect";
import type { WithId } from "mongodb";
import { ObjectId } from "mongodb";
import type { BalanceAdjustmentDoc, CustomerDoc } from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "@tokenpanel/db/test-support/memory-server";
import {
  balanceAdjustmentFixture,
  customerFixture,
} from "@tokenpanel/db/test-support/persistence-fixtures";
import {
  amountGteExpr,
  availableGteExpr,
  balanceDualIncPipeline,
} from "../mongo/balance-paths.ts";
import { withMongoSession } from "../mongo/session.ts";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";

const TEST_DB = "tokenpanel_balance_paths_test";

let handle: TestDbHandle;
let mongo: MongoDbService;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  mongo = {
    db: handle.db,
    client: handle.client,
    rawDb: handle.rawDb,
    close: async () => undefined,
  };
}, TEST_DB_START_TIMEOUT_MS);
afterAll(stopTestDb);

beforeEach(async () => {
  await resetTestCollections("customers", "balanceAdjustments");
});

/** Run an effect needing MongoDb on the real test-server service. */
async function runDb<A>(effect: Effect.Effect<A, unknown, MongoDb>): Promise<A> {
  const exit = await Effect.runPromiseExit(Effect.provideService(effect, MongoDb, mongo));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

async function seedCustomer(over: Partial<CustomerDoc> = {}): Promise<CustomerDoc> {
  const doc = customerFixture({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    ...over,
  });
  await handle.db.customers.insertOne(doc);
  return doc;
}

/** Ledger (balance_adjustments) row in the production usage_debit shape. */
function ledgerDoc(input: {
  _id: ObjectId;
  organizationId: ObjectId;
  customerId: ObjectId;
  amountMicros: number;
  now: Date;
}): BalanceAdjustmentDoc {
  return balanceAdjustmentFixture({
    _id: input._id,
    organizationId: input.organizationId,
    customerId: input.customerId,
    amountMicros: input.amountMicros,
    reason: "usage_debit",
    usageRecordId: null,
    note: null,
    occurredAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

type DebitOutcome =
  | { readonly debited: false }
  | { readonly debited: true; readonly balance: CustomerDoc["balance"] };

/**
 * Production settle flow: guarded findOneAndUpdate (amountGteExpr +
 * balanceDualIncPipeline) and the ledger insertOne committed in one
 * transaction — both land or neither does.
 */
function debitWithLedgerTxn(input: {
  customerId: ObjectId;
  organizationId: ObjectId;
  priceMicros: number;
  currency: string;
  ledgerId: ObjectId;
}): Effect.Effect<DebitOutcome, unknown, MongoDb> {
  return withMongoSession((session) =>
    Effect.tryPromise({
      try: async (): Promise<DebitOutcome> => {
        const now = new Date();
        const debited = await handle.db.customers.findOneAndUpdate(
          {
            _id: input.customerId,
            organizationId: input.organizationId,
            "balance.currency": input.currency,
            status: { $ne: "closed" },
            $expr: amountGteExpr(input.priceMicros),
          },
          balanceDualIncPipeline({
            amountDelta: -input.priceMicros,
            set: { updatedAt: now },
          }),
          { session, returnDocument: "after" },
        );
        if (!debited) return { debited: false };
        await handle.db.balanceAdjustments.insertOne(
          ledgerDoc({
            _id: input.ledgerId,
            organizationId: input.organizationId,
            customerId: input.customerId,
            amountMicros: -input.priceMicros,
            now,
          }),
          { session },
        );
        return { debited: true, balance: debited.balance };
      },
      catch: (e) => e,
    }),
  );
}

/** Single atomic guarded debit — no transaction (per-op atomicity only). */
function guardedDebitOp(
  customer: { readonly _id: ObjectId; readonly organizationId: ObjectId },
  priceMicros: number,
): Promise<WithId<CustomerDoc> | null> {
  return handle.db.customers.findOneAndUpdate(
    {
      _id: customer._id,
      organizationId: customer.organizationId,
      "balance.currency": "USD",
      status: { $ne: "closed" },
      $expr: amountGteExpr(priceMicros),
    },
    balanceDualIncPipeline({
      amountDelta: -priceMicros,
      set: { updatedAt: new Date() },
    }),
    { returnDocument: "after" },
  );
}

/** Reservation hold attempt: availableGteExpr guard, reservedDelta pipeline. */
function reserveOp(doc: CustomerDoc, needMicros: number) {
  return handle.db.customers.findOneAndUpdate(
    {
      _id: doc._id,
      organizationId: doc.organizationId,
      "balance.currency": "USD",
      status: { $ne: "closed" },
      $expr: availableGteExpr(needMicros),
    },
    balanceDualIncPipeline({
      reservedDelta: needMicros,
      set: { updatedAt: new Date() },
    }),
    { returnDocument: "after" },
  );
}

function expectDebited(result: DebitOutcome): CustomerDoc["balance"] {
  if (!result.debited) throw new Error("expected guarded debit to succeed");
  return result.balance;
}

describe("balance-paths guarded debit (transactional money path)", () => {
  test("guarded debit decrements balance exactly and commits ledger entry atomically", async () => {
    const doc = await seedCustomer(); // 100_000_000 micros, 0 reserved, USD
    const price = 2_500_000;

    const result = await runDb(
      debitWithLedgerTxn({
        customerId: doc._id,
        organizationId: doc.organizationId,
        priceMicros: price,
        currency: "USD",
        ledgerId: new ObjectId(),
      }),
    );
    const balance = expectDebited(result);
    expect(balance.amountMicros).toBe(97_500_000); // 100_000_000 - 2_500_000
    expect(balance.amountUnits).toBe(9_750); // floor(97_500_000 / 10_000) dual-write
    expect(Object.hasOwn(balance, "amountMinor")).toBe(false); // legacy Minor dropped
    expect(balance.reservedMicros).toBe(0); // amountDelta only — hold untouched

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(97_500_000);
    expect(after!.balance.amountUnits).toBe(9_750);
    expect(after!.balance.reservedMicros).toBe(0);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(doc.updatedAt.getTime());

    const ledger = await handle.db.balanceAdjustments
      .find({ customerId: doc._id })
      .toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amountMicros).toBe(-2_500_000);
    expect(ledger[0]!.reason).toBe("usage_debit");
    expect(ledger[0]!.currency).toBe("USD");
    expect(ledger[0]!.organizationId.toHexString()).toBe(
      doc.organizationId.toHexString(),
    );
  });

  test("debit exceeding amount is guard-refused: balance unchanged, no ledger write", async () => {
    const doc = await seedCustomer(); // 100_000_000 micros

    const result = await runDb(
      debitWithLedgerTxn({
        customerId: doc._id,
        organizationId: doc.organizationId,
        priceMicros: 100_000_001, // one micro past the guard
        currency: "USD",
        ledgerId: new ObjectId(),
      }),
    );
    expect(result.debited).toBe(false);

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(100_000_000); // exact no-op
    expect(after!.balance.amountUnits).toBeUndefined(); // dual-write skipped too
    expect(after!.balance.reservedMicros).toBe(0);
    expect(after!.updatedAt.getTime()).toBe(doc.updatedAt.getTime());
    expect(await handle.db.balanceAdjustments.countDocuments({})).toBe(0);
  });

  test("ledger insert failure aborts the transaction: debit rolled back, balance intact", async () => {
    const doc = await seedCustomer();
    const clashId = new ObjectId();
    await handle.db.balanceAdjustments.insertOne(
      ledgerDoc({
        _id: clashId,
        organizationId: doc.organizationId,
        customerId: doc._id,
        amountMicros: -1,
        now: new Date(),
      }),
    );

    let thrown: unknown;
    try {
      await runDb(
        debitWithLedgerTxn({
          customerId: doc._id,
          organizationId: doc.organizationId,
          priceMicros: 4_000_000, // well within balance — debit succeeds, insert clashes
          currency: "USD",
          ledgerId: clashId, // duplicate _id → E11000 → abort
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("E11000");

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(100_000_000); // debit rolled back
    expect(after!.balance.amountUnits).toBeUndefined(); // dual-write rolled back
    const remaining = await handle.db.balanceAdjustments.find().toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!._id.toHexString()).toBe(clashId.toHexString());
  });
});

describe("balanceDualIncPipeline dual-inc under concurrency", () => {
  test("two concurrent guarded debits both commit: exact final balance, no lost update", async () => {
    const doc = await seedCustomer({
      balance: {
        amountMicros: 12_000,
        reservedMicros: 0,
        currency: "USD",
        amountUnits: 1,
      },
    });

    const [a, b] = await Promise.all([
      guardedDebitOp(doc, 5_000),
      guardedDebitOp(doc, 5_000),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(2_000); // 12_000 - 5_000 - 5_000
    expect(after!.balance.amountUnits).toBe(0); // floor(2_000 / 10_000)
    expect(after!.balance.reservedMicros).toBe(0);
    expect(after!.balance.amountMicros).toBeGreaterThanOrEqual(0);
  });

  test("two concurrent guarded debits exceeding balance: exactly one commits, never negative", async () => {
    const doc = await seedCustomer({
      balance: {
        amountMicros: 10_000,
        reservedMicros: 0,
        currency: "USD",
        amountUnits: 1,
      },
    });

    const [a, b] = await Promise.all([
      guardedDebitOp(doc, 6_000),
      guardedDebitOp(doc, 6_000),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1); // guard admits exactly one of the two

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(4_000); // 10_000 - 6_000 exactly once
    expect(after!.balance.amountUnits).toBe(0); // floor(4_000 / 10_000)
    expect(after!.balance.amountMicros).toBeGreaterThanOrEqual(0);
    expect(winners[0]!.balance.amountMicros).toBe(4_000); // returned post-state matches
  });

  test("legacy Units-only balance: effectiveAmountExpr fallback feeds guard and dual-inc promotes Micros", async () => {
    const customerId = new ObjectId();
    const organizationId = new ObjectId();
    // No Micros keys: effective amount = 5_000 Units × 10_000 = 50_000_000 micros.
    await handle.db.customers.insertOne({
      _id: customerId,
      organizationId,
      name: "Legacy Units Corp",
      email: null,
      balance: { amountUnits: 5_000, currency: "USD" },
      status: "active",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await runDb(
      debitWithLedgerTxn({
        customerId,
        organizationId,
        priceMicros: 20_000_000,
        currency: "USD",
        ledgerId: new ObjectId(),
      }),
    );
    const balance = expectDebited(result);
    expect(balance.amountMicros).toBe(30_000_000); // 50_000_000 - 20_000_000
    expect(balance.amountUnits).toBe(3_000); // floor(30_000_000 / 10_000)
    expect(Object.hasOwn(balance, "amountMinor")).toBe(false); // legacy Minor dropped
    expect(Object.hasOwn(balance, "reservedMicros")).toBe(false); // reservedDelta 0 → untouched

    const after = await handle.db.customers.findOne({ _id: customerId });
    expect(after).not.toBeNull();
    expect(after!.balance.amountMicros).toBe(30_000_000);
    expect(after!.balance.amountUnits).toBe(3_000);
    expect(await handle.db.balanceAdjustments.countDocuments({})).toBe(1);
  });
});

describe("availableGteExpr hold accounting", () => {
  test("reservation above available (amount - holds) refused; exact available passes boundary", async () => {
    const doc = await seedCustomer({
      balance: {
        amountMicros: 10_000,
        reservedMicros: 7_000,
        currency: "USD",
        amountUnits: 1,
        reservedUnits: 0,
      },
    });
    // Effective available = 10_000 - 7_000 = 3_000 micros.

    const refused = await reserveOp(doc, 3_001); // one micro past available
    expect(refused).toBeNull();
    const afterRefusal = await handle.db.customers.findOne({ _id: doc._id });
    expect(afterRefusal).not.toBeNull();
    expect(afterRefusal!.balance.amountMicros).toBe(10_000);
    expect(afterRefusal!.balance.reservedMicros).toBe(7_000); // hold unchanged
    expect(afterRefusal!.balance.reservedUnits).toBe(0); // no dual-write on refusal

    const granted = await reserveOp(doc, 3_000); // $gte boundary is inclusive
    expect(granted).not.toBeNull();
    expect(granted!.balance.reservedMicros).toBe(10_000); // 7_000 + 3_000
    expect(granted!.balance.reservedUnits).toBe(1); // floor(10_000 / 10_000)
    expect(granted!.balance.amountMicros).toBe(10_000); // reserve never touches amount
    expect(granted!.balance.amountUnits).toBe(1); // amount side untouched

    const after = await handle.db.customers.findOne({ _id: doc._id });
    expect(after).not.toBeNull();
    expect(after!.balance.reservedMicros).toBe(10_000);
    // Balance fully held: any further need is refused.
    expect(await reserveOp(doc, 1)).toBeNull();
  });
});
