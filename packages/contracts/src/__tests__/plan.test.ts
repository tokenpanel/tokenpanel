import { test, expect, describe } from "bun:test";
import {
  PLAN_INTERVALS,
  planIntervalSchema,
  SUBSCRIPTION_STATUSES,
  subscriptionStatusSchema,
} from "../plan.ts";

describe("planIntervalSchema", () => {
  test("accepts every declared billing interval", () => {
    for (const interval of PLAN_INTERVALS) {
      expect(planIntervalSchema.safeParse(interval).success).toBe(true);
    }
    expect(PLAN_INTERVALS).toEqual(["day", "week", "month", "year"]);
  });

  test("rejects unknown intervals", () => {
    expect(planIntervalSchema.safeParse("decade").success).toBe(false);
    expect(planIntervalSchema.safeParse("MONTH").success).toBe(false);
    expect(planIntervalSchema.safeParse("").success).toBe(false);
    expect(planIntervalSchema.safeParse(null).success).toBe(false);
    expect(planIntervalSchema.safeParse(30).success).toBe(false);
  });
});

describe("subscriptionStatusSchema", () => {
  test("accepts every declared subscription status", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(subscriptionStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(SUBSCRIPTION_STATUSES).toEqual([
      "active",
      "past_due",
      "canceled",
      "ended",
    ]);
  });

  test("rejects unknown statuses", () => {
    expect(subscriptionStatusSchema.safeParse("trialing").success).toBe(false);
    expect(subscriptionStatusSchema.safeParse("ACTIVE").success).toBe(false);
    expect(subscriptionStatusSchema.safeParse("past-due").success).toBe(false);
    expect(subscriptionStatusSchema.safeParse("").success).toBe(false);
    expect(subscriptionStatusSchema.safeParse(undefined).success).toBe(false);
  });
});
