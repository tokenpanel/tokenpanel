/**
 * Settlement outbox: pure backoff/lease/abandon helpers + Effect claim flow.
 * Fake repo via Layer.succeed + MongoDb session stub — no DB.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { SettlementOutboxDoc } from "@tokenpanel/db";
import { SystemError } from "../../../errors/families.ts";
import { Clock } from "../../../runtime/services/clock.ts";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../../runtime/app-runtime.ts";
import { SettlementOutboxRepo } from "../../../infrastructure/mongo/repositories/settlement-outbox.ts";
import type { SettlementOutboxRepoService } from "../../../infrastructure/mongo/repositories/settlement-outbox.ts";
import {
  OUTBOX_BACKOFF_BASE_SECONDS,
  OUTBOX_BACKOFF_CAP_SECONDS,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS_COUNT,
} from "../policy.ts";
import {
  backoffSeconds,
  claimDueOp,
  claimFromRow,
  computeNextAttemptAt,
  enqueueOutboxOp,
  leaseUntil,
  shouldAbandon,
} from "../outbox.ts";

const ORG_ID = new ObjectId();

function outboxDoc(over: Partial<SettlementOutboxDoc> = {}): SettlementOutboxDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    customerId: null,
    gatewayRequestId: `gw_${new ObjectId().toHexString()}`,
    reason: "usage_missing",
    modelAliasId: "gpt-test",
    context: {},
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as SettlementOutboxDoc;
}

function installRuntime(stubs: {
  outbox?: Partial<SettlementOutboxRepoService>;
  nowMs?: number;
}): void {
  const outbox = (stubs.outbox ?? {}) as SettlementOutboxRepoService;
  const mongoStub = {
    client: {
      startSession: async () => ({
        startTransaction: () => undefined,
        commitTransaction: async () => undefined,
        abortTransaction: async () => undefined,
        endSession: async () => undefined,
        inTransaction: () => true,
      }),
    },
    db: {},
  };
  const layer = Layer.mergeAll(
    Layer.succeed(SettlementOutboxRepo, outbox),
    Layer.succeed(MongoDb, mongoStub as never),
    Layer.succeed(Clock, {
      nowMs: () => stubs.nowMs ?? 0,
      now: () => new Date(stubs.nowMs ?? 0),
    }),
  ) as unknown as Layer.Layer<never, never, never>;
  createAppRuntime(layer as never, { install: true });
}

function runEffect<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return getAppRuntime().runPromise(effect as never) as Promise<A>;
}

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
});

describe("pure backoff + lease helpers", () => {
  test("backoffSeconds: 5s base doubling, capped at 3600s", () => {
    expect(backoffSeconds(0)).toBe(5);
    expect(backoffSeconds(1)).toBe(10);
    expect(backoffSeconds(2)).toBe(20);
    expect(backoffSeconds(3)).toBe(40);
    expect(backoffSeconds(9)).toBe(2560);
    expect(backoffSeconds(10)).toBe(3600);
    expect(backoffSeconds(50)).toBe(3600);
    expect(OUTBOX_BACKOFF_BASE_SECONDS).toBe(5);
    expect(OUTBOX_BACKOFF_CAP_SECONDS).toBe(3600);
  });

  test("shouldAbandon: false below max attempts, true at/above", () => {
    expect(shouldAbandon(0)).toBe(false);
    expect(shouldAbandon(OUTBOX_MAX_ATTEMPTS_COUNT - 1)).toBe(false);
    expect(shouldAbandon(OUTBOX_MAX_ATTEMPTS_COUNT)).toBe(true);
    expect(shouldAbandon(OUTBOX_MAX_ATTEMPTS_COUNT + 5)).toBe(true);
    expect(OUTBOX_MAX_ATTEMPTS_COUNT).toBe(20);
  });

  test("leaseUntil: from + 5 minutes", () => {
    const fromMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(leaseUntil(fromMs).getTime()).toBe(
      fromMs + OUTBOX_CLAIM_LEASE_MS,
    );
    expect(OUTBOX_CLAIM_LEASE_MS).toBe(300_000);
  });

  test("computeNextAttemptAt: uses Clock now + backoff(attempts)", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    installRuntime({ nowMs });
    const at = await runEffect(computeNextAttemptAt(0));
    expect(at.getTime()).toBe(nowMs + 5_000);
    const capped = await runEffect(computeNextAttemptAt(20));
    expect(capped.getTime()).toBe(nowMs + 3600_000);
  });
});

describe("claimFromRow", () => {
  test("extracts attempts + claimToken when row has a token", () => {
    const claim = claimFromRow(outboxDoc({ claimToken: "tok-1", attempts: 3 }));
    expect(claim).toEqual({ attempts: 3, claimToken: "tok-1" });
  });

  test("null when claimToken missing or empty", () => {
    expect(claimFromRow(outboxDoc({ claimToken: undefined }))).toBeNull();
    expect(claimFromRow(outboxDoc({ claimToken: "" }))).toBeNull();
  });
});

describe("enqueueOutboxOp (Effect over fake repo)", () => {
  test("builds pending doc, compacts key, delegates to insertOrGetByGatewayRequestId", async () => {
    let captured: Record<string, unknown> | undefined;
    const id = new ObjectId();
    installRuntime({
      outbox: {
        insertOrGetByGatewayRequestId: (doc) => {
          captured = doc as Record<string, unknown>;
          return Effect.succeed(id as never);
        },
      },
    });
    const outboxId = await runEffect(
      enqueueOutboxOp({
        organizationId: ORG_ID,
        customerId: null,
        gatewayRequestId: "gw_dedupe",
        reason: "usage_missing",
        modelAliasId: "gpt-test",
        context: { note: "ctx" },
      }),
    );
    expect(outboxId).toBe(id);
    expect(captured?.organizationId).toBe(ORG_ID);
    expect(captured?.gatewayRequestId).toBe("gw_dedupe");
    expect(captured?.reason).toBe("usage_missing");
    expect(captured?.modelAliasId).toBe("gpt-test");
    expect(captured?.status).toBe("pending");
    expect(captured?.attempts).toBe(0);
    expect(captured?.context).toEqual({ note: "ctx" });
  });

  test("dedupe hit returns existing row id from repo", async () => {
    const existingId = new ObjectId();
    installRuntime({
      outbox: {
        insertOrGetByGatewayRequestId: () =>
          Effect.succeed(existingId as never),
      },
    });
    const outboxId = await runEffect(
      enqueueOutboxOp({
        organizationId: ORG_ID,
        customerId: null,
        gatewayRequestId: "gw_existing",
        reason: "usage_missing",
        modelAliasId: "gpt-test",
      }),
    );
    expect(outboxId).toBe(existingId);
  });
});

describe("claimDueOp (Effect over fake repo)", () => {
  test("passes limit + lease + token generator to repo.claimDue", async () => {
    const row = outboxDoc({ claimToken: "tok-1", attempts: 2 });
    let capturedLimit: number | undefined;
    installRuntime({
      outbox: {
        claimDue: (limit, leaseMs, genToken) => {
          capturedLimit = limit;
          expect(leaseMs).toBe(OUTBOX_CLAIM_LEASE_MS);
          expect(typeof genToken()).toBe("string");
          expect(genToken().length).toBeGreaterThan(0);
          return Effect.succeed([row] as never);
        },
      },
    });
    const rows = await runEffect(claimDueOp(5));
    expect(capturedLimit).toBe(5);
    expect(rows).toEqual([row]);
  });

  test("repo.claimDue failure maps to SystemError", async () => {
    installRuntime({
      outbox: {
        claimDue: () => Effect.fail(new Error("boom") as never),
      },
    });
    const err = (await runEffect(
      Effect.flip(claimDueOp()),
    ).catch((e) => e)) as unknown;
    if (!(err instanceof SystemError)) {
      throw new Error(`expected SystemError, got ${String(err)}`);
    }
    expect(err.message).toBe("Outbox claim failed");
    expect(err.code).toBe("system_error");
  });
});
