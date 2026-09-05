import { test, expect } from "bun:test";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import type { BalanceAdjustmentDoc, CustomerDoc } from "@tokenpanel/db";
import {
  adjustCustomerBalance,
} from "../operations.ts";
import {
  CustomerRepository,
  type CustomerRepositoryService,
} from "../../ports/customer-repository.ts";

const customer = {
  _id: new ObjectId(),
  organizationId: new ObjectId(),
  externalId: null,
  name: "Ada Buyer",
  email: "ada@example.com",
  balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" },
  status: "active",
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as CustomerDoc;

const adjustment = {
  _id: new ObjectId(),
  organizationId: customer.organizationId,
  customerId: customer._id,
  amountMicros: 500,
  currency: "USD",
  reason: "topup",
  usageRecordId: null,
  note: "original request",
  idempotencyKey: "grant-1",
  occurredAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as BalanceAdjustmentDoc;

const repository = {
  findById: () => Effect.succeed(customer),
  adjustBalance: () => Effect.succeed({ customer, adjustment }),
} as unknown as CustomerRepositoryService;

test("idempotent balance replay tolerates a retry-only note", async () => {
  const result = await Effect.runPromise(
    adjustCustomerBalance({
      organizationId: customer.organizationId.toHexString(),
      customerId: customer._id.toHexString(),
      amountMicros: 500,
      currency: "USD",
      reason: "topup",
      note: "retry diagnostic",
      idempotencyKey: "grant-1",
    }).pipe(Effect.provideService(CustomerRepository, repository)),
  );

  expect(result.adjustment.idempotencyKey).toBe("grant-1");
  expect(result.adjustment.note).toBe("original request");
});

test("uppercase ObjectId retry matches the stored adjustment (no 409)", async () => {
  // Stored customerId is lowercase hex; a valid uppercase ObjectId string
  // from a retrying client must still satisfy the sameRequest check.
  const upperHex = customer._id.toHexString().toUpperCase();
  const result = await Effect.runPromise(
    adjustCustomerBalance({
      organizationId: customer.organizationId.toHexString(),
      customerId: upperHex,
      amountMicros: 500,
      currency: "USD",
      reason: "topup",
      note: "retry diagnostic",
      idempotencyKey: "grant-1",
    }).pipe(Effect.provideService(CustomerRepository, repository)),
  );

  expect(result.adjustment.idempotencyKey).toBe("grant-1");
});
