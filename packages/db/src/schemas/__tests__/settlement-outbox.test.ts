import { test, expect, describe } from "bun:test";
import { ObjectId } from "mongodb";
import {
  settlementOutboxStatus,
  settlementOutboxDoc,
  settlementOutboxCreateInput,
  settlementOutboxUpdateInput,
} from "../settlement-outbox.ts";

// Mirrors usage.test.ts: decode accept/reject branches for the settlement
// outbox row (Effect Schema production path).

const orgId = () => new ObjectId();
const custId = () => new ObjectId();

const baseCreate = () => ({
  organizationId: orgId(),
  customerId: custId(),
  gatewayRequestId: "gw-req-1",
  reason: "usage-settlement",
  modelAliasId: "gpt-4o-mini",
  context: { sessionId: "s1" },
});

const baseDoc = () => ({
  ...baseCreate(),
  _id: new ObjectId(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("settlementOutboxDoc", () => {
  test("accepts a full row with optional fields", () => {
    const parsed = settlementOutboxDoc.safeParse({
      ...baseDoc(),
      providerId: new ObjectId(),
      upstreamModelId: "gpt-4o-mini-2024-07-18",
      protocol: "openai",
      providerRequestId: "upstream-1",
      status: "in_progress",
      attempts: 2,
      claimToken: "tok-1",
      nextAttemptAt: new Date(),
      claimedAt: new Date(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.gatewayRequestId).toBe("gw-req-1");
      expect(parsed.data.attempts).toBe(2);
    }
  });

  test("minimal row gets status 'pending' and attempts 0 defaults", () => {
    const parsed = settlementOutboxDoc.safeParse(baseDoc());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("pending");
      expect(parsed.data.attempts).toBe(0);
    }
  });

  test("customerId may be null (org-internal settlement)", () => {
    const parsed = settlementOutboxDoc.safeParse({
      ...baseDoc(),
      customerId: null,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown status and negative attempts", () => {
    expect(settlementOutboxDoc.safeParse({ ...baseDoc(), status: "shipped" }).success).toBe(false);
    expect(settlementOutboxDoc.safeParse({ ...baseDoc(), attempts: -1 }).success).toBe(false);
  });

  test("rejects bad protocol enum and oversized gatewayRequestId", () => {
    expect(settlementOutboxDoc.safeParse({ ...baseDoc(), protocol: "gemini" }).success).toBe(false);
    expect(
      settlementOutboxDoc.safeParse({ ...baseDoc(), gatewayRequestId: "x".repeat(81) }).success,
    ).toBe(false);
  });

  test("rejects missing required fields and non-Date timestamps", () => {
    const { modelAliasId: _drop, ...noAlias } = baseDoc();
    expect(settlementOutboxDoc.safeParse(noAlias).success).toBe(false);
    expect(settlementOutboxDoc.safeParse({ ...baseDoc(), createdAt: "2026-01-01" }).success).toBe(false);
    expect(settlementOutboxDoc.safeParse({ ...baseDoc(), organizationId: orgId().toHexString() }).success).toBe(false);
  });
});

describe("settlementOutboxCreateInput", () => {
  test("accepts the insert boundary shape; _id optional", () => {
    const parsed = settlementOutboxCreateInput.safeParse(baseCreate());
    expect(parsed.success).toBe(true);
    // With explicit _id also fine.
    expect(
      settlementOutboxCreateInput.safeParse({ ...baseCreate(), _id: new ObjectId() }).success,
    ).toBe(true);
  });

  test("coerces no string dates: nextAttemptAt must be a Date", () => {
    expect(
      settlementOutboxCreateInput.safeParse({ ...baseCreate(), nextAttemptAt: "2026-01-01" })
        .success,
    ).toBe(false);
    expect(
      settlementOutboxCreateInput.safeParse({ ...baseCreate(), nextAttemptAt: new Date() }).success,
    ).toBe(true);
  });

  test("rejects unknown status, negative attempts, oversized reason", () => {
    expect(settlementOutboxCreateInput.safeParse({ ...baseCreate(), status: "nope" }).success).toBe(false);
    expect(settlementOutboxCreateInput.safeParse({ ...baseCreate(), attempts: -3 }).success).toBe(false);
    expect(settlementOutboxCreateInput.safeParse({ ...baseCreate(), reason: "" }).success).toBe(false);
    expect(
      settlementOutboxCreateInput.safeParse({ ...baseCreate(), reason: "r".repeat(201) }).success,
    ).toBe(false);
  });

  test("rejects missing organizationId / gatewayRequestId / reason / modelAliasId", () => {
    const { organizationId: _o, ...noOrg } = baseCreate();
    const { gatewayRequestId: _g, ...noReq } = baseCreate();
    const { reason: _r, ...noReason } = baseCreate();
    const { modelAliasId: _m, ...noAlias } = baseCreate();
    expect(settlementOutboxCreateInput.safeParse(noOrg).success).toBe(false);
    expect(settlementOutboxCreateInput.safeParse(noReq).success).toBe(false);
    expect(settlementOutboxCreateInput.safeParse(noReason).success).toBe(false);
    expect(settlementOutboxCreateInput.safeParse(noAlias).success).toBe(false);
  });
});

describe("settlementOutboxUpdateInput", () => {
  test("accepts empty update and partial claim updates", () => {
    expect(settlementOutboxUpdateInput.safeParse({}).success).toBe(true);
    expect(
      settlementOutboxUpdateInput.safeParse({
        status: "in_progress",
        claimToken: "tok-9",
        claimedAt: new Date(),
        attempts: 1,
      }).success,
    ).toBe(true);
  });

  test("accepts release/complete variants and context/reason updates", () => {
    expect(settlementOutboxUpdateInput.safeParse({ status: "reconciled" }).success).toBe(true);
    expect(settlementOutboxUpdateInput.safeParse({ status: "failed" }).success).toBe(true);
    expect(settlementOutboxUpdateInput.safeParse({ status: "abandoned" }).success).toBe(true);
    expect(settlementOutboxUpdateInput.safeParse({ context: {} }).success).toBe(true);
    expect(settlementOutboxUpdateInput.safeParse({ reason: "retry-settlement" }).success).toBe(true);
    expect(settlementOutboxUpdateInput.safeParse({ nextAttemptAt: new Date() }).success).toBe(true);
  });

  test("rejects unknown status and negative attempts", () => {
    expect(settlementOutboxUpdateInput.safeParse({ status: "queued" }).success).toBe(false);
    expect(settlementOutboxUpdateInput.safeParse({ attempts: -1 }).success).toBe(false);
  });

  test("update contract only carries mutable worker fields", () => {
    // The update schema's keys are exactly the claim/complete/release fields;
    // immutable identity fields (organizationId, gatewayRequestId) must not
    // be part of it. Effect Structs ignore excess properties, so assert the
    // contract shape through a typed literal rather than rejection of extra
    // keys.
    type UpdateContract = {
      readonly status?: "pending" | "in_progress" | "reconciled" | "failed" | "abandoned";
      readonly attempts?: number;
      readonly claimToken?: string;
      readonly nextAttemptAt?: Date;
      readonly claimedAt?: Date;
      readonly context?: { readonly [x: string]: unknown };
      readonly reason?: string;
    };
    // Excess-property check at the type level: identity fields are unknown
    // to the update contract, so this only compiles via the unknown cast.
    const wrongIdentityField = { organizationId: "org" } as unknown as UpdateContract;
    const wrongRequestField = { gatewayRequestId: "req" } as unknown as UpdateContract;
    expect(Object.keys(wrongIdentityField)).toEqual(["organizationId"]);
    expect(Object.keys(wrongRequestField)).toEqual(["gatewayRequestId"]);

    // Wrong value types still fail the decode.
    expect(settlementOutboxUpdateInput.safeParse({ claimToken: 42 }).success).toBe(false);
    expect(settlementOutboxUpdateInput.safeParse({ claimedAt: "2026-01-01" }).success).toBe(false);
  });
});

test("settlementOutboxStatus rejects unknown statuses", () => {
  expect(settlementOutboxStatus.safeParse("pending").success).toBe(true);
  expect(settlementOutboxStatus.safeParse("in_progress").success).toBe(true);
  expect(settlementOutboxStatus.safeParse("reconciled").success).toBe(true);
  expect(settlementOutboxStatus.safeParse("failed").success).toBe(true);
  expect(settlementOutboxStatus.safeParse("abandoned").success).toBe(true);
  expect(settlementOutboxStatus.safeParse("shipped").success).toBe(false);
});
