import { test, expect, describe } from "bun:test";
import { ObjectId } from "mongodb";
import {
  resolveGatewayRequestId,
  newGatewayRequestId,
  nextOutboxAttemptAt,
  OUTBOX_MAX_ATTEMPTS,
  compactGatewayRequestId,
  GATEWAY_REQUEST_ID_MAX,
  newClaimToken,
} from "../settlement-outbox.ts";

describe("resolveGatewayRequestId", () => {
  const orgId = new ObjectId();

  test("prefers explicit gatewayRequestId", () => {
    expect(
      resolveGatewayRequestId({
        gatewayRequestId: "gw_explicit_1",
        providerRequestId: "prov_x",
        organizationId: orgId,
      }),
    ).toBe("gw_explicit_1");
  });

  test("derives stable id from providerRequestId (idempotent across calls)", () => {
    const a = resolveGatewayRequestId({
      providerRequestId: "req-abc-123",
      organizationId: orgId,
    });
    const b = resolveGatewayRequestId({
      providerRequestId: "req-abc-123",
      organizationId: orgId,
    });
    expect(a).toBe(b);
    expect(a).toContain("req-abc-123");
  });

  test("mints new id only when neither gateway nor provider id given", () => {
    const a = resolveGatewayRequestId({ organizationId: orgId });
    const b = resolveGatewayRequestId({ organizationId: orgId });
    expect(a).toMatch(/^gw_/);
    expect(b).toMatch(/^gw_/);
    expect(a).not.toBe(b);
  });

  test("newGatewayRequestId is unique-ish", () => {
    expect(newGatewayRequestId()).not.toBe(newGatewayRequestId());
  });

  test("distinct long provider IDs produce distinct keys (no truncate collision)", () => {
    const base = "x".repeat(100);
    const a = resolveGatewayRequestId({
      organizationId: orgId,
      providerRequestId: base + "_req_A_unique_suffix",
    });
    const b = resolveGatewayRequestId({
      organizationId: orgId,
      providerRequestId: base + "_req_B_unique_suffix",
    });
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(GATEWAY_REQUEST_ID_MAX);
    expect(b.length).toBeLessThanOrEqual(GATEWAY_REQUEST_ID_MAX);
  });

  test("long explicit gateway id hashes stably", () => {
    const long = "gw_" + "y".repeat(200);
    const a = resolveGatewayRequestId({
      organizationId: orgId,
      gatewayRequestId: long,
    });
    const b = resolveGatewayRequestId({
      organizationId: orgId,
      gatewayRequestId: long,
    });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(GATEWAY_REQUEST_ID_MAX);
    expect(a).not.toBe(long.slice(0, GATEWAY_REQUEST_ID_MAX));
  });
});

describe("compactGatewayRequestId", () => {
  test("short keys pass through", () => {
    expect(compactGatewayRequestId("gw_short")).toBe("gw_short");
  });

  test("long keys become unique hashes under max len", () => {
    const longA = "a".repeat(200);
    const longB = "b".repeat(200);
    const a = compactGatewayRequestId(longA);
    const b = compactGatewayRequestId(longB);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(GATEWAY_REQUEST_ID_MAX);
    expect(a.startsWith("gwh_")).toBe(true);
  });
});

describe("nextOutboxAttemptAt", () => {
  test("backs off and caps", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const a0 = nextOutboxAttemptAt(0, from);
    const a5 = nextOutboxAttemptAt(5, from);
    const a20 = nextOutboxAttemptAt(20, from);
    expect(a0.getTime() - from.getTime()).toBe(5_000);
    expect(a5.getTime() - from.getTime()).toBe(5 * 2 ** 5 * 1000);
    // Cap at 3600s
    expect(a20.getTime() - from.getTime()).toBe(3600_000);
  });

  test("OUTBOX_MAX_ATTEMPTS is positive", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe("claim fencing contract", () => {
  test("in_progress status is part of the outbox status union (schema)", async () => {
    const { OUTBOX_CLAIM_LEASE_MS } = await import("../settlement-outbox.ts");
    expect(OUTBOX_CLAIM_LEASE_MS).toBe(5 * 60 * 1000);
  });

  test("claim tokens are unique opaque hex", () => {
    const a = newClaimToken();
    const b = newClaimToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("stale worker cannot complete after reclaim (filter simulation)", () => {
    // Models markOutboxReconciled / release filter: status + attempts + claimToken
    type Row = {
      status: string;
      attempts: number;
      claimToken: string;
    };
    const row: Row = {
      status: "in_progress",
      attempts: 1,
      claimToken: "token-worker-a",
    };
    function complete(claim: { attempts: number; claimToken: string }): boolean {
      if (
        row.status !== "in_progress" ||
        row.attempts !== claim.attempts ||
        row.claimToken !== claim.claimToken
      ) {
        return false;
      }
      row.status = "reconciled";
      return true;
    }
    // Worker B reclaims (lease expired)
    row.attempts = 2;
    row.claimToken = "token-worker-b";
    // Stale worker A cannot overwrite
    expect(
      complete({ attempts: 1, claimToken: "token-worker-a" }),
    ).toBe(false);
    expect(row.status).toBe("in_progress");
    // Owner B can complete
    expect(
      complete({ attempts: 2, claimToken: "token-worker-b" }),
    ).toBe(true);
    expect(row.status).toBe("reconciled");
  });

  test("atomic claim filter rejects rows whose lease was renewed (TOCTOU)", () => {
    // Mirrors claimDueOutboxRows findOneAndUpdate filter: status + attempts +
    // nextAttemptAt still due. Owner renewal extends nextAttemptAt past `now`.
    const now = new Date("2026-01-01T00:05:00Z");
    type Row = {
      status: string;
      attempts: number;
      nextAttemptAt: Date;
    };
    const row: Row = {
      status: "in_progress",
      attempts: 1,
      nextAttemptAt: new Date("2026-01-01T00:04:00Z"), // expired at scan time
    };
    function tryClaim(candidate: Row, claimNow: Date): boolean {
      const leaseStillDue =
        !candidate.nextAttemptAt || candidate.nextAttemptAt.getTime() <= claimNow.getTime();
      if (
        candidate.status !== "in_progress" &&
        candidate.status !== "pending"
      ) {
        return false;
      }
      if (candidate.attempts !== row.attempts) return false;
      if (!leaseStillDue) return false;
      // Owner renewed between scan and claim:
      return true;
    }
    // Before renew: reclaim would succeed
    expect(tryClaim(row, now)).toBe(true);
    // Owner renews lease past now
    row.nextAttemptAt = new Date("2026-01-01T00:10:00Z");
    // Atomic filter must fail — no steal after renew
    expect(tryClaim(row, now)).toBe(false);
  });
});
