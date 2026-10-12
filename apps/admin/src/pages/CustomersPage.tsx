import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
import { columnDecimals, formatDate, formatMicros, formatMicrosFixed, formatNumber } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { UnitsPreview } from "@/components/ui/units-preview";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Search, Users, ChevronLeft, ChevronRight, ShieldCheck, ChevronRight as Chevron } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel, SpecList } from "@/components/Instrument";
import { useConfirm } from "@/components/ConfirmDialog";
import { WindowRuler } from "@/components/Scale";
import { limitCaption } from "../utils/limits.ts";
import { OneTimeSecret } from "@/components/OneTimeSecret";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";

import {
  CUSTOMER_STATUSES,
  parseMajorToMicros,
  type CustomerStatus,
} from "@tokenpanel/contracts";

interface Money {
  amountMicros: number;
  currency: string;
}

interface Customer {
  _id: string;
  organizationId: string;
  externalId: string | null;
  name: string;
  email: string | null;
  balance?: Money;
  status: CustomerStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}



interface BalanceAdjustment {
  _id: string;
  amountMicros: number;
  currency: string;
  reason: "topup" | "usage_debit" | "refund" | "adjustment" | "overage";
  note: string | null;
  occurredAt: string;
}

interface BalanceHistoryResponse {
  items: BalanceAdjustment[];
  total: number;
}

interface BalanceAdjustmentResponse {
  customer: Customer;
  adjustment: BalanceAdjustment | null;
}

interface Plan {
  _id: string;
  name: string;
  description: string | null;
  price: Money;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  includedCredit: Money;
  includedTokens: number;
  active: boolean;
  /** Plan rate-limit rules (returned with the plan document). */
  rateLimits?: Array<{
    id: string;
    windowSeconds: number;
    dimension: string;
    capValue: number;
    scope: string;
    scopeTarget?: string | null;
    currency?: string | null;
    active: boolean;
  }>;
}

interface PlansResponse {
  items: Plan[];
}

interface Subscription {
  _id: string;
  planId: string;
  status: "active" | "past_due" | "canceled" | "ended";
  periodStart: string;
  periodEnd: string;
  canceledAt: string | null;
}

interface SubscriptionResponse {
  subscription: Subscription;
  plan: Plan | null;
}

interface UsageByModel {
  modelAliasId: string;
  requests: number;
  tokens: number;
  costMicros: number;
  priceMicros: number;
}

interface UsageResponse {
  totalRequests: number;
  totalTokens: number;
  totalCostMicros: number;
  totalPriceMicros: number;
  currency: string;
  byModel: UsageByModel[];
}

interface ApiKey {
  _id: string;
  customerId: string;
  name: string;
  prefix: string;
  modelWhitelist: string[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
}

interface ApiKeysResponse {
  items: ApiKey[];
}

interface ApiKeyCreateResponse {
  apiKey: ApiKey;
  key: string;
}

interface OkResponse {
  ok: boolean;
}

const PAGE_SIZE = 20;
const STATUS_OPTIONS: readonly CustomerStatus[] = CUSTOMER_STATUSES;

// Domain-split labels (customers/labels.ts). Re-exported for unit tests.
export {
  statusVariant,
  reasonLabel,
  intervalLabel,
  subStatusLabel,
  errorMessage,
} from "./customers/labels.ts";

import {
  statusVariant,
  reasonLabel,
  intervalLabel,
  subStatusLabel,
  errorMessage,
} from "./customers/labels.ts";
import * as customersApi from "../api/customers.ts";

function keyBadgeClass(status: "active" | "revoked"): "success" | "destructive" {
  return status === "active" ? "success" : "destructive";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}


export default function CustomersPage(): React.ReactElement {
  const { user } = useAuth();
  const canWriteCustomers = hasPermission(user, "customers:write");
  const canReadBalances = hasPermission(user, "balances:read");

  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [statusFilter, setStatusFilter] = useState<CustomerStatus | "">("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebounced(query);
      setSkip(0);
    }, 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setListLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("skip", String(skip));
        if (statusFilter) params.set("status", statusFilter);
        if (debounced.trim()) params.set("q", debounced.trim());
        const res = await customersApi.listCustomers(Object.fromEntries(params.entries()));
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      } catch (err) {
        if (cancelled) return;
        setListError(errorMessage(err, "Failed to load customers."));
        setItems([]);
        setTotal(0);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [skip, statusFilter, debounced, reloadTick]);

  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  const currentPage = Math.floor(skip / PAGE_SIZE) + 1;

