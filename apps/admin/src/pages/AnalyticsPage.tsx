import { useCallback, useEffect, useState } from "react";
import {
  getAnalyticsSummary,
  type AnalyticsSummary,
} from "../api/analytics.ts";
import { formatMicros, formatNumber, formatCompact } from "../utils/format.ts";
import { cacheHitRate, formatPercent, grossMargin } from "../utils/usage.ts";
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
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel, PanelHeader, Readout, ReadoutStrip } from "@/components/Instrument";
import { Scale } from "@/components/Scale";
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

const PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 1, label: "Today" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

function presetFrom(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return isoDate(d);
}

function RangeControl({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}): React.ReactElement {
  const today = defaultTo();
  const activePreset = to === today ? PRESETS.find((p) => presetFrom(p.days) === from)?.days ?? null : null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div role="group" aria-label="Quick range" className="inline-flex h-9 items-center gap-0.5 rounded-lg border border-border bg-secondary p-[3px]">
        {PRESETS.map((p) => {
          const on = activePreset === p.days;
          return (
            <button
              key={p.days}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(presetFrom(p.days), today)}
              className={cn(
                "h-full rounded-md px-3 text-[13px] font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring",
                on
                  ? "bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.12),0_0_0_1px_var(--border)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="from" className="text-xs text-muted-foreground">From</Label>
          <Input id="from" type="date" value={from} max={to} className="w-[9.5rem] tabular-nums" onChange={(e) => onChange(e.target.value, to)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="to" className="text-xs text-muted-foreground">To</Label>
          <Input id="to" type="date" value={to} min={from} className="w-[9.5rem] tabular-nums" onChange={(e) => onChange(from, e.target.value)} />
        </div>
      </div>
    </div>
  );
}

function moneyLines(rows: ReadonlyArray<{ currency: string; micros: number }>): React.ReactNode {
  if (rows.length === 0) return "—";
  if (rows.length === 1) return formatMicros(rows[0]!.micros, rows[0]!.currency);
  return (
    <span className="flex flex-col gap-1 text-[18px]">
      {rows.map((r) => (
        <span key={r.currency}>{formatMicros(r.micros, r.currency)}</span>
      ))}
    </span>
  );
}

export default function AnalyticsPage(): React.ReactElement {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!from || !to) return;
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
  const byCurrency = totals?.byCurrency ?? [];
  const cache = totals ? cacheHitRate(totals) : { rate: null, served: 0 };
  const cacheRead = totals?.cacheReadTokens ?? 0;
  const cacheWrite = totals?.cacheWriteTokens ?? 0;
  const reasoningTokens = totals?.reasoningTokens ?? 0;
  // Share bars compare within currency only — never mix USD/AUD/CAD units.
  const maxPriceByCurrency = new Map<string, number>();
  for (const r of summary?.topCustomers ?? []) {
    const prev = maxPriceByCurrency.get(r.currency) ?? 0;
    if (r.priceMicros > prev) maxPriceByCurrency.set(r.currency, r.priceMicros);
  }
  const rows = summary?.topCustomers ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Requests, tokens, upstream cost, and charged price for the selected range."
      >
        <RangeControl
          from={from}
          to={to}
          onChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
        />
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <ReadoutStrip label="Range totals">
        <Readout label="Requests" loading={loading && !summary} value={formatNumber(totals?.requests ?? 0)} />
        <Readout
          label="Tokens"
          loading={loading && !summary}
          value={formatCompact(totals?.tokens ?? 0)}
          hint={`${formatNumber(totals?.tokens ?? 0)} total`}
        />
        <Readout
          label="Charged"
          loading={loading && !summary}
          value={moneyLines(byCurrency.map((r) => ({ currency: r.currency, micros: r.priceMicros })))}
          hint={byCurrency.length > 1 ? "Per currency, never summed" : "Price billed to customers"}
        />
        <Readout
          label="Upstream cost"
          loading={loading && !summary}
          value={moneyLines(byCurrency.map((r) => ({ currency: r.currency, micros: r.costMicros })))}
          hint="Paid to providers"
        />
      </ReadoutStrip>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Gross margin" description="Charged price over upstream cost, per currency." />
          <div className="flex flex-col gap-5 px-5 py-4">
            {byCurrency.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">{loading ? "Loading…" : "Nothing charged in this range."}</p>
            ) : (
              byCurrency.map((r) => {
                const m = grossMargin(r.priceMicros, r.costMicros);
                return (
                  <div key={r.currency}>
                    <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="legend text-muted-foreground">{r.currency}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatMicros(r.priceMicros - r.costMicros, r.currency)} kept ·{" "}
                        <span className={cn("font-semibold", m !== null && m < 0 ? "text-destructive" : "text-foreground")}>
                          {formatPercent(m)}
                        </span>
                      </span>
                    </div>
                    <Scale
                      value={m === null ? null : Math.max(0, m)}
                      label={`Gross margin ${r.currency}`}
                      valueText={formatPercent(m)}
                      marks={["0%", "25%", "50%", "75%", "100%"]}
                      tone={m !== null && m < 0 ? "destructive" : "signal"}
                    />
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Prompt cache & reasoning"
            description="Hit rate is blended: OpenAI reports cached tokens inside input, Anthropic separately."
          />
          <div className="flex flex-col gap-5 px-5 py-4">
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
                <span className="text-muted-foreground">
                  {cache.rate === null
                    ? "No cache activity in this range"
                    : `${formatCompact(cacheRead)} of ${formatCompact(cache.served)} input tokens from cache`}
                </span>
                <span className="font-semibold tabular-nums">{formatPercent(cache.rate)}</span>
              </div>
              <Scale
                value={cache.rate}
                label="Prompt cache hit rate"
                valueText={formatPercent(cache.rate)}
                marks={["0%", "25%", "50%", "75%", "100%"]}
                tone="success"
              />
            </div>
            <dl className="m-0 grid grid-cols-3 divide-x divide-rule border-t border-rule">
              {[
                { label: "Cache read", value: cacheRead, title: "Input served from the provider prompt cache." },
                { label: "Cache write", value: cacheWrite, title: "Tokens written into the cache (Anthropic cache creation)." },
                { label: "Reasoning", value: reasoningTokens, title: "Hidden reasoning / extended-thinking output tokens." },
              ].map((x) => (
                <div key={x.label} className="px-3.5 pt-3 first:pl-0" title={x.title}>
                  <dt className="legend text-muted-foreground">{x.label}</dt>
                  <dd className="readout m-0 mt-1.5 text-[20px] font-semibold leading-none">{formatCompact(x.value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Top customers by spend"
          description="Org totals above are computed server-side over all customers, not just these rows."
        />
        {rows.length === 0 ? (
          loading ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <EmptyState
              icon={<BarChart3 />}
              title="No usage in this range"
              description="Widen the range, or send a request through the gateway with a customer API key."
            />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden text-right md:table-cell">Requests</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="hidden w-[11rem] lg:table-cell">Cache hit</TableHead>
                <TableHead className="hidden text-right md:table-cell">Cost</TableHead>
                <TableHead className="text-right">Charged</TableHead>
                <TableHead className="hidden w-[14rem] sm:table-cell">Share of top spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const hit = cacheHitRate(row);
                const share = row.priceMicros / Math.max(1, maxPriceByCurrency.get(row.currency) ?? 1);
                return (
                  <TableRow key={`${row.customerId}:${row.currency}`}>
                    <TableCell className="max-w-[14rem] truncate font-medium">{row.customerName}</TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{formatNumber(row.requests)}</TableCell>
                    <TableCell className="text-right tabular-nums" title={formatNumber(row.tokens)}>
                      {formatCompact(row.tokens)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex items-center gap-3">
                        <Scale size="sm" value={hit.rate} label={`${row.customerName} cache hit rate`} valueText={formatPercent(hit.rate)} tone="success" divisions={5} minor={2} className="w-20" />
                        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{formatPercent(hit.rate, 0)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                      {formatMicros(row.costMicros, row.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMicros(row.priceMicros, row.currency)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Scale size="sm" value={share} label={`${row.customerName} share of top spend`} valueText={formatPercent(share, 0)} divisions={10} minor={2} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
