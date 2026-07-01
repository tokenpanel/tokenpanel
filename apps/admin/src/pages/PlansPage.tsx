import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreditCard, Plus, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FadeIn, StaggerItem } from "@/components/anim";

type Interval = "day" | "week" | "month" | "year";
type Dimension = "tokens" | "requests" | "spend_minor";
type Scope = "customer" | "plan" | "model" | "endpoint";

interface Money {
  amountMinor: number;
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

const INTERVALS: readonly Interval[] = ["day", "week", "month", "year"];
const DIMENSIONS: readonly Dimension[] = ["tokens", "requests", "spend_minor"];
const SCOPES: readonly Scope[] = ["customer", "plan", "model", "endpoint"];

const WINDOW_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: "1h", seconds: 3600 },
  { label: "5h", seconds: 18000 },
  { label: "1d", seconds: 86400 },
  { label: "1w", seconds: 604800 },
  { label: "30d", seconds: 2592000 },
];

const DIMENSION_CAP_LABEL: Record<Dimension, string> = {
  tokens: "max tokens",
  requests: "max requests",
  spend_minor: "max spend (minor)",
};

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
    priceAmount: String(plan.price.amountMinor),
    priceCurrency: plan.price.currency,
    interval: plan.interval,
    intervalCount: String(plan.intervalCount),
    includedCreditAmount: String(plan.includedCredit.amountMinor),
    includedCreditCurrency: plan.includedCredit.currency,
    includedTokens: String(plan.includedTokens),
    rateLimits: plan.rateLimits.map((r) => ({
      id: r.id,
      windowSeconds: String(r.windowSeconds),
      dimension: r.dimension,
      capValue: String(r.capValue),
      scope: r.scope,
      scopeTarget: r.scopeTarget ?? "",
      currency: r.currency ?? "USD",
      active: r.active,
    })),
  };
}

export function toApiRule(rule: DraftRule) {
  return {
    id: rule.id || undefined,
    windowSeconds: Number(rule.windowSeconds),
    dimension: rule.dimension,
    capValue: Number(rule.capValue),
    scope: rule.scope,
    scopeTarget: rule.scopeTarget.trim() || undefined,
    currency: rule.dimension === "spend_minor" ? rule.currency.toUpperCase() || undefined : undefined,
    active: rule.active,
  };
}

export function validateDraft(draft: DraftPlan): string | null {
  if (!draft.name.trim()) return "Name is required.";
  const price = Number(draft.priceAmount);
  if (!Number.isInteger(price) || price < 0) return "Price must be a non-negative integer (minor units).";
  if (!/^[A-Z]{3}$/.test(draft.priceCurrency.toUpperCase())) return "Price currency must be a 3-letter code.";
  const intervalCount = Number(draft.intervalCount);
  if (!Number.isInteger(intervalCount) || intervalCount <= 0) return "Interval count must be a positive integer.";
  const credit = Number(draft.includedCreditAmount);
  if (!Number.isInteger(credit) || credit < 0) return "Included credit must be a non-negative integer (minor units).";
  if (!/^[A-Z]{3}$/.test(draft.includedCreditCurrency.toUpperCase())) return "Credit currency must be a 3-letter code.";
  const tokens = Number(draft.includedTokens);
  if (!Number.isInteger(tokens) || tokens < 0) return "Included tokens must be a non-negative integer.";

  for (const r of draft.rateLimits) {
    const w = Number(r.windowSeconds);
    if (!Number.isInteger(w) || w <= 0 || w > 31536000) return "Rate limit window must be 1–31536000 seconds.";
    const c = Number(r.capValue);
    if (!(c > 0) || !Number.isFinite(c)) return "Rate limit cap value must be positive.";
    if (r.dimension === "spend_minor") {
      if (!/^[A-Z]{3}$/.test(r.currency.toUpperCase())) return "Spend rule requires a 3-letter currency.";
    }
    if ((r.scope === "model" || r.scope === "endpoint") && !r.scopeTarget.trim()) {
      return "Model/endpoint scope requires a scope target.";
    }
  }
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

export function formatAmountMinor(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  const fixed = Number.isInteger(major) ? major.toFixed(0) : major.toFixed(2);
  return `${currency} ${fixed}`;
}

function ruleSummary(r: RateLimitRule): string {
  const cap =
    r.dimension === "spend_minor"
      ? `${r.capValue} minor${r.currency ? ` ${r.currency}` : ""}`
      : String(r.capValue);
  const dim = r.dimension === "tokens" ? "tokens" : r.dimension === "requests" ? "requests" : "spend";
  const scope =
    r.scope === "model" || r.scope === "endpoint"
      ? `${r.scope}${r.scopeTarget ? ` ${r.scopeTarget}` : ""}`
      : r.scope;
  return `${formatWindow(r.windowSeconds)} \u00B7 max ${cap} ${dim} \u00B7 ${scope} scope${r.active ? "" : " \u00B7 off"}`;
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
      {help ? <span className="text-[11px] text-muted-foreground">{help}</span> : null}
    </div>
  );
}

