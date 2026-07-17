import { useCallback, useEffect, useState } from "react";
import {
  getAnalyticsSummary,
  type AnalyticsSummary,
} from "../api/analytics.ts";
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
import { Activity, Coins, TrendingUp, TrendingDown, Hash, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { FadeIn, StaggerItem } from "@/components/anim";
import { cn } from "@/lib/utils";

const DEFAULT_RANGE_DAYS = 30;

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
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(`${to}T23:59:59`).toISOString();
      const res = await getAnalyticsSummary({
        from: fromIso,
        to: toIso,
        top: 50,
      });
      setSummary(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics.");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = summary?.totals;
  const primaryCurrency = totals?.byCurrency[0]?.currency ?? "USD";
  const costUnits = totals?.byCurrency.reduce((s, r) => s + r.costUnits, 0) ?? 0;
  const priceUnits =
    totals?.byCurrency.reduce((s, r) => s + r.priceUnits, 0) ?? 0;
  const multiCurrency = (totals?.byCurrency.length ?? 0) > 1;
  // Share bars compare within currency only — never mix USD/AUD/CAD units.
  const maxPriceByCurrency = new Map<string, number>();
  for (const r of summary?.topCustomers ?? []) {
    const prev = maxPriceByCurrency.get(r.currency) ?? 0;
    if (r.priceUnits > prev) maxPriceByCurrency.set(r.currency, r.priceUnits);
  }

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Analytics" icon={<BarChart3 strokeWidth={1.75} />} />

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem index={0}>
          <StatCard
            label="Requests"
            value={loading ? "…" : formatNumber(totals?.requests ?? 0)}
            icon={<Hash className="size-4" />}
          />
        </StaggerItem>
        <StaggerItem index={1}>
          <StatCard
            label="Tokens"
            value={loading ? "…" : formatNumber(totals?.tokens ?? 0)}
            icon={<Activity className="size-4" />}
          />
        </StaggerItem>
        <StaggerItem index={2}>
          <StatCard
            label={multiCurrency ? "Cost (sum*)" : "Cost"}
            value={
              loading
                ? "…"
                : multiCurrency
                  ? totals!.byCurrency
                      .map((r) => formatMoney(r.costUnits, r.currency))
                      .join(" · ")
                  : formatMoney(costUnits, primaryCurrency)
            }
            icon={<TrendingDown className="size-4" />}
          />
        </StaggerItem>
        <StaggerItem index={3}>
          <StatCard
            label={multiCurrency ? "Revenue (by currency)" : "Revenue"}
            value={
              loading
                ? "…"
                : multiCurrency
                  ? totals!.byCurrency
                      .map((r) => formatMoney(r.priceUnits, r.currency))
                      .join(" · ")
                  : formatMoney(priceUnits, primaryCurrency)
            }
            icon={<TrendingUp className="size-4" />}
          />
        </StaggerItem>
      </div>

      <FadeIn className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Top customers by spend</h2>
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="w-[30%]">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(summary?.topCustomers ?? []).map((row) => (
                <TableRow key={`${row.customerId}:${row.currency}`}>
                  <TableCell className="font-medium">{row.customerName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.requests)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.priceUnits, row.currency)}
                  </TableCell>
                  <TableCell>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full bg-primary transition-all duration-500",
                        )}
                        style={{
                          width: `${Math.round(
                            (row.priceUnits /
                              Math.max(
                                1,
                                maxPriceByCurrency.get(row.currency) ?? 1,
                              )) *
                              100,
                          )}%`,
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && (summary?.topCustomers.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No usage in this range.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
        {totals ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Coins className="size-3" />
            Org totals are server-side over all customers, not limited to the table page size.
          </p>
        ) : null}
      </FadeIn>
    </div>
  );
}
