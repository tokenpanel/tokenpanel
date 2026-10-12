import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreditCard, Plus, ShieldCheck, X } from "lucide-react";
import { Panel, PanelHeader, SpecList } from "@/components/Instrument";
import { WindowRuler, type WindowMarker } from "@/components/Scale";
import { useConfirm } from "@/components/ConfirmDialog";
import { CurrencySelect } from "@/components/CurrencySelect";
import { ModelAliasSelect } from "@/components/ModelPickers";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { formatMicros } from "../utils/format.ts";
import { limitCaption } from "../utils/limits.ts";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";

import {
  PLAN_INTERVALS,
  findDuplicateRateLimitStream,
  duplicateRateLimitStreamMessage,
  parseMajorToMicros,
  formatMicrosToMajor,
  type PlanInterval,
} from "@tokenpanel/contracts";

type Interval = PlanInterval;
type Dimension = "tokens" | "requests" | "spend_units" | "spend_micros";
type Scope = "customer" | "plan" | "model";

interface Money {
  amountMicros: number;
  currency: string;
}

interface RateLimitRule {
  id: string;
  windowSeconds: number;
  dimension: Dimension;
  capValue: number;
  scope: Scope;
  scopeTarget?: string | null;
  currency?: string | null;
  active: boolean;
}

interface Plan {
  _id: string;
  organizationId: string;
  name: string;
  description?: string | null;
  price: Money;
  interval: Interval;
  intervalCount: number;
  includedCredit: Money;
  includedTokens: number;
  rateLimits: RateLimitRule[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PlanListResponse {
  items: Plan[];
}

interface PlansResponse {
  ok?: boolean;
  error?: string;
  message?: string;
}

const INTERVALS: readonly Interval[] = PLAN_INTERVALS;
const DIMENSIONS: readonly Dimension[] = ["tokens", "requests", "spend_micros"];
const SCOPES: readonly Scope[] = ["customer", "plan", "model"];

const WINDOW_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: "1h", seconds: 3600 },
  { label: "5h", seconds: 18000 },
  { label: "1d", seconds: 86400 },
  { label: "1w", seconds: 604800 },
  { label: "30d", seconds: 2592000 },
];

const DIMENSION_CAP_LABEL: Record<Dimension, string> = {
  tokens: "Max tokens",
  requests: "Max requests",
  spend_units: "Max spend",
  spend_micros: "Max spend",
};

const DIMENSION_LABEL: Record<Dimension, string> = {
  tokens: "Tokens",
  requests: "Requests",
  spend_units: "Spend",
  spend_micros: "Spend",
};

const SCOPE_LABEL: Record<Scope, string> = {
  customer: "Each customer",
  plan: "Each subscriber (plan)",
  model: "One model",
};

/** Spend dimensions carry a currency + decimal major-unit cap. */
function isSpendDimension(d: Dimension): boolean {
  return d === "spend_units" || d === "spend_micros";
}

let ruleIdCounter = 0;
function nextRuleId(): string {
  ruleIdCounter += 1;
  return `rl-${Date.now().toString(36)}-${ruleIdCounter.toString(36)}`;
}

interface DraftRule {
  id: string;
  windowSeconds: string;
  dimension: Dimension;
  capValue: string;
  scope: Scope;
  scopeTarget: string;
  currency: string;
  active: boolean;
}

interface DraftPlan {
  name: string;
  description: string;
  priceAmount: string;
  priceCurrency: string;
  interval: Interval;
  intervalCount: string;
  includedCreditAmount: string;
  includedCreditCurrency: string;
  includedTokens: string;
  rateLimits: DraftRule[];
}

function emptyDraft(): DraftPlan {
  return {
    name: "",
    description: "",
    priceAmount: "0",
    priceCurrency: "USD",
    interval: "month",
    intervalCount: "1",
    includedCreditAmount: "0",
    includedCreditCurrency: "USD",
    includedTokens: "0",
    rateLimits: [],
  };
}

