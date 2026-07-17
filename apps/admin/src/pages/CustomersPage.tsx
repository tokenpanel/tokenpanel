import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
import { formatDate, formatMoney, formatNumber } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { Plus, Search, Users, ChevronLeft, ChevronRight, Copy, Check, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn } from "@/components/anim";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";

import {
  CUSTOMER_STATUSES,
  type CustomerStatus,
} from "@tokenpanel/contracts";

interface Money {
  amountMinor: number;
  currency: string;
}

interface Customer {
  _id: string;
  organizationId: string;
  externalId: string | null;
  name: string;
  email: string | null;
  balance: Money;
  status: CustomerStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}



interface BalanceAdjustment {
  _id: string;
  amountMinor: number;
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
  costMinor: number;
  priceMinor: number;
}

interface UsageResponse {
  totalRequests: number;
  totalTokens: number;
  totalCostMinor: number;
  totalPriceMinor: number;
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

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export default function CustomersPage(): React.ReactElement {
  const { user } = useAuth();
  const canWriteCustomers = hasPermission(user, "customers:write");

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

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("skip", String(skip));
      if (statusFilter) params.set("status", statusFilter);
      if (debounced.trim()) params.set("q", debounced.trim());
      const res = await customersApi.listCustomers(Object.fromEntries(params.entries()));
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setListError(errorMessage(err, "Failed to load customers."));
      setItems([]);
      setTotal(0);
    } finally {
      setListLoading(false);
    }
  }, [skip, statusFilter, debounced]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

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

  function onRowEdit(e: React.MouseEvent, c: Customer) {
    e.stopPropagation();
    setSelected(c);
    setDrawerOpen(true);
  }

  return (
    <div className="flex min-h-full flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Customers" icon={<Users strokeWidth={1.75} />}>
        {canWriteCustomers ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Customer
          </Button>
        ) : null}
      </PageHeader>

      {!canWriteCustomers ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            You can view customers but need{" "}
            <code className="font-mono text-xs">customers:write</code> (and related
            permissions) for create, edit, balance, subscription, and key actions.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <FadeIn className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-[280px] pl-8"
          />
        </FadeIn>
        <FadeIn delay={0.04}>
          <Select
            value={statusFilter || "all"}
            onValueChange={(v) => {
              setStatusFilter(v === "all" ? "" : (v as CustomerStatus));
              setSkip(0);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FadeIn>
      </div>

      {listError ? (
        <Alert variant="destructive">
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden p-0">
        {listLoading && items.length === 0 ? null : items.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title="No customers"
            description="Adjust filters or add a new customer."
          />
        ) : (
          <FadeIn>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow
                    key={c._id}
                    className="cursor-pointer"
                    onClick={() => openDetail(c)}
                  >
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className={cn(c.email ? "text-muted-foreground" : "text-muted-foreground/60")}>{c.email || "—"}</TableCell>
                    <TableCell className={cn("font-mono text-xs", c.externalId ? "text-muted-foreground" : "text-muted-foreground/60")}>{c.externalId || "—"}</TableCell>
                    <TableCell className={cn("font-semibold tabular-nums", c.balance.amountMinor < 0 && "text-destructive")}>
                      {formatMoney(c.balance.amountMinor, c.balance.currency)}
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(c.status)}>{c.status}</Badge></TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {canWriteCustomers ? (
                          <Button variant="outline" size="sm" onClick={(e) => onRowEdit(e, c)}>
                            Edit
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => openDetail(c)}>
                          {canWriteCustomers ? "Manage" : "View"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FadeIn>
        )}
      </Card>

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {total} customer{total === 1 ? "" : "s"} · page {currentPage} of {pages}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={skip === 0 || listLoading} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
            <ChevronLeft className="size-4" />
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={skip + PAGE_SIZE >= total || listLoading} onClick={() => setSkip(skip + PAGE_SIZE)}>
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <Sheet open={drawerOpen} onOpenChange={(o) => (o ? null : closeDrawer())}>
        <SheetContent className="w-full flex-col gap-0 p-0 sm:max-w-[640px]">
          {selected ? (
            <CustomerDrawer customer={selected} onClose={closeDrawer} onUpdated={(c) => setSelected(c)} onDeleted={closeDrawer} />
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
              void loadList();
              openDetail(c);
            }}
          />
        ) : null}
      </Dialog>
    </div>
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
  const canReadBalances = hasPermission(user, "balances:read") || canWriteBalances;
  const canReadKeys = hasPermission(user, "customer_keys:read") || canWriteKeys;

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

  async function handleDelete() {
    if (!canWriteCustomers) return;
    if (!confirm(`Close customer "${customer.name}"? This sets status to closed.`)) return;
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
      <SheetHeader className="flex-row items-center justify-between border-b border-border px-6 py-4">
        <SheetTitle className="flex items-center gap-2.5 text-lg">
          <span>{customer.name}</span>
          <Badge variant={statusVariant(customer.status)}>{customer.status}</Badge>
        </SheetTitle>
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
        <Card className="flex flex-col gap-3.5 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold">Customer info</div>
            {canWriteCustomers ? (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={deleting}>
                  {deleting ? "Closing…" : "Close"}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-sm">
            <div className="text-muted-foreground">Name</div><div>{customer.name}</div>
            <div className="text-muted-foreground">Email</div><div>{customer.email || "—"}</div>
            <div className="text-muted-foreground">External ID</div><div>{customer.externalId || "—"}</div>
            <div className="text-muted-foreground">Balance</div><div className="text-2xl font-bold tabular-nums">{formatMoney(customer.balance.amountMinor, customer.balance.currency)}</div>
            <div className="text-muted-foreground">Status</div><div><Badge variant={statusVariant(customer.status)}>{customer.status}</Badge></div>
            <div className="text-muted-foreground">Created</div><div>{formatDate(customer.createdAt)}</div>
            <div className="text-muted-foreground">Updated</div><div>{formatDate(customer.updatedAt)}</div>
            {Object.keys(customer.metadata).length > 0 ? (
              <>
                <div className="text-muted-foreground">Metadata</div>
                <div className="font-mono text-xs">{JSON.stringify(customer.metadata)}</div>
              </>
            ) : null}
          </div>
          {deleteError ? <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert> : null}
        </Card>

        {canReadBalances ? (
          <BalanceCard
            customerId={customer._id}
            balance={customer.balance}
            canWrite={canWriteBalances}
            onUpdated={onUpdated}
          />
        ) : null}
        <SubscriptionCard customerId={customer._id} canWrite={canWriteSubscriptions} />
        <UsageCard customerId={customer._id} />
        {canReadKeys ? (
          <ApiKeysCard
            customerId={customer._id}
            customerName={customer.name}
            canWrite={canWriteKeys}
          />
        ) : null}
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
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await getJson<BalanceHistoryResponse>(
        `/admin/customers/${customerId}/balance-history?limit=10&skip=0`,
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
    <Card className="flex flex-col gap-3.5 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">Balance</div>
        {canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
            Add Credit
          </Button>
        ) : null}
      </div>
      <div className="text-2xl font-bold tabular-nums">{formatMoney(balance.amountMinor, balance.currency)}</div>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent adjustments</div>
        {loadingHistory && history.length === 0 ? (
          <div className="py-3 text-center text-sm text-muted-foreground">Loading…</div>
        ) : historyError ? (
          <Alert variant="destructive"><AlertDescription>{historyError}</AlertDescription></Alert>
        ) : history.length === 0 ? (
          <div className="py-2 text-sm text-muted-foreground/60">No adjustments yet.</div>
        ) : (
          <div>
            {history.map((a) => (
              <div key={a._id} className="grid grid-cols-[110px_1fr_90px] gap-2.5 border-b border-border py-2 text-sm last:border-b-0">
                <div className="flex flex-col gap-0.5">
                  <span>{reasonLabel(a.reason)}</span>
                  {a.note ? <span className="text-xs text-muted-foreground">{a.note}</span> : null}
                </div>
                <div className="text-xs text-muted-foreground">{formatDate(a.occurredAt)}</div>
                <div className={cn("text-right font-semibold tabular-nums", a.amountMinor < 0 && "text-destructive")}>
                  {formatMoney(a.amountMinor, a.currency)}
                </div>
              </div>
            ))}
            {historyTotal > history.length ? (
              <div className="pt-1.5 text-xs text-muted-foreground/60">{historyTotal - history.length} more…</div>
            ) : null}
          </div>
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
    </Card>
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
    const amountMinor = Number(amount);
    if (!Number.isInteger(amountMinor)) {
      setError("Amount must be a whole number of minor units.");
      return;
    }
    if (amountMinor === 0) {
      setError("Amount cannot be zero.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<BalanceAdjustmentResponse>(`/admin/customers/${customerId}/balance`, {
        amountMinor,
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
        <DialogTitle>Add credit / adjustment</DialogTitle>
      </DialogHeader>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex gap-3">
          <div className="flex-1">
            <Field id="bal-amount" label="Amount (minor units)">
              <Input id="bal-amount" type="number" step="1" value={amount} required disabled={submitting} onChange={(e) => setAmount(e.target.value)} />
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
          <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Apply"}</Button>
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
        getJson<PlansResponse>("/admin/plans"),
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
      await postJson<Subscription>(`/admin/customers/${customerId}/subscribe`, { planId });
      await load();
      setPlanId("");
    } catch (err) {
      setError(errorMessage(err, "Failed to subscribe."));
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5 p-5">
      <div className="text-sm font-semibold">Subscription</div>
      {loading ? (
        <div className="py-3 text-center text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      ) : sub && sub.subscription ? (
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Plan</span><span>{sub.plan?.name ?? sub.subscription.planId}</span></div>
          <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Status</span><Badge variant={statusVariant(sub.subscription.status as CustomerStatus)}>{subStatusLabel(sub.subscription.status)}</Badge></div>
          {sub.plan ? (
            <>
              <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Price</span><span>{formatMoney(sub.plan.price.amountMinor, sub.plan.price.currency)} {intervalLabel(sub.plan.interval, sub.plan.intervalCount)}</span></div>
              <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Credits</span><span>{formatMoney(sub.plan.includedCredit.amountMinor, sub.plan.includedCredit.currency)}</span></div>
              <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Tokens</span><span>{formatNumber(sub.plan.includedTokens)}</span></div>
            </>
          ) : null}
          <div className="flex gap-2"><span className="min-w-[90px] text-muted-foreground">Period</span><span>{formatDate(sub.subscription.periodStart)} → {formatDate(sub.subscription.periodEnd)}</span></div>
        </div>
      ) : (
        <div>
          <div className="mb-3 text-sm text-muted-foreground/60">No active subscription.</div>
          {canWrite ? (
            <form className="flex gap-2" onSubmit={onSubscribe}>
              <Select value={planId} onValueChange={setPlanId} disabled={subscribing || plans.length === 0}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select plan…" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p._id} value={p._id}>{p.name} — {formatMoney(p.price.amountMinor, p.price.currency)} {intervalLabel(p.interval, p.intervalCount)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={subscribing || plans.length === 0 || !planId}>{subscribing ? "Subscribing…" : "Assign"}</Button>
            </form>
          ) : null}
        </div>
      )}
    </Card>
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
    <Card className="flex flex-col gap-3.5 p-5">
      <div className="text-sm font-semibold">Usage</div>
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="flex flex-col gap-1">
          <Label htmlFor="usage-from" className="text-xs">From</Label>
          <Input id="usage-from" type="datetime-local" value={from} disabled={loading} onChange={(e) => onDateChange(e, setFrom)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="usage-to" className="text-xs">To</Label>
          <Input id="usage-to" type="datetime-local" value={to} disabled={loading} onChange={(e) => onDateChange(e, setTo)} />
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>Apply</Button>
      </div>
      {loading ? <div className="py-3 text-center text-sm text-muted-foreground">Loading…</div> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!loading && !error && loaded && data ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Requests</span>
              <span className="text-base font-semibold tabular-nums">{formatNumber(data.totalRequests)}</span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Tokens</span>
              <span className="text-base font-semibold tabular-nums">{formatNumber(data.totalTokens)}</span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Cost</span>
              <span className="text-base font-semibold tabular-nums">{formatMoney(data.totalCostMinor, data.currency)}</span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Price</span>
              <span className="text-base font-semibold tabular-nums">{formatMoney(data.totalPriceMinor, data.currency)}</span>
            </div>
          </div>
          {data.byModel.length > 0 ? (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byModel.map((m) => (
                    <TableRow key={m.modelAliasId}>
                      <TableCell className="font-mono text-xs font-medium">{m.modelAliasId}</TableCell>
                      <TableCell className="text-muted-foreground">{formatNumber(m.requests)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatNumber(m.tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(m.costMinor, data.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(m.priceMinor, data.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : <div className="text-sm text-muted-foreground">No usage in range.</div>}
        </>
      ) : null}
    </Card>
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

  async function onRevoke(k: ApiKey) {
    if (!canWrite) return;
    if (!confirm(`Revoke key "${k.name}"? This cannot be undone.`)) return;
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
    <Card className="flex flex-col gap-3.5 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">API Keys</div>
        {canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            Create Key
          </Button>
        ) : null}
      </div>
      {newKey ? (
        <div className="flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/10 px-3.5 py-3 text-sm">
          <div className="flex-1 flex-col gap-1.5">
            <div className="font-semibold text-primary">Key created — copy now, shown only once</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all">{newKey.key}</code>
              <Button variant="outline" size="sm" onClick={() => void onCopy()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
          <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={() => setNewKey(null)}>Dismiss</Button>
        </div>
      ) : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading ? (
        <div className="py-3 text-center text-sm text-muted-foreground">Loading…</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-muted-foreground/60">No API keys yet.</div>
      ) : (
        <div>
          {keys.map((k) => (
            <div key={k._id} className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold">{k.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{k.prefix}…</span>
                  <Badge variant={keyBadgeClass(k.status)}>{k.status}</Badge>
                  <span>last used: {k.lastUsedAt ? formatDate(k.lastUsedAt) : "—"}</span>
                  {k.modelWhitelist.length > 0 ? <span>models: {k.modelWhitelist.join(", ")}</span> : null}
                </span>
              </div>
              {canWrite && k.status === "active" ? (
                <Button variant="destructive" size="sm" onClick={() => void onRevoke(k)}>Revoke</Button>
              ) : null}
            </div>
          ))}
        </div>
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
    </Card>
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
        <Field id="key-whitelist" label="Model whitelist (optional, comma-separated)">
          <Textarea id="key-whitelist" value={whitelist} disabled={submitting} onChange={(e) => setWhitelist(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create"}</Button>
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
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(customer?.balance.currency ?? "USD");
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
        let startingBalance: Money | undefined;
        if (amount || currency !== "USD") {
          const minor = Number(amount);
          if (!Number.isInteger(minor) || minor < 0) {
            setError("Starting balance must be a non-negative whole number.");
            setSubmitting(false);
            return;
          }
          startingBalance = { amountMinor: minor, currency };
        }
        const created = await postJson<Customer>("/admin/customers", {
          name: name.trim(),
          email: email.trim() || undefined,
          externalId: externalId.trim() || undefined,
          startingBalance,
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
        <div className="flex gap-3">
          <div className="flex-1">
            <Field id="cust-email" label="Email">
              <Input id="cust-email" type="email" maxLength={254} value={email} disabled={submitting} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div className="flex-1">
            <Field id="cust-extid" label="External ID">
              <Input id="cust-extid" type="text" maxLength={128} value={externalId} disabled={submitting} onChange={(e) => setExternalId(e.target.value)} />
            </Field>
          </div>
        </div>
        {mode === "create" ? (
          <div className="flex gap-3">
            <div className="flex-1">
              <Field id="cust-amount" label="Starting balance (minor units)">
                <Input id="cust-amount" type="number" step="1" min={0} value={amount} disabled={submitting} onChange={(e) => setAmount(e.target.value)} />
              </Field>
            </div>
            <div className="flex-1">
              <Field id="cust-cur" label="Currency">
                <Input id="cust-cur" type="text" maxLength={3} value={currency} disabled={submitting} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              </Field>
            </div>
          </div>
        ) : (
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
        )}
        <Field id="cust-meta" label="Metadata (JSON, optional)">
          <Textarea id="cust-meta" value={metadata} disabled={submitting} onChange={(e) => setMetadata(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}