import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  ApiError,
  deleteJson,
  getJson,
  patchJson,
  postJson,
} from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Boxes, Plus, ArrowLeft, Trash2, GripVertical, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn } from "@/components/anim";
import { FetchModelDialog } from "@/components/FetchModelDialog";
import type { FetchedModel } from "../api/catalog.ts";
import { cn } from "@/lib/utils";

const MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];

const STATUSES = ["alpha", "beta", "deprecated", "ga"] as const;
type Status = (typeof STATUSES)[number];

interface TokenPriceSchedule {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
  reasoningMinorPerMillion?: number;
  cacheReadMinorPerMillion?: number;
  cacheWriteMinorPerMillion?: number;
  inputAudioMinorPerMillion?: number;
  outputAudioMinorPerMillion?: number;
}

interface ModelEntry {
  id: string;
  providerId: string;
  upstreamModelId: string;
  cost?: TokenPriceSchedule;
  price?: TokenPriceSchedule;
  priority: number;
  active: boolean;
}

interface ModelLimits {
  context: number;
  input?: number;
  output?: number;
}

interface ModelModalities {
  input: Modality[];
  output: Modality[];
}

interface Model {
  _id: string;
  organizationId: string;
  aliasId: string;
  displayName: string;
  description?: string | null;
  entries: ModelEntry[];
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment: boolean;
  limits: ModelLimits;
  modalities: ModelModalities;
  status?: Status;
  price: TokenPriceSchedule;
  marginBps: number;
  currency: string;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface Provider {
  _id: string;
  organizationId: string;
  name: string;
  sdkType: string;
  baseUrl: string;
  active: boolean;
  hasApiKey: boolean;
}

interface ModelCatalog {
  _id: string;
  providerId: string;
  upstreamModelId: string;
  displayName: string;
}

type StatusFilter = Status | "none";

function StatusBadge({ status }: { status: StatusFilter }): React.ReactElement {
  const variant =
    status === "alpha" ? "secondary"
      : status === "beta" ? "warning"
        : status === "ga" ? "success"
          : status === "deprecated" ? "destructive"
            : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

export function parseModalities(raw: string): Modality[] {
  const seen = new Set<Modality>();
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if ((MODALITIES as readonly string[]).includes(t)) {
      seen.add(t as Modality);
    }
  }
  return Array.from(seen);
}

export function modalitiesToText(list: Modality[]): string {
  return list.join(", ");
}

export function toInt(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

export function toPositiveInt(v: string): number | undefined {
  const n = toInt(v);
  if (n === undefined) return undefined;
  return n > 0 ? n : undefined;
}

export function toNonNegInt(v: string): number | undefined {
  const n = toInt(v);
  if (n === undefined) return undefined;
  return n >= 0 ? n : undefined;
}

export interface FormState {
  aliasId: string;
  displayName: string;
  description: string;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  attachment: boolean;
  contextLimit: string;
  inputLimit: string;
  outputLimit: string;
  inputModalities: string;
  outputModalities: string;
  status: StatusFilter;
  inputMinor: string;
  outputMinor: string;
  currency: string;
  marginBps: string;
  firstProviderId: string;
  firstUpstreamModelId: string;
}

function emptyForm(): FormState {
  return {
    aliasId: "",
    displayName: "",
    description: "",
    reasoning: false,
    toolCall: false,
    structuredOutput: false,
    temperature: false,
    attachment: false,
    contextLimit: "",
    inputLimit: "",
    outputLimit: "",
    inputModalities: "text",
    outputModalities: "text",
    status: "none",
    inputMinor: "0",
    outputMinor: "0",
    currency: "USD",
    marginBps: "0",
    firstProviderId: "",
    firstUpstreamModelId: "",
  };
}

function formFromModel(m: Model): FormState {
  return {
    aliasId: m.aliasId,
    displayName: m.displayName,
    description: m.description ?? "",
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    structuredOutput: m.structuredOutput ?? false,
    temperature: m.temperature ?? false,
    attachment: m.attachment,
    contextLimit: String(m.limits.context),
    inputLimit: m.limits.input !== undefined ? String(m.limits.input) : "",
    outputLimit: m.limits.output !== undefined ? String(m.limits.output) : "",
    inputModalities: modalitiesToText(m.modalities.input),
    outputModalities: modalitiesToText(m.modalities.output),
    status: m.status ?? "none",
    inputMinor: String(m.price.inputMinorPerMillion),
    outputMinor: String(m.price.outputMinorPerMillion),
    currency: m.currency,
    marginBps: String(m.marginBps),
    firstProviderId: "",
    firstUpstreamModelId: "",
  };
}

export function slugifyModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Map a fetched catalog model onto the Add Model form state. Preserves fields
 * the catalog doesn't know about (currency, marginBps, firstProviderId) so the
 * admin's existing choices aren't clobbered. The fetched upstreamModelId is
 * dropped into the primary-entry upstream field as a convenience; the admin
 * still picks which of their configured providers serves it.
 */
export function formFromFetched(m: FetchedModel, base: FormState): FormState {
  return {
    ...base,
    aliasId: slugifyModelId(m.upstreamModelId),
    displayName: m.displayName,
    reasoning: m.reasoning ?? false,
    toolCall: m.toolCall ?? false,
    structuredOutput: m.structuredOutput ?? false,
    temperature: m.temperature ?? false,
    attachment: m.attachment ?? false,
    contextLimit: m.limits.context > 0 ? String(m.limits.context) : base.contextLimit,
    inputLimit: m.limits.input !== undefined && m.limits.input > 0 ? String(m.limits.input) : base.inputLimit,
    outputLimit: m.limits.output !== undefined && m.limits.output > 0 ? String(m.limits.output) : base.outputLimit,
    inputModalities: m.modalities.input.length > 0 ? modalitiesToText(m.modalities.input as Modality[]) : base.inputModalities,
    outputModalities: m.modalities.output.length > 0 ? modalitiesToText(m.modalities.output as Modality[]) : base.outputModalities,
    status: m.status ?? "none",
    inputMinor: m.cost ? String(m.cost.inputMinorPerMillion) : base.inputMinor,
    outputMinor: m.cost ? String(m.cost.outputMinorPerMillion) : base.outputMinor,
    firstUpstreamModelId: m.upstreamModelId,
  };
}

export function buildModelPayload(f: FormState, isCreate: boolean):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const aliasId = f.aliasId.trim();
  if (!aliasId) return { ok: false, error: "Alias ID required." };
  if (!/^[a-z0-9_-]+$/.test(aliasId))
    return { ok: false, error: "Alias ID must be lowercase slug (a-z0-9_-)." };

  const displayName = f.displayName.trim();
  if (!displayName) return { ok: false, error: "Display name required." };

  const context = toPositiveInt(f.contextLimit);
  if (context === undefined)
    return { ok: false, error: "Context limit must be a positive integer." };

  const inputMinor = toNonNegInt(f.inputMinor);
  const outputMinor = toNonNegInt(f.outputMinor);
  if (inputMinor === undefined || outputMinor === undefined)
    return { ok: false, error: "Price must be non-negative integers." };

  const marginBps = toNonNegInt(f.marginBps);
  if (marginBps === undefined)
    return { ok: false, error: "Margin (bps) must be a non-negative integer." };

  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    return { ok: false, error: "Currency must be a 3-letter code (e.g. USD)." };

  const limits: Record<string, unknown> = { context };
  const inputLimit = toPositiveInt(f.inputLimit);
  if (inputLimit !== undefined) limits.input = inputLimit;
  const outputLimit = toPositiveInt(f.outputLimit);
  if (outputLimit !== undefined) limits.output = outputLimit;

  const inputModalities = parseModalities(f.inputModalities);
  const outputModalities = parseModalities(f.outputModalities);

  const status = f.status === "none" ? undefined : f.status;

  const price: TokenPriceSchedule = {
    inputMinorPerMillion: inputMinor,
    outputMinorPerMillion: outputMinor,
  };

  const payload: Record<string, unknown> = {
    aliasId,
    displayName,
    description: f.description.trim() || undefined,
    reasoning: f.reasoning,
    toolCall: f.toolCall,
    structuredOutput: f.structuredOutput || undefined,
    temperature: f.temperature || undefined,
    attachment: f.attachment,
    limits,
    modalities: { input: inputModalities, output: outputModalities },
    status,
    price,
    marginBps,
    currency,
  };

  if (isCreate) {
    const providerId = f.firstProviderId.trim();
    const upstreamModelId = f.firstUpstreamModelId.trim();
    if (!providerId) return { ok: false, error: "Select a provider for the primary entry." };
    if (!upstreamModelId)
      return { ok: false, error: "Enter an upstream model id for the primary entry." };
    payload.entries = [
      {
        providerId,
        upstreamModelId,
        priority: 0,
        active: true,
      },
    ];
  }

  return { ok: true, payload };
}

export default function ModelsPage(): React.ReactElement {
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "edit">("list");
  const [editing, setEditing] = useState<Model | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fetchOpen, setFetchOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getJson<{ items: Model[] }>("/admin/models"),
      getJson<{ items: Provider[] }>("/admin/providers"),
    ])
      .then(([mRes, pRes]) => {
        if (cancelled) return;
        setModels(mRes.items);
        setProviders(pRes.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load models.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const providerMap = useMemo(() => {
    const m = new Map<string, Provider>();
    for (const p of providers) m.set(p._id, p);
    return m;
  }, [providers]);

  const reload = useCallback(() => setRefreshKey((k) => k + 1), []);

  const startAdd = useCallback(() => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setView("edit");
  }, []);

  const startEdit = useCallback((m: Model) => {
    setEditing(m);
    setForm(formFromModel(m));
    setFormError(null);
    setView("edit");
  }, []);

  const backToList = useCallback(() => {
    setView("list");
    setEditing(null);
    setFormError(null);
  }, []);

  const applyFetched = useCallback(
    (m: FetchedModel) => {
      setForm((prev) => formFromFetched(m, prev));
      setFormError(null);
    },
    [],
  );

  const submitForm = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const isCreate = editing === null;
      const built = buildModelPayload(form, isCreate);
      if (!built.ok) {
        setFormError(built.error);
        return;
      }
      setSaving(true);
      setFormError(null);
      try {
        if (isCreate) {
          const created = await postJson<Model>("/admin/models", built.payload);
          setModels((prev) => [created, ...prev]);
          setEditing(created);
          setForm(formFromModel(created));
          setView("edit");
        } else {
          const updated = await patchJson<Model>(
            `/admin/models/${editing!._id}`,
            built.payload,
          );
          setModels((prev) => prev.map((m) => (m._id === updated._id ? updated : m)));
          setEditing(updated);
          setForm(formFromModel(updated));
        }
      } catch (err) {
        setFormError(err instanceof ApiError ? err.message : "Save failed.");
      } finally {
        setSaving(false);
      }
    },
    [form, editing],
  );

  const deleteModel = useCallback(
    async (m: Model) => {
      if (!confirm(`Delete model "${m.displayName}" (${m.aliasId})? This cannot be undone.`))
        return;
      try {
        await deleteJson(`/admin/models/${m._id}`);
        setModels((prev) => prev.filter((x) => x._id !== m._id));
        if (editing?._id === m._id) backToList();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Delete failed.");
      }
    },
    [editing, backToList],
  );

  if (view === "edit") {
    return (
      <>
        <ModelEditor
          form={form}
          setForm={setForm}
          saving={saving}
          formError={formError}
          isCreate={editing === null}
          model={editing}
          providers={providers}
          providerMap={providerMap}
          onSubmit={submitForm}
          onBack={backToList}
          onDelete={deleteModel}
          onModelReplaced={reload}
          onOpenFetch={() => setFetchOpen(true)}
        />
        <FetchModelDialog
          open={fetchOpen}
          onOpenChange={setFetchOpen}
          onApply={applyFetched}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Models" description="Aliased models with ordered provider fallback chains.">
        <Button size="sm" onClick={startAdd}>
          <Plus className="size-4" />
          Add Model
        </Button>
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden p-0">
        {loading ? null : models.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-5" />}
            title="No models yet"
            description="Create your first aliased model with a provider fallback chain."
            action={<Button size="sm" onClick={startAdd}><Plus className="size-4" />Add Model</Button>}
          />
        ) : (
          <FadeIn>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Alias</TableHead>
                  <TableHead>Display name</TableHead>
                  <TableHead>Entries</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => {
                  const status = m.status ?? "none";
                  return (
                    <TableRow key={m._id}>
                      <TableCell className="font-mono font-medium">{m.aliasId}</TableCell>
                      <TableCell className="font-medium">{m.displayName}</TableCell>
                      <TableCell className="text-muted-foreground">{m.entries.length}</TableCell>
                      <TableCell><StatusBadge status={status} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.active ? "on" : "off"}</TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          <Button variant="secondary" size="sm" onClick={() => startEdit(m)}>Edit</Button>
                          <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => void deleteModel(m)} aria-label="Delete">
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </FadeIn>
        )}
      </Card>
    </div>
  );
}

