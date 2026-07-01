import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plug, RefreshCw, Plus, Pencil, Search, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn } from "@/components/anim";

interface Provider {
  _id: string;
  organizationId: string;
  name: string;
  sdkType: string;
  baseUrl: string;
  providerOrg?: string;
  headers: Record<string, string>;
  active: boolean;
  metadata: Record<string, unknown>;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProvidersResponse {
  items: Provider[];
}

interface AdaptersResponse {
  items: string[];
}

interface ModelCatalog {
  _id: string;
  upstreamModelId: string;
  displayName: string;
  modalities: { input: string[]; output: string[] };
  limits: { context: number; input?: number; output?: number };
  status?: string;
}

interface CatalogResponse {
  items: ModelCatalog[];
}

interface DiscoveredModel {
  upstreamModelId: string;
  displayName: string;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  limits: { context: number; input?: number; output?: number };
  modalities: { input: string[]; output: string[] };
  status?: string;
  cost?: unknown;
}

interface DiscoverResponse {
  items: DiscoveredModel[];
}

interface FormState {
  name: string;
  sdkType: string;
  apiKey: string;
  baseUrl: string;
  providerOrg: string;
  headers: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  sdkType: "",
  apiKey: "",
  baseUrl: "",
  providerOrg: "",
  headers: "",
};

export function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function fromProvider(p: Provider): FormState {
  const headers = Object.keys(p.headers).length > 0 ? JSON.stringify(p.headers, null, 2) : "";
  return {
    name: p.name,
    sdkType: p.sdkType,
    apiKey: "",
    baseUrl: p.baseUrl,
    providerOrg: p.providerOrg ?? "",
    headers,
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default function ProvidersPage(): React.ReactElement {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<string[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [discoverFor, setDiscoverFor] = useState<Provider | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ModelCatalog[]>>({});
  const [catalogLoadingFor, setCatalogLoadingFor] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getJson<ProvidersResponse>("/admin/providers");
      setProviders(res.items);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load providers.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAdapters = useCallback(async () => {
    try {
      const res = await getJson<AdaptersResponse>("/admin/providers/adapters");
      setAdapters(res.items);
    } catch {
      /* adapters best-effort */
    }
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadAdapters();
  }, [loadProviders, loadAdapters]);

  function updateField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, sdkType: adapters[0] ?? "" });
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(p: Provider) {
    setEditing(p);
    setForm(fromProvider(p));
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function onToggleActive(p: Provider) {
    const next = !p.active;
    try {
      const updated = await patchJson<Provider>(`/admin/providers/${p._id}`, { active: next });
      setProviders((prev) => prev.map((x) => (x._id === updated._id ? updated : x)));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to toggle provider.");
    }
  }

  async function loadCatalog(p: Provider) {
    setCatalogLoadingFor(p._id);
    try {
      const res = await getJson<CatalogResponse>(`/admin/providers/${p._id}/models`);
      setCatalogByProvider((prev) => ({ ...prev, [p._id]: res.items }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load cached models.");
    } finally {
      setCatalogLoadingFor(null);
    }
  }

  async function onDiscover(p: Provider) {
    setDiscoverFor(p);
    setDiscovering(true);
    try {
      const res = await postJson<DiscoverResponse>(`/admin/providers/${p._id}/discover-models`);
      toast.success(`Discovered ${res.items.length} model${res.items.length === 1 ? "" : "s"}.`);
      void loadCatalog(p);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Discovery failed.");
    } finally {
      setDiscovering(false);
    }
  }

  async function onDelete(p: Provider) {
    setDeleteError(null);
    try {
      await deleteJson<{ ok: boolean }>(`/admin/providers/${p._id}`);
      setProviders((prev) => prev.filter((x) => x._id !== p._id));
      setCatalogByProvider((prev) => {
        const copy = { ...prev };
        delete copy[p._id];
        return copy;
      });
      setDeleting(null);
      toast.success("Provider deleted.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDeleteError("Provider is in use by one or more models. Remove those models first.");
      } else {
        setDeleteError(err instanceof ApiError ? err.message : "Failed to delete provider.");
      }
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const sdkType = form.sdkType.trim();

    if (!name) {
      setFormError("Name is required.");
      return;
    }
    if (!sdkType) {
      setFormError("Adapter type is required.");
      return;
    }
    if (!baseUrl || !isUrl(baseUrl)) {
      setFormError("Base URL must be a valid http(s) URL.");
      return;
    }
    if (!editing && !form.apiKey) {
      setFormError("API key is required when creating a provider.");
      return;
    }

    let parsedHeaders: Record<string, string> | null = {};
    const headersRaw = form.headers.trim();
    if (headersRaw) {
      try {
        const parsed = JSON.parse(headersRaw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setFormError("Headers must be a JSON object of string key/value pairs.");
          return;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== "string") {
            setFormError(`Header "${k}" must be a string.`);
            return;
          }
          out[k] = v;
        }
        parsedHeaders = out;
      } catch {
        setFormError("Headers must be valid JSON.");
        return;
      }
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        sdkType,
        baseUrl,
        providerOrg: form.providerOrg.trim() || undefined,
        headers: parsedHeaders,
      };
      if (form.apiKey) body.apiKey = form.apiKey;

      if (editing) {
        const updated = await patchJson<Provider>(`/admin/providers/${editing._id}`, body);
        setProviders((prev) => prev.map((x) => (x._id === updated._id ? updated : x)));
        toast.success("Provider updated.");
      } else {
        const created = await postJson<Provider>("/admin/providers", body);
        setProviders((prev) => [...prev, created]);
        toast.success("Provider created.");
      }
      closeModal();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) => a.name.localeCompare(b.name));
  }, [providers]);

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Providers" description="Manage AI service providers and discover available models.">
        <Button variant="outline" size="sm" onClick={() => void loadProviders()} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          Refresh
        </Button>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          Add Provider
        </Button>
      </PageHeader>

      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden p-0">
        {loading && providers.length === 0 ? null : providers.length === 0 ? (
          <EmptyState
            icon={<Plug className="size-5" />}
            title="No providers yet"
            description="Add your first AI service provider to start discovering and configuring models."
            action={<Button size="sm" onClick={openCreate}><Plus className="size-4" />Add Provider</Button>}
          />
        ) : (
          <FadeIn>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Adapter</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>API Key</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProviders.map((p) => (
                  <ProviderRow
                    key={p._id}
                    provider={p}
                    discovering={discovering && discoverFor?._id === p._id}
                    catalog={catalogByProvider[p._id]}
                    catalogLoading={catalogLoadingFor === p._id}
                    onEdit={() => openEdit(p)}
                    onDiscover={() => void onDiscover(p)}
                    onDelete={() => {
                      setDeleteError(null);
                      setDeleting(p);
                    }}
                    onToggle={() => void onToggleActive(p)}
                    onLoadCatalog={() => void loadCatalog(p)}
                  />
                ))}
              </TableBody>
            </Table>
          </FadeIn>
        )}
      </Card>

      <Dialog open={modalOpen} onOpenChange={(o) => (o ? null : closeModal())}>
        <DialogContent className="max-w-[540px] gap-0 p-0">
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle>{editing ? "Edit Provider" : "Add Provider"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit}>
            <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-5">
              {formError ? (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}
              <Field id="prov-name" label="Name">
                <Input
                  id="prov-name"
                  type="text"
                  value={form.name}
                  required
                  disabled={saving}
                  onChange={(e) => updateField("name", e.target.value)}
                  placeholder="e.g. OpenAI production"
                />
              </Field>
              <Field id="prov-sdk" label="Adapter type">
                {adapters.length > 0 ? (
                  <Select value={form.sdkType} onValueChange={(v) => updateField("sdkType", v)} disabled={saving}>
                    <SelectTrigger id="prov-sdk">
                      <SelectValue placeholder="Select adapter" />
                    </SelectTrigger>
                    <SelectContent>
                      {adapters.map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="prov-sdk"
                    type="text"
                    value={form.sdkType}
                    disabled={saving}
                    onChange={(e) => updateField("sdkType", e.target.value)}
                    placeholder="openai-compatible"
                  />
                )}
              </Field>
              <Field id="prov-url" label="Base URL">
                <Input
                  id="prov-url"
                  type="url"
                  value={form.baseUrl}
                  required
                  disabled={saving}
                  onChange={(e) => updateField("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </Field>
              <Field id="prov-key" label="API key" hint={editing ? "Stored encrypted. Leave blank to keep current key." : undefined}>
                <Input
                  id="prov-key"
                  type="password"
                  value={form.apiKey}
                  disabled={saving}
                  onChange={(e) => updateField("apiKey", e.target.value)}
                  autoComplete="off"
                  placeholder={editing ? "Leave blank to keep current key" : "sk-…"}
                />
              </Field>
              <Field id="prov-org" label="Provider org (optional)">
                <Input
                  id="prov-org"
                  type="text"
                  value={form.providerOrg}
                  disabled={saving}
                  onChange={(e) => updateField("providerOrg", e.target.value)}
                  placeholder="organization slug"
                />
              </Field>
              <Field id="prov-headers" label="Custom headers (optional JSON)" hint="JSON object of string→string. Sent with every upstream request.">
                <Textarea
                  id="prov-headers"
                  rows={4}
                  value={form.headers}
                  disabled={saving}
                  onChange={(e) => updateField("headers", e.target.value)}
                  placeholder={`{"X-Custom-Header": "value"}`}
                />
              </Field>
            </div>
            <DialogFooter className="border-t border-border bg-muted/30 p-4">
              <Button type="button" variant="outline" onClick={closeModal} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving…
                  </>
                ) : editing ? (
                  "Save changes"
                ) : (
                  "Create provider"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => (o ? null : (setDeleting(null), setDeleteError(null)))}>
        <DialogContent className="max-w-[420px] gap-0 p-0">
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle>Delete provider</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-5">
            {deleteError ? (
              <Alert variant="destructive">
                <AlertDescription>{deleteError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="text-sm">
              Delete <strong>{deleting?.name}</strong>?
            </div>
            <div className="text-sm text-muted-foreground">
              This removes the provider configuration. Cached models are unaffected until re-discovery.
            </div>
          </div>
          <DialogFooter className="border-t border-border bg-muted/30 p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeleting(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleting && void onDelete(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProviderRowProps {
  provider: Provider;
  discovering: boolean;
  catalog: ModelCatalog[] | undefined;
  catalogLoading: boolean;
  onEdit: () => void;
  onDiscover: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onLoadCatalog: () => void;
}

function ProviderRow({
  provider,
  discovering,
  catalog,
  catalogLoading,
  onEdit,
  onDiscover,
  onDelete,
  onToggle,
  onLoadCatalog,
}: ProviderRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expanded && !catalog && !catalogLoading) {
      onLoadCatalog();
    }
  }, [expanded, catalog, catalogLoading, onLoadCatalog]);

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{provider.name}</TableCell>
        <TableCell>
          <Badge variant="secondary">{provider.sdkType}</Badge>
        </TableCell>
        <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={provider.baseUrl}>
          {provider.baseUrl}
        </TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={
                provider.hasApiKey
                  ? "size-1.5 rounded-full bg-success"
                  : "size-1.5 rounded-full bg-muted-foreground"
              }
            />
            {provider.hasApiKey ? "Set" : "Not set"}
          </span>
        </TableCell>
        <TableCell>
          <Switch checked={provider.active} onCheckedChange={onToggle} aria-label="Toggle provider active" />
        </TableCell>
        <TableCell className="text-right">
          <div className="inline-flex gap-1">
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit">
              <Pencil className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={onDiscover} disabled={discovering}>
              {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
              {discovering ? "…" : "Discover"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {expanded ? "Hide" : "Models"}
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={onDelete} aria-label="Delete">
              <Trash2 className="size-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={6} className="p-0">
            <ModelsPanel loading={catalogLoading} items={catalog} onRefresh={onDiscover} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

interface ModelsPanelProps {
  loading: boolean;
  items: ModelCatalog[] | undefined;
  onRefresh: () => void;
}

function ModelsPanel({ loading, items, onRefresh }: ModelsPanelProps): React.ReactElement {
  return (
    <div className="flex flex-col border-t border-border bg-muted/20">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-medium">
        <span>Cached Models</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          {loading ? "Loading…" : items && items.length > 0 ? `${items.length} cached` : "None cached"}
          <Button variant="ghost" size="sm" onClick={onRefresh}>Re-discover</Button>
        </span>
      </div>
      {!loading && (!items || items.length === 0) ? (
        <div className="px-6 py-10 text-center text-sm text-muted-foreground">
          No models cached. Click Discover to fetch from upstream.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model ID</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead>Modalities</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items ?? []).map((m) => (
              <TableRow key={m._id}>
                <TableCell className="font-mono text-xs">{m.upstreamModelId}</TableCell>
                <TableCell className="font-medium">{m.displayName}</TableCell>
                <TableCell>
                  <div className="inline-flex flex-wrap gap-1">
                    {[...m.modalities.input, ...m.modalities.output].map((mo) => (
                      <span key={mo} className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {mo}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {m.limits.context.toLocaleString()}
                </TableCell>
                <TableCell>
                  {m.status ? <Badge variant="secondary">{m.status}</Badge> : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}