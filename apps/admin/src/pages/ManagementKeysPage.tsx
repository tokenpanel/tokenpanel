import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getJson, patchJson, postJson, deleteJson } from "../api/client.ts";
import type {
  ManagementKey,
  ManagementKeyCreateResponse,
  ManagementKeyListResponse,
  ManagementScopeMeta,
  ManagementScopeMetaListResponse,
} from "../api/management-keys.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { formatRelative } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { KeyRound, Copy, Check, Plus, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn } from "@/components/anim";
import {
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
} from "@tokenpanel/contracts";

const ALL_SCOPES = MANAGEMENT_SCOPES;

type ScopeToggle = { scope: string; label: string; group: string; description: string };

/** Offline fallback when the scopes meta endpoint is unavailable. */
const SCOPE_META_FALLBACK: ScopeToggle[] = MANAGEMENT_SCOPES_META.map((m) => ({
  scope: m.scope,
  label: m.description,
  group: m.group,
  description: m.description,
}));

function scopeToggles(meta: ManagementScopeMeta[] | null): ScopeToggle[] {
  if (!meta || meta.length === 0) return SCOPE_META_FALLBACK;
  return ALL_SCOPES.map((scope) => {
    const m = meta.find((x) => x.scope === scope);
    return {
      scope,
      label: m?.description ?? scope,
      group: m?.group ?? "Other",
      description: m?.description ?? "",
    };
  });
}

function groupBy<T, K extends string>(items: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

export default function ManagementKeysPage(): React.ReactElement {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const activeOrgId = user?.activeOrganizationId;

  const [keys, setKeys] = useState<ManagementKey[]>([]);
  const [scopes, setScopes] = useState<ManagementScopeMeta[] | null>(null);
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
      setLoading(true);
      setError(null);
      try {
        const [keyRes, scopeRes] = await Promise.all([
          getJson<ManagementKeyListResponse>("/admin/management-keys"),
          getJson<ManagementScopeMetaListResponse>("/admin/management-keys/__scopes/meta").catch(() => null),
        ]);
        if (cancelled) return;
        setKeys(keyRes.items);
        setScopes(scopeRes?.items ?? null);
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
  }, [activeOrgId]);

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
    const scopesArr = Array.from(selected).sort();
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

  const grouped = useMemo(() => groupBy(scopeToggles(scopes), (s) => s.group), [scopes]);

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader
        title="Management Keys"
        description="Server-to-server API keys with fine-grained scopes for backend integrations."
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {createdKey ? (
        <Alert variant="info">
          <div className="flex flex-col gap-2.5">
            <div className="text-sm font-semibold">
              Management key created. Copy it now — shown only once.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all">
                {createdKey}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copyKey(createdKey)}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Management keys use the <code className="font-mono text-xs">tp_mgmt_</code> prefix and are
          separate from customer API keys (<code className="font-mono text-xs">tp_live_</code>).
        </p>
        {isAdmin && !showCreate ? (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            Create Key
          </Button>
        ) : null}
      </div>

      {showCreate && isAdmin ? (
        <FadeIn>
          <Card className="p-5">
            <form className="flex flex-col gap-4" onSubmit={onSubmit}>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">
                  {editingId ? "Edit management key" : "Create management key"}
                </h2>
                <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mgmt-name">Name</Label>
                <Input
                  id="mgmt-name"
                  type="text"
                  placeholder="e.g. Billing sync service"
                  value={name}
                  required
                  disabled={saving}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Scopes</Label>
                <p className="text-xs text-muted-foreground">
                  Each scope is independent — grant only what the integration needs.
                </p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(grouped).map(([group, items]) => (
                    <div key={group} className="flex flex-col gap-2 rounded-md border border-border p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group}
                      </div>
                      {items.map((s) => (
                        <label
                          key={s.scope}
                          className="flex cursor-pointer items-start gap-2 text-sm"
                          title={s.description}
                        >
                          <Checkbox
                            checked={selected.has(s.scope)}
                            onCheckedChange={() => toggleScope(s.scope)}
                            className="mt-0.5"
                          />
                          <span className="flex flex-col">
                            <span className="font-medium leading-tight">{s.label}</span>
                            <code className="font-mono text-[10px] text-muted-foreground">{s.scope}</code>
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <Button type="submit" disabled={saving || !name.trim()}>
                  {saving
                    ? "Saving…"
                    : editingId
                      ? "Save changes"
                      : "Create key"}
                </Button>
              </div>
            </form>
          </Card>
        </FadeIn>
      ) : null}

      {!isAdmin ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Only org admins can create or modify management keys. Contact an admin if you need a key
            for an integration.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? null : keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-5" />}
          title="No management keys yet"
          description="Create one to enable backend services to read org data and call /v1 on your behalf."
        />
      ) : (
        <FadeIn>
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k._id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{k.prefix}…</code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={k.status === "active" ? "success" : "destructive"}>
                        {k.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {k.scopes.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No scopes</span>
                      ) : (
                        <div className="flex max-w-[420px] flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <span
                              key={s}
                              className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(k.lastUsedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {k.status === "active" && isAdmin ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={saving}
                              onClick={() => openEdit(k)}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={revokingId === k._id}
                              onClick={() => void onRevoke(k._id)}
                            >
                              {revokingId === k._id ? "Revoking…" : "Revoke"}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}