export default function PlansPage(): React.ReactElement {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<DraftPlan>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
    setShowForm(true);
  }, []);

  const startEdit = useCallback((plan: Plan) => {
    setEditing(plan);
    setDraft(planToDraft(plan));
    setFormError(null);
    setShowForm(true);
  }, []);

  const cancelForm = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
  }, []);

  const onDelete = useCallback(
    async (plan: Plan) => {
      if (!window.confirm(`Deactivate plan "${plan.name}"? This is a soft delete.`)) return;
      try {
        await deleteJson<PlansResponse>(`/admin/plans/${plan._id}`);
        await loadPlans();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Delete failed.");
      }
    },
    [loadPlans],
  );

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
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
          amountMinor: Number(draft.priceAmount),
          currency: draft.priceCurrency.toUpperCase(),
        },
        interval: draft.interval,
        intervalCount: Number(draft.intervalCount),
        includedCredit: {
          amountMinor: Number(draft.includedCreditAmount),
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
    [draft, editing, loadPlans],
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
        r.dimension === "spend_minor"
          ? `${r.capValue} minor${r.currency ? ` ${r.currency.toUpperCase()}` : ""}`
          : r.capValue;
      const dim = r.dimension === "tokens" ? "tokens" : r.dimension === "requests" ? "requests" : "spend";
      const scope =
        r.scope === "model" || r.scope === "endpoint"
          ? `${r.scope}${r.scopeTarget.trim() ? ` ${r.scopeTarget.trim()}` : ""}`
          : r.scope;
      return `${formatWindow(Number.isFinite(seconds) ? seconds : 0)} \u00B7 max ${cap} ${dim} \u00B7 ${scope} scope${r.active ? "" : " \u00B7 off"}`;
    });
  }, [draft.rateLimits]);

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Plans" description="Subscription plans, pricing, and rate-limit defaults.">
        {showForm ? (
          <Button variant="outline" size="sm" onClick={cancelForm} disabled={saving}>Cancel</Button>
        ) : (
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            Add Plan
          </Button>
        )}
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {showForm ? (
        <FadeIn className="flex flex-col gap-5 rounded-lg border border-border bg-card p-6 shadow-xs">
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <h2 className="text-lg font-semibold">{editing ? "Edit plan" : "New plan"}</h2>
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField id="plan-name" label="Name">
              <Input id="plan-name" type="text" maxLength={120} value={draft.name} required disabled={saving} onChange={(e) => setField("name", e.target.value)} />
            </FormField>
            <FormField id="plan-interval" label="Interval">
              <Select value={draft.interval} onValueChange={(v) => setField("interval", v as Interval)} disabled={saving}>
                <SelectTrigger id="plan-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVALS.map((i) => (<SelectItem key={i} value={i}>{i}</SelectItem>))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField id="plan-interval-count" label="Interval count">
              <Input id="plan-interval-count" type="number" min={1} step={1} value={draft.intervalCount} required disabled={saving} onChange={(e) => setField("intervalCount", e.target.value)} />
            </FormField>
          </div>

          <FormField id="plan-description" label="Description">
            <Textarea id="plan-description" maxLength={2000} rows={3} value={draft.description} disabled={saving} onChange={(e) => setField("description", e.target.value)} />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <FormField id="plan-price-amount" label="Price (minor units)">
              <Input id="plan-price-amount" type="number" min={0} step={1} value={draft.priceAmount} required disabled={saving} onChange={(e) => setField("priceAmount", e.target.value)} />
            </FormField>
            <FormField id="plan-price-currency" label="Price currency">
              <Input id="plan-price-currency" type="text" maxLength={3} value={draft.priceCurrency} required disabled={saving} onChange={(e) => setField("priceCurrency", e.target.value.toUpperCase())} />
            </FormField>
            <FormField id="plan-credit-amount" label="Included credit (minor units)">
              <Input id="plan-credit-amount" type="number" min={0} step={1} value={draft.includedCreditAmount} required disabled={saving} onChange={(e) => setField("includedCreditAmount", e.target.value)} />
            </FormField>
            <FormField id="plan-credit-currency" label="Credit currency">
              <Input id="plan-credit-currency" type="text" maxLength={3} value={draft.includedCreditCurrency} required disabled={saving} onChange={(e) => setField("includedCreditCurrency", e.target.value.toUpperCase())} />
            </FormField>
            <FormField id="plan-tokens" label="Included tokens">
              <Input id="plan-tokens" type="number" min={0} step={1} value={draft.includedTokens} required disabled={saving} onChange={(e) => setField("includedTokens", e.target.value)} />
            </FormField>
          </div>

          <div className="flex items-center justify-between border-b border-border pb-1.5">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rate limits</div>
              <div className="text-sm text-muted-foreground">Default rules applied to subscribers of this plan.</div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addRule} disabled={saving}>
              <Plus className="size-4" />
              Add Rule
            </Button>
          </div>

          {draft.rateLimits.length === 0 ? (
            <div className="rounded-md bg-muted/40 px-3.5 py-2.5 text-sm text-muted-foreground">No rate limits configured.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {draft.rateLimits.map((rule, idx) => {
                const summary = draftSummary[idx] ?? "";
                return (
                  <div key={rule.id} className="relative grid grid-cols-1 gap-3 rounded-md border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
                    <button
                      type="button"
                      className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:bg-muted"
                      aria-label="Remove rule"
                      onClick={() => removeRule(idx)}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                    </button>

                    <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
                      <Label>Window (seconds)</Label>
                      <Input className="max-w-[200px]" type="number" min={1} max={31536000} step={1} value={rule.windowSeconds} required disabled={saving} onChange={(e) => updateRule(idx, "windowSeconds", e.target.value)} />
                      <div className="flex gap-1.5">
                        {WINDOW_PRESETS.map((p) => (
                          <button
                            key={p.seconds}
                            type="button"
                            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                            disabled={saving}
                            onClick={() => updateRule(idx, "windowSeconds", String(p.seconds))}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <FormField id={`rule-dim-${rule.id}`} label="Dimension">
                      <Select value={rule.dimension} onValueChange={(v) => updateRule(idx, "dimension", v as Dimension)} disabled={saving}>
                        <SelectTrigger id={`rule-dim-${rule.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DIMENSIONS.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField id={`rule-cap-${rule.id}`} label={DIMENSION_CAP_LABEL[rule.dimension]}>
                      <Input type="number" min={1} step={1} value={rule.capValue} required disabled={saving} onChange={(e) => updateRule(idx, "capValue", e.target.value)} />
                    </FormField>
                    <FormField id={`rule-scope-${rule.id}`} label="Scope">
                      <Select value={rule.scope} onValueChange={(v) => updateRule(idx, "scope", v as Scope)} disabled={saving}>
                        <SelectTrigger id={`rule-scope-${rule.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SCOPES.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
                        </SelectContent>
                      </Select>
                    </FormField>

                    {(rule.scope === "model" || rule.scope === "endpoint") && (
                      <FormField id={`rule-target-${rule.id}`} label="Scope target">
                        <Input type="text" maxLength={120} value={rule.scopeTarget} placeholder={rule.scope === "model" ? "model alias" : "/endpoint path"} disabled={saving} onChange={(e) => updateRule(idx, "scopeTarget", e.target.value)} />
                      </FormField>
                    )}

                    {rule.dimension === "spend_minor" && (
                      <FormField id={`rule-cur-${rule.id}`} label="Currency">
                        <Input type="text" maxLength={3} value={rule.currency} disabled={saving} onChange={(e) => updateRule(idx, "currency", e.target.value.toUpperCase())} />
                      </FormField>
                    )}

                    <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
                        <Checkbox checked={rule.active} onCheckedChange={(v) => updateRule(idx, "active", v === true)} disabled={saving} />
                        Active
                      </label>
                      <div className="text-[11px] text-muted-foreground">{summary}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={cancelForm} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving\u2026" : editing ? "Save changes" : "Create plan"}</Button>
          </div>
        </form>
        </FadeIn>
      ) : null}

      {loading ? null : plans.length === 0 && !showForm ? (
        <EmptyState
          icon={<CreditCard className="size-5" />}
          title="No plans yet"
          description="Create your first subscription plan with pricing and rate-limit defaults."
          action={<Button size="sm" onClick={startCreate}><Plus className="size-4" />Add Plan</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan, i) => (
            <StaggerItem key={plan._id} index={i} step={0.05}>
              <Card className="flex h-full flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-semibold">{plan.name}</h3>
                  <Badge variant={plan.active ? "success" : "secondary"}>{plan.active ? "active" : "inactive"}</Badge>
                </div>
                {plan.description ? <p className="text-sm text-muted-foreground">{plan.description}</p> : null}
                <div className="flex flex-col gap-1 text-sm">
                  <span>Price: <strong>{formatAmountMinor(plan.price.amountMinor, plan.price.currency)}</strong> / {plan.intervalCount} {plan.interval}{plan.intervalCount > 1 ? "s" : ""}</span>
                  <span>Credit: <strong>{formatAmountMinor(plan.includedCredit.amountMinor, plan.includedCredit.currency)}</strong></span>
                  <span>Tokens: <strong>{plan.includedTokens.toLocaleString()}</strong></span>
                  <span>Rate limits: <strong>{plan.rateLimits.length}</strong></span>
                </div>
                {plan.rateLimits.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {plan.rateLimits.map((r) => (
                      <li key={r.id}>{ruleSummary(r)}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-auto flex gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => startEdit(plan)}>Edit</Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void onDelete(plan)}>Delete</Button>
                </div>
              </Card>
            </StaggerItem>
          ))}
        </div>
      )}
    </div>
  );
}