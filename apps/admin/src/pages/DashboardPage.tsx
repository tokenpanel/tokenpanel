import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api/client.ts";
import type {
  CustomerListResponse,
  ModelListResponse,
  PlanListResponse,
  ProviderListResponse,
} from "../api/types.ts";
import { formatDate, formatMoney } from "../utils/format.ts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { FadeIn, StaggerItem } from "@/components/anim";
import { Users, Boxes, Plug, CreditCard, Wallet } from "lucide-react";

interface DashboardData {
  customers: CustomerListResponse;
  models: ModelListResponse;
  providers: ProviderListResponse;
  plans: PlanListResponse;
}

const FETCH_LIMIT = 500;

export default function DashboardPage(): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const [customers, models, providers, plans] = await Promise.all([
          getJson<CustomerListResponse>(`/admin/customers?limit=${FETCH_LIMIT}&skip=0`),
          getJson<ModelListResponse>("/admin/models"),
          getJson<ProviderListResponse>("/admin/providers"),
          getJson<PlanListResponse>("/admin/plans"),
        ]);
        if (cancelled) return;
        setData({ customers, models, providers, plans });
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

  const totalBalance = useMemo(() => {
    if (!data) return null;
    const byCurrency = new Map<string, number>();
    for (const c of data.customers.items) {
      const cur = c.balance.currency;
      byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + c.balance.amountMinor);
    }
    return byCurrency;
  }, [data]);

  const recentCustomers = useMemo(() => {
    if (!data) return [];
    return [...data.customers.items]
      .sort((a, b) => {
        const aDate = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bDate = b.createdAt ? Date.parse(b.createdAt) : 0;
        return bDate - aDate;
      })
      .slice(0, 5);
  }, [data]);

  const activePlanCount = useMemo(() => {
    if (!data) return 0;
    return data.plans.items.filter((p) => p.status === "active").length;
  }, [data]);

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
            <StatCard label="Customers" value={String(data.customers.total)} icon={<Users className="size-4" />} />
          </StaggerItem>
          <StaggerItem index={1}>
            <StatCard label="Models" value={String(data.models.items.length)} icon={<Boxes className="size-4" />} />
          </StaggerItem>
          <StaggerItem index={2}>
            <StatCard label="Providers" value={String(data.providers.items.length)} icon={<Plug className="size-4" />} />
          </StaggerItem>
          <StaggerItem index={3}>
            <StatCard label="Active Plans" value={String(activePlanCount)} icon={<CreditCard className="size-4" />} />
          </StaggerItem>
        </div>
      ) : null}

      <FadeIn className="flex flex-col gap-3" delay={0.05}>
        <h2 className="text-base font-semibold">Total Customer Balance</h2>
        {totalBalance && totalBalance.size > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...totalBalance.entries()].map(([currency, amount], i) => (
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
                      <span className="text-2xl font-bold tracking-tight tabular-nums">
                        {formatMoney(amount, currency)}
                      </span>
                    </div>
                  </div>
                </Card>
              </StaggerItem>
            ))}
          </div>
        ) : data ? (
          <Card className="p-5 text-sm text-muted-foreground">No customer balances.</Card>
        ) : null}
      </FadeIn>

      <FadeIn className="flex flex-col gap-3" delay={0.1}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent Customers</h2>
          {data && data.customers.total > 5 ? (
            <span className="text-xs text-muted-foreground">
              {data.customers.total} total
            </span>
          ) : null}
        </div>
        {recentCustomers.length === 0 ? (
          data ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No customers yet.
            </Card>
          ) : null
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="grid grid-cols-[1fr_1fr_100px_140px] gap-3 border-b border-border bg-muted/40 px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <div>Name</div>
              <div>Email</div>
              <div>Status</div>
              <div>Created</div>
            </div>
            {recentCustomers.map((c, i) => (
              <StaggerItem key={c._id} index={i} step={0.03}>
                <div className="grid grid-cols-[1fr_1fr_100px_140px] gap-3 border-b border-border px-5 py-3.5 text-sm last:border-b-0 transition-colors hover:bg-muted/30">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-muted-foreground">{c.email || "—"}</div>
                  <div>
                    <Badge variant={c.status === "active" ? "success" : "secondary"}>
                      {c.status}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground">{formatDate(c.createdAt)}</div>
                </div>
              </StaggerItem>
            ))}
          </Card>
        )}
      </FadeIn>
    </div>
  );
}