/**
 * Analytics + dashboard read operations (task 8.6).
 */
import { Effect } from "effect";
import type { ValidationError } from "../../errors/families.ts";
import type { HexId, RepoError } from "../ports/common.ts";
import { UsageRepository } from "../ports/usage-repository.ts";
import { parseDateRange } from "../pagination/range.ts";
import type {
  CustomerUsageSummary,
  DashboardSummary,
} from "../ports/usage-repository.ts";

export type AnalyticsDomainError = ValidationError | RepoError;

export type AnalyticsSummaryResult = {
  readonly from: string;
  readonly to: string;
  readonly totals: {
    readonly requests: number;
    readonly tokens: number;
    readonly byCurrency: readonly {
      readonly currency: string;
      readonly requests: number;
      readonly tokens: number;
      readonly costUnits: number;
      readonly priceUnits: number;
    }[];
  };
  readonly topCustomers: readonly {
    readonly customerId: HexId;
    readonly customerName: string;
    readonly currency: string;
    readonly requests: number;
    readonly tokens: number;
    readonly costUnits: number;
    readonly priceUnits: number;
  }[];
};

export const customerUsage = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): Effect.Effect<
  CustomerUsageSummary,
  AnalyticsDomainError,
  UsageRepository
> =>
  Effect.gen(function* () {
    const usage = yield* UsageRepository;
    const range: { from?: Date; to?: Date } = {};
    if (input.from !== undefined) range.from = new Date(input.from);
    if (input.to !== undefined) range.to = new Date(input.to);
    return yield* usage.customerUsageSummary(
      input.organizationId,
      input.customerId,
      range,
    );
  });

export const analyticsSummary = (input: {
  readonly organizationId: HexId;
  readonly from: string;
  readonly to: string;
  readonly top?: number | undefined;
}): Effect.Effect<
  AnalyticsSummaryResult,
  AnalyticsDomainError,
  UsageRepository
> =>
  Effect.gen(function* () {
    const range = yield* parseDateRange({ from: input.from, to: input.to });
    const top = Math.min(100, Math.max(1, input.top ?? 20));
    const usage = yield* UsageRepository;
    const { totalsByCurrency, topCustomers } = yield* usage.analyticsSummary(
      input.organizationId,
      range,
      top,
    );
    const customerIds = topCustomers.map((c) => c.customerId);
    const customers = yield* usage.findCustomersByIds(
      input.organizationId,
      customerIds,
    );
    const nameById = new Map(
      customers.map((c) => [c._id.toHexString(), c.name]),
    );
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totals: {
        requests: totalsByCurrency.reduce((s, r) => s + r.requests, 0),
        tokens: totalsByCurrency.reduce((s, r) => s + r.tokens, 0),
        byCurrency: totalsByCurrency.map((r) => ({
          currency: r.currency || "USD",
          requests: r.requests,
          tokens: r.tokens,
          costUnits: r.costUnits,
          priceUnits: r.priceUnits,
        })),
      },
      topCustomers: topCustomers.map((r) => ({
        customerId: r.customerId,
        customerName: nameById.get(r.customerId) ?? "Unknown",
        currency: r.currency || "USD",
        requests: r.requests,
        tokens: r.tokens,
        costUnits: r.costUnits,
        priceUnits: r.priceUnits,
      })),
    };
  });

export const dashboardSummary = (
  organizationId: HexId,
  options?: { readonly includeBalances?: boolean },
): Effect.Effect<
  {
    readonly customers: number;
    readonly models: number;
    readonly providers: number;
    readonly activePlans: number;
    readonly balancesByCurrency: Readonly<Record<string, number>>;
    readonly recentCustomers: readonly {
      readonly _id: string;
      readonly name: string;
      readonly email: string | null;
      readonly balance: DashboardSummary["recentCustomers"][number]["balance"];
      readonly status: string;
      readonly createdAt: string | Date;
    }[];
  },
  RepoError,
  UsageRepository
> =>
  Effect.gen(function* () {
    const usage = yield* UsageRepository;
    const summary = yield* usage.dashboardSummary(organizationId, options);
    return {
      customers: summary.customers,
      models: summary.models,
      providers: summary.providers,
      activePlans: summary.activePlans,
      balancesByCurrency: summary.balancesByCurrency,
      recentCustomers: summary.recentCustomers.map((c) => ({
        _id: c._id.toHexString(),
        name: c.name,
        email: c.email ?? null,
        balance: c.balance,
        status: c.status,
        createdAt: c.createdAt?.toISOString?.() ?? c.createdAt,
      })),
    };
  });
