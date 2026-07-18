/**
 * Usage / analytics read port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type { CustomerDoc } from "@tokenpanel/db";
import type { DateRange, HexId, RepoError } from "./common.ts";

export type UsageByModelRow = {
  readonly modelAliasId: string;
  readonly requests: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly priceUnits: number;
  readonly currency: string;
};

export type CustomerUsageSummary = {
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly totalCostUnits: number;
  readonly totalPriceUnits: number;
  readonly currency: string;
  readonly byModel: readonly Omit<UsageByModelRow, "currency">[];
};

export type AnalyticsCurrencyTotals = {
  readonly currency: string;
  readonly requests: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly priceUnits: number;
};

export type AnalyticsTopCustomer = {
  readonly customerId: HexId;
  readonly currency: string;
  readonly requests: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly priceUnits: number;
};

export type DashboardSummary = {
  readonly customers: number;
  readonly models: number;
  readonly providers: number;
  readonly activePlans: number;
  readonly balancesByCurrency: Readonly<Record<string, number>>;
  readonly recentCustomers: readonly CustomerDoc[];
};

export type UsageRepositoryService = {
  readonly customerUsageSummary: (
    organizationId: HexId,
    customerId: HexId,
    range: Partial<DateRange>,
  ) => Effect.Effect<CustomerUsageSummary, RepoError>;
  readonly analyticsSummary: (
    organizationId: HexId,
    range: DateRange,
    top: number,
  ) => Effect.Effect<
    {
      readonly totalsByCurrency: readonly AnalyticsCurrencyTotals[];
      readonly topCustomers: readonly AnalyticsTopCustomer[];
    },
    RepoError
  >;
  readonly findCustomersByIds: (
    organizationId: HexId,
    customerIds: readonly HexId[],
  ) => Effect.Effect<readonly CustomerDoc[], RepoError>;
  readonly dashboardSummary: (
    organizationId: HexId,
    options?: { readonly includeBalances?: boolean },
  ) => Effect.Effect<DashboardSummary, RepoError>;
};

export class UsageRepository extends Context.Tag("tokenpanel/UsageRepository")<
  UsageRepository,
  UsageRepositoryService
>() {}
