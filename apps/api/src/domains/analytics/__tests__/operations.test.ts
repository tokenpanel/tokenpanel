/**
 * Analytics domain operations over the UsageRepository port.
 * Fake repo via Layer.succeed — no DB.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { CustomerDoc } from "@tokenpanel/db";
import { ObjectId } from "mongodb";
import { SystemError } from "../../../errors/families.ts";
import {
  analyticsSummary,
  customerUsage,
  dashboardSummary,
  type AnalyticsSummaryResult,
} from "../operations.ts";
import { UsageRepository } from "../../ports/usage-repository.ts";
import type {
  AnalyticsCurrencyTotals,
  AnalyticsTopCustomer,
  CustomerUsageSummary,
  DashboardSummary,
  UsageRepositoryService,
} from "../../ports/usage-repository.ts";

const ORG_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();

function customerDoc(over: Partial<CustomerDoc> = {}): CustomerDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: new ObjectId(CUSTOMER_ID),
    organizationId: new ObjectId(ORG_ID),
    externalId: "ext-1",
    name: "Bob Corp",
    email: "bob@corp.com",
    balance: { amountMicros: 5_000_000, currency: "USD" },
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  } as CustomerDoc;
}

const baseCurrencyTotals: AnalyticsCurrencyTotals = {
  currency: "USD",
  requests: 7,
  tokens: 900,
  promptTokens: 600,
  cacheReadTokens: 100,
  cacheWriteTokens: 50,
  reasoningTokens: 150,
  costMicros: 1_234,
  priceMicros: 2_345,
};

const baseTopCustomer: AnalyticsTopCustomer = {
  customerId: CUSTOMER_ID,
  currency: "USD",
  requests: 7,
  tokens: 900,
  promptTokens: 600,
  cacheReadTokens: 100,
  cacheWriteTokens: 50,
  reasoningTokens: 150,
  costMicros: 1_234,
  priceMicros: 2_345,
};

const baseCustomerUsage: CustomerUsageSummary = {
  totalRequests: 12,
  totalTokens: 3_400,
  totalCostMicros: 4_500,
  totalPriceMicros: 9_900,
  currency: "USD",
  byModel: [
    { modelAliasId: "gpt-x", requests: 12, tokens: 3_400, costMicros: 4_500, priceMicros: 9_900 },
  ],
};

const baseDashboard: DashboardSummary = {
  customers: 3,
  models: 5,
  providers: 2,
  activePlans: 1,
  balancesByCurrency: { USD: 10_000_000 },
  recentCustomers: [customerDoc()],
};

function runWith(
  repo: Partial<UsageRepositoryService>,
  effect: Effect.Effect<unknown, unknown, UsageRepository>,
): Promise<unknown> {
  const layer = Layer.succeed(
    UsageRepository,
    repo as UsageRepositoryService,
  );
  return Effect.runPromise(
    Effect.provide(effect, layer) as Effect.Effect<unknown, never>,
  );
}

function runFailWith(
  repo: Partial<UsageRepositoryService>,
  effect: Effect.Effect<unknown, unknown, UsageRepository>,
): Promise<never> {
  const layer = Layer.succeed(
    UsageRepository,
    repo as UsageRepositoryService,
  );
  return Effect.runPromiseExit(
    Effect.provide(effect, layer),
  ).then((exit) => {
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      throw exit.cause.error;
    }
    throw new Error(`expected failure, got ${JSON.stringify(exit)}`);
  });
}


describe("customerUsage", () => {
  test("delegates to customerUsageSummary with parsed range", async () => {
    let captured: { org: string; customer: string; range: unknown } | undefined;
    const result = (await runWith(
      {
        customerUsageSummary: (org, customer, range) => {
          captured = { org, customer, range };
          return Effect.succeed(baseCustomerUsage);
        },
      },
      customerUsage({
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T23:59:59.999Z",
      }),
    )) as CustomerUsageSummary;

    expect(result).toEqual(baseCustomerUsage);
    expect(captured?.org).toBe(ORG_ID);
    expect(captured?.customer).toBe(CUSTOMER_ID);
    expect(captured?.range).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  test("omits range bounds when from/to undefined", async () => {
    let captured: { range: unknown } | undefined;
    await runWith(
      {
        customerUsageSummary: (_org, _customer, range) => {
          captured = { range };
          return Effect.succeed(baseCustomerUsage);
        },
      },
      customerUsage({ organizationId: ORG_ID, customerId: CUSTOMER_ID }),
    );
    expect(captured?.range).toEqual({});
  });

  test("propagates repo failure on error channel", async () => {
    const failure = new SystemError({
      code: "system_error",
      message: "repo exploded",
    });
    await expect(
      runFailWith(
        {
          customerUsageSummary: () => Effect.fail(failure),
        },
        customerUsage({ organizationId: ORG_ID, customerId: CUSTOMER_ID }),
      ),
    ).rejects.toBe(failure);
  });
});

describe("analyticsSummary", () => {
  const FROM = "2026-01-01T00:00:00.000Z";
  const TO = "2026-01-31T00:00:00.000Z";

  function repoWith(
    capture: { top?: number; range?: unknown },
    totals: readonly AnalyticsCurrencyTotals[] = [baseCurrencyTotals],
    topCustomers: readonly AnalyticsTopCustomer[] = [baseTopCustomer],
  ): Partial<UsageRepositoryService> {
    return {
      analyticsSummary: (_org, range, top) => {
        capture.top = top;
        capture.range = range;
        return Effect.succeed({ totalsByCurrency: totals, topCustomers });
      },
      findCustomersByIds: () =>
        Effect.succeed([customerDoc({ name: "Named Co" })]),
    };
  }

  test("aggregates totals and maps customer names by id", async () => {
    const capture: { top?: number; range?: unknown } = {};
    const result = (await runWith(
      repoWith(capture),
      analyticsSummary({ organizationId: ORG_ID, from: FROM, to: TO }),
    )) as AnalyticsSummaryResult;

    expect(result.from).toBe(FROM);
    expect(result.to).toBe(TO);
    expect(result.totals).toEqual({
      requests: 7,
      tokens: 900,
      promptTokens: 600,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      reasoningTokens: 150,
      byCurrency: [
        {
          currency: "USD",
          requests: 7,
          tokens: 900,
          costMicros: 1_234,
          priceMicros: 2_345,
        },
      ],
    });
    expect(result.topCustomers).toHaveLength(1);
    expect(result.topCustomers[0]?.customerName).toBe("Named Co");
    expect(result.topCustomers[0]?.customerId).toBe(CUSTOMER_ID);
  });

  test("clamps top: default 20, min 1, max 100", async () => {
    const capture: { top?: number; range?: unknown } = {};
    await runWith(
      repoWith(capture),
      analyticsSummary({ organizationId: ORG_ID, from: FROM, to: TO }),
    );
    expect(capture.top).toBe(20);

    const hi: { top?: number; range?: unknown } = {};
    await runWith(
      repoWith(hi),
      analyticsSummary({
        organizationId: ORG_ID,
        from: FROM,
        to: TO,
        top: 1000,
      }),
    );
    expect(hi.top).toBe(100);

    const lo: { top?: number; range?: unknown } = {};
    await runWith(
      repoWith(lo),
      analyticsSummary({
        organizationId: ORG_ID,
        from: FROM,
        to: TO,
        top: 0,
      }),
    );
    expect(lo.top).toBe(1);
  });

  test("falls back to Unknown name when customer missing from lookup", async () => {
    const capture: { top?: number; range?: unknown } = {};
    const result = (await runWith(
      {
        analyticsSummary: () =>
          Effect.succeed({
            totalsByCurrency: [],
            topCustomers: [baseTopCustomer],
          }),
        findCustomersByIds: () => Effect.succeed([]),
      },
      analyticsSummary({ organizationId: ORG_ID, from: FROM, to: TO }),
    )) as { topCustomers: { customerName: string }[] };
    expect(result.topCustomers[0]?.customerName).toBe("Unknown");
    expect(capture.top).toBeUndefined();
  });

  test("empty currency string normalized to USD", async () => {
    const result = (await runWith(
      {
        analyticsSummary: () =>
          Effect.succeed({
            totalsByCurrency: [{ ...baseCurrencyTotals, currency: "" }],
            topCustomers: [],
          }),
        findCustomersByIds: () => Effect.succeed([]),
      },
      analyticsSummary({ organizationId: ORG_ID, from: FROM, to: TO }),
    )) as { totals: { byCurrency: { currency: string }[] } };
    expect(result.totals.byCurrency[0]?.currency).toBe("USD");
  });
});


describe("dashboardSummary", () => {
  test("maps CustomerDoc rows to wire shape (hex id, null email, ISO date)", async () => {
    const createdAt = new Date("2026-02-03T04:05:06.000Z");
    const result = (await runWith(
      {
        dashboardSummary: () =>
          Effect.succeed({
            ...baseDashboard,
            recentCustomers: [
              customerDoc({
                email: null,
                createdAt,
              }),
            ],
          }),
      },
      dashboardSummary(ORG_ID),
    )) as {
      customers: number;
      models: number;
      providers: number;
      activePlans: number;
      balancesByCurrency: Record<string, number>;
      recentCustomers: {
        _id: string;
        name: string;
        email: string | null;
        status: string;
        createdAt: string;
      }[];
    };

    expect(result.customers).toBe(3);
    expect(result.models).toBe(5);
    expect(result.providers).toBe(2);
    expect(result.activePlans).toBe(1);
    expect(result.balancesByCurrency).toEqual({ USD: 10_000_000 });
    const row = result.recentCustomers[0];
    expect(row?._id).toBe(CUSTOMER_ID);
    expect(row?.email).toBeNull();
    expect(row?.createdAt).toBe("2026-02-03T04:05:06.000Z");
    expect(row?.status).toBe("active");
  });

  test("passes includeBalances option through", async () => {
    let capturedOptions: { includeBalances?: boolean } | undefined;
    await runWith(
      {
        dashboardSummary: (_org, options) => {
          capturedOptions = options;
          return Effect.succeed(baseDashboard);
        },
      },
      dashboardSummary(ORG_ID, { includeBalances: true }),
    );
    expect(capturedOptions?.includeBalances).toBe(true);
  });

  test("propagates repo failure", async () => {
    const failure = new SystemError({
      code: "system_error",
      message: "dashboard down",
    });
    await expect(
      runFailWith(
        { dashboardSummary: () => Effect.fail(failure) },
        dashboardSummary(ORG_ID),
      ),
    ).rejects.toBe(failure);
  });
});
