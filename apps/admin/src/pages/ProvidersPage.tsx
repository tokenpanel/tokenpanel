import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Plug,
  RefreshCw,
  Plus,
  Pencil,
  MoreHorizontal,
  Search,
  Trash2,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/Instrument";
import {
  PROVIDER_PRESET_CATEGORY_LABELS,
  PROVIDER_PRESET_CATEGORY_ORDER,
  PROVIDER_PRESETS,
  applyProviderPreset,
  getDefaultProviderPresetId,
  getProviderPreset,
} from "../config/provider-presets.ts";

interface Provider {
  _id: string;
  organizationId: string;
  name: string;
  sdkType: string;
  baseUrl: string;
  providerOrg?: string;
  /**
   * Header *names* only — values are redacted server-side
   * (`Record<headerName, true>`). Values are write-only.
   */
  headers: Record<string, true>;
  /**
   * Optional HTTP timeout override (ms). null/absent → process global
   * PROVIDER_HTTP_TIMEOUT_MS. 0 → no app-level timeout for this provider.
   */
  httpTimeoutMs?: number | null;
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
  limits: { context?: number; input?: number; output?: number };
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
  limits: { context?: number; input?: number; output?: number };
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
  /** Empty = inherit global; "0" = disable; positive decimal ms string. */
  httpTimeoutMs: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  sdkType: "",
  apiKey: "",
  baseUrl: "",
  providerOrg: "",
  headers: "",
  httpTimeoutMs: "",
};

export function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Populate edit form from a masked provider.
 *
 * Headers are names-only in the API response. Update replaces headers
 * wholesale, so we leave the field empty on edit — only send headers when
 * the user explicitly enters a new JSON object (same pattern as apiKey).
 */
export function fromProvider(p: Provider): FormState {
  return {
    name: p.name,
    sdkType: p.sdkType,
    apiKey: "",
    baseUrl: p.baseUrl,
    providerOrg: p.providerOrg ?? "",
    headers: "",
    httpTimeoutMs:
      p.httpTimeoutMs !== undefined && p.httpTimeoutMs !== null
        ? String(p.httpTimeoutMs)
        : "",
  };
}

/**
 * Parse optional HTTP timeout field.
 * empty → inherit (undefined on create, null on edit clear)
 * "0" / positive int ≤ 3600000 → number
 */
export function parseHttpTimeoutMsInput(
  raw: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: "HTTP timeout must be a non-negative integer (milliseconds).",
    };
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 0 || n > 3_600_000) {
    return {
      ok: false,
      error: "HTTP timeout must be between 0 and 3600000 ms (1 hour).",
    };
  }
  return { ok: true, value: n };
}


