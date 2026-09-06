import { test, expect, describe } from "bun:test";
import {
  CUSTOMER_STATUSES,
  customerStatusSchema,
  BALANCE_ADJUSTMENT_REASONS,
  balanceAdjustmentReasonSchema,
  OPERATOR_BALANCE_REASONS,
} from "../customer.ts";

describe("customerStatusSchema", () => {
  test("accepts every declared status", () => {
    for (const status of CUSTOMER_STATUSES) {
      expect(customerStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(CUSTOMER_STATUSES).toEqual(["active", "suspended", "closed"]);
  });

  test("rejects unknown and malformed values", () => {
    expect(customerStatusSchema.safeParse("unknown").success).toBe(false);
    expect(customerStatusSchema.safeParse("ACTIVE").success).toBe(false);
    expect(customerStatusSchema.safeParse("").success).toBe(false);
    expect(customerStatusSchema.safeParse(null).success).toBe(false);
    expect(customerStatusSchema.safeParse(1).success).toBe(false);
  });
});

describe("balanceAdjustmentReasonSchema", () => {
  test("accepts every declared reason", () => {
    for (const reason of BALANCE_ADJUSTMENT_REASONS) {
      expect(balanceAdjustmentReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(BALANCE_ADJUSTMENT_REASONS).toEqual([
      "topup",
      "usage_debit",
      "refund",
      "adjustment",
      "overage",
    ]);
  });

  test("rejects unknown reasons", () => {
    expect(balanceAdjustmentReasonSchema.safeParse("chargeback").success).toBe(
      false,
    );
    expect(balanceAdjustmentReasonSchema.safeParse("TOPUP").success).toBe(false);
    expect(balanceAdjustmentReasonSchema.safeParse("usage").success).toBe(false);
    expect(balanceAdjustmentReasonSchema.safeParse("").success).toBe(false);
    expect(balanceAdjustmentReasonSchema.safeParse(null).success).toBe(false);
  });
});

describe("operator reason subset invariant", () => {
  test("OPERATOR_BALANCE_REASONS excludes usage_debit and is a subset", () => {
    expect(OPERATOR_BALANCE_REASONS).toEqual(["topup", "adjustment", "refund"]);
    for (const reason of OPERATOR_BALANCE_REASONS) {
      expect(BALANCE_ADJUSTMENT_REASONS).toContain(reason);
      expect(balanceAdjustmentReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(BALANCE_ADJUSTMENT_REASONS).toContain("usage_debit");
    expect(OPERATOR_BALANCE_REASONS).not.toContain("usage_debit");
  });
});
