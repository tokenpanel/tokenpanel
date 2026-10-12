import { useEffect, useMemo, useState, type FormEvent } from "react";
import { deleteJson, getJson, postJson } from "../api/client.ts";
import type {
  ApiKey,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  CustomerListResponse,
} from "../api/types.ts";
import { formatRelative } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, KeyRound, ShieldCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/Instrument";
import { OneTimeSecret } from "@/components/OneTimeSecret";
import { useConfirm } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";

const CUSTOMER_LIMIT = 200;
const PAGE_SIZE = 50;

/** Parse the comma-separated model whitelist input into a clean list. */
export function parseWhitelist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function ApiKeysPage(): React.ReactElement {
  const { user } = useAuth();
  const canWrite = hasPermission(user, "customer_keys:write");
  const canReadCustomers = hasPermission(user, "customers:read");

  const confirm = useConfirm();
  const [customers, setCustomers] = useState<CustomerListResponse | null>(null);
  const [customerId, setCustomerId] = useState<string>("");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWhitelist, setNewWhitelist] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadCustomers) {
      setLoadingCustomers(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoadingCustomers(true);
      setError(null);
      try {
        const res = await getJson<CustomerListResponse>(
          `/admin/customers?limit=${CUSTOMER_LIMIT}&skip=0`,
        );
        if (cancelled) return;
        setCustomers(res);
        if (res.items.length > 0) setCustomerId(res.items[0]!._id);
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
  }, [canReadCustomers]);

  useEffect(() => {
    if (canReadCustomers && !customerId) {
      setKeys([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoadingKeys(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("skip", String(skip));
        if (canReadCustomers) params.set("customerId", customerId);
        const res = await getJson<ApiKeyListResponse>(
          `/admin/api-keys?${params.toString()}`,
        );
        if (cancelled) return;
        setKeys(res.items);
        setTotal(res.total);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load API keys.");
        setKeys([]);
        setTotal(0);
      } finally {
        if (!cancelled) setLoadingKeys(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [customerId, canReadCustomers, skip]);

  useEffect(() => {
    setSkip(0);
  }, [customerId, canReadCustomers]);

  const customerName = useMemo(() => {
    if (!customers || !customerId) return "";
    return customers.items.find((c) => c._id === customerId)?.name ?? "";
  }, [customers, customerId]);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canWrite || !customerId || !newName.trim()) return;
    setCreating(true);
    setError(null);
    const whitelist = parseWhitelist(newWhitelist);
    try {
      const res = await postJson<ApiKeyCreateResponse>("/admin/api-keys", {
        customerId,
        name: newName.trim(),
        ...(whitelist.length > 0 ? { modelWhitelist: whitelist } : {}),
      });
      setCreatedKey(res.key);
      setNewName("");
      setNewWhitelist("");
      setShowCreate(false);
      setSkip(0);
      setKeys((prev) => [res.apiKey, ...prev.filter((k) => k._id !== res.apiKey._id)].slice(0, PAGE_SIZE));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key.");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(keyId: string, keyName: string) {
    if (!canWrite) return;
    const ok = await confirm({
      title: `Revoke key "${keyName}"?`,
      description: "Requests using this key fail immediately. This cannot be undone.",
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!ok) return;
    setRevokingId(keyId);
    setError(null);
    try {
      await deleteJson(`/admin/api-keys/${encodeURIComponent(keyId)}`);
      setKeys((prev) =>
        prev.map((k) => (k._id === keyId ? { ...k, status: "revoked" } : k)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key.");
    } finally {
      setRevokingId(null);
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API keys"
        description="Keys your customers' apps call the gateway with. Usage is billed to the owning customer."
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canWrite ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Read-only access. Creating or revoking keys needs{" "}
            <code className="font-mono text-xs">customer_keys:write</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {loadingCustomers ? (
        <div className="skeleton h-40 rounded-xl" aria-hidden />
      ) : canReadCustomers && customers && customers.items.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<KeyRound />}
            title="No customers yet"
            description="API keys belong to a customer. Create a customer first, then issue their keys here or from their account drawer."
          />
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-rule px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            {canReadCustomers ? (
              <div className="flex min-w-0 items-center gap-3">
                <Label htmlFor="apikey-customer" className="shrink-0 text-muted-foreground">Customer</Label>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger id="apikey-customer" className="w-full sm:w-[22rem]">
                    <SelectValue placeholder="Choose a customer…" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers?.items.map((c) => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.name}{c.email ? <span className="text-muted-foreground"> · {c.email}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <h2 className="text-[15px] font-semibold">All API keys</h2>
            )}
            {canWrite && canReadCustomers && customerId ? (
              <Button size="sm" variant={showCreate ? "outline" : "default"} onClick={() => setShowCreate((v) => !v)}>
                {showCreate ? "Cancel" : (
                  <>
                    <Plus />
                    New key
                  </>
                )}
              </Button>
            ) : null}
          </div>

          {createdKey ? (
            <div className="border-b border-rule px-4 pt-4 sm:px-5">
              <OneTimeSecret
                label="Key created. Copy it now; it is shown only once."
                secret={createdKey}
                copied={copied}
                onCopy={() => void copyKey(createdKey)}
                onDismiss={() => setCreatedKey(null)}
              />
            </div>
          ) : null}

          {canReadCustomers && showCreate && canWrite ? (
            <form className="grid grid-cols-1 gap-4 border-b border-rule bg-background px-4 py-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end sm:px-5" onSubmit={onCreate}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apikey-name">Key name</Label>
                <Input
                  id="apikey-name"
                  type="text"
                  placeholder="Production server"
                  value={newName}
                  required
                  disabled={creating}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apikey-whitelist">
                  Allowed models <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="apikey-whitelist"
                  type="text"
                  placeholder="All models"
                  className="font-mono text-[13px]"
                  aria-describedby="apikey-whitelist-hint"
                  value={newWhitelist}
                  disabled={creating}
                  onChange={(e) => setNewWhitelist(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={creating}>{creating ? "Creating…" : "Create key"}</Button>
              <p id="apikey-whitelist-hint" className="text-xs text-muted-foreground sm:col-span-3">
                Model aliases separated by commas. Leave empty to allow every model.
              </p>
            </form>
          ) : null}

          {canReadCustomers && !customerId ? (
            <EmptyState
              icon={<KeyRound />}
              title="Choose a customer"
              description="Pick a customer above to see, issue, or revoke their keys."
            />
          ) : loadingKeys && keys.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title="No keys yet"
              description={canReadCustomers ? `${customerName} has no API keys. Create one to let their app call the gateway.` : "No API keys in this organization."}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Allowed models</TableHead>
                    <TableHead className="hidden sm:table-cell">Last used</TableHead>
                    <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k._id} className={cn(k.status === "revoked" && "text-muted-foreground")}>
                      <TableCell>
                        <div className="font-medium text-foreground">{k.name}</div>
                        <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant={k.status === "active" ? "success" : "destructive"} className="capitalize">{k.status}</Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {k.modelWhitelist && k.modelWhitelist.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {k.modelWhitelist.map((m) => (
                              <span key={m} className="rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">{m}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">All models</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">{k.lastUsedAt ? formatRelative(k.lastUsedAt) : "Never"}</TableCell>
                      <TableCell className="text-right">
                        {canWrite && k.status !== "revoked" ? (
                          <Button variant="ghost-destructive" size="sm" disabled={revokingId === k._id} onClick={() => void onRevoke(k._id, k.name)}>
                            {revokingId === k._id ? "Revoking…" : "Revoke"}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-2.5 sm:px-5">
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {total} key{total === 1 ? "" : "s"}
                </span>
                {total > PAGE_SIZE ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={skip === 0 || loadingKeys} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
                      <ChevronLeft />
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={skip + PAGE_SIZE >= total || loadingKeys} onClick={() => setSkip(skip + PAGE_SIZE)}>
                      Next
                      <ChevronRight />
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}