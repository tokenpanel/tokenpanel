import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson } from "../api/client.ts";
import type {
  CustomerListResponse,
  CustomerUsageResponse,
} from "../api/types.ts";
import { formatMoney, formatNumber } from "../utils/format.ts";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, Coins, TrendingUp, TrendingDown, Hash } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { FadeIn, StaggerItem } from "@/components/anim";
import { cn } from "@/lib/utils";

const TOP_N = 20;
const DEFAULT_RANGE_DAYS = 30;

interface Row {
  customerId: string;
  customerName: string;
  usage: CustomerUsageResponse | null;
  error: string | null;
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - (DEFAULT_RANGE_DAYS - 1));
  return isoDate(d);
}

export function defaultTo(): string {
  return isoDate(new Date());
}

export default function AnalyticsPage(): React.ReactElement {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [customers, setCustomers] = useState<CustomerListResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingCustomers(true);
      setError(null);
      try {
        const res = await getJson<CustomerListResponse>(
          `/admin/customers?limit=${TOP_N}&skip=0`,
        );
        if (cancelled) return;
        setCustomers(res);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load customers.");
      } finally {
        if (!cancelled) setLoadingCustomers(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchUsage = useCallback(async () => {
    if (!customers || customers.items.length === 0) return;
    setLoadingUsage(true);
    setError(null);
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(`${to}T23:59:59`).toISOString();
    const next: Row[] = await Promise.all(
      customers.items.map(async (c): Promise<Row> => {
        try {
          const usage = await getJson<CustomerUsageResponse>(
            `/admin/customers/${c._id}/usage?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
          );
          return { customerId: c._id, customerName: c.name, usage, error: null };
        } catch (err) {
          return {
            customerId: c._id,
            customerName: c.name,
            usage: null,
            error: err instanceof Error ? err.message : "usage fetch failed",
          };
        }
      }),
    );
    setRows(next);
    setLoadingUsage(false);
  }, [customers, from, to]);

  useEffect(() => {
    if (customers) void fetchUsage();
  }, [customers, fetchUsage]);

  const totals = useMemo(() => {
    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostMinor = 0;
    let totalPriceMinor = 0;
    const byCurrency = new Map<string, { cost: number; price: number }>();
    for (const r of rows) {
      if (!r.usage) continue;
      totalRequests += r.usage.totalRequests;
      totalTokens += r.usage.totalTokens;
      totalCostMinor += r.usage.totalCostMinor;
      totalPriceMinor += r.usage.totalPriceMinor;
      const cur = r.usage.currency;
      const existing = byCurrency.get(cur);
      if (existing) {
        existing.cost += r.usage.totalCostMinor;
        existing.price += r.usage.totalPriceMinor;
      } else {
        byCurrency.set(cur, {
          cost: r.usage.totalCostMinor,
          price: r.usage.totalPriceMinor,
        });
      }
    }
    return {
      totalRequests,
      totalTokens,
      totalCostMinor,
      totalPriceMinor,
      totalProfitMinor: totalPriceMinor - totalCostMinor,
      byCurrency,
    };
  }, [rows]);

  const chartRows = useMemo(() => {
    return rows
      .filter((r) => r.usage && r.usage.totalPriceMinor > 0)
      .map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        costMinor: r.usage ? r.usage.totalCostMinor : 0,
        priceMinor: r.usage ? r.usage.totalPriceMinor : 0,
        currency: r.usage ? r.usage.currency : "USD",
      }))
      .sort((a, b) => b.priceMinor - a.priceMinor)
      .slice(0, 10);
  }, [rows]);

  const maxPriceMinor = useMemo(() => {
    return chartRows.reduce((max, r) => Math.max(max, r.priceMinor), 0);
  }, [chartRows]);

  const primaryCurrency = useMemo(() => {
    if (totals.byCurrency.size === 0) return "USD";
    const entries = [...totals.byCurrency.entries()];
    return entries.sort((a, b) => b[1].price - a[1].price)[0]?.[0] ?? "USD";
  }, [totals]);

  const profitPositive = totals.totalProfitMinor >= 0;

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Analytics" description="Customer usage and revenue for the selected range." />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="analytics-from" className="text-xs">From</Label>
          <Input id="analytics-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="analytics-to" className="text-xs">To</Label>
          <Input id="analytics-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
        </div>
      </div>

      {loadingCustomers ? null : (
        <>
          <FadeIn className="flex flex-col gap-3" delay={0.05}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Org Totals</h2>
              <span className="text-xs text-muted-foreground">
                Aggregated across {rows.filter((r) => r.usage).length} of {rows.length} customers.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <StaggerItem index={0} step={0.04}>
                <StatCard
                  label="Requests"
                  value={formatNumber(totals.totalRequests)}
                  icon={<Hash className="size-4" />}
                  tone="default"
                />
              </StaggerItem>
              <StaggerItem index={1} step={0.04}>
                <StatCard
                  label="Tokens"
                  value={formatNumber(totals.totalTokens)}
                  icon={<Activity className="size-4" />}
                  tone="default"
                />
              </StaggerItem>
              <StaggerItem index={2} step={0.04}>
                <StatCard
                  label="Cost"
                  value={formatMoney(totals.totalCostMinor, primaryCurrency)}
                  icon={<Coins className="size-4" />}
                  tone="muted"
                />
              </StaggerItem>
              <StaggerItem index={3} step={0.04}>
                <StatCard
                  label="Revenue"
                  value={formatMoney(totals.totalPriceMinor, primaryCurrency)}
                  icon={<TrendingUp className="size-4" />}
                  tone="success"
                />
              </StaggerItem>
              <StaggerItem index={4} step={0.04}>
                <StatCard
                  label="Profit"
                  value={formatMoney(totals.totalProfitMinor, primaryCurrency)}
                  icon={profitPositive ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                  tone={profitPositive ? "success" : "destructive"}
                />
              </StaggerItem>
            </div>
          </FadeIn>

          <FadeIn className="flex flex-col gap-3" delay={0.1}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Top Customers by Spend</h2>
            </div>
            {chartRows.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">No usage data for the selected range.</Card>
            ) : (
              <Card className="flex flex-col gap-4 p-6">
                <div className="flex gap-4 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-3 rounded-sm bg-destructive/50" /> Cost
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-3 rounded-sm bg-success/60" /> Profit
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  {chartRows.map((r, i) => {
                    const pricePct = maxPriceMinor > 0 ? (r.priceMinor / maxPriceMinor) * 100 : 0;
                    const costPct = maxPriceMinor > 0 ? (r.costMinor / maxPriceMinor) * 100 : 0;
                    const profitPct = Math.max(0, pricePct - costPct);
                    return (
                      <StaggerItem key={r.customerId} index={i} step={0.03}>
                        <div className="grid grid-cols-[160px_1fr_110px] items-center gap-3">
                          <div className="truncate text-sm">{r.customerName}</div>
                          <div className="flex h-5 overflow-hidden rounded bg-muted">
                            <div className="bg-destructive/50 transition-all duration-500" style={{ width: `${costPct}%` }} />
                            <div className="bg-success/60 transition-all duration-500" style={{ width: `${profitPct}%` }} />
                          </div>
                          <div className="text-right text-sm font-semibold tabular-nums">{formatMoney(r.priceMinor, r.currency)}</div>
                        </div>
                      </StaggerItem>
                    );
                  })}
                </div>
              </Card>
            )}
          </FadeIn>

          <FadeIn className="flex flex-col gap-3" delay={0.15}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Per-Customer Usage</h2>
              {customers && customers.total > TOP_N ? (
                <span className="text-xs text-muted-foreground">
                  Showing first {TOP_N} of {customers.total} customers.
                </span>
              ) : null}
            </div>
            {loadingUsage ? null : rows.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">No customers found.</Card>
            ) : (
              <FadeIn>
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-right">Profit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => {
                        const profitMinor = r.usage ? r.usage.totalPriceMinor - r.usage.totalCostMinor : 0;
                        return (
                          <TableRow key={r.customerId}>
                            <TableCell>{r.customerName}</TableCell>
                            {r.usage ? (
                              <>
                                <TableCell className="text-right tabular-nums">{formatNumber(r.usage.totalRequests)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(r.usage.totalTokens)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatMoney(r.usage.totalCostMinor, r.usage.currency)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatMoney(r.usage.totalPriceMinor, r.usage.currency)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums", profitMinor >= 0 ? "text-success" : "text-destructive")}>
                                  {formatMoney(profitMinor, r.usage.currency)}
                                </TableCell>
                              </>
                            ) : (
                              <TableCell className="text-right text-muted-foreground" colSpan={5}>
                                {r.error ?? "No usage data"}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Card>
              </FadeIn>
            )}
          </FadeIn>
        </>
      )}
    </div>
  );
}