function planToDraft(plan: Plan): DraftPlan {
  return {
    name: plan.name,
    description: plan.description ?? "",
    priceAmount: formatMicrosToMajor(plan.price.amountMicros),
    priceCurrency: plan.price.currency,
    interval: plan.interval,
    intervalCount: String(plan.intervalCount),
    includedCreditAmount: formatMicrosToMajor(plan.includedCredit.amountMicros),
    includedCreditCurrency: plan.includedCredit.currency,
    includedTokens: String(plan.includedTokens),
    rateLimits: plan.rateLimits.map((r) => ({
      id: r.id,
      windowSeconds: String(r.windowSeconds),
      dimension: r.dimension,
      capValue: isSpendDimension(r.dimension) ? formatMicrosToMajor(r.capValue) : String(r.capValue),
      scope: r.scope,
      scopeTarget: r.scopeTarget ?? "",
      currency: r.currency ?? "USD",
      active: r.active,
    })),
  };
}

export function toApiRule(rule: DraftRule) {
  const spend = isSpendDimension(rule.dimension);
  return {
    id: rule.id || undefined,
    windowSeconds: Number(rule.windowSeconds),
    dimension: rule.dimension,
    capValue: spend ? parseMajorToMicros(rule.capValue) : Number(rule.capValue),
    scope: rule.scope,
    scopeTarget: rule.scopeTarget.trim() || undefined,
    currency: spend ? rule.currency.toUpperCase() || undefined : undefined,
    active: rule.active,
  };
}

export function validateDraft(draft: DraftPlan): string | null {
  if (!draft.name.trim()) return "Name is required.";
  try {
    parseMajorToMicros(draft.priceAmount);
  } catch {
    return "Price must be a non-negative decimal (major units, ≤6 dp).";
  }
  if (!/^[A-Z]{3}$/.test(draft.priceCurrency.toUpperCase())) return "Price currency must be a 3-letter code.";
  const intervalCount = Number(draft.intervalCount);
  if (!Number.isInteger(intervalCount) || intervalCount <= 0) return "Interval count must be a positive integer.";
  try {
    parseMajorToMicros(draft.includedCreditAmount);
  } catch {
    return "Included credit must be a non-negative decimal (major units, ≤6 dp).";
  }
  if (!/^[A-Z]{3}$/.test(draft.includedCreditCurrency.toUpperCase())) return "Credit currency must be a 3-letter code.";
  const tokens = Number(draft.includedTokens);
  if (!Number.isInteger(tokens) || tokens < 0) return "Included tokens must be a non-negative integer.";

  for (const r of draft.rateLimits) {
    const w = Number(r.windowSeconds);
    if (!Number.isInteger(w) || w <= 0 || w > 31536000) return "Rate limit window must be 1–31536000 seconds.";
    if (isSpendDimension(r.dimension)) {
      try {
        if (parseMajorToMicros(r.capValue) <= 0) return "Spend cap must be a positive amount.";
      } catch {
        return "Spend cap must be a positive decimal (major units, ≤6 dp).";
      }
      if (!/^[A-Z]{3}$/.test(r.currency.toUpperCase())) return "Spend rule requires a 3-letter currency.";
    } else {
      const c = Number(r.capValue);
      if (!(c > 0) || !Number.isFinite(c)) return "Rate limit cap value must be positive.";
    }
    if (r.scope === "model" && !r.scopeTarget.trim()) {
      return "Model scope requires a model alias.";
    }
  }

  const streamDup = findDuplicateRateLimitStream(
    draft.rateLimits.map((r) => ({
      windowSeconds: Number(r.windowSeconds),
      dimension: r.dimension,
      scope: r.scope,
      scopeTarget: r.scopeTarget.trim() || null,
      currency: isSpendDimension(r.dimension) ? r.currency.toUpperCase() : null,
      active: r.active,
    })),
  );
  if (streamDup) return duplicateRateLimitStreamMessage(streamDup);

  return null;
}

