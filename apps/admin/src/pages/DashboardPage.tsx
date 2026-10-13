import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getDashboardSummary, type DashboardSummary } from "../api/dashboard.ts";
import { getAnalyticsSummary, type AnalyticsSummary } from "../api/analytics.ts";
import { formatCompact, formatMicros, formatNumber, formatRelative } from "../utils/format.ts";
import { cacheHitRate, formatPercent, grossMargin } from "../utils/usage.ts";
import { statusVariant, type CustomerStatus } from "./customers/labels.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel, PanelHeader, Readout, ReadoutStrip } from "@/components/Instrument";
import { Scale } from "@/components/Scale";
import {
  ArrowRight,
  BarChart3,
  KeyRound,
  MessageSquare,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import type { PanelPermission } from "../auth/AuthContext.tsx";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

export function customerStatusVariant(
  status: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "active" || status === "suspended" || status === "closed") {
    return statusVariant(status as CustomerStatus);
  }
  return "secondary";
}

const WINDOW_DAYS = 30;

function windowRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (WINDOW_DAYS - 1));
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

const QUICK_LINKS: ReadonlyArray<{
  to: string;
  label: string;
  icon: typeof UserPlus;
  permission: PanelPermission;
}> = [
  { to: "/customers", label: "Add customer", icon: UserPlus, permission: "customers:read" },
  { to: "/api-keys", label: "Issue API key", icon: KeyRound, permission: "customer_keys:read" },
  { to: "/playground", label: "Open playground", icon: MessageSquare, permission: "playground:write" },
  { to: "/analytics", label: "View analytics", icon: BarChart3, permission: "usage:read" },
];

function CountReadout({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: number;
  hint: string;
  to: string | null;
}): React.ReactElement {
  const inner = <Readout label={label} value={formatNumber(value)} hint={hint} />;
  if (!to) return inner;
  return (
    <Link
      to={to}
      className="group block no-underline outline-none transition-colors hover:bg-accent/70 hover:no-underline focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring"
    >
      {inner}
    </Link>
  );
}

