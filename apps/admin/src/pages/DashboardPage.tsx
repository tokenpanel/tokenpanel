import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getDashboardSummary, type DashboardSummary } from "../api/dashboard.ts";
import { formatMoney, formatRelative } from "../utils/format.ts";
import { statusVariant, type CustomerStatus } from "./customers/labels.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn, StaggerItem } from "@/components/anim";
import {
  Users,
  Boxes,
  Plug,
  CreditCard,
  Wallet,
  ArrowRight,
  UserPlus,
  KeyRound,
  MessageSquare,
  BarChart3,
  LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import type { PanelPermission } from "../auth/AuthContext.tsx";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function customerStatusVariant(
  status: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "active" || status === "suspended" || status === "closed") {
    return statusVariant(status as CustomerStatus);
  }
  return "secondary";
}

function DashboardSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8" aria-hidden>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-3">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-9 w-16" />
              </div>
              <Skeleton className="size-11 rounded-xl" />
            </div>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <Card className="p-6 xl:col-span-2">
          <Skeleton className="mb-4 h-5 w-40" />
          <Skeleton className="h-10 w-48" />
          <Skeleton className="mt-3 h-4 w-32" />
        </Card>
        <Card className="overflow-hidden xl:col-span-3">
          <div className="flex items-center justify-between border-b border-border/80 px-6 py-4">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-16" />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border/60 px-6 py-4 last:border-0"
            >
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-14 rounded-md" />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

const QUICK_LINKS: ReadonlyArray<{
  to: string;
  label: string;
  description: string;
  icon: typeof UserPlus;
  permission: PanelPermission;
}> = [
  {
    to: "/customers",
    label: "Add customer",
    description: "Create a customer account",
    icon: UserPlus,
    permission: "customers:read",
  },
  {
    to: "/api-keys",
    label: "Issue API key",
    description: "Scoped keys for customer access",
    icon: KeyRound,
    permission: "customer_keys:read",
  },
  {
    to: "/playground",
    label: "Open playground",
    description: "Try models with live chat",
    icon: MessageSquare,
    permission: "playground:write",
  },
  {
    to: "/analytics",
    label: "View analytics",
    description: "Usage, spend, and top customers",
    icon: BarChart3,
    permission: "usage:read",
  },
];