export function formatWindow(seconds: number): string {
  if (seconds % 2592000 === 0) return `${seconds / 2592000}mo`;
  if (seconds === 604800) return "1w";
  if (seconds === 86400) return "1d";
  if (seconds === 18000) return "5h";
  if (seconds === 3600) return "1h";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

/** Plan card money display — delegates to ISO-aware formatMicros. */
export function formatAmountMicros(amountMicros: number, currency: string): string {
  return formatMicros(amountMicros, currency);
}

function ruleSummary(r: RateLimitRule): string {
  const cap =
    r.dimension === "spend_units" || r.dimension === "spend_micros"
      ? formatMicros(r.capValue, r.currency ?? "USD")
      : r.capValue.toLocaleString();
  const dim = r.dimension === "tokens" ? " tokens" : r.dimension === "requests" ? " requests" : "";
  const scope =
    r.scope === "model"
      ? `model ${r.scopeTarget ?? ""}`.trim()
      : r.scope === "plan"
        ? "per subscriber"
        : "per customer";
  return `${formatWindow(r.windowSeconds)} window \u00B7 max ${cap}${dim} \u00B7 ${scope}${r.active ? "" : " \u00B7 not enforced"}`;
}

/** Short printed caption for a rule needle on the window ruler. */
const ruleCaption = limitCaption;

function ruleMarkers(rules: readonly RateLimitRule[]): WindowMarker[] {
  return rules.map((r) => ({
    key: r.id,
    windowSeconds: r.windowSeconds,
    caption: ruleCaption(r),
    active: r.active,
  }));
}

export default function PlansPage(): React.ReactElement {
  const { user } = useAuth();
  const canWrite = hasPermission(user, "plans:write");

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<DraftPlan>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const confirm = useConfirm();

  const loadPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<PlanListResponse>("/admin/plans");
      setPlans(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load plans.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const startCreate = useCallback(() => {
    if (!canWrite) return;
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
    setShowForm(true);
  }, [canWrite]);

  const startEdit = useCallback(
    (plan: Plan) => {
      if (!canWrite) return;
      setEditing(plan);
      setDraft(planToDraft(plan));
      setFormError(null);
      setShowForm(true);
    },
    [canWrite],
  );

  const cancelForm = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
  }, []);

  const onDelete = useCallback(
    async (plan: Plan) => {
      if (!canWrite) return;
      const ok = await confirm({
        title: `Deactivate ${plan.name}?`,
        description: "The plan can no longer be assigned to new customers. Existing subscriptions keep their terms.",
        confirmLabel: "Deactivate plan",
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteJson<PlansResponse>(`/admin/plans/${plan._id}`);
        await loadPlans();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Delete failed.");
      }
    },
    [loadPlans, canWrite, confirm],
  );

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!canWrite) return;
      const validation = validateDraft(draft);
      if (validation) {
        setFormError(validation);
        return;
      }
      setSaving(true);
      setFormError(null);

      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        price: {
          amountMicros: parseMajorToMicros(draft.priceAmount),
          currency: draft.priceCurrency.toUpperCase(),
        },
        interval: draft.interval,
        intervalCount: Number(draft.intervalCount),
        includedCredit: {
          amountMicros: parseMajorToMicros(draft.includedCreditAmount),
          currency: draft.includedCreditCurrency.toUpperCase(),
        },
        includedTokens: Number(draft.includedTokens),
        rateLimits: draft.rateLimits.map(toApiRule),
      };

      try {
        if (editing) {
          await patchJson<PlansResponse>(`/admin/plans/${editing._id}`, payload);
        } else {
          await postJson<PlansResponse>("/admin/plans", payload);
        }
        setShowForm(false);
        setEditing(null);
        setDraft(emptyDraft());
        await loadPlans();
      } catch (err) {
        setFormError(err instanceof ApiError ? err.message : "Save failed.");
      } finally {
        setSaving(false);
      }
    },
    [draft, editing, loadPlans, canWrite],
  );

  const setField = useCallback(
    <K extends keyof DraftPlan>(key: K, value: DraftPlan[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const addRule = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      rateLimits: [
        ...prev.rateLimits,
        {
          id: nextRuleId(),
          windowSeconds: "3600",
          dimension: "tokens",
          capValue: "100000",
          scope: "customer",
          scopeTarget: "",
          currency: "USD",
          active: true,
        },
      ],
    }));
  }, []);

  const updateRule = useCallback(<K extends keyof DraftRule>(idx: number, key: K, value: DraftRule[K]) => {
    setDraft((prev) => {
      const next = prev.rateLimits.slice();
      const cur = next[idx];
      if (!cur) return prev;
      next[idx] = { ...cur, [key]: value };
      return { ...prev, rateLimits: next };
    });
  }, []);

  const removeRule = useCallback((idx: number) => {
    setDraft((prev) => ({
      ...prev,
      rateLimits: prev.rateLimits.filter((_, i) => i !== idx),
    }));
  }, []);

  const draftSummary = useMemo(() => {
    return draft.rateLimits.map((r) => {
      const seconds = Number(r.windowSeconds);
      const cap =
        isSpendDimension(r.dimension)
          ? (() => {
              try {
                return formatMicros(parseMajorToMicros(r.capValue), r.currency.toUpperCase() || "USD");
              } catch {
                return r.capValue;
              }
            })()
          : r.capValue;
      const dim = r.dimension === "tokens" ? "tokens" : r.dimension === "requests" ? "requests" : "spend";
      const scope =
        r.scope === "model"
          ? `${r.scope}${r.scopeTarget.trim() ? ` ${r.scopeTarget.trim()}` : ""}`
          : r.scope;
      return `${formatWindow(Number.isFinite(seconds) ? seconds : 0)} \u00B7 max ${cap} ${dim} \u00B7 ${scope} scope${r.active ? "" : " \u00B7 off"}`;
    });
  }, [draft.rateLimits]);

  const draftMarkers = useMemo<WindowMarker[]>(
    () =>
      draft.rateLimits.flatMap((r) => {
        const seconds = Number(r.windowSeconds);
        if (!Number.isFinite(seconds) || seconds <= 0) return [];
        let cap = Number(r.capValue);
        if (isSpendDimension(r.dimension)) {
          try {
            cap = parseMajorToMicros(r.capValue);
          } catch {
            return [];
          }
        }
        if (!Number.isFinite(cap)) return [];
        return [{
          key: r.id,
          windowSeconds: seconds,
          caption: ruleCaption({ dimension: r.dimension, capValue: cap, currency: r.currency, scope: r.scope, scopeTarget: r.scopeTarget }),
          active: r.active,
        }];
      }),
    [draft.rateLimits],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plans"
        description="Subscriptions with a price, included credit and tokens, and default rolling limits."
      >
        {showForm ? null : canWrite ? (
          <Button onClick={startCreate}>
            <Plus />
            Add plan
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
            Read-only access. Creating, editing, or deactivating plans needs{" "}
            <code className="font-mono text-xs">plans:write</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {showForm && canWrite ? (
        <Panel>
          <PanelHeader
            title={editing ? `Edit ${editing.name}` : "New plan"}
            description="Subscribers get the included credit and tokens each interval, capped by the rolling limits below."
          />
          <form className="flex flex-col" onSubmit={onSubmit}>
            {formError ? (
              <div className="px-5 pt-4">
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              </div>
            ) : null}

            <fieldset className="grid grid-cols-1 gap-4 border-b border-rule px-5 py-5 sm:grid-cols-[2fr_1fr_1fr]">
              <legend className="sr-only">Basics</legend>
              <Field id="plan-name" label="Name">
                <Input id="plan-name" type="text" maxLength={120} value={draft.name} required disabled={saving} onChange={(e) => setField("name", e.target.value)} />
              </Field>
              <Field id="plan-interval" label="Billing interval">
                <Select value={draft.interval} onValueChange={(v) => setField("interval", v as Interval)} disabled={saving}>
                  <SelectTrigger id="plan-interval" className="capitalize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((i) => (<SelectItem key={i} value={i} className="capitalize">{i}</SelectItem>))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="plan-interval-count" label="Every" hint={`Bills every ${draft.intervalCount || "1"} ${draft.interval}${Number(draft.intervalCount) > 1 ? "s" : ""}`}>
                <Input id="plan-interval-count" type="number" min={1} step={1} value={draft.intervalCount} required disabled={saving} onChange={(e) => setField("intervalCount", e.target.value)} />
              </Field>
              <Field id="plan-description" label="Description" optional className="sm:col-span-3">
                <Textarea id="plan-description" maxLength={2000} rows={2} value={draft.description} disabled={saving} onChange={(e) => setField("description", e.target.value)} />
              </Field>
            </fieldset>

            <fieldset className="grid grid-cols-2 gap-4 border-b border-rule px-5 py-5 lg:grid-cols-[1.4fr_0.6fr_1.4fr_0.6fr_1.4fr]">
              <legend className="sr-only">Pricing</legend>
              <Field id="plan-price-amount" label="Price" tooltip="Amount charged per billing interval in major units (e.g. 9.99 = $9.99 USD).">
                <Input id="plan-price-amount" type="number" min={0} step="any" value={draft.priceAmount} required disabled={saving} onChange={(e) => setField("priceAmount", e.target.value)} />
                <UnitsPreview value={draft.priceAmount} currency={draft.priceCurrency} />
              </Field>
              <Field id="plan-price-currency" label="Currency">
                <CurrencySelect id="plan-price-currency" value={draft.priceCurrency} disabled={saving} onChange={(v) => setField("priceCurrency", v)} />
              </Field>
              <Field id="plan-credit-amount" label="Included credit" tooltip="Balance granted each interval in major units (e.g. 10 = $10.00 USD).">
                <Input id="plan-credit-amount" type="number" min={0} step="any" value={draft.includedCreditAmount} required disabled={saving} onChange={(e) => setField("includedCreditAmount", e.target.value)} />
                <UnitsPreview value={draft.includedCreditAmount} currency={draft.includedCreditCurrency} />
              </Field>
              <Field id="plan-credit-currency" label="Currency">
                <CurrencySelect id="plan-credit-currency" value={draft.includedCreditCurrency} disabled={saving} onChange={(v) => setField("includedCreditCurrency", v)} />
              </Field>
              <Field id="plan-tokens" label="Included tokens" className="col-span-2 lg:col-span-1">
                <Input id="plan-tokens" type="number" min={0} step={1} value={draft.includedTokens} required disabled={saving} onChange={(e) => setField("includedTokens", e.target.value)} />
              </Field>
            </fieldset>

            <fieldset className="flex flex-col gap-4 px-5 py-5">
              <legend className="sr-only">Rolling limits</legend>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-semibold">Rolling limits</h3>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">Default caps for subscribers. Each window rolls continuously.</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addRule} disabled={saving}>
                  <Plus />
                  Add limit
                </Button>
              </div>

              {draft.rateLimits.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                  No limits. Subscribers are capped only by their balance.
                </p>
              ) : (
                <>
                  <div className="pb-2 pt-1">
                    <WindowRuler markers={draftMarkers} />
                  </div>
                  <ul className="flex flex-col">
                    {draft.rateLimits.map((rule, idx) => {
                      const summary = draftSummary[idx] ?? "";
                      return (
                        <li key={rule.id} className={cn("border-t border-rule py-3", !rule.active && "border-dashed")}>
                          <div className="flex flex-wrap items-center gap-3">
                            <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                              <Checkbox checked={rule.active} onCheckedChange={(v) => updateRule(idx, "active", v === true)} disabled={saving} />
                              Enforced
                            </label>
                            <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">{summary}</span>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove limit" onClick={() => removeRule(idx)} disabled={saving}>
                              <X />
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 gap-4 pt-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor={`rule-window-${rule.id}`}>Window</Label>
                              <div className="flex gap-2">
                                <Input id={`rule-window-${rule.id}`} aria-describedby={`rule-window-unit-${rule.id}`} className="w-28" type="number" min={1} max={31536000} step={1} value={rule.windowSeconds} required disabled={saving} onChange={(e) => updateRule(idx, "windowSeconds", e.target.value)} />
                                <span id={`rule-window-unit-${rule.id}`} className="self-center text-xs text-muted-foreground">seconds</span>
                              </div>
                              <div className="flex flex-wrap gap-1" role="group" aria-label="Window presets">
                                {WINDOW_PRESETS.map((p) => {
                                  const on = rule.windowSeconds === String(p.seconds);
                                  return (
                                    <button
                                      key={p.seconds}
                                      type="button"
                                      aria-pressed={on}
                                      className={cn(
                                        "h-6 rounded-[5px] border px-2 text-xs font-medium tabular-nums outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50",
                                        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                                      )}
                                      disabled={saving}
                                      onClick={() => updateRule(idx, "windowSeconds", String(p.seconds))}
                                    >
                                      {p.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <Field id={`rule-dim-${rule.id}`} label="Measures">
                              <Select value={rule.dimension} onValueChange={(v) => updateRule(idx, "dimension", v as Dimension)} disabled={saving}>
                                <SelectTrigger id={`rule-dim-${rule.id}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {DIMENSIONS.map((d) => (<SelectItem key={d} value={d}>{DIMENSION_LABEL[d]}</SelectItem>))}
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field id={`rule-cap-${rule.id}`} label={DIMENSION_CAP_LABEL[rule.dimension]}>
                              <Input id={`rule-cap-${rule.id}`} type="number" min={isSpendDimension(rule.dimension) ? 0 : 1} step={isSpendDimension(rule.dimension) ? "any" : 1} value={rule.capValue} required disabled={saving} onChange={(e) => updateRule(idx, "capValue", e.target.value)} />
                            </Field>
                            <Field id={`rule-scope-${rule.id}`} label="Applies to" tooltip="Customer and plan scope count all of a customer's usage; model scope counts one model alias.">
                              <Select value={rule.scope} onValueChange={(v) => updateRule(idx, "scope", v as Scope)} disabled={saving}>
                                <SelectTrigger id={`rule-scope-${rule.id}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {SCOPES.map((sc) => (<SelectItem key={sc} value={sc}>{SCOPE_LABEL[sc]}</SelectItem>))}
                                </SelectContent>
                              </Select>
                            </Field>

                            {rule.scope === "model" && (
                              <Field id={`rule-target-${rule.id}`} label="Model alias">
                                <ModelAliasSelect id={`rule-target-${rule.id}`} value={rule.scopeTarget} disabled={saving} onChange={(v) => updateRule(idx, "scopeTarget", v)} />
                              </Field>
                            )}

                            {isSpendDimension(rule.dimension) && (
                              <Field id={`rule-cur-${rule.id}`} label="Currency">
                                <CurrencySelect id={`rule-cur-${rule.id}`} value={rule.currency} disabled={saving} onChange={(v) => updateRule(idx, "currency", v)} />
                              </Field>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </fieldset>

            <div className="flex justify-end gap-2 border-t border-rule px-5 py-4">
              <Button type="button" variant="outline" onClick={cancelForm} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving\u2026" : editing ? "Save changes" : "Create plan"}</Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-72 rounded-xl" />
          ))}
        </div>
      ) : plans.length === 0 && !showForm ? (
        <Panel>
          <EmptyState
            icon={<CreditCard />}
            title="No plans yet"
            description={
              canWrite
                ? "A plan bundles a recurring price, included credit and tokens, and default rolling limits for its subscribers."
                : "No plans configured yet. Someone with plans:write can add them."
            }
            action={
              canWrite ? (
                <Button size="sm" onClick={startCreate}>
                  <Plus />
                  Add plan
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {plans.map((plan) => (
            <Panel key={plan._id} as="article" className={cn("flex flex-col", !plan.active && "opacity-75")}>
              <div className="flex items-start justify-between gap-3 px-5 pt-4">
                <div className="min-w-0">
                  <h2 className="truncate text-[17px] font-semibold">{plan.name}</h2>
                  {plan.description ? <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{plan.description}</p> : null}
                </div>
                <Badge variant={plan.active ? "success" : "off"}>{plan.active ? "Active" : "Inactive"}</Badge>
              </div>
              <div className="flex items-baseline gap-1.5 px-5 pt-4">
                <span className="readout text-[30px] font-semibold leading-none">{formatAmountMicros(plan.price.amountMicros, plan.price.currency)}</span>
                <span className="text-[13px] text-muted-foreground">
                  / {plan.intervalCount > 1 ? `${plan.intervalCount} ` : ""}{plan.interval}{plan.intervalCount > 1 ? "s" : ""}
                </span>
              </div>
              <SpecList
                className="px-5 pt-3"
                rows={[
                  { label: "Included credit", value: <span className="tabular-nums">{formatAmountMicros(plan.includedCredit.amountMicros, plan.includedCredit.currency)}</span> },
                  { label: "Included tokens", value: <span className="tabular-nums">{plan.includedTokens.toLocaleString()}</span> },
                ]}
              />
              <div className="px-5 pb-5 pt-4">
                <div className="legend mb-1 text-muted-foreground">
                  Rolling limits{plan.rateLimits.length > 0 ? ` · ${plan.rateLimits.length}` : ""}
                </div>
                {plan.rateLimits.length > 0 ? (
                  <>
                    <WindowRuler markers={ruleMarkers(plan.rateLimits)} className="mt-2" />
                    <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                      {plan.rateLimits.map((r) => (
                        <li key={r.id} className={cn("tabular-nums", !r.active && "line-through")}>{ruleSummary(r)}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="py-1 text-[13px] text-muted-foreground">None. Capped by balance only.</p>
                )}
              </div>
              {canWrite ? (
                <div className="mt-auto flex gap-2 border-t border-rule px-5 py-3">
                  <Button variant="outline" size="sm" onClick={() => startEdit(plan)}>Edit</Button>
                  {plan.active ? (
                    <Button variant="ghost-destructive" size="sm" onClick={() => void onDelete(plan)}>Deactivate</Button>
                  ) : null}
                </div>
              ) : null}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