/** Last-30-days spend instrument. Only rendered with usage:read. */
function SpendPanel({
  data,
  loading,
  error,
}: {
  data: AnalyticsSummary | null;
  loading: boolean;
  error: string | null;
}): React.ReactElement {
  const primary = data?.totals.byCurrency[0] ?? null;
  const others = data?.totals.byCurrency.slice(1) ?? [];
  const margin = primary ? grossMargin(primary.priceMicros, primary.costMicros) : null;
  const cache = data ? cacheHitRate(data.totals) : { rate: null, served: 0 };
  const top = (data?.topCustomers ?? []).filter((c) => c.currency === primary?.currency).slice(0, 5);
  const topMax = top.reduce((m, c) => Math.max(m, c.priceMicros), 0);

  return (
    <Panel className="flex flex-col">
      <PanelHeader
        title="Last 30 days"
        description="Charged price, upstream cost, and cache efficiency across all customers."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/analytics">
              Analytics
              <ArrowRight />
            </Link>
          </Button>
        }
      />
      {error ? (
        <div className="p-5">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : loading && !data ? (
        <div className="grid gap-6 p-5 sm:grid-cols-2" aria-hidden>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : !primary ? (
        <EmptyState
          icon={<BarChart3 />}
          title="No usage in the last 30 days"
          description="Requests through the gateway show up here with their cost and charged price."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/playground">Try a model in the playground</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-1 gap-px bg-rule sm:grid-cols-2 [&>*]:bg-card">
            <div className="flex flex-col gap-4 px-5 py-4">
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <div className="legend text-muted-foreground">Charged</div>
                  <div className="readout mt-2 truncate text-[32px] font-semibold leading-none">
                    {formatMicros(primary.priceMicros, primary.currency)}
                  </div>
                </div>
                <div className="min-w-0 text-right">
                  <div className="legend text-muted-foreground">Upstream cost</div>
                  <div className="readout mt-2 truncate text-[17px] font-medium leading-none text-muted-foreground">
                    {formatMicros(primary.costMicros, primary.currency)}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-baseline justify-between text-[13px]">
                  <span className="text-muted-foreground">Gross margin</span>
                  <span className="font-semibold tabular-nums">{formatPercent(margin)}</span>
                </div>
                <Scale
                  value={margin === null ? null : Math.max(0, margin)}
                  label="Gross margin"
                  valueText={formatPercent(margin)}
                  marks={["0%", "50%", "100%"]}
                  tone={margin !== null && margin < 0 ? "destructive" : "signal"}
                />
              </div>
            </div>
            <div className="flex flex-col gap-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="legend text-muted-foreground">Requests</div>
                  <div className="readout mt-2 text-[22px] font-semibold leading-none">{formatNumber(data?.totals.requests ?? 0)}</div>
                </div>
                <div>
                  <div className="legend text-muted-foreground">Tokens</div>
                  <div className="readout mt-2 text-[22px] font-semibold leading-none" title={formatNumber(data?.totals.tokens ?? 0)}>
                    {formatCompact(data?.totals.tokens ?? 0)}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-baseline justify-between text-[13px]">
                  <span className="text-muted-foreground">Prompt cache hit rate</span>
                  <span className="font-semibold tabular-nums">{formatPercent(cache.rate)}</span>
                </div>
                <Scale
                  value={cache.rate}
                  label="Prompt cache hit rate"
                  valueText={formatPercent(cache.rate)}
                  marks={["0%", "50%", "100%"]}
                  tone="success"
                />
              </div>
            </div>
          </div>
          {others.length > 0 ? (
            <div className="border-t border-rule px-5 py-2.5 text-xs text-muted-foreground">
              Also charged:{" "}
              {others.map((r) => formatMicros(r.priceMicros, r.currency)).join(" · ")}
            </div>
          ) : null}
          {top.length > 0 ? (
            <div className="border-t border-rule px-5 pb-4 pt-3.5">
              <div className="legend mb-2.5 text-muted-foreground">Top spenders · {primary.currency}</div>
              <ol className="flex flex-col gap-2.5">
                {top.map((c) => (
                  <li key={`${c.customerId}:${c.currency}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,10rem)_1fr_auto]">
                    <span className="truncate text-[13px] font-medium">{c.customerName}</span>
                    <Scale
                      className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"
                      size="sm"
                      value={topMax > 0 ? c.priceMicros / topMax : 0}
                      label={`${c.customerName} share of top spend`}
                      valueText={formatMicros(c.priceMicros, c.currency)}
                      divisions={10}
                      minor={2}
                    />
                    <span className="col-start-2 row-start-1 min-w-[5.5rem] text-right text-[13px] tabular-nums sm:col-start-auto sm:row-start-auto">
                      {formatMicros(c.priceMicros, c.currency)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function BalancePanel({ balances }: { balances: Record<string, number> }): React.ReactElement {
  const entries = Object.entries(balances);
  const [primary, ...rest] = entries;
  return (
    <Panel>
      <PanelHeader title="Customer balances" description="Prepaid credit held across all accounts." />
      {primary ? (
        <div className="px-5 py-4">
          <div className="legend text-muted-foreground">{primary[0]}</div>
          <div
            className={cn(
              "readout mt-2 text-[32px] font-semibold leading-none",
              primary[1] < 0 && "text-destructive",
            )}
          >
            {formatMicros(primary[1], primary[0])}
          </div>
          {rest.length > 0 ? (
            <dl className="mt-4 flex flex-col border-t border-rule">
              {rest.map(([currency, amount]) => (
                <div key={currency} className="flex items-center justify-between border-b border-rule py-2 text-sm">
                  <dt className="legend text-muted-foreground">{currency}</dt>
                  <dd className={cn("m-0 font-medium tabular-nums", amount < 0 && "text-destructive")}>
                    {formatMicros(amount, currency)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : (
        <EmptyState
          className="py-8"
          icon={<Wallet />}
          title="No balances yet"
          description="Top up a customer from their account drawer to see credit here."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/customers">Open customers</Link>
            </Button>
          }
        />
      )}
    </Panel>
  );
}

function QuickActions(): React.ReactElement | null {
  const { user } = useAuth();
  const links = QUICK_LINKS.filter((item) => hasPermission(user, item.permission));
  if (links.length === 0) return null;
  return (
    <Panel>
      <PanelHeader title="Shortcuts" />
      <div className="grid grid-cols-2 gap-px bg-rule [&>*]:bg-card rounded-b-xl overflow-hidden">
        {links.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className="group flex items-center gap-2.5 px-4 py-3.5 text-[13px] font-medium no-underline outline-none transition-colors hover:bg-accent hover:no-underline focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-signal" strokeWidth={1.8} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </Panel>
  );
}

function DashboardSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Skeleton className="h-[104px] rounded-xl" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}

export default function DashboardPage(): React.ReactElement {
  const { user } = useAuth();
  const canReadBalances = hasPermission(user, "balances:read");
  const canReadCustomers = hasPermission(user, "customers:read");
  const canReadUsage = hasPermission(user, "usage:read");
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<AnalyticsSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(canReadUsage);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      setLoading(true);
      try {
        const summary = await getDashboardSummary();
        if (cancelled) return;
        setData(summary);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!canReadUsage) return;
    let cancelled = false;
    async function load() {
      setUsageLoading(true);
      setUsageError(null);
      try {
        const res = await getAnalyticsSummary({ ...windowRange(), top: 5 });
        if (!cancelled) setUsage(res);
      } catch (err) {
        if (!cancelled) setUsageError(err instanceof Error ? err.message : "Failed to load usage.");
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [canReadUsage]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Money, catalog, and recent accounts for this organization."
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading && !data ? <DashboardSkeleton /> : null}

      {data ? (
        <>
          <ReadoutStrip label="Organization totals">
            <CountReadout
              label="Customers"
              value={data.customers}
              hint="Accounts"
              to={canReadCustomers ? "/customers" : null}
            />
            <CountReadout
              label="Models"
              value={data.models}
              hint="Published aliases"
              to={hasPermission(user, "models:read") ? "/models" : null}
            />
            <CountReadout
              label="Providers"
              value={data.providers}
              hint="Upstream connections"
              to={hasPermission(user, "providers:read") ? "/providers" : null}
            />
            <CountReadout
              label="Active plans"
              value={data.activePlans}
              hint="Sellable subscriptions"
              to={hasPermission(user, "plans:read") ? "/plans" : null}
            />
          </ReadoutStrip>

          <div
            className={cn(
              "grid grid-cols-1 items-start gap-6",
              canReadUsage && "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]",
              !canReadUsage && canReadBalances && "lg:grid-cols-2",
            )}
          >
            {canReadUsage ? (
              <SpendPanel data={usage} loading={usageLoading} error={usageError} />
            ) : null}
            <div className="flex flex-col gap-6">
              {canReadBalances ? <BalancePanel balances={data.balancesByCurrency} /> : null}
              <QuickActions />
            </div>
          </div>

          <Panel className="overflow-hidden">
            <PanelHeader
              title="Recent customers"
              description={
                data.recentCustomers.length > 0
                  ? `Newest ${data.recentCustomers.length} of ${formatNumber(data.customers)}`
                  : undefined
              }
              actions={
                canReadCustomers ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/customers">
                      All customers
                      <ArrowRight />
                    </Link>
                  </Button>
                ) : null
              }
            />
            {data.recentCustomers.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden sm:table-cell">Status</TableHead>
                    {canReadBalances ? <TableHead className="text-right">Balance</TableHead> : null}
                    <TableHead className="hidden text-right sm:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentCustomers.map((c) => (
                    <TableRow key={c._id}>
                      <TableCell className="max-w-[16rem]">
                        <div className="truncate font-medium">{c.name ?? "Customer"}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.email ?? (canReadCustomers ? "No email" : "Details hidden")}
                        </div>
                        <Badge variant={customerStatusVariant(c.status)} className="mt-1.5 capitalize sm:hidden">
                          {c.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant={customerStatusVariant(c.status)} className="capitalize">
                          {c.status}
                        </Badge>
                      </TableCell>
                      {canReadBalances ? (
                        <TableCell
                          className={cn(
                            "text-right font-medium tabular-nums",
                            c.balance && c.balance.amountMicros < 0 && "text-destructive",
                          )}
                        >
                          {c.balance ? formatMicros(c.balance.amountMicros, c.balance.currency) : "—"}
                        </TableCell>
                      ) : null}
                      <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
                        {c.createdAt ? formatRelative(c.createdAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={<Users />}
                title="No customers yet"
                description="Customers hold balances, subscriptions, and API keys. Create one to start metering usage."
                action={
                  canReadCustomers ? (
                    <Button asChild size="sm">
                      <Link to="/customers">
                        <UserPlus />
                        Add customer
                      </Link>
                    </Button>
                  ) : null
                }
              />
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
