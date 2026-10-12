import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getJson, patchJson, postJson, deleteJson } from "../api/client.ts";
import type {
  ManagementKey,
  ManagementKeyCreateResponse,
  ManagementKeyListResponse,
} from "../api/management-keys.ts";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import { formatRelative } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KeyRound, MoreHorizontal, Plus, ShieldCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel, PanelHeader } from "@/components/Instrument";
import { OneTimeSecret } from "@/components/OneTimeSecret";
import { useConfirm } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { MANAGEMENT_SCOPE_DEFINITIONS, requiredPanelPermissionForScope } from "@tokenpanel/contracts";

function groupBy<T, K extends string>(items: readonly T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/** All scope definitions grouped — filtered at render time by actor permissions. */
const ALL_SCOPES_BY_GROUP = groupBy(MANAGEMENT_SCOPE_DEFINITIONS, (s) => s.group);

/** Scope definition lookup by value, for resolving locked-scope labels. */
const SCOPE_BY_VALUE = new Map<string, (typeof MANAGEMENT_SCOPE_DEFINITIONS)[number]>(
  MANAGEMENT_SCOPE_DEFINITIONS.map((s) => [s.value, s]),
);

export default function ManagementKeysPage(): React.ReactElement {
  const { user } = useAuth();
  const canRead = hasPermission(user, "management_keys:read");
  const canWrite = hasPermission(user, "management_keys:write");
  const activeOrgId = user?.activeOrganizationId;

  const grantableScopeValues = useMemo(
    () =>
      new Set<string>(
        MANAGEMENT_SCOPE_DEFINITIONS.filter(
          (s) =>
            user?.role === "admin" ||
            hasPermission(user, requiredPanelPermissionForScope(s.value)),
        ).map((s) => s.value),
      ),
    [user],
  );

  const confirm = useConfirm();
  const [keys, setKeys] = useState<ManagementKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Reload when the active org changes — otherwise the table keeps the
  // previous org's keys and a one-time plaintext secret from create.
  useEffect(() => {
    let cancelled = false;
    setCreatedKey(null);
    setCopied(false);
    setShowCreate(false);
    setEditingId(null);
    setName("");
    setSelected(new Set());
    async function load() {
      if (!canRead) {
        setKeys([]);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const keyRes = await getJson<ManagementKeyListResponse>("/admin/management-keys");
        if (cancelled) return;
        setKeys(keyRes.items);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load management keys.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeOrgId, canRead]);

  function resetForm() {
    setName("");
    setSelected(new Set());
    setEditingId(null);
    setShowCreate(false);
  }

  function openCreate() {
    setName("");
    setSelected(new Set(["models:read", "customers:read"]));
    setEditingId(null);
    setShowCreate(true);
  }

  function openEdit(k: ManagementKey) {
    setName(k.name);
    setSelected(new Set(k.scopes));
    setEditingId(k._id);
    setShowCreate(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    let scopesArr = Array.from(selected).sort();
    // When editing, preserve scopes already on the key that this actor
    // can't grant (prevents inadvertent stripping of elevated scopes).
    if (editingId) {
      const existing = keys.find((k) => k._id === editingId);
      if (existing) {
        const locked = existing.scopes.filter(
          (s) => !grantableScopeValues.has(s),
        );
        scopesArr = [...new Set([...scopesArr, ...locked])].sort();
      }
    }
    try {
      if (editingId) {
        const updated = await patchJson<{ managementKey?: ManagementKey } & ManagementKey>(
          `/admin/management-keys/${encodeURIComponent(editingId)}`,
          { name: name.trim(), scopes: scopesArr },
        );
        setKeys((prev) =>
          prev.map((k) => (k._id === editingId ? { ...k, ...updated, scopes: scopesArr } : k)),
        );
        resetForm();
      } else {
        const res = await postJson<ManagementKeyCreateResponse>("/admin/management-keys", {
          name: name.trim(),
          scopes: scopesArr,
        });
        setCreatedKey(res.key);
        setKeys((prev) => [res.managementKey, ...prev.filter((k) => k._id !== res.managementKey._id)]);
        resetForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save management key.");
    } finally {
      setSaving(false);
    }
  }

  async function onRevoke(id: string) {
    const key = keys.find((k) => k._id === id);
    const ok = await confirm({
      title: `Revoke "${key?.name ?? id}"?`,
      description: "Services using this management key lose access immediately. This cannot be undone.",
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!ok) return;
    setRevokingId(id);
    setError(null);
    try {
      await deleteJson(`/admin/management-keys/${encodeURIComponent(id)}`);
      setKeys((prev) => prev.map((k) => (k._id === id ? { ...k, status: "revoked" } : k)));
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

  function toggleScope(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  const lockedScopes = editingId
    ? Array.from(selected)
        .filter((s) => !grantableScopeValues.has(s))
        .sort()
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Management keys"
        description={
          <>
            Server-to-server keys for your own backend: read org data and call the gateway on your behalf. Prefixed{" "}
            <code className="font-mono text-xs">tp_mgmt_</code>, separate from customer keys (<code className="font-mono text-xs">tp_live_</code>).
          </>
        }
      >
        {canWrite && !showCreate ? (
          <Button onClick={openCreate}>
            <Plus />
            New key
          </Button>
        ) : null}
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canRead ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Viewing management keys needs <code className="font-mono text-xs">management_keys:read</code>. Ask an admin for access.
          </AlertDescription>
        </Alert>
      ) : !canWrite ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Read-only access. Creating or revoking keys needs{" "}
            <code className="font-mono text-xs">management_keys:write</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {createdKey ? (
        <OneTimeSecret
          className="mb-0"
          label="Management key created. Copy it now; it is shown only once."
          secret={createdKey}
          copied={copied}
          onCopy={() => void copyKey(createdKey)}
          onDismiss={() => setCreatedKey(null)}
        />
      ) : null}

      {showCreate && canWrite ? (
        <Panel>
          <PanelHeader
            title={editingId ? "Edit management key" : "New management key"}
            description="Grant only the scopes the integration needs. Each scope is independent."
          />
          <form className="flex flex-col" onSubmit={onSubmit}>
            <div className="flex flex-col gap-5 px-5 py-5">
              <div className="flex max-w-md flex-col gap-1.5">
                <Label htmlFor="mgmt-name">Name</Label>
                <Input
                  id="mgmt-name"
                  type="text"
                  placeholder="Billing sync service"
                  value={name}
                  required
                  disabled={saving}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
                {lockedScopes.length > 0 ? (
                  <fieldset className="flex flex-col gap-2.5 border-t border-dashed border-border pt-3 sm:col-span-2 xl:col-span-3">
                    <legend className="sr-only">Locked scopes</legend>
                    <div className="legend text-muted-foreground">Locked scopes</div>
                    <p className="text-xs text-muted-foreground">
                      Granted on this key but outside what your role can change. Kept as-is on save.
                    </p>
                    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                      {lockedScopes.map((sc) => {
                        const def = SCOPE_BY_VALUE.get(sc);
                        return (
                          <label
                            key={sc}
                            className="flex cursor-not-allowed items-start gap-2.5 text-sm opacity-70"
                            title="Cannot be modified by your role"
                          >
                            <Checkbox checked disabled className="mt-0.5" />
                            <span className="flex flex-col gap-0.5">
                              <span className="font-medium leading-tight">{def?.description ?? sc}</span>
                              <code className="font-mono text-[11px] text-muted-foreground">{sc}</code>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                ) : null}
                {Object.entries(ALL_SCOPES_BY_GROUP).map(([group, items]) => {
                  const grantable = items.filter((sc) => grantableScopeValues.has(sc.value));
                  if (grantable.length === 0) return null;
                  const on = grantable.filter((sc) => selected.has(sc.value)).length;
                  return (
                    <fieldset key={group} className="flex flex-col gap-2.5 border-t border-rule pt-3">
                      <legend className="sr-only">{group}</legend>
                      <div className="flex items-center justify-between">
                        <span className="legend text-muted-foreground">{group}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{on}/{grantable.length}</span>
                      </div>
                      {grantable.map((sc) => (
                        <label key={sc.value} className="flex cursor-pointer items-start gap-2.5 text-sm" title={sc.description}>
                          <Checkbox
                            checked={selected.has(sc.value)}
                            onCheckedChange={() => toggleScope(sc.value)}
                            className="mt-0.5"
                          />
                          <span className="flex flex-col gap-0.5">
                            <span className="font-medium leading-tight">{sc.description}</span>
                            <code className="font-mono text-[11px] text-muted-foreground">{sc.value}</code>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-rule px-5 py-4">
              <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Create key"}
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {!canRead ? null : loading ? (
        <div className="skeleton h-32 rounded-xl" aria-hidden />
      ) : keys.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<KeyRound />}
            title="No management keys yet"
            description="Create one so a backend service can read organization data or call /v1 on your behalf."
            action={
              canWrite && !showCreate ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus />
                  New key
                </Button>
              ) : null
            }
          />
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Scopes</TableHead>
                <TableHead className="hidden sm:table-cell">Last used</TableHead>
                <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k._id} className={cn(k.status !== "active" && "text-muted-foreground")}>
                  <TableCell>
                    <div className="font-medium text-foreground">{k.name}</div>
                    <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={k.status === "active" ? "success" : "destructive"} className="capitalize">
                      {k.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-normal md:table-cell">
                    {k.scopes.length === 0 ? (
                      <span className="text-[13px] text-muted-foreground">No scopes</span>
                    ) : (
                      <div className="flex max-w-[30rem] flex-wrap gap-1">
                        {k.scopes.map((sc) => (
                          <span key={sc} className="rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                            {sc}
                          </span>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {k.lastUsedAt ? formatRelative(k.lastUsedAt) : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {k.status === "active" && canWrite ? (
                      <div className="flex justify-end sm:hidden">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${k.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem disabled={saving} onClick={() => openEdit(k)}>Edit</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={revokingId === k._id}
                              onClick={() => void onRevoke(k._id)}
                              className="text-destructive focus:text-destructive"
                            >
                              Revoke…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ) : null}
                    {k.status === "active" && canWrite ? (
                      <div className="hidden justify-end gap-1 sm:flex">
                        <Button variant="outline" size="sm" disabled={saving} onClick={() => openEdit(k)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost-destructive"
                          size="sm"
                          disabled={revokingId === k._id}
                          onClick={() => void onRevoke(k._id)}
                        >
                          {revokingId === k._id ? "Revoking…" : "Revoke"}
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </div>
  );
}
