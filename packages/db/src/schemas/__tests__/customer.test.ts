import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  customerDoc,
  customerCreateInput,
  customerUpdateInput,
  balanceAdjustmentDoc,
  balanceAdjustmentCreateInput,
  _balanceMoneyMinor,
} from "../customer.ts";

const orgId = () => new ObjectId().toHexString();

test("customerDoc applies defaults: balance 0 USD, status active, metadata {}", () => {
  const r = customerDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    name: "Bob",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.balance).toEqual({ amountMinor: 0, reservedMinor: 0, currency: "USD" });
  expect(r.status).toBe("active");
  expect(r.metadata).toEqual({});
  expect(r.externalId).toBeUndefined();
  expect(r.email).toBeUndefined();
});

test("customerCreateInput requires name, optional email/externalId/balance/metadata", () => {
  expect(
    customerCreateInput.safeParse({ name: "Bob" }).success,
  ).toBe(true);
  expect(
    customerCreateInput.safeParse({ name: "" }).success,
  ).toBe(false);
  expect(
    customerCreateInput.safeParse({ name: "Bob", email: "not-email" }).success,
  ).toBe(false);
  expect(
    customerCreateInput.safeParse({ name: "Bob", email: "bad" }).success,
  ).toBe(false);
  expect(
    customerCreateInput.safeParse({
      name: "Bob",
      startingBalance: { amountMinor: -1, currency: "USD" },
    }).success,
  ).toBe(false);
  expect(
    customerCreateInput.safeParse({
      name: "Bob",
      externalId: "x".repeat(129),
    }).success,
  ).toBe(false);
});

test("customerUpdateInput allows nullish externalId/email", () => {
  expect(customerUpdateInput.safeParse({ name: "Bob" }).success).toBe(true);
  expect(customerUpdateInput.safeParse({ externalId: null }).success).toBe(true);
  expect(customerUpdateInput.safeParse({ email: null }).success).toBe(true);
  expect(customerUpdateInput.safeParse({ status: "closed" }).success).toBe(true);
  expect(customerUpdateInput.safeParse({ status: "deleted" }).success).toBe(false);
});

test("balanceAdjustmentDoc requires amountMinor int (any sign), currency, reason enum", () => {
  const base = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    currency: "USD",
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(balanceAdjustmentDoc.safeParse({ ...base, amountMinor: 1000, reason: "topup" }).success).toBe(true);
  expect(balanceAdjustmentDoc.safeParse({ ...base, amountMinor: -500, reason: "usage_debit" }).success).toBe(true);
  expect(balanceAdjustmentDoc.safeParse({ ...base, amountMinor: 1000, reason: "bonus" }).success).toBe(false);
  expect(balanceAdjustmentDoc.safeParse({ ...base, amountMinor: 1.5, reason: "topup" }).success).toBe(false);
  expect(balanceAdjustmentDoc.safeParse({ ...base, amountMinor: 1000, reason: "topup", currency: "us" }).success).toBe(false);
});

test("balanceAdjustmentCreateInput coerces occurredAt from string", () => {
  const r = balanceAdjustmentCreateInput.parse({
    customerId: orgId(),
    amountMinor: 1000,
    currency: "USD",
    reason: "topup",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  expect(r.occurredAt).toBeInstanceOf(Date);
});

test("balanceAdjustmentCreateInput reason enum", () => {
  const b = {
    customerId: orgId(),
    amountMinor: 100,
    currency: "USD",
  };
  for (const reason of ["topup", "usage_debit", "refund", "adjustment", "overage"]) {
    expect(balanceAdjustmentCreateInput.safeParse({ ...b, reason }).success).toBe(true);
  }
  expect(balanceAdjustmentCreateInput.safeParse({ ...b, reason: "bonus" }).success).toBe(false);
});

test("re-export _balanceMoneyMinor matches moneyMinor", () => {
  expect(_balanceMoneyMinor.safeParse(100).success).toBe(true);
  expect(_balanceMoneyMinor.safeParse(-1).success).toBe(false);
});