export default function DashboardPage(): React.ReactElement {
  const { user } = useAuth();
  const canReadBalances = hasPermission(user, "balances:read");
  const canReadCustomers = hasPermission(user, "customers:read");
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const balanceEntries = data ? Object.entries(data.balancesByCurrency) : [];
  const primaryBalance = balanceEntries[0];

  return (
    <div className="flex flex-col gap-8 p-6 pb-12 lg:p-10">
      <FadeIn>
        <PageHeader title="Dashboard" icon={<LayoutDashboard strokeWidth={1.75} />} />
      </FadeIn>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading && !data ? <DashboardSkeleton /> : null}

      {data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StaggerItem index={0}>
              <StatCard
                label="Customers"
                value={String(data.customers)}
                icon={<Users />}
                tone="muted"
                hint="Accounts in this organization"
              />
            </StaggerItem>
            <StaggerItem index={1}>
              <StatCard
                label="Models"
                value={String(data.models)}
                icon={<Boxes />}
                tone="muted"
                hint="Aliased models in catalog"
              />
            </StaggerItem>
            <StaggerItem index={2}>
              <StatCard
                label="Providers"
                value={String(data.providers)}
                icon={<Plug />}
                tone="muted"
                hint="Upstream AI connections"
              />
            </StaggerItem>
            <StaggerItem index={3}>
              <StatCard
                label="Active plans"
                value={String(data.activePlans)}
                icon={<CreditCard />}
                tone="muted"
                hint="Sellable subscription plans"
              />
            </StaggerItem>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            {/* Balance + quick actions column */}
            <FadeIn className="flex flex-col gap-6 xl:col-span-2" delay={0.06}>
              {canReadBalances ? (
              <Card className="p-6">
                <div className="flex flex-col gap-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-muted-foreground">
                        Total customer balance
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Sum of account balances by currency
                      </span>
                    </div>
                    <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-inset ring-border">
                      <Wallet className="size-5" />
                    </div>
                  </div>

                  {balanceEntries.length > 0 && primaryBalance ? (
                    <>
                      <div className="flex flex-col gap-1">
                        <span className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
                          {formatMoney(primaryBalance[1], primaryBalance[0])}
                        </span>
                        {balanceEntries.length > 1 ? (
                          <span className="text-xs text-muted-foreground">
                            Primary currency · {balanceEntries.length} currencies total
                          </span>
                        ) : null}
                      </div>
                      {balanceEntries.length > 1 ? (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {balanceEntries.slice(1).map(([currency, amount]) => (
                            <div
                              key={currency}
                              className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
                            >
                              <div className="text-xs font-medium text-muted-foreground">
                                {currency}
                              </div>
                              <div className="text-sm font-semibold tabular-nums">
                                {formatMoney(amount, currency)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <EmptyState
                      className="py-6"
                      title="No balances yet"
                      description="Customer balances will show here once accounts are funded."
                      icon={<Wallet className="size-5" />}
                      action={
                        <Button asChild size="sm" variant="outline">
                          <Link to="/customers">
                            Manage customers
                            <ArrowRight className="size-3.5" />
                          </Link>
                        </Button>
                      }
                    />
                  )}
                </div>
              </Card>
              ) : null}

              <Card className="overflow-hidden">
                <div className="border-b border-border/80 px-6 py-3.5">
                  <h2 className="text-sm font-semibold tracking-tight">Quick actions</h2>
                </div>
                <ul className="divide-y divide-border/70">
                  {QUICK_LINKS.filter((item) =>
                    hasPermission(user, item.permission),
                  ).map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.to}>
                        <Link
                          to={item.to}
                          className={cn(
                            "group flex items-center gap-3.5 px-6 py-3.5 no-underline",
                            "transition-colors hover:bg-muted/40",
                          )}
                        >
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-inset ring-border transition-colors group-hover:bg-accent group-hover:text-foreground">
                            <Icon className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-foreground">
                              {item.label}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {item.description}
                            </div>
                          </div>
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </FadeIn>

            {/* Recent customers */}
            <FadeIn className="xl:col-span-3" delay={0.1}>
              <Card className="flex h-full flex-col overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border/80 px-6 py-3.5">
                  <h2 className="text-sm font-semibold tracking-tight">
                    Recent customers
                    {!canReadCustomers ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        (limited)
                      </span>
                    ) : null}
                  </h2>
                  <Button asChild variant="ghost" size="sm" className="shrink-0">
                    <Link to="/customers">
                      View all
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>

                {data.recentCustomers.length > 0 ? (
                  <ul className="divide-y divide-border/70">
                    {data.recentCustomers.map((c, i) => (
                      <StaggerItem key={c._id} index={i} step={0.03} as="li">
                        <div className="flex items-center gap-3.5 px-6 py-4 transition-colors hover:bg-muted/30">
                          <Avatar className="size-10 shrink-0 ring-1 ring-border/60">
                            <AvatarFallback className="bg-muted text-xs font-semibold text-muted-foreground">
                              {initials(c.name ?? "")}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">
                                {c.name ?? "Unknown customer"}
                              </span>
                              <Badge
                                variant={customerStatusVariant(c.status)}
                                className="capitalize shrink-0"
                              >
                                {c.status}
                              </Badge>
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {c.email ?? "No email"}
                              {c.createdAt ? (
                                <>
                                  <span className="mx-1.5 text-border">·</span>
                                  {formatRelative(c.createdAt)}
                                </>
                              ) : null}
                            </div>
                          </div>
                          {canReadBalances && c.balance ? (
                            <div className="hidden shrink-0 flex-col items-end sm:flex">
                              <span className="text-sm font-semibold tabular-nums">
                                {formatMoney(
                                  c.balance.amountUnits,
                                  c.balance.currency,
                                )}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                balance
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </StaggerItem>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    className="flex-1 py-14"
                    title="No customers yet"
                    description="Create your first customer to start tracking balances and usage."
                    icon={<Users className="size-5" />}
                    action={
                      <Button asChild size="sm">
                        <Link to="/customers">
                          <UserPlus className="size-3.5" />
                          Add customer
                        </Link>
                      </Button>
                    }
                  />
                )}

                {data.recentCustomers.length > 0 ? (
                  <>
                    <Separator className="mt-auto" />
                    <div className="px-6 py-3 text-xs text-muted-foreground">
                      Showing {data.recentCustomers.length} most recent
                      {data.customers > data.recentCustomers.length
                        ? ` of ${data.customers}`
                        : ""}
                    </div>
                  </>
                ) : null}
              </Card>
            </FadeIn>
          </div>
        </>
      ) : null}
    </div>
  );
}
