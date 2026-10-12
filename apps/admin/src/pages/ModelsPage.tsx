import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { ApiError, deleteJson, patchJson, postJson } from "../api/client.ts";
import * as modelsApi from "../api/models.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { UnitsPreview } from "@/components/ui/units-preview";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Boxes, Plus, ArrowLeft, Trash2, GripVertical, Sparkles, ShieldCheck, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/Instrument";
import { Scale } from "@/components/Scale";
import { useConfirm } from "@/components/ConfirmDialog";
import { MultiSelect, type MultiSelectOption } from "@/components/MultiSelect";
import { CurrencySelect } from "@/components/CurrencySelect";
import { UpstreamModelPicker } from "@/components/ModelPickers";
import { MODEL_MODALITIES, type ModelModality as Modality } from "@tokenpanel/contracts";

const MODALITY_LABEL: Record<Modality, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
};
const MODALITY_OPTIONS: MultiSelectOption[] = MODEL_MODALITIES.map((m) => ({ value: m, label: MODALITY_LABEL[m] }));
import { formatMicros } from "../utils/format.ts";
import { FetchModelDialog } from "@/components/FetchModelDialog";
import type { FetchedModel } from "../api/catalog.ts";
import { cn } from "@/lib/utils";
import {
  MODEL_METADATA_POLICY,
  parseMajorToMicros,
  formatMicrosToMajor,
  type ModelStatus,
} from "@tokenpanel/contracts";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";


// Domain-split pure helpers (models/model-form.ts). Re-exported for unit tests.
export {
  type MetadataRow,
  type FormState,
  type MetadataFieldErrors,
  type Model,
  type ModelEntry,
  type Provider,
  newMetadataRowId,
  coerceMetadataValue,
  metadataToRows,
  rowsToMetadata,
  isValidMetadataKey,
  metadataRowFieldErrors,
  normalizeMetadataValueNewlines,
  parseModalities,
  modalitiesToText,
  toInt,
  toPositiveInt,
  toNonNegInt,
  formFromModel,
  formFromFetched,
  buildModelPayload,
  priceFromCostMargin,
  slugifyModelId,
  emptyForm,
} from "./models/model-form.ts";

import {
  type FormState,
  type TokenPriceSchedule,
  type Model,
  type ModelEntry,
  type Provider,
  newMetadataRowId,
  metadataRowFieldErrors,
  formFromModel,
  formFromFetched,
  buildModelPayload,
  priceFromCostMargin,
  emptyForm,
  parseModalities,
  modalitiesToText,
} from "./models/model-form.ts";

type Status = ModelStatus;

const METADATA_MAX_ENTRIES = MODEL_METADATA_POLICY.maxEntries;
const METADATA_KEY_MAX_LEN = MODEL_METADATA_POLICY.keyMaxLen;


type StatusFilter = Status | "none";

function StatusBadge({ status }: { status: StatusFilter }): React.ReactElement {
  if (status === "none") return <span className="text-muted-foreground">—</span>;
  const variant =
    status === "alpha" ? "info"
      : status === "beta" ? "warning"
        : status === "ga" ? "success"
          : "destructive";
  const label = status === "ga" ? "GA" : status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge variant={variant}>{label}</Badge>;
}