interface ModelEditorProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
  formError: string | null;
  isCreate: boolean;
  model: Model | null;
  providers: Provider[];
  providerMap: Map<string, Provider>;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onDelete: (m: Model) => void;
  onModelReplaced: () => void;
  onOpenFetch: () => void;
}

function setField<K extends keyof FormState>(
  setForm: React.Dispatch<React.SetStateAction<FormState>>,
  key: K,
  value: FormState[K],
) {
  setForm((prev) => ({ ...prev, [key]: value }));
}

function FormField({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}

function ModelEditor({
  form,
  setForm,
  saving,
  formError,
  isCreate,
  model,
  providers,
  providerMap,
  onSubmit,
  onBack,
  onDelete,
  onModelReplaced,
  onOpenFetch,
}: ModelEditorProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader
        title={isCreate ? "Add Model" : `Edit: ${model?.displayName ?? ""}`}
        description={isCreate ? "Create a new aliased model with a primary provider entry." : `Alias ${model?.aliasId ?? ""}`}
      >
        {isCreate ? (
          <Button variant="outline" size="sm" onClick={onOpenFetch} disabled={saving}>
            <Sparkles className="size-4" />
            Fetch Model Information
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back to list
        </Button>
      </PageHeader>

      <form className="flex flex-col gap-6 rounded-lg border border-border bg-card p-6 shadow-xs" onSubmit={onSubmit}>
        <SectionTitle>Identity</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField id="m-alias" label="Alias ID" help="Lowercase slug: a-z, 0-9, _ or -.">
            <Input
              id="m-alias"
              type="text"
              value={form.aliasId}
              placeholder="my-gpt"
              onChange={(e) => setField(setForm, "aliasId", e.target.value)}
              required
              disabled={saving}
            />
          </FormField>
          <FormField id="m-name" label="Display name">
            <Input
              id="m-name"
              type="text"
              value={form.displayName}
              onChange={(e) => setField(setForm, "displayName", e.target.value)}
              required
              disabled={saving}
            />
          </FormField>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="m-desc">Description</Label>
            <Textarea
              id="m-desc"
              rows={3}
              value={form.description}
              onChange={(e) => setField(setForm, "description", e.target.value)}
              disabled={saving}
            />
          </div>
        </div>

        <SectionTitle>Capabilities</SectionTitle>
        <div className="flex flex-wrap gap-4">
          <CapabilityCheck label="Reasoning" checked={form.reasoning} onChange={(v) => setField(setForm, "reasoning", v)} disabled={saving} />
          <CapabilityCheck label="Tool call" checked={form.toolCall} onChange={(v) => setField(setForm, "toolCall", v)} disabled={saving} />
          <CapabilityCheck label="Structured output" checked={form.structuredOutput} onChange={(v) => setField(setForm, "structuredOutput", v)} disabled={saving} />
          <CapabilityCheck label="Temperature" checked={form.temperature} onChange={(v) => setField(setForm, "temperature", v)} disabled={saving} />
          <CapabilityCheck label="Attachment" checked={form.attachment} onChange={(v) => setField(setForm, "attachment", v)} disabled={saving} />
        </div>

        <SectionTitle>Limits</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField id="m-ctx" label="Context window">
            <Input id="m-ctx" type="number" min={1} value={form.contextLimit} onChange={(e) => setField(setForm, "contextLimit", e.target.value)} required disabled={saving} />
          </FormField>
          <FormField id="m-in" label="Input limit (optional)">
            <Input id="m-in" type="number" min={1} value={form.inputLimit} onChange={(e) => setField(setForm, "inputLimit", e.target.value)} disabled={saving} />
          </FormField>
          <FormField id="m-out" label="Output limit (optional)">
            <Input id="m-out" type="number" min={1} value={form.outputLimit} onChange={(e) => setField(setForm, "outputLimit", e.target.value)} disabled={saving} />
          </FormField>
        </div>

        <SectionTitle>Modalities</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField id="m-min" label="Input modalities" help="Comma-separated: text, image, audio, video, pdf.">
            <Input id="m-min" type="text" value={form.inputModalities} placeholder="text, image" onChange={(e) => setField(setForm, "inputModalities", e.target.value)} disabled={saving} />
          </FormField>
          <FormField id="m-mout" label="Output modalities" help="Comma-separated: text, image, audio, video, pdf.">
            <Input id="m-mout" type="text" value={form.outputModalities} placeholder="text" onChange={(e) => setField(setForm, "outputModalities", e.target.value)} disabled={saving} />
          </FormField>
        </div>

        <SectionTitle>Pricing &amp; status</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField id="m-ipm" label="Input price (minor/M)" help="Per million tokens in minor units (300 = $3.00/M).">
            <Input id="m-ipm" type="number" min={0} value={form.inputMinor} onChange={(e) => setField(setForm, "inputMinor", e.target.value)} required disabled={saving} />
          </FormField>
          <FormField id="m-opm" label="Output price (minor/M)" help="Per million tokens in minor units.">
            <Input id="m-opm" type="number" min={0} value={form.outputMinor} onChange={(e) => setField(setForm, "outputMinor", e.target.value)} required disabled={saving} />
          </FormField>
          <FormField id="m-status" label="Status">
            <Select value={form.status} onValueChange={(v) => setField(setForm, "status", v as StatusFilter)} disabled={saving}>
              <SelectTrigger id="m-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">none</SelectItem>
                <SelectItem value="alpha">alpha</SelectItem>
                <SelectItem value="beta">beta</SelectItem>
                <SelectItem value="ga">ga</SelectItem>
                <SelectItem value="deprecated">deprecated</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField id="m-cur" label="Currency">
            <Input id="m-cur" type="text" value={form.currency} onChange={(e) => setField(setForm, "currency", e.target.value)} required disabled={saving} />
          </FormField>
          <FormField id="m-margin" label="Margin (bps)" help="Basis points over cost if price unset (100 = 1%).">
            <Input id="m-margin" type="number" min={0} value={form.marginBps} onChange={(e) => setField(setForm, "marginBps", e.target.value)} required disabled={saving} />
          </FormField>
        </div>

        {isCreate ? (
          <>
            <SectionTitle>Primary provider entry</SectionTitle>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField id="m-prov" label="Provider">
                <Select value={form.firstProviderId} onValueChange={(v) => setField(setForm, "firstProviderId", v)} disabled={saving}>
                  <SelectTrigger id="m-prov">
                    <SelectValue placeholder="Select provider…" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField id="m-up" label="Upstream model id" help="Upstream model id on the chosen provider.">
                <Input id="m-up" type="text" value={form.firstUpstreamModelId} placeholder="gpt-4o-mini" onChange={(e) => setField(setForm, "firstUpstreamModelId", e.target.value)} required disabled={saving} />
              </FormField>
            </div>
          </>
        ) : null}

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          {!isCreate && model ? (
            <Button type="button" variant="destructive" onClick={() => void onDelete(model)} disabled={saving}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onBack} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : isCreate ? "Create" : "Save"}</Button>
        </div>
      </form>

      {!isCreate && model ? (
        <FallbackChain model={model} providers={providers} providerMap={providerMap} onModelReplaced={onModelReplaced} />
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function CapabilityCheck({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} />
      {label}
    </label>
  );
}

interface FallbackChainProps {
  model: Model;
  providers: Provider[];
  providerMap: Map<string, Provider>;
  onModelReplaced: () => void;
}

function FallbackChain({ model, providers, providerMap, onModelReplaced }: FallbackChainProps): React.ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const entries = model.entries;

  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      setDragIndex(index);
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", String(index));
      } catch {
        /* some browsers throw without user gesture */
      }
    },
    [],
  );

  const onDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragIndex === null) return;
      if (dragIndex === index) {
        setDropTarget(null);
        return;
      }
      setDropTarget(index);
    },
    [dragIndex],
  );

  const onDragEnd = useCallback(() => {
    setDragIndex(null);
    setDropTarget(null);
  }, []);

  const onDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>, dropIndex: number) => {
      e.preventDefault();
      if (dragIndex === null) return;
      const from = dragIndex;
      const to = dropIndex;
      setDragIndex(null);
      setDropTarget(null);
      if (from === to) return;

      const reordered = [...entries];
      const [moved] = reordered.splice(from, 1);
      if (!moved) return;
      reordered.splice(to, 0, moved);

      const payload = {
        entries: reordered.map((entry, i) => ({ id: entry.id, priority: i })),
      };
      setReordering(true);
      setChainError(null);
      try {
        await patchJson<Model>(`/admin/models/${model._id}/fallbacks`, payload);
        onModelReplaced();
      } catch (err) {
        setChainError(err instanceof ApiError ? err.message : "Reorder failed.");
      } finally {
        setReordering(false);
      }
    },
    [dragIndex, entries, model._id, onModelReplaced],
  );

  const onDragOverTop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragIndex === null) return;
      setDropTarget(0);
    },
    [dragIndex],
  );

  const onDropTop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === 0) {
        setDragIndex(null);
        setDropTarget(null);
        return;
      }
      const from = dragIndex;
      setDragIndex(null);
      setDropTarget(null);

      const reordered = [...entries];
      const [moved] = reordered.splice(from, 1);
      if (!moved) return;
      reordered.splice(0, 0, moved);

      const payload = {
        entries: reordered.map((entry, i) => ({ id: entry.id, priority: i })),
      };
      setReordering(true);
      setChainError(null);
      try {
        await patchJson<Model>(`/admin/models/${model._id}/fallbacks`, payload);
        onModelReplaced();
      } catch (err) {
        setChainError(err instanceof ApiError ? err.message : "Reorder failed.");
      } finally {
        setReordering(false);
      }
    },
    [dragIndex, entries, model._id, onModelReplaced],
  );

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onActiveToggle = useCallback(
    async (entry: ModelEntry, next: boolean) => {
      setChainError(null);
      try {
        await patchJson<Model>(`/admin/models/${model._id}`, {
          entries: model.entries.map((e) =>
            e.id === entry.id ? { ...e, active: next } : e,
          ),
        });
        onModelReplaced();
      } catch (err) {
        setChainError(err instanceof ApiError ? err.message : "Toggle failed.");
      }
    },
    [model._id, model.entries, onModelReplaced],
  );

  const onRemoveEntry = useCallback(
    async (entry: ModelEntry) => {
      if (model.entries.length <= 1) {
        setChainError("Cannot remove the last entry.");
        return;
      }
      if (!confirm(`Remove entry "${entry.upstreamModelId}"?`)) return;
      setChainError(null);
      try {
        await deleteJson<Model>(`/admin/models/${model._id}/entries/${entry.id}`);
        onModelReplaced();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setChainError("Cannot remove the last entry.");
        } else {
          setChainError(err instanceof ApiError ? err.message : "Remove failed.");
        }
      }
    },
    [model._id, model.entries.length, onModelReplaced],
  );

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-6 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Fallback chain</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Drag rows to reorder priorities (lower = tried first).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)} disabled={reordering}>
          {showAdd ? "Close" : "Add Provider Entry"}
        </Button>
      </div>

      {chainError ? (
        <Alert variant="destructive">
          <AlertDescription>{chainError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-visible rounded-md border border-border bg-card">
        {entries.length === 0 ? (
          <div className="px-5 py-5 text-center text-sm text-muted-foreground">No entries.</div>
        ) : (
          <>
            <div
              className={cn(
                dropTarget === 0 && dragIndex !== 0 ? "h-0.5 bg-primary" : "h-0",
              )}
              onDragOver={onDragOverTop}
              onDrop={onDropTop}
            />
            {entries.map((entry, index) => {
              const provider = providerMap.get(entry.providerId);
              const isDragging = dragIndex === index;
              const showIndicator = dropTarget === index && dragIndex !== null && dragIndex !== index;
              return (
                <div key={entry.id}>
                  {showIndicator ? <div className="h-0.5 bg-primary" /> : null}
                  <div
                    className={cn(
                      "flex items-stretch border-b border-border last:border-b-0 bg-card transition-colors",
                      isDragging && "opacity-50 bg-muted",
                    )}
                    draggable
                    onDragStart={(e) => onDragStart(e, index)}
                    onDragOver={(e) => onDragOver(e, index)}
                    onDrop={(e) => onDrop(e, index)}
                    onDragEnd={onDragEnd}
                  >
                    <div
                      className="flex w-9 shrink-0 cursor-grab select-none items-center justify-center border-r border-border text-muted-foreground active:cursor-grabbing"
                      aria-label="Drag to reorder"
                      title="Drag to reorder"
                    >
                      <GripVertical className="size-4" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-bold text-primary">
                          {entry.priority}
                        </span>
                        <span className="text-sm font-semibold">{provider?.name ?? "Unknown provider"}</span>
                        <span className="font-mono text-xs text-muted-foreground">{entry.upstreamModelId}</span>
                        <div className="ml-auto flex items-center gap-2">
                          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                            <Checkbox checked={entry.active} onCheckedChange={(v) => void onActiveToggle(entry, v === true)} disabled={reordering} />
                            active
                          </label>
                          <button
                            type="button"
                            className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                            onClick={() => toggleExpand(entry.id)}
                          >
                            {expanded.has(entry.id) ? "Hide" : "Cost/Price"}
                          </button>
                          <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => void onRemoveEntry(entry)} disabled={reordering} aria-label="Remove">
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                      {expanded.has(entry.id) ? <EntryCostPrice entry={entry} /> : null}
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span>cost: {entry.cost ? `${entry.cost.inputMinorPerMillion}/${entry.cost.outputMinorPerMillion}` : "default"}</span>
                        <span>price: {entry.price ? `${entry.price.inputMinorPerMillion}/${entry.price.outputMinorPerMillion}` : "default"}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {showAdd ? (
        <AddEntryForm
          modelId={model._id}
          providers={providers}
          onAdded={() => {
            setShowAdd(false);
            onModelReplaced();
          }}
        />
      ) : null}
    </div>
  );
}

function EntryCostPrice({ entry }: { entry: ModelEntry }): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-2.5 pt-1 sm:grid-cols-2">
      <div>
        <div className="text-[11px] text-muted-foreground">Cost override (minor/M):</div>
        <div className="font-mono text-xs">
          input={entry.cost?.inputMinorPerMillion ?? "—"}
          {"  "}output={entry.cost?.outputMinorPerMillion ?? "—"}
        </div>
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">Price override (minor/M):</div>
        <div className="font-mono text-xs">
          input={entry.price?.inputMinorPerMillion ?? "—"}
          {"  "}output={entry.price?.outputMinorPerMillion ?? "—"}
        </div>
      </div>
    </div>
  );
}

interface AddEntryFormProps {
  modelId: string;
  providers: Provider[];
  onAdded: () => void;
}

interface AddEntryState {
  providerId: string;
  upstreamModelId: string;
  manualMode: boolean;
  costInput: string;
  costOutput: string;
  priceInput: string;
  priceOutput: string;
  active: boolean;
}

function emptyAddEntry(): AddEntryState {
  return {
    providerId: "",
    upstreamModelId: "",
    manualMode: false,
    costInput: "",
    costOutput: "",
    priceInput: "",
    priceOutput: "",
    active: true,
  };
}

function AddEntryForm({ modelId, providers, onAdded }: AddEntryFormProps): React.ReactElement {
  const [state, setState] = useState<AddEntryState>(emptyAddEntry);
  const [catalog, setCatalog] = useState<ModelCatalog[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!state.providerId) {
      setCatalog([]);
      setCatalogError(null);
      return;
    }
    setLoadingCatalog(true);
    setCatalogError(null);
    getJson<{ items: ModelCatalog[] }>(`/admin/providers/${state.providerId}/models`)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setCatalogError(err instanceof ApiError ? err.message : "Failed to load models.");
        setCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.providerId]);

  const submit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const providerId = state.providerId.trim();
      const upstreamModelId = state.upstreamModelId.trim();
      if (!providerId) {
        setError("Select a provider.");
        return;
      }
      if (!upstreamModelId) {
        setError("Enter or select an upstream model id.");
        return;
      }

      const body: Record<string, unknown> = {
        providerId,
        upstreamModelId,
        active: state.active,
      };

      const cIn = toNonNegInt(state.costInput);
      const cOut = toNonNegInt(state.costOutput);
      if (state.costInput !== "" || state.costOutput !== "") {
        if (cIn === undefined || cOut === undefined) {
          setError("Cost must be non-negative integers.");
          return;
        }
        body.cost = { inputMinorPerMillion: cIn, outputMinorPerMillion: cOut };
      }

      const pIn = toNonNegInt(state.priceInput);
      const pOut = toNonNegInt(state.priceOutput);
      if (state.priceInput !== "" || state.priceOutput !== "") {
        if (pIn === undefined || pOut === undefined) {
          setError("Price must be non-negative integers.");
          return;
        }
        body.price = { inputMinorPerMillion: pIn, outputMinorPerMillion: pOut };
      }

      setSubmitting(true);
      setError(null);
      try {
        await postJson<Model>(`/admin/models/${modelId}/entries`, body);
        setState(emptyAddEntry());
        onAdded();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Add entry failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [state, modelId, onAdded],
  );

  return (
    <form className="mt-3 flex flex-col gap-3 rounded-md border border-dashed border-border bg-muted/20 p-4" onSubmit={submit}>
      <SectionTitle>New provider entry</SectionTitle>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id="ae-prov" label="Provider">
          <Select
            value={state.providerId}
            onValueChange={(v) => setState((s) => ({ ...s, providerId: v, upstreamModelId: "" }))}
            required
            disabled={submitting}
          >
            <SelectTrigger id="ae-prov">
              <SelectValue placeholder="Select provider…" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-up">Upstream model id</Label>
          {state.manualMode || catalog.length === 0 ? (
            <Input id="ae-up" type="text" value={state.upstreamModelId} placeholder="gpt-4o-mini" onChange={(e) => setState((s) => ({ ...s, upstreamModelId: e.target.value }))} required disabled={submitting} />
          ) : (
            <Select value={state.upstreamModelId} onValueChange={(v) => setState((s) => ({ ...s, upstreamModelId: v }))} disabled={submitting || loadingCatalog}>
              <SelectTrigger id="ae-up">
                <SelectValue placeholder={loadingCatalog ? "Loading…" : "Select model…"} />
              </SelectTrigger>
              <SelectContent>
                {catalog.map((c) => (
                  <SelectItem key={c._id} value={c.upstreamModelId}>{c.upstreamModelId} — {c.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            {catalogError ? <span className="text-destructive">{catalogError}</span> : null}
            <button type="button" className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted" onClick={() => setState((s) => ({ ...s, manualMode: !s.manualMode, upstreamModelId: "" }))}>
              {state.manualMode ? "Use dropdown" : "Enter manually"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField id="ae-cin" label="Cost input (minor/M, optional)">
          <Input id="ae-cin" type="number" min={0} value={state.costInput} onChange={(e) => setState((s) => ({ ...s, costInput: e.target.value }))} disabled={submitting} />
        </FormField>
        <FormField id="ae-cout" label="Cost output (minor/M, optional)">
          <Input id="ae-cout" type="number" min={0} value={state.costOutput} onChange={(e) => setState((s) => ({ ...s, costOutput: e.target.value }))} disabled={submitting} />
        </FormField>
        <FormField id="ae-pin" label="Price input (minor/M, optional)">
          <Input id="ae-pin" type="number" min={0} value={state.priceInput} onChange={(e) => setState((s) => ({ ...s, priceInput: e.target.value }))} disabled={submitting} />
        </FormField>
        <FormField id="ae-pout" label="Price output (minor/M, optional)">
          <Input id="ae-pout" type="number" min={0} value={state.priceOutput} onChange={(e) => setState((s) => ({ ...s, priceOutput: e.target.value }))} disabled={submitting} />
        </FormField>
      </div>

      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
        <Checkbox checked={state.active} onCheckedChange={(v) => setState((s) => ({ ...s, active: v === true }))} disabled={submitting} />
        Active in fallback chain
      </label>

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>{submitting ? "Adding…" : "Add entry"}</Button>
      </div>
    </form>
  );
}