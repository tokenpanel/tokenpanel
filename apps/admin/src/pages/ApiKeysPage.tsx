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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, KeyRound, Copy, Check, ShieldCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn } from "@/components/anim";
import { cn } from "@/lib/utils";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";

const CUSTOMER_LIMIT = 200;
const PAGE_SIZE = 50;

export default function ApiKeysPage(): React.ReactElement {
  const { user } = useAuth();
  const canWrite = hasPermission(user, "customer_keys:write");
  const canReadCustomers = hasPermission(user, "customers:read");

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
    const whitelist = newWhitelist
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
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
    if (!confirm(`Revoke key "${keyName}"? This cannot be undone.`)) return;
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
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="API Keys" icon={<KeyRound strokeWidth={1.75} />} />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canWrite ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            You can view API keys but need{" "}
            <code className="font-mono text-xs">customer_keys:write</code> to create or revoke them.
          </AlertDescription>
        </Alert>
      ) : null}

      {createdKey ? (
        <Alert variant="info">
          <div className="flex flex-col gap-2.5">
            <div className="text-sm font-semibold">Key created. Copy it now — shown only once.</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all">{createdKey}</code>
              <Button variant="outline" size="sm" onClick={() => void copyKey(createdKey)}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>Dismiss</Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {loadingCustomers ? null : canReadCustomers && customers && customers.items.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-5" />}
          title="No customers available"
          description="Create a customer first to manage their API keys."
        />
      ) : (
        <>
          {canReadCustomers ? (
            <FadeIn className="flex flex-col gap-1.5" style={{ minWidth: 280 }}>
              <Label htmlFor="apikey-customer">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="apikey-customer" className="w-[320px]">
                  <SelectValue placeholder="Select customer…" />
                </SelectTrigger>
                <SelectContent>
                  {customers?.items.map((c) => (
                    <SelectItem key={c._id} value={c._id}>
                      {c.name} — {c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FadeIn>
          ) : null}

          {(!canReadCustomers || customerId) ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">
                  {canReadCustomers ? `Keys for ${customerName}` : "All API Keys"}
                </h2>
                {canWrite && canReadCustomers ? (
                  <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
                    {showCreate ? "Cancel" : (
                      <>
                        <Plus className="size-4" />
                        Create Key
                      </>
                    )}
                  </Button>
                ) : null}
              </div>

              {canReadCustomers && showCreate && canWrite ? (
                <FadeIn>
                  <Card className="p-5">
                    <form className="flex flex-col gap-3" onSubmit={onCreate}>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="apikey-name">Name</Label>
                        <Input
                          id="apikey-name"
                          type="text"
                          placeholder="e.g. Production server"
                          value={newName}
                          required
                          disabled={creating}
                          onChange={(e) => setNewName(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="apikey-whitelist">Model whitelist (optional)</Label>
                        <Input
                          id="apikey-whitelist"
                          type="text"
                          placeholder="model-a, model-b"
                          value={newWhitelist}
                          disabled={creating}
                          onChange={(e) => setNewWhitelist(e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                          Comma-separated list of allowed model IDs. Leave empty for all models.
                        </span>
                      </div>
                      <div>
                        <Button type="submit" disabled={creating}>{creating ? "Creating…" : "Create Key"}</Button>
                      </div>
                    </form>
                  </Card>
                </FadeIn>
              ) : null}

              {loadingKeys ? null : keys.length === 0 ? (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  {canReadCustomers ? "No API keys for this customer." : "No API keys."}
                </Card>
              ) : (
                <>
                <FadeIn>
                  <Card className="overflow-hidden p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Prefix</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Model Whitelist</TableHead>
                          <TableHead>Last Used</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {keys.map((k) => (
                          <TableRow key={k._id}>
                            <TableCell className="font-medium">{k.name}</TableCell>
                            <TableCell><code className="font-mono text-xs">{k.prefix}…</code></TableCell>
                            <TableCell>
                              <Badge variant={k.status === "active" ? "success" : "destructive"}>{k.status}</Badge>
                            </TableCell>
                            <TableCell>
                              {k.modelWhitelist && k.modelWhitelist.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {k.modelWhitelist.map((m) => (
                                    <span key={m} className={cn("rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground")}>{m}</span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">All models</span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{formatRelative(k.lastUsedAt)}</TableCell>
                            <TableCell className="text-right">
                              {canWrite && k.status !== "revoked" ? (
                                <Button variant="destructive" size="sm" disabled={revokingId === k._id} onClick={() => void onRevoke(k._id, k.name)}>
                                  {revokingId === k._id ? "Revoking…" : "Revoke"}
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </FadeIn>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    {total} key{total === 1 ? "" : "s"}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={skip === 0 || loadingKeys} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
                      <ChevronLeft className="size-4" />
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={skip + PAGE_SIZE >= total || loadingKeys} onClick={() => setSkip(skip + PAGE_SIZE)}>
                      Next
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}