export default function ProvidersPage(): React.ReactElement {
  const { user } = useAuth();
  // Mutations (create/edit/toggle/discover/delete) require providers:write.
  // providers:read can list + view cached models only.
  const canWrite = hasPermission(user, "providers:write");

  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<string[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [presetId, setPresetId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [discoverFor, setDiscoverFor] = useState<Provider | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ModelCatalog[]>>({});
  const [catalogLoadingFor, setCatalogLoadingFor] = useState<string | null>(null);
  const [catalogErrorByProvider, setCatalogErrorByProvider] = useState<Record<string, string>>({});

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

  const visiblePresets = useMemo(() => {
    if (adapters.length === 0) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((preset) =>
      adapters.includes(preset.sdkType),
    );
  }, [adapters]);

  const presetGroups = useMemo(() => {
    return PROVIDER_PRESET_CATEGORY_ORDER.map((category) => ({
      category,
      label: PROVIDER_PRESET_CATEGORY_LABELS[category],
      items: visiblePresets.filter((preset) => preset.category === category),
    })).filter((group) => group.items.length > 0);
  }, [visiblePresets]);

  const selectedPreset = useMemo(() => getProviderPreset(presetId), [presetId]);

  useEffect(() => {
    if (!modalOpen || editing) return;
    if (visiblePresets.length === 0) return;
    if (presetId && visiblePresets.some((preset) => preset.id === presetId)) {
      return;
    }
    const defaultId = getDefaultProviderPresetId(visiblePresets);
    setPresetId(defaultId);
    setForm((prev) => applyProviderPreset(getProviderPreset(defaultId), prev));
  }, [modalOpen, editing, visiblePresets, presetId]);

  function updateField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onPresetChange(id: string) {
    setPresetId(id);
    setForm((prev) => applyProviderPreset(getProviderPreset(id), prev));
    setFormError(null);
  }

  function openCreate() {
    if (!canWrite) return;
    const defaultId = getDefaultProviderPresetId(visiblePresets);
    const preset = getProviderPreset(defaultId);
    setEditing(null);
    setPresetId(defaultId);
    setForm(
      applyProviderPreset(preset, {
        ...EMPTY_FORM,
        sdkType: adapters[0] ?? "",
      }),
    );
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(p: Provider) {
    if (!canWrite) return;
    setEditing(p);
    setPresetId("");
    setForm(fromProvider(p));
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setEditing(null);
    setPresetId("");
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function onToggleActive(p: Provider) {
    if (!canWrite) return;
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
    setCatalogErrorByProvider((prev) => {
      const copy = { ...prev };
      delete copy[p._id];
      return copy;
    });
    try {
      const res = await getJson<CatalogResponse>(`/admin/providers/${p._id}/models`);
      setCatalogByProvider((prev) => ({ ...prev, [p._id]: res.items }));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to load cached models.";
      setCatalogErrorByProvider((prev) => ({ ...prev, [p._id]: msg }));
      toast.error(msg);
    } finally {
      setCatalogLoadingFor(null);
    }
  }

  async function onDiscover(p: Provider) {
    if (!canWrite) return;
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
    if (!canWrite) return;
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
    if (!canWrite) return;
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

    const timeoutParsed = parseHttpTimeoutMsInput(form.httpTimeoutMs);
    if (!timeoutParsed.ok) {
      setFormError(timeoutParsed.error);
      return;
    }

    // Omit headers on edit when field left blank so we don't wipe stored secrets.
    // Create always sends headers (default {}).
    let parsedHeaders: Record<string, string> | undefined;
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
    } else if (!editing) {
      parsedHeaders = {};
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        sdkType,
        baseUrl,
        providerOrg: form.providerOrg.trim() || undefined,
      };
      if (parsedHeaders !== undefined) body.headers = parsedHeaders;
      if (form.apiKey) body.apiKey = form.apiKey;
      // Create: omit when empty (inherit). Edit: null clears override to inherit.
      if (editing) {
        body.httpTimeoutMs =
          timeoutParsed.value !== undefined ? timeoutParsed.value : null;
      } else if (timeoutParsed.value !== undefined) {
        body.httpTimeoutMs = timeoutParsed.value;
      }

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
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Providers"
        description="Upstream AI connections. Keys are stored encrypted and never shown to customers."
      >
        <Button variant="outline" onClick={() => void loadProviders()} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
        {canWrite ? (
          <Button onClick={openCreate}>
            <Plus />
            Add provider
          </Button>
        ) : null}
      </PageHeader>

      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {!canWrite ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Read-only access. Creating, editing, toggling, discovering, or deleting providers needs{" "}
            <code className="font-mono text-xs">providers:write</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      <Panel className="overflow-hidden">
        {loading && providers.length === 0 ? <div className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</div> : providers.length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title="No providers yet"
            description={
              canWrite
                ? "Connect an OpenAI- or Anthropic-compatible upstream, then discover its models and publish them as aliases."
                : "No providers configured yet. Someone with providers:write can add them."
            }
            action={
              canWrite ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus />
                  Add provider
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="hidden md:table-cell">Adapter</TableHead>
                  <TableHead className="hidden sm:table-cell">Key</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProviders.map((p) => (
                  <ProviderRow
                    key={p._id}
                    provider={p}
                    canWrite={canWrite}
                    discovering={discovering && discoverFor?._id === p._id}
                    catalog={catalogByProvider[p._id]}
                    catalogLoading={catalogLoadingFor === p._id}
                    catalogError={catalogErrorByProvider[p._id]}
                    onEdit={() => openEdit(p)}
                    onDiscover={() => void onDiscover(p)}
                    onDelete={() => {
                      if (!canWrite) return;
                      setDeleteError(null);
                      setDeleting(p);
                    }}
                    onToggle={() => void onToggleActive(p)}
                    onLoadCatalog={() => void loadCatalog(p)}
                  />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Panel>

      <Dialog open={canWrite && modalOpen} onOpenChange={(o) => (o ? null : closeModal())}>
        <DialogContent className="max-w-[540px] gap-0 p-0 sm:p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>{editing ? `Edit ${editing.name}` : "Add provider"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit}>
            <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-5">
              {formError ? (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}
              {!editing && visiblePresets.length > 0 ? (
                <Field id="prov-preset" label="Provider preset" hint={selectedPreset?.hint}>
                  <Select value={presetId} onValueChange={onPresetChange} disabled={saving}>
                    <SelectTrigger id="prov-preset">
                      <SelectValue placeholder="Select a provider preset" />
                    </SelectTrigger>
                    <SelectContent>
                      {presetGroups.map((group) => (
                        <SelectGroup key={group.category}>
                          <SelectLabel>{group.label}</SelectLabel>
                          {group.items.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {preset.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
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
              <Field id="prov-sdk" label="Adapter type" tooltip="The integration driver for this provider (e.g. 'openai', 'anthropic'). Determines request/response format.">
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
                  placeholder={editing ? "Leave blank to keep current key" : (selectedPreset?.apiKeyPlaceholder ?? "API key")}
                />
              </Field>
              <Field id="prov-org" label="Provider organization" optional tooltip="Some providers (e.g. OpenAI) support organization-level scoping. Leave blank if not applicable.">
                <Input
                  id="prov-org"
                  type="text"
                  value={form.providerOrg}
                  disabled={saving}
                  onChange={(e) => updateField("providerOrg", e.target.value)}
                  placeholder="organization slug"
                />
              </Field>
              <Field
                id="prov-timeout"
                label="HTTP timeout (ms)" optional
                hint="Leave empty to use the process default (PROVIDER_HTTP_TIMEOUT_MS, usually 120000). 0 disables the app-level timeout for this provider. Non-streaming: full request. Streaming: time-to-first-byte only."
              >
                <Input
                  id="prov-timeout"
                  type="text"
                  inputMode="numeric"
                  value={form.httpTimeoutMs}
                  disabled={saving}
                  onChange={(e) => updateField("httpTimeoutMs", e.target.value)}
                  placeholder="e.g. 120000 (inherit if blank)"
                />
              </Field>
              <Field
                id="prov-headers"
                label="Custom headers (JSON)" optional
                hint={
                  editing
                    ? (() => {
                        const names = Object.keys(editing.headers ?? {}).sort();
                        const existing =
                          names.length > 0
                            ? ` Configured: ${names.join(", ")}.`
                            : " None configured.";
                        return `JSON object of string→string. Leave blank to keep existing headers.${existing} Sending a new object replaces the whole map.`;
                      })()
                    : "JSON object of string→string. Sent with every upstream request."
                }
              >
                <Textarea
                  id="prov-headers"
                  rows={4}
                  className="font-mono text-[13px]"
                  value={form.headers}
                  disabled={saving}
                  onChange={(e) => updateField("headers", e.target.value)}
                  placeholder={
                    editing
                      ? "Leave blank to keep existing headers"
                      : `{"X-Custom-Header": "value"}`
                  }
                />
              </Field>
            </div>
            <DialogFooter className="border-t border-border bg-background px-5 py-3.5">
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

      <Dialog
        open={canWrite && deleting !== null}
        onOpenChange={(o) => (o ? null : (setDeleting(null), setDeleteError(null)))}
      >
        <DialogContent className="max-w-[420px] gap-0 p-0 sm:p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>Delete provider?</DialogTitle>
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
          <DialogFooter className="border-t border-border bg-background px-5 py-3.5">
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
              Delete provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProviderRowProps {
  provider: Provider;
  canWrite: boolean;
  discovering: boolean;
  catalog: ModelCatalog[] | undefined;
  catalogLoading: boolean;
  catalogError: string | undefined;
  onEdit: () => void;
  onDiscover: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onLoadCatalog: () => void;
}

function ProviderRow({
  provider,
  canWrite,
  discovering,
  catalog,
  catalogLoading,
  catalogError,
  onEdit,
  onDiscover,
  onDelete,
  onToggle,
  onLoadCatalog,
}: ProviderRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expanded && catalog === undefined && !catalogLoading && !catalogError) {
      onLoadCatalog();
    }
  }, [expanded, catalog, catalogLoading, catalogError, onLoadCatalog]);

  return (
    <>
      <TableRow className={cn(!provider.active && "text-muted-foreground")}>
        <TableCell className="max-w-[22rem]">
          <div className="truncate font-medium text-foreground">{provider.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={provider.baseUrl}>
            {provider.baseUrl}
          </div>
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <Badge variant="secondary" className="font-mono text-[11px]">{provider.sdkType}</Badge>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <Badge variant={provider.hasApiKey ? "success" : "off"}>{provider.hasApiKey ? "Stored" : "Missing"}</Badge>
        </TableCell>
        <TableCell>
          {canWrite ? (
            <Switch
              checked={provider.active}
              onCheckedChange={onToggle}
              aria-label={`${provider.active ? "Disable" : "Enable"} ${provider.name}`}
            />
          ) : (
            <Badge variant={provider.active ? "success" : "off"}>
              {provider.active ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right">
          <div className="inline-flex items-center gap-1 sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${provider.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setExpanded((v) => !v)}>
                  {expanded ? <ChevronUp /> : <ChevronDown />}
                  {expanded ? "Hide models" : "Show models"}
                </DropdownMenuItem>
                {canWrite ? (
                  <>
                    <DropdownMenuItem disabled={discovering} onClick={onDiscover}>
                      <Search />
                      Discover models
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onEdit}>
                      <Pencil />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                      <Trash2 />
                      Delete…
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="hidden items-center gap-1 sm:inline-flex">
            <Button variant="outline" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? <ChevronUp /> : <ChevronDown />}
              Models
            </Button>
            {canWrite ? (
              <>
                <Button variant="ghost" size="sm" onClick={onDiscover} disabled={discovering} aria-label={`Discover from ${provider.name}`}>
                  {discovering ? <Loader2 className="animate-spin" /> : <Search />}
                  <span className="hidden lg:inline">{discovering ? "Discovering…" : "Discover"}</span>
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${provider.name}`}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost-destructive"
                  size="icon-sm"
                  onClick={onDelete}
                  aria-label={`Delete ${provider.name}`}
                >
                  <Trash2 />
                </Button>
              </>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={5} className="p-0 first:pl-0 last:pr-0">
            <ModelsPanel
              loading={catalogLoading}
              items={catalog}
              error={catalogError}
              canWrite={canWrite}
              onRefresh={onDiscover}
              onRetry={onLoadCatalog}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

interface ModelsPanelProps {
  loading: boolean;
  items: ModelCatalog[] | undefined;
  error: string | undefined;
  canWrite: boolean;
  onRefresh: () => void;
  onRetry: () => void;
}

function ModelsPanel({
  loading,
  items,
  error,
  canWrite,
  onRefresh,
  onRetry,
}: ModelsPanelProps): React.ReactElement {
  return (
    <div className="flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-rule px-5 py-2.5 text-sm font-medium">
        <span>Discovered upstream models</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          {loading ? "Loading…" : items && items.length > 0 ? `${items.length} cached` : "None cached"}
          {canWrite ? (
            <Button variant="ghost" size="sm" onClick={onRefresh}>
              Re-discover
            </Button>
          ) : null}
        </span>
      </div>
      {!loading && error ? (
        <div className="px-6 py-10 text-center text-sm text-destructive">
          <p>{error}</p>
          {canWrite ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : !loading && (!items || items.length === 0) ? (
        <div className="px-6 py-8 text-center text-sm text-muted-foreground">
          {canWrite
            ? "Nothing discovered yet. Use Discover to fetch this provider's model list."
            : "No models cached for this provider."}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Upstream ID</TableHead>
              <TableHead>Display name</TableHead>
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
                      <span key={mo} className="rounded-[4px] bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
                        {mo}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {m.limits.context !== undefined ? m.limits.context.toLocaleString() : "—"}
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