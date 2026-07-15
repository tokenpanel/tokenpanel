import { useEffect, useState } from "react";
import { getDashboardSummary, type DashboardSummary } from "../api/dashboard.ts";
import { formatDate, formatMoney } from "../utils/format.ts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { FadeIn, StaggerItem } from "@/components/anim";
import { Users, Boxes, Plug, CreditCard, Wallet } from "lucide-react";

export default function DashboardPage(): React.ReactElement {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const summary = await getDashboardSummary();
        if (cancelled) return;
        setData(summary);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const balanceEntries = data
    ? Object.entries(data.balancesByCurrency)
    : [];

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Dashboard" description="Organization overview." />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StaggerItem index={0}>
            <StatCard
              label="Customers"
              value={String(data.customers)}
              icon={<Users className="size-4" />}
            />
          </StaggerItem>
          <StaggerItem index={1}>
            <StatCard
              label="Models"
              value={String(data.models)}
              icon={<Boxes className="size-4" />}
            />
          </StaggerItem>
          <StaggerItem index={2}>
            <StatCard
              label="Providers"
              value={String(data.providers)}
              icon={<Plug className="size-4" />}
            />
          </StaggerItem>
          <StaggerItem index={3}>
            <StatCard
              label="Active Plans"
              value={String(data.activePlans)}
              icon={<CreditCard className="size-4" />}
            />
          </StaggerItem>
        </div>
      ) : null}

      <FadeIn className="flex flex-col gap-3" delay={0.05}>
        <h2 className="text-base font-semibold">Total Customer Balance</h2>
        {balanceEntries.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {balanceEntries.map(([currency, amount], i) => (
              <StaggerItem key={currency} index={i} step={0.04}>
                <Card className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Wallet className="size-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {currency}
                      </span>
                      <span className="text-lg font-semibold tabular-nums">
                        {formatMoney(amount, currency)}
                      </span>
                    </div>
                  </div>
                </Card>
              </StaggerItem>
            ))}
          </div>
        ) : data ? (
          <p className="text-sm text-muted-foreground">No customer balances yet.</p>
        ) : null}
      </FadeIn>

      <FadeIn className="flex flex-col gap-3" delay={0.1}>
        <h2 className="text-base font-semibold">Recent Customers</h2>
        {data && data.recentCustomers.length > 0 ? (
          <Card className="divide-y divide-border">
            {data.recentCustomers.map((c) => (
              <div
                key={c._id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{c.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {c.email ?? "—"} · {c.createdAt ? formatDate(c.createdAt) : "—"}
                  </span>
                </div>
                <Badge variant="secondary">{c.status}</Badge>
              </div>
            ))}
          </Card>
        ) : data ? (
          <p className="text-sm text-muted-foreground">No customers yet.</p>
        ) : null}
      </FadeIn>
    </div>
  );
}