  function openDetail(c: Customer) {
    setSelected(c);
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setSelected(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Customers"
        description="Accounts that hold balances, subscriptions, usage, and API keys."
      >
        {canWriteCustomers ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Add customer
          </Button>
        ) : null}
      </PageHeader>

      {!canWriteCustomers ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Read-only access. Creating, editing, balances, subscriptions, and keys need{" "}
            <code className="font-mono text-xs">customers:write</code> and related permissions.
          </AlertDescription>
        </Alert>
      ) : null}

      {listError ? (
        <Alert variant="destructive">
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-rule px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="relative flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search customers"
              placeholder="Search name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={statusFilter || "all"}
            onValueChange={(v) => {
              setStatusFilter(v === "all" ? "" : (v as CustomerStatus));
              setSkip(0);
            }}
          >
            <SelectTrigger className="sm:w-[11rem]" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((st) => (
                <SelectItem key={st} value={st}>{st.charAt(0).toUpperCase() + st.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[13px] tabular-nums text-muted-foreground sm:ml-auto">
            {listLoading && items.length === 0 ? "Loading…" : `${formatNumber(total)} customer${total === 1 ? "" : "s"}`}
          </span>
        </div>

        {listLoading && items.length === 0 ? (
          <div className="flex flex-col" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-rule px-5 py-3.5 last:border-0">
                <div className="skeleton h-4 w-40 rounded-sm" />
                <div className="skeleton ml-auto h-4 w-20 rounded-sm" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={debounced.trim() || statusFilter ? "No customers match" : "No customers yet"}
            description={
              debounced.trim() || statusFilter
                ? "Try a different search or clear the status filter."
                : "Customers hold prepaid balances, plan subscriptions, and the API keys your apps call with."
            }
            action={
              debounced.trim() || statusFilter ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("");
                  }}
                >
                  Clear filters
                </Button>
              ) : canWriteCustomers ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  Add customer
                </Button>
              ) : null
            }
          />
        ) : (
          <Table className={cn(listLoading && "opacity-60 transition-opacity")}>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden md:table-cell">External ID</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                {canReadBalances ? <TableHead className="text-right">Balance</TableHead> : null}
                <TableHead className="w-12"><span className="sr-only">Open</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow
                  key={c._id}
                  className="cursor-pointer"
                  onClick={() => openDetail(c)}
                >
                  <TableCell className="max-w-[18rem]">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.email || "No email"}</div>
                    <Badge variant={statusVariant(c.status)} className="mt-1.5 capitalize sm:hidden">{c.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{c.externalId || "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell"><Badge variant={statusVariant(c.status)} className="capitalize">{c.status}</Badge></TableCell>
                  {canReadBalances ? (
                    <TableCell className={cn("text-right font-medium tabular-nums", c.balance && c.balance.amountMicros < 0 && "text-destructive")}>
                      {c.balance ? formatMicros(c.balance.amountMicros, c.balance.currency) : "—"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Open ${c.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(c);
                      }}
                    >
                      <Chevron />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-2.5 sm:px-5">
            <span className="text-[13px] tabular-nums text-muted-foreground">
              Page {currentPage} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={skip === 0 || listLoading} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
                <ChevronLeft />
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={skip + PAGE_SIZE >= total || listLoading} onClick={() => setSkip(skip + PAGE_SIZE)}>
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Sheet open={drawerOpen} onOpenChange={(o) => (o ? null : closeDrawer())}>
        <SheetContent
          className="w-full max-w-none gap-0 bg-background p-0 outline-none sm:max-w-[680px]"
          onOpenAutoFocus={(e) => {
            // Focus the drawer itself rather than ringing its first button.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          {selected ? (
            <CustomerDrawer customer={selected} onClose={closeDrawer} onUpdated={(c) => { setSelected(c); setItems((prev) => prev.map((item) => { if (item._id !== c._id) return item; const { balance: cBal, ...cRest } = c; const merged: Customer = { ...item, ...cRest }; if (cBal) merged.balance = cBal; return merged; })); }} onDeleted={() => { const id = selected._id; closeDrawer(); setItems((prev) => prev.filter((item) => item._id !== id)); setTotal((prev) => Math.max(0, prev - 1)); }} />
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={canWriteCustomers && createOpen}
        onOpenChange={(o) => (o ? null : setCreateOpen(false))}
      >
        {canWriteCustomers && createOpen ? (
          <CustomerFormModal
            mode="create"
            onClose={() => setCreateOpen(false)}
            onSaved={(c) => {
              setCreateOpen(false);
              setReloadTick((n) => n + 1);
              openDetail(c);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function DrawerSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="border-b border-border px-5 py-5 last:border-b-0 sm:px-6">
      <div className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

interface DrawerProps {
  customer: Customer;
  onClose: () => void;
  onUpdated: (c: Customer) => void;
  onDeleted: () => void;
}

function CustomerDrawer({ customer, onClose, onUpdated, onDeleted }: DrawerProps): React.ReactElement {
  const { user } = useAuth();
  const canWriteCustomers = hasPermission(user, "customers:write");
  const canWriteBalances = hasPermission(user, "balances:write");
  const canWriteSubscriptions = hasPermission(user, "subscriptions:write");
  const canWriteKeys = hasPermission(user, "customer_keys:write");
  // write implies read via hasPanelPermission (contracts).
  const canReadBalances = hasPermission(user, "balances:read");
  const canReadKeys = hasPermission(user, "customer_keys:read");
  const canReadUsage = hasPermission(user, "usage:read");

  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = useConfirm();

  async function handleDelete() {
    if (!canWriteCustomers) return;
    const ok = await confirm({
      title: `Close ${customer.name}?`,
      description: "The account's status becomes closed and its API keys stop working. Balance history and usage records are kept.",
      confirmLabel: "Close account",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteJson<OkResponse>(`/admin/customers/${customer._id}`);
      onDeleted();
    } catch (err) {
      setDeleteError(errorMessage(err, "Failed to close customer."));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <SheetHeader className="gap-0 border-b border-border bg-card px-5 pb-4 pt-5 pr-14 sm:px-6">
        <SheetTitle className="text-xl leading-tight">{customer.name}</SheetTitle>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground">
          <Badge variant={statusVariant(customer.status)} className="capitalize">{customer.status}</Badge>
          <span className="truncate">{customer.email || "No email"}</span>
          {customer.externalId ? <span className="font-mono text-xs">{customer.externalId}</span> : null}
        </div>
        {canWriteCustomers ? (
          <div className="mt-4 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>Edit details</Button>
            {customer.status !== "closed" ? (
              <Button variant="ghost-destructive" size="sm" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? "Closing…" : "Close account"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {deleteError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{deleteError}</AlertDescription></Alert> : null}
      </SheetHeader>
      <div className="flex-1 overflow-y-auto">
        {canReadBalances && customer.balance ? (
          <BalanceCard
            customerId={customer._id}
            balance={customer.balance}
            canWrite={canWriteBalances}
            onUpdated={onUpdated}
          />
        ) : null}
        <SubscriptionCard customerId={customer._id} canWrite={canWriteSubscriptions} />
        {canReadUsage ? (
          <UsageCard customerId={customer._id} />
        ) : null}
        {canReadKeys ? (
          <ApiKeysCard
            customerId={customer._id}
            customerName={customer.name}
            canWrite={canWriteKeys}
          />
        ) : null}
        <DrawerSection title="Account">
          <SpecList
            rows={[
              { label: "Name", value: customer.name },
              { label: "Email", value: customer.email || "—" },
              { label: "External ID", value: customer.externalId ? <span className="font-mono text-xs">{customer.externalId}</span> : "—" },
              { label: "Created", value: formatDate(customer.createdAt) },
              { label: "Updated", value: formatDate(customer.updatedAt) },
              Object.keys(customer.metadata).length > 0
                ? {
                    label: "Metadata",
                    value: (
                      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
                        {JSON.stringify(customer.metadata, null, 2)}
                      </pre>
                    ),
                  }
                : null,
            ]}
          />
        </DrawerSection>
      </div>

      <Dialog
        open={canWriteCustomers && editOpen}
        onOpenChange={(o) => (o ? null : setEditOpen(false))}
      >
        {canWriteCustomers && editOpen ? (
          <CustomerFormModal
            mode="edit"
            customer={customer}
            onClose={() => setEditOpen(false)}
            onSaved={(c) => {
              setEditOpen(false);
              onUpdated(c);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

interface BalanceCardProps {
  customerId: string;
  balance: Money;
  canWrite: boolean;
  onUpdated: (c: Customer) => void;
}

function BalanceCard({
  customerId,
  balance,
  canWrite,
  onUpdated,
}: BalanceCardProps): React.ReactElement {
  const [history, setHistory] = useState<BalanceAdjustment[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await getJson<BalanceHistoryResponse>(
        `/admin/customers/${customerId}/balance/history?limit=10&skip=0`,
      );
      setHistory(res.items);
      setHistoryTotal(res.total);
    } catch (err) {
      setHistoryError(errorMessage(err, "Failed to load balance history."));
    } finally {
      setLoadingHistory(false);
    }
  }, [customerId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <DrawerSection
      title="Balance"
      actions={
        canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
            <Plus />
            Adjust balance
          </Button>
        ) : null
      }
    >
      <div className={cn("readout text-[34px] font-semibold leading-none", balance.amountMicros < 0 && "text-destructive")}>
        {formatMicros(balance.amountMicros, balance.currency)}
      </div>
      <div className="mt-5">
        <div className="legend mb-1 text-muted-foreground">Ledger</div>
        {loadingHistory && history.length === 0 ? (
          <div className="py-3 text-sm text-muted-foreground">Loading…</div>
        ) : historyError ? (
          <Alert variant="destructive"><AlertDescription>{historyError}</AlertDescription></Alert>
        ) : history.length === 0 ? (
          <div className="py-2 text-sm text-muted-foreground">No adjustments yet.</div>
        ) : (
          <ul>
            {(showAllHistory ? history : history.slice(0, 5)).map((a, _i, shown) => (
              <li key={a._id} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 border-b border-rule py-2.5 text-sm last:border-b-0">
                <span className="font-medium">{reasonLabel(a.reason)}</span>
                <span
                  className={cn("text-right font-medium tabular-nums", a.amountMicros < 0 ? "text-destructive" : "text-foreground")}
                  title={formatMicros(a.amountMicros, a.currency)}
                >
                  {a.amountMicros > 0 ? "+" : ""}
                  {formatMicrosFixed(
                    a.amountMicros,
                    a.currency,
                    columnDecimals(shown.filter((x) => x.currency === a.currency).map((x) => x.amountMicros), a.currency),
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">{a.note || ""}</span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">{formatDate(a.occurredAt)}</span>
              </li>
            ))}
            {history.length > 5 || historyTotal > history.length ? (
              <li className="flex items-center justify-between gap-3 pt-2.5 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  Showing {showAllHistory ? history.length : Math.min(5, history.length)} of {historyTotal}
                </span>
                {history.length > 5 ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllHistory((v) => !v)}>
                    {showAllHistory ? "Show fewer" : `Show latest ${history.length}`}
                  </Button>
                ) : null}
              </li>
            ) : null}
          </ul>
        )}
      </div>
      <Dialog open={canWrite && formOpen} onOpenChange={(o) => (o ? null : setFormOpen(false))}>
        {canWrite && formOpen ? (
          <BalanceForm
            customerId={customerId}
            currency={balance.currency}
            onClose={() => setFormOpen(false)}
            onSaved={(c) => {
              setFormOpen(false);
              onUpdated(c);
              void loadHistory();
            }}
          />
        ) : null}
      </Dialog>
    </DrawerSection>
  );
}

interface BalanceFormProps {
  customerId: string;
  currency: string;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}

function BalanceForm({ customerId, currency, onClose, onSaved }: BalanceFormProps): React.ReactElement {
  const [amount, setAmount] = useState("");
  const [cur, setCur] = useState(currency);
  const [reason, setReason] = useState<"topup" | "adjustment" | "refund">("topup");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    let amountMicros: number;
    try {
      amountMicros = parseMajorToMicros(amount, { allowNegative: true });
    } catch {
      setError("Amount must be a decimal in major units (≤6 dp).");
      return;
    }
    if (amountMicros === 0) {
      setError("Amount cannot be zero.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<BalanceAdjustmentResponse>(`/admin/customers/${customerId}/balance`, {
        amountMicros,
        currency: cur,
        reason,
        note: note.trim() || undefined,
      });
      onSaved(res.customer);
    } catch (err) {
      setError(errorMessage(err, "Failed to adjust balance."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent className="gap-4">
      <DialogHeader>
        <DialogTitle>Adjust balance</DialogTitle>
      </DialogHeader>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-3">
          <div className="flex-1">
            <Field id="bal-amount" label="Amount" tooltip="Decimal major units (e.g. 25.50 = $25.50 USD). Positive = credit, negative = debit.">
              <Input id="bal-amount" type="number" step="any" value={amount} required disabled={submitting} onChange={(e) => setAmount(e.target.value)} />
              <UnitsPreview value={amount} currency={cur} allowNegative />
            </Field>
          </div>
          <div className="flex-1">
            <Field id="bal-currency" label="Currency">
              <Input id="bal-currency" type="text" maxLength={3} value={cur} required disabled={submitting} onChange={(e) => setCur(e.target.value.toUpperCase())} />
            </Field>
          </div>
        </div>
        <Field id="bal-reason" label="Reason">
          <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)} disabled={submitting}>
            <SelectTrigger id="bal-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="topup">Top-up</SelectItem>
              <SelectItem value="adjustment">Adjustment</SelectItem>
              <SelectItem value="refund">Refund</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="bal-note" label="Note (optional)">
          <Textarea id="bal-note" value={note} maxLength={280} disabled={submitting} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Applying…" : "Apply adjustment"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

interface SubscriptionCardProps {
  customerId: string;
  canWrite: boolean;
}

function SubscriptionCard({ customerId, canWrite }: SubscriptionCardProps): React.ReactElement {
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState("");
  const [subscribing, setSubscribing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subRes, plansRes] = await Promise.all([
        getJson<SubscriptionResponse>(`/admin/customers/${customerId}/subscription`).catch((err) => {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }),
        getJson<PlansResponse>("/admin/plans").catch(() => ({ items: [] as Plan[] })),
      ]);
      setSub(subRes);
      setPlans(plansRes.items.filter((p) => p.active));
    } catch (err) {
      setError(errorMessage(err, "Failed to load subscription."));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubscribe(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canWrite || !planId) return;
    setSubscribing(true);
    setError(null);
    try {
      await postJson<Subscription>(`/admin/customers/${customerId}/subscription`, { planId });
      await load();
      setPlanId("");
    } catch (err) {
      setError(errorMessage(err, "Failed to subscribe."));
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <DrawerSection title="Subscription">
      {loading ? (
        <div className="py-2 text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      ) : sub && sub.subscription ? (
        <>
        <SpecList
          rows={[
            { label: "Plan", value: <span className="font-medium">{sub.plan?.name ?? sub.subscription.planId}</span> },
            { label: "Status", value: <Badge variant={statusVariant(sub.subscription.status as CustomerStatus)} className="capitalize">{subStatusLabel(sub.subscription.status)}</Badge> },
            sub.plan ? { label: "Price", value: <span className="tabular-nums">{formatMicros(sub.plan.price.amountMicros, sub.plan.price.currency)} {intervalLabel(sub.plan.interval, sub.plan.intervalCount)}</span> } : null,
            sub.plan ? { label: "Included credit", value: <span className="tabular-nums">{formatMicros(sub.plan.includedCredit.amountMicros, sub.plan.includedCredit.currency)}</span> } : null,
            sub.plan ? { label: "Included tokens", value: <span className="tabular-nums">{formatNumber(sub.plan.includedTokens)}</span> } : null,
            { label: "Current period", value: <span className="tabular-nums">{formatDate(sub.subscription.periodStart)} → {formatDate(sub.subscription.periodEnd)}</span> },
          ]}
        />
        {sub.plan?.rateLimits && sub.plan.rateLimits.length > 0 ? (
          <div className="mt-4">
            <div className="legend mb-2 text-muted-foreground">Plan rolling limits</div>
            <WindowRuler
              markers={sub.plan.rateLimits.map((r) => ({
                key: r.id,
                windowSeconds: r.windowSeconds,
                caption: limitCaption(r),
                active: r.active,
              }))}
            />
          </div>
        ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">No active subscription. Usage is paid from the prepaid balance only.</p>
          {canWrite ? (
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onSubscribe}>
              <Select value={planId} onValueChange={setPlanId} disabled={subscribing || plans.length === 0}>
                <SelectTrigger className="flex-1" aria-label="Plan">
                  <SelectValue placeholder={plans.length === 0 ? "No active plans" : "Choose a plan…"} />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p._id} value={p._id}>{p.name} — {formatMicros(p.price.amountMicros, p.price.currency)} {intervalLabel(p.interval, p.intervalCount)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={subscribing || plans.length === 0 || !planId}>{subscribing ? "Subscribing…" : "Subscribe"}</Button>
            </form>
          ) : null}
        </div>
      )}
    </DrawerSection>
  );
}

interface UsageCardProps {
  customerId: string;
}

function UsageCard({ customerId }: UsageCardProps): React.ReactElement {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      const q = params.toString();
      const res = await getJson<UsageResponse>(`/admin/customers/${customerId}/usage${q ? `?${q}` : ""}`);
      setData(res);
      setLoaded(true);
    } catch (err) {
      setError(errorMessage(err, "Failed to load usage."));
    } finally {
      setLoading(false);
    }
  }, [customerId, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function onDateChange(e: ChangeEvent<HTMLInputElement>, setter: (v: string) => void) {
    setter(e.target.value);
  }

  return (
    <DrawerSection title="Usage">
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="usage-from" className="text-xs text-muted-foreground">From</Label>
          <Input id="usage-from" type="datetime-local" value={from} disabled={loading} className="w-[13.5rem]" onChange={(e) => onDateChange(e, setFrom)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="usage-to" className="text-xs text-muted-foreground">To</Label>
          <Input id="usage-to" type="datetime-local" value={to} disabled={loading} className="w-[13.5rem]" onChange={(e) => onDateChange(e, setTo)} />
        </div>
        {from || to ? (
          <Button variant="ghost" size="sm" className="mb-0.5" onClick={() => { setFrom(""); setTo(""); }} disabled={loading}>All time</Button>
        ) : (
          <span className="mb-2 text-xs text-muted-foreground">All time</span>
        )}
      </div>
      {error ? <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading && !data ? <div className="py-3 text-sm text-muted-foreground">Loading…</div> : null}
      {!error && loaded && data ? (
        <div className={cn("mt-4 flex flex-col gap-4", loading && "opacity-60")}>
          <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-4 [&>div]:bg-card">
            {[
              { label: "Requests", value: formatNumber(data.totalRequests) },
              { label: "Tokens", value: formatNumber(data.totalTokens) },
              { label: "Cost", value: formatMicros(data.totalCostMicros, data.currency) },
              { label: "Charged", value: formatMicros(data.totalPriceMicros, data.currency) },
            ].map((x) => (
              <div key={x.label} className="min-w-0 px-3.5 py-3">
                <dt className="legend text-muted-foreground">{x.label}</dt>
                <dd className="readout m-0 mt-1.5 truncate text-[17px] font-semibold leading-none">{x.value}</dd>
              </div>
            ))}
          </dl>
          {data.byModel.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-rule">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Charged</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byModel.map((m) => (
                    <TableRow key={m.modelAliasId}>
                      <TableCell className="font-mono text-xs font-medium">{m.modelAliasId}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(m.requests)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(m.tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatMicros(m.costMicros, data.currency)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatMicros(m.priceMicros, data.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : <p className="text-sm text-muted-foreground">No usage in this range.</p>}
        </div>
      ) : null}
    </DrawerSection>
  );
}

interface ApiKeysCardProps {
  customerId: string;
  customerName: string;
  canWrite: boolean;
}

function ApiKeysCard({ customerId, customerName, canWrite }: ApiKeysCardProps): React.ReactElement {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<{ apiKey: ApiKey; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<ApiKeysResponse>(`/admin/api-keys?customerId=${customerId}`);
      setKeys(res.items);
    } catch (err) {
      setError(errorMessage(err, "Failed to load API keys."));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = useConfirm();

  async function onRevoke(k: ApiKey) {
    if (!canWrite) return;
    const ok = await confirm({
      title: `Revoke key "${k.name}"?`,
      description: `Requests using ${k.prefix}… fail immediately. This cannot be undone.`,
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteJson<OkResponse>(`/admin/api-keys/${k._id}`);
      void load();
    } catch (err) {
      setError(errorMessage(err, "Failed to revoke key."));
    }
  }

  async function onCopy() {
    if (!newKey) return;
    const ok = await copyToClipboard(newKey.key);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <DrawerSection
      title="API keys"
      actions={
        canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Create key
          </Button>
        ) : null
      }
    >
      {newKey ? <OneTimeSecret label="Key created. Copy it now; it is shown only once." secret={newKey.key} copied={copied} onCopy={() => void onCopy()} onDismiss={() => setNewKey(null)} /> : null}
      {error ? <Alert variant="destructive" className="mb-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading ? (
        <div className="py-2 text-sm text-muted-foreground">Loading…</div>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet. Keys let this customer call the gateway; usage is billed to their balance.</p>
      ) : (
        <ul>
          {keys.map((k) => (
            <li key={k._id} className="flex items-center justify-between gap-3 border-b border-rule py-3 first:pt-0 last:border-b-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{k.name}</span>
                  <Badge variant={keyBadgeClass(k.status)} className="capitalize">{k.status}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{k.prefix}…</span>
                  <span>Last used {k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}</span>
                  <span className="truncate">{k.modelWhitelist.length > 0 ? `Models: ${k.modelWhitelist.join(", ")}` : "All models"}</span>
                </div>
              </div>
              {canWrite && k.status === "active" ? (
                <Button variant="ghost-destructive" size="sm" onClick={() => void onRevoke(k)}>Revoke</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={canWrite && createOpen} onOpenChange={(o) => (o ? null : setCreateOpen(false))}>
        {canWrite && createOpen ? (
          <ApiKeyCreateForm
            customerId={customerId}
            customerName={customerName}
            onClose={() => setCreateOpen(false)}
            onSaved={(res) => {
              setCreateOpen(false);
              setNewKey(res);
              void load();
            }}
          />
        ) : null}
      </Dialog>
    </DrawerSection>
  );
}

interface ApiKeyCreateFormProps {
  customerId: string;
  customerName: string;
  onClose: () => void;
  onSaved: (res: ApiKeyCreateResponse) => void;
}

function ApiKeyCreateForm({ customerId, customerName, onClose, onSaved }: ApiKeyCreateFormProps): React.ReactElement {
  const [name, setName] = useState("");
  const [whitelist, setWhitelist] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const models = whitelist
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setSubmitting(true);
    try {
      const res = await postJson<ApiKeyCreateResponse>("/admin/api-keys", {
        customerId,
        name: name.trim(),
        modelWhitelist: models.length > 0 ? models : undefined,
      });
      onSaved(res);
    } catch (err) {
      setError(errorMessage(err, "Failed to create key."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent className="gap-4">
      <DialogHeader>
        <DialogTitle>Create API key for {customerName}</DialogTitle>
      </DialogHeader>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <Field id="key-name" label="Name">
          <Input id="key-name" type="text" required maxLength={120} value={name} disabled={submitting} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="key-whitelist" label="Allowed models" optional hint="Model aliases separated by commas or spaces. Leave empty to allow every model.">
          <Textarea id="key-whitelist" value={whitelist} rows={2} placeholder="gpt-4.1-mini, claude-sonnet-4" className="font-mono text-[13px]" disabled={submitting} onChange={(e) => setWhitelist(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create key"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

interface CustomerFormModalProps {
  mode: "create" | "edit";
  customer?: Customer;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}

function CustomerFormModal({ mode, customer, onClose, onSaved }: CustomerFormModalProps): React.ReactElement {
  const [name, setName] = useState(customer?.name ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [externalId, setExternalId] = useState(customer?.externalId ?? "");
  const [metadata, setMetadata] = useState(
    customer && Object.keys(customer.metadata).length > 0 ? JSON.stringify(customer.metadata, null, 2) : "",
  );
  const [status, setStatus] = useState<CustomerStatus>(customer?.status ?? "active");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Email is invalid.");
      return;
    }

    let parsedMetadata: Record<string, unknown> | undefined;
    if (metadata.trim()) {
      try {
        const obj = JSON.parse(metadata);
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
          setError("Metadata must be a JSON object.");
          return;
        }
        parsedMetadata = obj as Record<string, unknown>;
      } catch {
        setError("Metadata is not valid JSON.");
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === "create") {
        const created = await postJson<Customer>("/admin/customers", {
          name: name.trim(),
          email: email.trim() || undefined,
          externalId: externalId.trim() || undefined,
          metadata: parsedMetadata,
        });
        onSaved(created);
      } else if (customer) {
        const body: Record<string, unknown> = {
          name: name.trim(),
          email: email.trim() || null,
          externalId: externalId.trim() || null,
          status,
          metadata: parsedMetadata ?? {},
        };
        const updated = await patchJson<Customer>(`/admin/customers/${customer._id}`, body);
        onSaved(updated);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to save customer."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent className="gap-4">
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "Add customer" : "Edit customer"}</DialogTitle>
      </DialogHeader>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <Field id="cust-name" label="Name">
          <Input id="cust-name" type="text" required maxLength={160} value={name} disabled={submitting} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-3">
          <div className="flex-1">
            <Field id="cust-email" label="Email">
              <Input id="cust-email" type="email" maxLength={254} value={email} disabled={submitting} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div className="flex-1">
            <Field id="cust-extid" label="External ID" tooltip="Your system's identifier for this customer. Used for API-based lookups instead of the internal ID.">
              <Input id="cust-extid" type="text" maxLength={128} value={externalId} disabled={submitting} onChange={(e) => setExternalId(e.target.value)} />
            </Field>
          </div>
        </div>
        {mode === "edit" ? (
          <Field id="cust-status" label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as CustomerStatus)} disabled={submitting}>
              <SelectTrigger id="cust-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field id="cust-meta" label="Metadata (JSON)" optional tooltip="Arbitrary JSON key-value pairs stored with the customer. Visible in API responses and usage records.">
          <Textarea id="cust-meta" value={metadata} rows={4} placeholder={'{ "region": "eu-west" }'} className="font-mono text-[13px]" disabled={submitting} onChange={(e) => setMetadata(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : mode === "create" ? "Create customer" : "Save changes"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}