export default function ModelsPage(): React.ReactElement {
  const { user } = useAuth();
  const canWrite = hasPermission(user, "models:write");
  const confirm = useConfirm();

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
    // Models list is the load contract; the providers fetch is best-effort.
    // The page only requires `models:read`, but `/admin/providers` needs
    // `providers:read` — a models-only member would otherwise 403 here and
    // reject the whole Promise.all, blanking the list with "Failed to load
    // models". Provider labels degrade to the raw id when unavailable.
    Promise.all([
      modelsApi.listModels(),
      modelsApi.listProviders().catch(() => ({ items: [] as modelsApi.AdminProviderSummary[] })),
    ])
      .then(([mRes, pRes]) => {
        if (cancelled) return;
        const items = mRes.items as unknown as Model[];
        setModels(items);
        setProviders(pRes.items as unknown as Provider[]);
        // Keep the open editor in sync with the fresh list so entry mutations
        // (add / remove / reorder / toggle) surfaced via reload() update the
        // live provider routing instead of leaving a stale `editing` snapshot.
        setEditing((prev) => {
          if (!prev) return prev;
          return items.find((m) => m._id === prev._id) ?? prev;
        });
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
    if (!canWrite) return;
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setView("edit");
  }, [canWrite]);

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
      if (!canWrite) return;
      const isCreate = editing === null;
      const built = buildModelPayload(form, isCreate, editing ?? undefined);
      if (!built.ok) {
        setFormError(built.error);
        return;
      }
      setSaving(true);
      setFormError(null);
      try {
        if (isCreate) {
          const created = (await modelsApi.createModel(built.payload)) as unknown as Model;
          setModels((prev) => [created, ...prev]);
          setEditing(created);
          setForm(formFromModel(created));
          setView("edit");
        } else {
          const updated = (await modelsApi.updateModel(
            editing!._id,
            built.payload,
          )) as unknown as Model;
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
    [form, editing, canWrite],
  );

  const deleteModel = useCallback(
    async (m: Model) => {
      if (!canWrite) return;
      const ok = await confirm({
        title: `Delete ${m.displayName}?`,
        description: `Requests for "${m.aliasId}" will fail for every customer and key. This cannot be undone.`,
        confirmLabel: "Delete model",
        destructive: true,
      });
      if (!ok) return;
      try {
        await modelsApi.deleteModel(m._id);
        setModels((prev) => prev.filter((x) => x._id !== m._id));
        if (editing?._id === m._id) backToList();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Delete failed.");
      }
    },
    [editing, backToList, canWrite, confirm],
  );

  if (view === "edit" && (canWrite || editing !== null)) {
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
          canWrite={canWrite}
          onSubmit={submitForm}
          onBack={backToList}
          onDelete={deleteModel}
          onModelReplaced={reload}
          onOpenFetch={() => setFetchOpen(true)}
        />
        <FetchModelDialog
          open={canWrite && fetchOpen}
          onOpenChange={setFetchOpen}
          onApply={applyFetched}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Models"
        description="Aliases your customers call, each routed to one or more provider models with its own price."
      >
        {canWrite ? (
          <Button onClick={startAdd}>
            <Plus />
            Add model
          </Button>
        ) : null}
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canWrite ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Read-only access. Creating, editing, or deleting models needs{" "}
            <code className="font-mono text-xs">models:write</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      <Panel className="overflow-hidden">
        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : models.length === 0 ? (
          <EmptyState
            icon={<Boxes />}
            title="No models yet"
            description={
              canWrite
                ? "Publish an alias such as \u201cgpt-4.1\u201d, route it to a provider model, and set what customers pay per million tokens."
                : "No models configured yet. Someone with models:write can add them."
            }
            action={
              canWrite ? (
                <Button size="sm" onClick={startAdd}>
                  <Plus />
                  Add model
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="hidden lg:table-cell">Routes to</TableHead>
                <TableHead className="hidden text-right md:table-cell">Input / 1M</TableHead>
                <TableHead className="hidden text-right md:table-cell">Output / 1M</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const status = m.status ?? "none";
                const primary = [...m.entries].sort((a, b) => a.priority - b.priority)[0];
                const primaryName = primary ? providerMap.get(primary.providerId)?.name ?? "Unknown provider" : "—";
                return (
                  <TableRow key={m._id} className={cn("cursor-pointer", !m.active && "text-muted-foreground")} onClick={() => startEdit(m)}>
                    <TableCell className="max-w-[18rem]">
                      <div className="truncate font-medium text-foreground">{m.displayName}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{m.aliasId}</div>
                      <div className="mt-1 text-xs tabular-nums text-muted-foreground md:hidden">
                        {formatMicros(m.price.inputMicrosPerMillion, m.currency)} in · {formatMicros(m.price.outputMicrosPerMillion, m.currency)} out / 1M
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-[16rem] lg:table-cell">
                      <div className="truncate text-[13px]">{primaryName}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.entries.length > 1 ? `+${m.entries.length - 1} fallback${m.entries.length > 2 ? "s" : ""}` : "No fallback"}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMicros(m.price.inputMicrosPerMillion, m.currency)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMicros(m.price.outputMicrosPerMillion, m.currency)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={status} />
                        {!m.active ? <Badge variant="off">Off</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button variant="outline" size="sm" onClick={() => startEdit(m)}>
                          {canWrite ? "Edit" : "View"}
                        </Button>
                        {canWrite ? (
                          <Button
                            variant="ghost-destructive"
                            size="icon-sm"
                            onClick={() => void deleteModel(m)}
                            aria-label={`Delete ${m.displayName}`}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
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
  canWrite: boolean;
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

/** Select all text on focus so typing replaces the value instead of appending. */
function selectOnFocus(e: React.FocusEvent<HTMLInputElement>): void {
  e.target.select();
}

/** Price↔cost field pairs for margin-invalidation on direct price edits. */
const PRICE_COST_PAIRS = {
  inputUnits: "costInputUnits",
  outputUnits: "costOutputUnits",
  reasoningUnits: "costReasoningUnits",
  cacheReadUnits: "costCacheReadUnits",
  cacheWriteUnits: "costCacheWriteUnits",
  inputAudioUnits: "costInputAudioUnits",
  outputAudioUnits: "costOutputAudioUnits",
} as const satisfies Record<string, keyof FormState>;

/**
 * Set a price field from direct user input. If the entered value no longer
 * matches cost + current margin, clear marginBps (price is now manual).
 */
function setPriceField(
  setForm: React.Dispatch<React.SetStateAction<FormState>>,
  key: keyof typeof PRICE_COST_PAIRS,
  value: string,
): void {
  const costKey = PRICE_COST_PAIRS[key];
  setForm((prev) => {
    const derived = priceFromCostMargin(prev[costKey] as string, prev.marginBps);
    const stale = derived !== undefined && derived !== value.trim();
    return { ...prev, [key]: value, ...(stale ? { marginBps: "" } : {}) };
  });
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
  canWrite,
  onSubmit,
  onBack,
  onDelete,
  onModelReplaced,
  onOpenFetch,
}: ModelEditorProps): React.ReactElement {
  const readOnly = !canWrite;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="link" size="sm" className="-ml-0.5 mb-2 h-auto text-muted-foreground no-underline hover:text-foreground" onClick={onBack}>
          <ArrowLeft />
          Models
        </Button>
        <PageHeader
          title={
            isCreate
              ? "Add model"
              : readOnly
                ? (model?.displayName ?? "Model")
                : (model?.displayName ?? "Edit model")
          }
          description={
            isCreate
              ? "Publish an alias, describe what it can do, set cost and price, and route it to a provider."
              : model ? <span className="font-mono text-[13px]">{model.aliasId}</span> : undefined
          }
        >
          {canWrite ? (
            <Button variant="outline" onClick={onOpenFetch} disabled={saving}>
              <Sparkles />
              {isCreate ? "Fill from catalog" : "Refresh from catalog"}
            </Button>
          ) : null}
        </PageHeader>
      </div>

      <form
        className="flex flex-col gap-6 rounded-xl border border-border bg-card p-5 sm:p-6"
        onSubmit={onSubmit}
        aria-readonly={readOnly || undefined}
      >
        <SectionTitle>Identity</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="m-alias" label="Alias ID" hint="Lowercase: a-z, 0-9, _, - or ." tooltip="The model identifier customers use in API requests (e.g. 'gpt-4o'). Maps to one or more upstream provider entries.">
            <Input
              id="m-alias"
              type="text"
              value={form.aliasId}
              placeholder="my-gpt"
              onChange={(e) => setField(setForm, "aliasId", e.target.value)}
              required
              disabled={saving}
            />
          </Field>
          <Field id="m-name" label="Display name">
            <Input
              id="m-name"
              type="text"
              value={form.displayName}
              onChange={(e) => setField(setForm, "displayName", e.target.value)}
              required
              disabled={saving}
            />
          </Field>
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
          <Field id="m-ctx" label="Context window">
            <Input id="m-ctx" type="number" min={1} value={form.contextLimit} onChange={(e) => setField(setForm, "contextLimit", e.target.value)} required disabled={saving} />
          </Field>
          <Field id="m-in" label="Input limit" optional>
            <Input id="m-in" type="number" min={1} value={form.inputLimit} onChange={(e) => setField(setForm, "inputLimit", e.target.value)} disabled={saving} />
          </Field>
          <Field id="m-out" label="Output limit" optional>
            <Input id="m-out" type="number" min={1} value={form.outputLimit} onChange={(e) => setField(setForm, "outputLimit", e.target.value)} disabled={saving} />
          </Field>
        </div>

        <SectionTitle>Modalities</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="m-min" label="Input modalities" hint="What the model accepts.">
            <MultiSelect
              id="m-min"
              label="Input modalities"
              options={MODALITY_OPTIONS}
              value={parseModalities(form.inputModalities)}
              onChange={(list) => setField(setForm, "inputModalities", modalitiesToText(list as Modality[]))}
              placeholder="None selected"
              disabled={saving}
            />
          </Field>
          <Field id="m-mout" label="Output modalities" hint="What the model can produce.">
            <MultiSelect
              id="m-mout"
              label="Output modalities"
              options={MODALITY_OPTIONS}
              value={parseModalities(form.outputModalities)}
              onChange={(list) => setField(setForm, "outputModalities", modalitiesToText(list as Modality[]))}
              placeholder="None selected"
              disabled={saving}
            />
          </Field>
        </div>

        <SectionTitle>Pricing &amp; status</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field id="m-cur" label="Currency">
            <CurrencySelect id="m-cur" value={form.currency} onChange={(v) => setField(setForm, "currency", v)} disabled={saving} />
          </Field>
          <Field id="m-margin" label="Margin (bps)" optional tooltip="Markup over cost, in basis points (100 = 1%). Blank = 0 (price equals cost). Changing this re-derives the price fields below from cost; editing a price directly clears this field.">
            <Input
              id="m-margin"
              type="number"
              min={0}
              value={form.marginBps}
              onChange={(e) => {
                const marginBps = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  marginBps,
                  inputUnits: priceFromCostMargin(prev.costInputUnits, marginBps) ?? prev.inputUnits,
                  outputUnits: priceFromCostMargin(prev.costOutputUnits, marginBps) ?? prev.outputUnits,
                  reasoningUnits: priceFromCostMargin(prev.costReasoningUnits, marginBps) ?? prev.reasoningUnits,
                  cacheReadUnits: priceFromCostMargin(prev.costCacheReadUnits, marginBps) ?? prev.cacheReadUnits,
                  cacheWriteUnits: priceFromCostMargin(prev.costCacheWriteUnits, marginBps) ?? prev.cacheWriteUnits,
                  inputAudioUnits: priceFromCostMargin(prev.costInputAudioUnits, marginBps) ?? prev.inputAudioUnits,
                  outputAudioUnits: priceFromCostMargin(prev.costOutputAudioUnits, marginBps) ?? prev.outputAudioUnits,
                }));
              }}
              onFocus={selectOnFocus}
              disabled={saving}
            />
          </Field>
          <Field id="m-status" label="Status">
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
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2">
          <FormMarginScale cost={form.costInputUnits} price={form.inputUnits} currency={form.currency} />
          <div className="flex flex-col gap-3 border-t border-rule pt-3">
            <div className="legend text-muted-foreground">Cost · what you pay upstream</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="m-cin" label="Input cost ($/M)" optional tooltip="Wholesale cost per million input tokens, in major units (e.g. 1.50 = $1.50/M). Drives the Cost column in analytics. Blank = no cost tracking.">
                <Input id="m-cin" type="number" min={0} step="any" value={form.costInputUnits} placeholder="blank" onChange={(e) => setField(setForm, "costInputUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-cout" label="Output cost ($/M)" optional tooltip="Wholesale cost per million output tokens.">
                <Input id="m-cout" type="number" min={0} step="any" value={form.costOutputUnits} placeholder="blank" onChange={(e) => setField(setForm, "costOutputUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-ccread" label="Cache read cost ($/M)" optional tooltip="Cost per million cached-input tokens.">
                <Input id="m-ccread" type="number" min={0} step="any" value={form.costCacheReadUnits} placeholder="blank" onChange={(e) => setField(setForm, "costCacheReadUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-ccwrite" label="Cache write cost ($/M)" optional tooltip="Cost per million cache-creation tokens.">
                <Input id="m-ccwrite" type="number" min={0} step="any" value={form.costCacheWriteUnits} placeholder="blank" onChange={(e) => setField(setForm, "costCacheWriteUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-creason" label="Reasoning cost ($/M)" optional tooltip="Cost per million reasoning tokens.">
                <Input id="m-creason" type="number" min={0} step="any" value={form.costReasoningUnits} placeholder="blank" onChange={(e) => setField(setForm, "costReasoningUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-ciaudio" label="Input audio cost ($/M)" optional tooltip="Cost per million audio-input tokens.">
                <Input id="m-ciaudio" type="number" min={0} step="any" value={form.costInputAudioUnits} placeholder="blank" onChange={(e) => setField(setForm, "costInputAudioUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-coaudio" label="Output audio cost ($/M)" optional tooltip="Cost per million audio-output tokens.">
                <Input id="m-coaudio" type="number" min={0} step="any" value={form.costOutputAudioUnits} placeholder="blank" onChange={(e) => setField(setForm, "costOutputAudioUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-rule pt-3">
            <div className="legend text-muted-foreground">Price · what customers pay</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="m-ipm" label="Input price ($/M)" tooltip="Retail price per million input tokens, in major units (e.g. 3.00 = $3.00/M). Drives Revenue. Auto-derived from cost + margin; editable.">
                <Input id="m-ipm" type="number" min={0} step="any" value={form.inputUnits} onChange={(e) => setPriceField(setForm, "inputUnits", e.target.value)} onFocus={selectOnFocus} required disabled={saving} />
                <UnitsPreview value={form.inputUnits} currency={form.currency} suffix="/ 1M tokens" />
              </Field>
              <Field id="m-opm" label="Output price ($/M)" tooltip="Retail price per million output tokens.">
                <Input id="m-opm" type="number" min={0} step="any" value={form.outputUnits} onChange={(e) => setPriceField(setForm, "outputUnits", e.target.value)} onFocus={selectOnFocus} required disabled={saving} />
                <UnitsPreview value={form.outputUnits} currency={form.currency} suffix="/ 1M tokens" />
              </Field>
              <Field id="m-cread" label="Cache read price ($/M)" optional tooltip="Price per million cached-input tokens. Blank = billed as regular input.">
                <Input id="m-cread" type="number" min={0} step="any" value={form.cacheReadUnits} placeholder="blank" onChange={(e) => setPriceField(setForm, "cacheReadUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-cwrite" label="Cache write price ($/M)" optional tooltip="Price per million cache-creation tokens. Blank = not billed separately.">
                <Input id="m-cwrite" type="number" min={0} step="any" value={form.cacheWriteUnits} placeholder="blank" onChange={(e) => setPriceField(setForm, "cacheWriteUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-reason" label="Reasoning price ($/M)" optional tooltip="Price per million reasoning tokens. Blank = billed at the output rate.">
                <Input id="m-reason" type="number" min={0} step="any" value={form.reasoningUnits} placeholder="blank" onChange={(e) => setPriceField(setForm, "reasoningUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-iaudio" label="Input audio price ($/M)" optional tooltip="Price per million audio-input tokens.">
                <Input id="m-iaudio" type="number" min={0} step="any" value={form.inputAudioUnits} placeholder="blank" onChange={(e) => setPriceField(setForm, "inputAudioUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
              <Field id="m-oaudio" label="Output audio price ($/M)" optional tooltip="Price per million audio-output tokens.">
                <Input id="m-oaudio" type="number" min={0} step="any" value={form.outputAudioUnits} placeholder="blank" onChange={(e) => setPriceField(setForm, "outputAudioUnits", e.target.value)} onFocus={selectOnFocus} disabled={saving} />
              </Field>
            </div>
          </div>
        </div>

        {isCreate ? (
          <>
            <SectionTitle>Primary provider entry</SectionTitle>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="m-prov" label="Provider">
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
              </Field>
              <Field id="m-up" label="Upstream model id">
                <UpstreamModelPicker
                  id="m-up"
                  providerId={form.firstProviderId}
                  value={form.firstUpstreamModelId}
                  onChange={(v) => setField(setForm, "firstUpstreamModelId", v)}
                  disabled={saving}
                />
              </Field>
            </div>
          </>
        ) : null}

        <MetadataSection form={form} setForm={setForm} saving={saving} />

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="-mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t border-rule px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6">
          {canWrite && !isCreate && model ? (
            <Button type="button" variant="ghost-destructive" className="mr-auto" onClick={() => void onDelete(model)} disabled={saving}>
              <Trash2 />
              Delete model
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
            {canWrite ? "Cancel" : "Back"}
          </Button>
          {canWrite ? (
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isCreate ? "Create model" : "Save changes"}
            </Button>
          ) : null}
        </div>
      </form>

      {!isCreate && model ? (
        <ProviderRouting
          model={model}
          providers={providers}
          providerMap={providerMap}
          canWrite={canWrite}
          onModelReplaced={onModelReplaced}
        />
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <h2 className="-mb-1 border-b border-rule pb-2 pt-1 text-[15px] font-semibold first:pt-0">
      {children}
    </h2>
  );
}

/** Live margin of the input price over the input cost (both from the form). */
function FormMarginScale({ cost, price, currency }: { cost: string; price: string; currency: string }): React.ReactElement | null {
  const c = Number(cost);
  const p = Number(price);
  if (cost.trim() === "" || price.trim() === "" || !Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
  const m = (p - c) / p;
  return (
    <div className="py-1 lg:col-span-2">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">Input margin · {currency.toUpperCase() || "—"}</span>
        <span className={cn("font-semibold tabular-nums", m < 0 && "text-destructive")}>{(m * 100).toFixed(1)}%</span>
      </div>
      <Scale
        value={Math.max(0, m)}
        label="Input price margin over cost"
        valueText={`${(m * 100).toFixed(1)}%`}
        marks={["0%", "25%", "50%", "75%", "100%"]}
        tone={m < 0 ? "destructive" : "signal"}
      />
    </div>
  );
}

function MetadataSection({
  form,
  setForm,
  saving,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
}): React.ReactElement {
  const rows = form.metadataRows;
  const atMax = rows.length >= METADATA_MAX_ENTRIES;
  const corrupt = form.metadataSourceMalformed;

  /** Any metadata mutation means the user is intentionally setting the map. */
  const touchMetadata = (
    updater: (prev: FormState) => Pick<FormState, "metadataRows">,
  ) => {
    setForm((prev) => ({
      ...prev,
      ...updater(prev),
      metadataSourceMalformed: false,
      metadataCorruptReason: null,
    }));
  };

  const addRow = () => {
    if (atMax || saving) return;
    touchMetadata((prev) => ({
      metadataRows: [
        ...prev.metadataRows,
        { id: newMetadataRowId(), key: "", value: "" },
      ],
    }));
  };

  const clearAll = () => {
    if (saving) return;
    touchMetadata(() => ({ metadataRows: [] }));
  };

  const removeRow = (id: string) => {
    if (saving) return;
    touchMetadata((prev) => ({
      metadataRows: prev.metadataRows.filter((r) => r.id !== id),
    }));
  };

  const updateRow = (id: string, field: "key" | "value", value: string) => {
    touchMetadata((prev) => ({
      metadataRows: prev.metadataRows.map((r) =>
        r.id === id ? { ...r, [field]: value } : r,
      ),
    }));
  };

  return (
    <>
      <SectionTitle>Metadata</SectionTitle>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Custom string properties for this model (for example cost tier or
          intelligence label). Metadata is plain configuration, visible to
          organization members — do not store secrets, API keys, or passwords.
          Names are single-line; values may include line breaks.
        </p>
        {corrupt ? (
          <Alert variant="destructive">
            <AlertDescription>
              {form.metadataCorruptReason ??
                "Stored metadata is malformed and cannot be edited safely."}{" "}
              Saving other fields will not change metadata. Use Clear all or Add
              metadata, then Save, to replace it.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={saving || atMax}
            aria-label="Add metadata row"
          >
            <Plus className="size-4" />
            Add metadata
          </Button>
          {rows.length > 0 || corrupt ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAll}
              disabled={saving}
              aria-label="Clear all metadata"
            >
              Clear all
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {corrupt ? "No editable rows (source malformed)." : "No metadata pairs yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((row, index) => {
              const fieldErrs = metadataRowFieldErrors(row, rows);
              const keyErrorId = `m-meta-key-err-${row.id}`;
              const valErrorId = `m-meta-val-err-${row.id}`;
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
                >
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`m-meta-key-${row.id}`} className="sr-only">
                      Metadata name {index + 1}
                    </Label>
                    <Input
                      id={`m-meta-key-${row.id}`}
                      type="text"
                      value={row.key}
                      placeholder="Name"
                      maxLength={METADATA_KEY_MAX_LEN + 8}
                      onChange={(e) => updateRow(row.id, "key", e.target.value)}
                      disabled={saving}
                      aria-label={`Metadata name ${index + 1}`}
                      aria-invalid={fieldErrs.key ? true : undefined}
                      aria-describedby={fieldErrs.key ? keyErrorId : undefined}
                      className={cn(fieldErrs.key && "border-destructive")}
                    />
                    {fieldErrs.key ? (
                      <p id={keyErrorId} className="text-xs text-destructive" role="alert">
                        {fieldErrs.key}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`m-meta-val-${row.id}`} className="sr-only">
                      Metadata value {index + 1}
                    </Label>
                    <Textarea
                      id={`m-meta-val-${row.id}`}
                      rows={2}
                      value={row.value}
                      placeholder="Value"
                      // No maxLength: browser counts raw CR/LF; limit is enforced
                      // on the normalized (LF) length in metadataRowFieldErrors.
                      onChange={(e) => updateRow(row.id, "value", e.target.value)}
                      disabled={saving}
                      aria-label={`Metadata value ${index + 1}`}
                      aria-invalid={fieldErrs.value ? true : undefined}
                      aria-describedby={fieldErrs.value ? valErrorId : undefined}
                      className={cn(
                        "min-h-[2.5rem] resize-y",
                        fieldErrs.value && "border-destructive",
                      )}
                    />
                    {fieldErrs.value ? (
                      <p id={valErrorId} className="text-xs text-destructive" role="alert">
                        {fieldErrs.value}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive sm:mt-0.5"
                    onClick={() => removeRow(row.id)}
                    disabled={saving}
                    aria-label={`Remove metadata row ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {atMax ? (
          <p className="text-xs text-muted-foreground">
            Maximum of {METADATA_MAX_ENTRIES} metadata pairs reached.
          </p>
        ) : null}
      </div>
    </>
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

interface ProviderRoutingProps {
  model: Model;
  providers: Provider[];
  providerMap: Map<string, Provider>;
  canWrite: boolean;
  onModelReplaced: () => void;
}

function ProviderRouting({
  model,
  providers,
  providerMap,
  canWrite,
  onModelReplaced,
}: ProviderRoutingProps): React.ReactElement {
  const confirm = useConfirm();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const entries = model.entries;

  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      if (!canWrite) return;
      setDragIndex(index);
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", String(index));
      } catch {
        /* some browsers throw without user gesture */
      }
    },
    [canWrite],
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
        await modelsApi.reorderFallbacks(model._id, payload);
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
        await modelsApi.reorderFallbacks(model._id, payload);
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
      const ok = await confirm({
        title: `Remove ${entry.upstreamModelId} from routing?`,
        description: "Requests stop falling back to this provider model. You can add it again later.",
        confirmLabel: "Remove route",
        destructive: true,
      });
      if (!ok) return;
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
    [model._id, model.entries.length, onModelReplaced, confirm],
  );

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold">Provider routing</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {canWrite
              ? "Requests try route 1 first and fall back in order. Drag to reorder."
              : "Requests try route 1 first and fall back in order."}
          </p>
        </div>
        {canWrite ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAdd((v) => !v)}
            disabled={reordering}
          >
            {showAdd ? "Cancel" : <><Plus />Add route</>}
          </Button>
        ) : null}
      </div>

      {chainError ? (
        <Alert variant="destructive">
          <AlertDescription>{chainError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-visible rounded-lg border border-border bg-background">
        {entries.length === 0 ? (
          <div className="px-5 py-5 text-center text-sm text-muted-foreground">No routes.</div>
        ) : (
          <>
            <div
              className={cn(
                dropTarget === 0 && dragIndex !== 0 ? "h-0.5 bg-signal" : "h-0",
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
                  {showIndicator ? <div className="h-0.5 bg-signal" /> : null}
                  <div
                    className={cn(
                      "flex items-stretch border-b border-rule bg-card transition-colors first:rounded-t-lg last:rounded-b-lg last:border-b-0",
                      isDragging && "bg-muted opacity-50",
                      !entry.active && "bg-transparent",
                    )}
                    draggable={canWrite}
                    onDragStart={(e) => onDragStart(e, index)}
                    onDragOver={(e) => onDragOver(e, index)}
                    onDrop={(e) => onDrop(e, index)}
                    onDragEnd={onDragEnd}
                  >
                    {canWrite ? (
                      <div
                        className="flex w-9 shrink-0 cursor-grab select-none items-center justify-center border-r border-rule text-muted-foreground hover:text-foreground active:cursor-grabbing"
                        aria-label="Drag to reorder"
                        title="Drag to reorder"
                      >
                        <GripVertical className="size-4" />
                      </div>
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col gap-2 px-3.5 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={cn(
                            "inline-flex h-6 min-w-6 items-center justify-center rounded-[5px] px-1.5 text-xs font-semibold tabular-nums",
                            entry.active ? "bg-foreground text-background" : "border border-border text-muted-foreground",
                          )}
                          title={`Priority ${entry.priority}`}
                        >
                          {index + 1}
                        </span>
                        <span className={cn("text-sm font-semibold", !entry.active && "text-muted-foreground line-through decoration-1")}>{provider?.name ?? "Unknown provider"}</span>
                        <span className="font-mono text-xs text-muted-foreground">{entry.upstreamModelId}</span>
                        <div className="ml-auto flex items-center gap-2">
                          {canWrite ? (
                            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                              <Checkbox
                                checked={entry.active}
                                onCheckedChange={(v) => void onActiveToggle(entry, v === true)}
                                disabled={reordering}
                              />
                              In use
                            </label>
                          ) : (
                            <Badge variant={entry.active ? "success" : "off"}>
                              {entry.active ? "In use" : "Off"}
                            </Badge>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            aria-expanded={expanded.has(entry.id)}
                            onClick={() => toggleExpand(entry.id)}
                          >
                            {expanded.has(entry.id) ? "Hide rates" : "Rates"}
                          </Button>
                          {canWrite ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setEditingEntryId(editingEntryId === entry.id ? null : entry.id)}
                              disabled={reordering}
                              aria-label="Edit"
                            >
                              <Pencil className="size-4" />
                            </Button>
                          ) : null}
                          {canWrite ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => void onRemoveEntry(entry)}
                              disabled={reordering}
                              aria-label="Remove"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {expanded.has(entry.id) ? <EntryCostPrice entry={entry} /> : null}
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span className="tabular-nums">Cost in/out: {entry.cost ? `${formatMicrosToMajor(entry.cost.inputMicrosPerMillion)} / ${formatMicrosToMajor(entry.cost.outputMicrosPerMillion)}` : "model default"}</span>
                        <span className="tabular-nums">Price in/out: {entry.price ? `${formatMicrosToMajor(entry.price.inputMicrosPerMillion)} / ${formatMicrosToMajor(entry.price.outputMicrosPerMillion)}` : "model default"}</span>
                      </div>
                      {editingEntryId === entry.id ? (
                        <EditEntryForm
                          modelId={model._id}
                          entry={entry}
                          allEntries={entries}
                          onSaved={() => {
                            setEditingEntryId(null);
                            onModelReplaced();
                          }}
                          onCancel={() => setEditingEntryId(null)}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {canWrite && showAdd ? (
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
function ScheduleRates({ label, schedule }: { label: string; schedule?: TokenPriceSchedule | undefined }): React.ReactElement {
  const rows: Array<[string, number | undefined]> = [
    ["input", schedule?.inputMicrosPerMillion],
    ["output", schedule?.outputMicrosPerMillion],
    ["cache read", schedule?.cacheReadMicrosPerMillion],
    ["cache write", schedule?.cacheWriteMicrosPerMillion],
    ["reasoning", schedule?.reasoningMicrosPerMillion],
    ["audio in", schedule?.inputAudioMicrosPerMillion],
    ["audio out", schedule?.outputAudioMicrosPerMillion],
  ];
  return (
    <div>
      <div className="legend mb-1 text-muted-foreground">{label}</div>
      <div className="grid grid-cols-2 gap-x-3 font-mono text-xs">
        {rows.map(([name, rate]) => (
          <span key={name} className={rate === undefined ? "text-muted-foreground/60" : undefined}>
            {name}={rate ?? "—"}
          </span>
        ))}
      </div>
    </div>
  );
}

function EntryCostPrice({ entry }: { entry: ModelEntry }): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-2.5 pt-1 sm:grid-cols-2">
      <ScheduleRates label="Cost override (micros / 1M)" schedule={entry.cost} />
      <ScheduleRates label="Price override (micros / 1M)" schedule={entry.price} />
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
  marginBps: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  costReasoning: string;
  costInputAudio: string;
  costOutputAudio: string;
  priceInput: string;
  priceOutput: string;
  priceCacheRead: string;
  priceCacheWrite: string;
  priceReasoning: string;
  priceInputAudio: string;
  priceOutputAudio: string;
  active: boolean;
}

function emptyAddEntry(): AddEntryState {
  return {
    providerId: "",
    upstreamModelId: "",
    marginBps: "0",
    costInput: "",
    costOutput: "",
    costCacheRead: "",
    costCacheWrite: "",
    costReasoning: "",
    costInputAudio: "",
    costOutputAudio: "",
    priceInput: "",
    priceOutput: "",
    priceCacheRead: "",
    priceCacheWrite: "",
    priceReasoning: "",
    priceInputAudio: "",
    priceOutputAudio: "",
    active: true,
  };
}

function AddEntryForm({ modelId, providers, onAdded }: AddEntryFormProps): React.ReactElement {
  const [state, setState] = useState<AddEntryState>(emptyAddEntry);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);


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

      let cIn: number;
      let cOut: number;
      if (state.costInput !== "" || state.costOutput !== "") {
        try {
          cIn = parseMajorToMicros(state.costInput === "" ? "0" : state.costInput);
          cOut = parseMajorToMicros(state.costOutput === "" ? "0" : state.costOutput);
        } catch {
          setError("Cost input/output must be non-negative decimals (≤6 dp).");
          return;
        }
        const cost: TokenPriceSchedule = {
          inputMicrosPerMillion: cIn,
          outputMicrosPerMillion: cOut,
        };
        const optionalCost: Array<[keyof TokenPriceSchedule, string]> = [
          ["cacheReadMicrosPerMillion", state.costCacheRead],
          ["cacheWriteMicrosPerMillion", state.costCacheWrite],
          ["reasoningMicrosPerMillion", state.costReasoning],
          ["inputAudioMicrosPerMillion", state.costInputAudio],
          ["outputAudioMicrosPerMillion", state.costOutputAudio],
        ];
        for (const [key, raw] of optionalCost) {
          if (raw.trim() === "") continue;
          try {
            cost[key] = parseMajorToMicros(raw);
          } catch {
            setError("Optional cost rates must be non-negative decimals (≤6 dp).");
            return;
          }
        }
        body.cost = cost;
      } else if (
        state.costCacheRead !== "" ||
        state.costCacheWrite !== "" ||
        state.costReasoning !== "" ||
        state.costInputAudio !== "" ||
        state.costOutputAudio !== ""
      ) {
        setError("Set cost input/output before adding optional cost rates.");
        return;
      }

      let pIn: number;
      let pOut: number;
      if (state.priceInput !== "" || state.priceOutput !== "") {
        try {
          pIn = parseMajorToMicros(state.priceInput === "" ? "0" : state.priceInput);
          pOut = parseMajorToMicros(state.priceOutput === "" ? "0" : state.priceOutput);
        } catch {
          setError("Price input/output must be non-negative decimals (≤6 dp).");
          return;
        }
        const price: TokenPriceSchedule = {
          inputMicrosPerMillion: pIn,
          outputMicrosPerMillion: pOut,
        };
        const optionalPrice: Array<[keyof TokenPriceSchedule, string]> = [
          ["cacheReadMicrosPerMillion", state.priceCacheRead],
          ["cacheWriteMicrosPerMillion", state.priceCacheWrite],
          ["reasoningMicrosPerMillion", state.priceReasoning],
          ["inputAudioMicrosPerMillion", state.priceInputAudio],
          ["outputAudioMicrosPerMillion", state.priceOutputAudio],
        ];
        for (const [key, raw] of optionalPrice) {
          if (raw.trim() === "") continue;
          try {
            price[key] = parseMajorToMicros(raw);
          } catch {
            setError("Optional price rates must be non-negative decimals (≤6 dp).");
            return;
          }
        }
        body.price = price;
      } else if (
        state.priceCacheRead !== "" ||
        state.priceCacheWrite !== "" ||
        state.priceReasoning !== "" ||
        state.priceInputAudio !== "" ||
        state.priceOutputAudio !== ""
      ) {
        setError("Set price input/output before adding optional price rates.");
        return;
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
    <form className="mt-3 flex flex-col gap-3 rounded-lg border border-dashed border-border bg-background p-4" onSubmit={submit}>
      <SectionTitle>New provider entry</SectionTitle>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ae-prov" label="Provider">
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
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-up">Upstream model id</Label>
          <UpstreamModelPicker
            id="ae-up"
            providerId={state.providerId}
            value={state.upstreamModelId}
            onChange={(v) => setState((s) => ({ ...s, upstreamModelId: v }))}
            disabled={submitting}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="ae-margin" label="Margin (bps)" optional tooltip="Markup over cost (100 = 1%). Blank = 0. Changing this re-derives price fields from cost; you can still edit price directly.">
          <Input
            id="ae-margin"
            type="number"
            min={0}
            value={state.marginBps}
            onChange={(e) => {
              const marginBps = e.target.value;
              setState((s) => ({
                ...s,
                marginBps,
                priceInput: priceFromCostMargin(s.costInput, marginBps) ?? s.priceInput,
                priceOutput: priceFromCostMargin(s.costOutput, marginBps) ?? s.priceOutput,
                priceCacheRead: priceFromCostMargin(s.costCacheRead, marginBps) ?? s.priceCacheRead,
                priceCacheWrite: priceFromCostMargin(s.costCacheWrite, marginBps) ?? s.priceCacheWrite,
                priceReasoning: priceFromCostMargin(s.costReasoning, marginBps) ?? s.priceReasoning,
                priceInputAudio: priceFromCostMargin(s.costInputAudio, marginBps) ?? s.priceInputAudio,
                priceOutputAudio: priceFromCostMargin(s.costOutputAudio, marginBps) ?? s.priceOutputAudio,
              }));
            }}
            onFocus={selectOnFocus}
            disabled={submitting}
          />
        </Field>
        <Field id="ae-cin" label="Cost input ($/M)" optional>
          <Input id="ae-cin" type="number" min={0} step="any" value={state.costInput} onChange={(e) => setState((s) => ({ ...s, costInput: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-cout" label="Cost output ($/M)" optional>
          <Input id="ae-cout" type="number" min={0} step="any" value={state.costOutput} onChange={(e) => setState((s) => ({ ...s, costOutput: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-ccr" label="Cost cache read ($/M)" optional tooltip="Requires cost input/output. Per-million rate for cache-hit input tokens.">
          <Input id="ae-ccr" type="number" min={0} step="any" value={state.costCacheRead} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, costCacheRead: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-ccw" label="Cost cache write ($/M)" optional tooltip="Requires cost input/output. Anthropic cache-creation tokens.">
          <Input id="ae-ccw" type="number" min={0} step="any" value={state.costCacheWrite} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, costCacheWrite: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-crs" label="Cost reasoning ($/M)" optional tooltip="Requires cost input/output. Hidden reasoning tokens.">
          <Input id="ae-crs" type="number" min={0} step="any" value={state.costReasoning} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, costReasoning: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-cain" label="Cost audio in ($/M)" optional tooltip="Requires cost input/output. Per-million rate for audio input tokens.">
          <Input id="ae-cain" type="number" min={0} step="any" value={state.costInputAudio} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, costInputAudio: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-caout" label="Cost audio out ($/M)" optional tooltip="Requires cost input/output. Per-million rate for audio output tokens.">
          <Input id="ae-caout" type="number" min={0} step="any" value={state.costOutputAudio} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, costOutputAudio: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-pin" label="Price input ($/M)" optional>
          <Input id="ae-pin" type="number" min={0} step="any" value={state.priceInput} onChange={(e) => setState((s) => ({ ...s, priceInput: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-pout" label="Price output ($/M)" optional>
          <Input id="ae-pout" type="number" min={0} step="any" value={state.priceOutput} onChange={(e) => setState((s) => ({ ...s, priceOutput: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-pcr" label="Price cache read ($/M)" optional tooltip="Requires price input/output. What the customer pays per million cache-hit tokens.">
          <Input id="ae-pcr" type="number" min={0} step="any" value={state.priceCacheRead} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, priceCacheRead: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-pcw" label="Price cache write ($/M)" optional tooltip="Requires price input/output. What the customer pays per million cache-creation tokens.">
          <Input id="ae-pcw" type="number" min={0} step="any" value={state.priceCacheWrite} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, priceCacheWrite: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-prs" label="Price reasoning ($/M)" optional tooltip="Requires price input/output. What the customer pays per million reasoning tokens.">
          <Input id="ae-prs" type="number" min={0} step="any" value={state.priceReasoning} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, priceReasoning: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-pain" label="Price audio in ($/M)" optional tooltip="Requires price input/output. What the customer pays per million audio input tokens.">
          <Input id="ae-pain" type="number" min={0} step="any" value={state.priceInputAudio} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, priceInputAudio: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ae-paout" label="Price audio out ($/M)" optional tooltip="Requires price input/output. What the customer pays per million audio output tokens.">
          <Input id="ae-paout" type="number" min={0} step="any" value={state.priceOutputAudio} placeholder="blank" onChange={(e) => setState((s) => ({ ...s, priceOutputAudio: e.target.value }))} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
      </div>

      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
        <Checkbox checked={state.active} onCheckedChange={(v) => setState((s) => ({ ...s, active: v === true }))} disabled={submitting} />
        Active in provider routing
      </label>

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>{submitting ? "Adding…" : "Add entry"}</Button>
      </div>
    </form>
  );
}

interface EditEntryFormProps {
  modelId: string;
  entry: ModelEntry;
  allEntries: ModelEntry[];
  onSaved: () => void;
  onCancel: () => void;
}

function microsToInput(micros: number | undefined): string {
  return micros !== undefined ? formatMicrosToMajor(micros) : "";
}

function EditEntryForm({ modelId, entry, allEntries, onSaved, onCancel }: EditEntryFormProps): React.ReactElement {
  const [upstreamModelId, setUpstreamModelId] = useState(entry.upstreamModelId);
  const [costInput, setCostInput] = useState(microsToInput(entry.cost?.inputMicrosPerMillion));
  const [costOutput, setCostOutput] = useState(microsToInput(entry.cost?.outputMicrosPerMillion));
  const [costCacheRead, setCostCacheRead] = useState(microsToInput(entry.cost?.cacheReadMicrosPerMillion));
  const [costCacheWrite, setCostCacheWrite] = useState(microsToInput(entry.cost?.cacheWriteMicrosPerMillion));
  const [costReasoning, setCostReasoning] = useState(microsToInput(entry.cost?.reasoningMicrosPerMillion));
  const [costInputAudio, setCostInputAudio] = useState(microsToInput(entry.cost?.inputAudioMicrosPerMillion));
  const [costOutputAudio, setCostOutputAudio] = useState(microsToInput(entry.cost?.outputAudioMicrosPerMillion));
  const [priceInput, setPriceInput] = useState(microsToInput(entry.price?.inputMicrosPerMillion));
  const [priceOutput, setPriceOutput] = useState(microsToInput(entry.price?.outputMicrosPerMillion));
  const [priceCacheRead, setPriceCacheRead] = useState(microsToInput(entry.price?.cacheReadMicrosPerMillion));
  const [priceCacheWrite, setPriceCacheWrite] = useState(microsToInput(entry.price?.cacheWriteMicrosPerMillion));
  const [priceReasoning, setPriceReasoning] = useState(microsToInput(entry.price?.reasoningMicrosPerMillion));
  const [priceInputAudio, setPriceInputAudio] = useState(microsToInput(entry.price?.inputAudioMicrosPerMillion));
  const [priceOutputAudio, setPriceOutputAudio] = useState(microsToInput(entry.price?.outputAudioMicrosPerMillion));
  const [active, setActive] = useState(entry.active);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmedUpstream = upstreamModelId.trim();
      if (!trimmedUpstream) {
        setError("Upstream model id is required.");
        return;
      }

      const updatedEntry: Record<string, unknown> = {
        id: entry.id,
        providerId: entry.providerId,
        upstreamModelId: trimmedUpstream,
        priority: entry.priority,
        active,
      };

      // Build cost override
      if (costInput !== "" || costOutput !== "") {
        try {
          const cIn = parseMajorToMicros(costInput === "" ? "0" : costInput);
          const cOut = parseMajorToMicros(costOutput === "" ? "0" : costOutput);
          const cost: Record<string, number> = {
            inputMicrosPerMillion: cIn,
            outputMicrosPerMillion: cOut,
          };
          const optCost: Array<[string, string]> = [
            ["cacheReadMicrosPerMillion", costCacheRead],
            ["cacheWriteMicrosPerMillion", costCacheWrite],
            ["reasoningMicrosPerMillion", costReasoning],
            ["inputAudioMicrosPerMillion", costInputAudio],
            ["outputAudioMicrosPerMillion", costOutputAudio],
          ];
          for (const [key, raw] of optCost) {
            if (raw.trim() === "") continue;
            cost[key] = parseMajorToMicros(raw);
          }
          updatedEntry.cost = cost;
        } catch {
          setError("Cost values must be non-negative decimals (≤6 dp).");
          return;
        }
      } else if (
        costCacheRead !== "" ||
        costCacheWrite !== "" ||
        costReasoning !== "" ||
        costInputAudio !== "" ||
        costOutputAudio !== ""
      ) {
        setError("Set cost input/output before adding optional cost rates.");
        return;
      }

      // Build price override
      if (priceInput !== "" || priceOutput !== "") {
        try {
          const pIn = parseMajorToMicros(priceInput === "" ? "0" : priceInput);
          const pOut = parseMajorToMicros(priceOutput === "" ? "0" : priceOutput);
          const price: Record<string, number> = {
            inputMicrosPerMillion: pIn,
            outputMicrosPerMillion: pOut,
          };
          const optPrice: Array<[string, string]> = [
            ["cacheReadMicrosPerMillion", priceCacheRead],
            ["cacheWriteMicrosPerMillion", priceCacheWrite],
            ["reasoningMicrosPerMillion", priceReasoning],
            ["inputAudioMicrosPerMillion", priceInputAudio],
            ["outputAudioMicrosPerMillion", priceOutputAudio],
          ];
          for (const [key, raw] of optPrice) {
            if (raw.trim() === "") continue;
            price[key] = parseMajorToMicros(raw);
          }
          updatedEntry.price = price;
        } catch {
          setError("Price values must be non-negative decimals (≤6 dp).");
          return;
        }
      } else if (
        priceCacheRead !== "" ||
        priceCacheWrite !== "" ||
        priceReasoning !== "" ||
        priceInputAudio !== "" ||
        priceOutputAudio !== ""
      ) {
        setError("Set price input/output before adding optional price rates.");
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        const updatedEntries = allEntries.map((e) =>
          e.id === entry.id ? updatedEntry : e,
        );
        await patchJson(`/admin/models/${modelId}`, { entries: updatedEntries });
        onSaved();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Update failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [upstreamModelId, costInput, costOutput, costCacheRead, costCacheWrite, costReasoning, costInputAudio, costOutputAudio, priceInput, priceOutput, priceCacheRead, priceCacheWrite, priceReasoning, priceInputAudio, priceOutputAudio, active, entry, allEntries, modelId, onSaved],
  );

  return (
    <form className="mt-2 flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-4" onSubmit={submit}>
      <SectionTitle>Edit entry overrides</SectionTitle>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ee-up" label="Upstream model id">
          <Input id="ee-up" type="text" value={upstreamModelId} onChange={(e) => setUpstreamModelId(e.target.value)} required disabled={submitting} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="ee-cin" label="Cost input ($/M)" optional>
          <Input id="ee-cin" type="number" min={0} step="any" value={costInput} onChange={(e) => setCostInput(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-cout" label="Cost output ($/M)" optional>
          <Input id="ee-cout" type="number" min={0} step="any" value={costOutput} onChange={(e) => setCostOutput(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-ccr" label="Cost cache read ($/M)" optional>
          <Input id="ee-ccr" type="number" min={0} step="any" value={costCacheRead} placeholder="blank" onChange={(e) => setCostCacheRead(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-ccw" label="Cost cache write ($/M)" optional>
          <Input id="ee-ccw" type="number" min={0} step="any" value={costCacheWrite} placeholder="blank" onChange={(e) => setCostCacheWrite(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-crs" label="Cost reasoning ($/M)" optional>
          <Input id="ee-crs" type="number" min={0} step="any" value={costReasoning} placeholder="blank" onChange={(e) => setCostReasoning(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-cain" label="Cost audio in ($/M)" optional>
          <Input id="ee-cain" type="number" min={0} step="any" value={costInputAudio} placeholder="blank" onChange={(e) => setCostInputAudio(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-caout" label="Cost audio out ($/M)" optional>
          <Input id="ee-caout" type="number" min={0} step="any" value={costOutputAudio} placeholder="blank" onChange={(e) => setCostOutputAudio(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-pin" label="Price input ($/M)" optional>
          <Input id="ee-pin" type="number" min={0} step="any" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-pout" label="Price output ($/M)" optional>
          <Input id="ee-pout" type="number" min={0} step="any" value={priceOutput} onChange={(e) => setPriceOutput(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-pcr" label="Price cache read ($/M)" optional>
          <Input id="ee-pcr" type="number" min={0} step="any" value={priceCacheRead} placeholder="blank" onChange={(e) => setPriceCacheRead(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-pcw" label="Price cache write ($/M)" optional>
          <Input id="ee-pcw" type="number" min={0} step="any" value={priceCacheWrite} placeholder="blank" onChange={(e) => setPriceCacheWrite(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-prs" label="Price reasoning ($/M)" optional>
          <Input id="ee-prs" type="number" min={0} step="any" value={priceReasoning} placeholder="blank" onChange={(e) => setPriceReasoning(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-pain" label="Price audio in ($/M)" optional>
          <Input id="ee-pain" type="number" min={0} step="any" value={priceInputAudio} placeholder="blank" onChange={(e) => setPriceInputAudio(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
        <Field id="ee-paout" label="Price audio out ($/M)" optional>
          <Input id="ee-paout" type="number" min={0} step="any" value={priceOutputAudio} placeholder="blank" onChange={(e) => setPriceOutputAudio(e.target.value)} onFocus={selectOnFocus} disabled={submitting} />
        </Field>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
        <Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} disabled={submitting} />
        Active in provider routing
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" disabled={submitting}>{submitting ? "Saving…" : "Save changes"}</Button>
      </div>
    </form>
  );
}