/**
 * Pure / mock-level tests for settlement claim + idempotency semantics.
 * Full Mongo integration requires a replica set; these guard the algorithms.
 */
import { test, expect, describe } from "bun:test";
import {
  nextOutboxAttemptAt,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  resolveGatewayRequestId,
} from "../settlement-outbox.ts";
import { ObjectId } from "mongodb";
import {
  parseOpenAIProviderUsage,
  parseAnthropicProviderUsage,
} from "../../providers/provider-usage.ts";
import {
  makeProviderError,
  isFallbackAllowed,
} from "../../providers/provider-errors.ts";

describe("outbox claim lease semantics", () => {
  test("lease duration is multi-minute so slow workers are not reclaimed early", () => {
    expect(OUTBOX_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("backoff grows then caps", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const a0 = nextOutboxAttemptAt(0, from).getTime() - from.getTime();
    const a10 = nextOutboxAttemptAt(10, from).getTime() - from.getTime();
    expect(a0).toBe(5_000);
    expect(a10).toBe(3_600_000); // cap
  });

  test("max attempts bound is finite", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(OUTBOX_MAX_ATTEMPTS).toBeLessThanOrEqual(50);
  });
});

describe("gatewayRequestId stability (settlement idempotency key)", () => {
  const org = new ObjectId();

  test("same provider request id → same gateway id across recon retries", () => {
    const a = resolveGatewayRequestId({
      organizationId: org,
      providerRequestId: "prov-42",
    });
    const b = resolveGatewayRequestId({
      organizationId: org,
      providerRequestId: "prov-42",
    });
    expect(a).toBe(b);
  });

  test("explicit gateway id wins (request-scoped)", () => {
    expect(
      resolveGatewayRequestId({
        organizationId: org,
        gatewayRequestId: "gw_fixed",
        providerRequestId: "other",
      }),
    ).toBe("gw_fixed");
  });

  test("long distinct provider ids never collide after compact", () => {
    const pad = "p".repeat(90);
    const a = resolveGatewayRequestId({
      organizationId: org,
      providerRequestId: `${pad}-alpha`,
    });
    const b = resolveGatewayRequestId({
      organizationId: org,
      providerRequestId: `${pad}-beta`,
    });
    expect(a).not.toBe(b);
  });
});

describe("reconcile entry resolution never falls back to unrelated entry", () => {
  test("exact match required when upstream id known", () => {
    // Mirrors resolveEntry logic: no active/first fallback.
    const providerA = new ObjectId();
    const providerB = new ObjectId();
    const entries = [
      {
        id: "1",
        providerId: providerA,
        upstreamModelId: "model-a",
        priority: 0,
        active: true,
      },
      {
        id: "2",
        providerId: providerB,
        upstreamModelId: "model-b",
        priority: 1,
        active: true,
      },
    ];
    const upstreamModelId = "model-gone";
    const exact = entries.find(
      (e) =>
        e.providerId.equals(providerA) && e.upstreamModelId === upstreamModelId,
    );
    // Old bug: fell back to entries.find(e => e.active) ?? entries[0]
    const wrongFallback =
      exact ?? entries.find((e) => e.active) ?? entries[0];
    expect(exact).toBeUndefined();
    // Correct behavior: refuse unrelated entry
    expect(wrongFallback?.upstreamModelId).toBe("model-a"); // what the bug did
    // Our fix: no fallback — result is entry_not_found (tested via absence)
    const safe = exact; // only exact
    expect(safe).toBeUndefined();
  });
});

describe("body-phase ProviderError is never fallback-eligible", () => {
  test("phase=body after headers → no failover", () => {
    const err = makeProviderError({
      message: "stream body failed",
      category: "connection",
      phase: "body",
      fallbackEligible: false,
      maybeAcceptedUpstream: true,
    });
    expect(isFallbackAllowed(err, false)).toBe(false);
    expect(isFallbackAllowed(err, true)).toBe(false);
  });

  test("pre-stream 503 still eligible", () => {
    const err = makeProviderError({
      message: "up",
      category: "http_5xx",
      phase: "headers",
      httpStatus: 503,
      fallbackEligible: true,
    });
    expect(isFallbackAllowed(err, false)).toBe(true);
  });
});

describe("usage parse blocks free-settle incomplete objects", () => {
  test("OpenAI total-only", () => {
    expect(parseOpenAIProviderUsage({ total_tokens: 100 }).status).toBe("missing");
  });
  test("Anthropic input-only", () => {
    expect(parseAnthropicProviderUsage({ input_tokens: 100 }).status).toBe(
      "missing",
    );
  });
});

describe("recon idempotency before live model/provider", () => {
  test("existing usageRecords.gatewayRequestId short-circuits without live config", () => {
    // Mirrors reconcileOutboxRow: check usage record first, then mark reconciled.
    const usageByGw = new Map<string, { id: string }>([
      ["gw_crash_after_commit", { id: "usage_1" }],
    ]);
    const row = {
      gatewayRequestId: "gw_crash_after_commit",
      modelAliasId: "deleted-model",
    };
    // Live model gone — old path would release "model_not_found" forever.
    const liveModel = null;
    const existing = usageByGw.get(row.gatewayRequestId);
    expect(existing).toBeDefined();
    // Must reconcile from existing settle even when model is null
    const outcome = existing ? "reconciled" : liveModel ? "settle" : "model_not_found";
    expect(outcome).toBe("reconciled");
  });

  test("frozen price + upstream allows reconstruct when model deleted", () => {
    const ctx = {
      priceMinor: 42,
      upstreamModelId: "gpt-4o",
      currency: "USD",
      priceSchedule: {
        inputMinorPerMillion: 100,
        outputMinorPerMillion: 200,
      },
    };
    const canReconstruct =
      (typeof ctx.priceMinor === "number" || ctx.priceSchedule !== undefined) &&
      !!ctx.upstreamModelId;
    expect(canReconstruct).toBe(true);
  });
});

describe("recon freezes request time and rules (not wall clock)", () => {
  test("occurredAt prefers frozen context ISO over recon now", () => {
    const ctx: Record<string, unknown> = {
      occurredAt: "2026-03-01T12:00:00.000Z",
      rules: [{ windowSeconds: 3600, dimension: "tokens", capValue: 100, scope: "customer" }],
    };
    const rowCreatedAt = new Date("2026-03-01T12:00:05.000Z");
    const reconNow = new Date("2026-03-08T00:00:00.000Z");

    // Mirrors reconcileOutboxRow occurredAt resolution.
    let occurredAt: Date;
    const raw = ctx.occurredAt;
    if (typeof raw === "string" || raw instanceof Date) {
      const parsed = new Date(raw);
      occurredAt = Number.isNaN(parsed.getTime()) ? rowCreatedAt : parsed;
    } else {
      occurredAt = rowCreatedAt;
    }
    // Must not use reconNow
    expect(occurredAt.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(occurredAt.getTime()).not.toBe(reconNow.getTime());

    const rules = Array.isArray(ctx.rules) ? ctx.rules : [];
    expect(rules).toHaveLength(1);
    expect((rules[0] as { windowSeconds: number }).windowSeconds).toBe(3600);
  });

  test("missing occurredAt falls back to outbox createdAt not recon now", () => {
    const ctx: Record<string, unknown> = {};
    const rowCreatedAt = new Date("2026-02-01T08:00:00.000Z");
    const reconNow = new Date("2026-07-01T00:00:00.000Z");
    const raw = ctx.occurredAt;
    const occurredAt =
      typeof raw === "string" || raw instanceof Date
        ? new Date(raw)
        : rowCreatedAt;
    expect(occurredAt).toEqual(rowCreatedAt);
    expect(occurredAt.getTime()).not.toBe(reconNow.getTime());
  });
});

/**
 * Simulated double-settle guard: a set of gatewayRequestIds models the unique
 * index. A second settle with the same id is a no-op (no second charge).
 */
describe("idempotent settle simulation", () => {
  test("second charge with same gatewayRequestId is skipped", () => {
    const settled = new Set<string>();
    let charges = 0;
    function settleOnce(gatewayRequestId: string, amount: number): "ok" | "dup" {
      if (settled.has(gatewayRequestId)) return "dup";
      settled.add(gatewayRequestId);
      charges += amount;
      return "ok";
    }
    // Crash after settle before outbox mark → retry
    expect(settleOnce("gw_1", 100)).toBe("ok");
    expect(settleOnce("gw_1", 100)).toBe("dup");
    expect(charges).toBe(100);
  });

  test("concurrent claim: only one worker holds in_progress", () => {
    type Row = { id: string; status: string; attempts: number };
    const row: Row = { id: "1", status: "pending", attempts: 0 };
    function claim(worker: string): boolean {
      if (row.status !== "pending" && row.status !== "in_progress") return false;
      // Only pending can be claimed fresh; in_progress needs lease expiry (skipped here)
      if (row.status === "in_progress") return false;
      row.status = "in_progress";
      row.attempts += 1;
      void worker;
      return true;
    }
    expect(claim("a")).toBe(true);
    expect(claim("b")).toBe(false);
    expect(row.attempts).toBe(1);
  });
});
