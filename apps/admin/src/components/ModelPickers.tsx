import { useEffect, useState } from "react";
import * as modelsApi from "../api/models.ts";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/MultiSelect";
import { useModelOptions } from "@/hooks/use-model-options";
import { cn } from "@/lib/utils";

function splitAliases(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0)));
}

/**
 * Pick several published model aliases (e.g. an API key's allow-list). The
 * value stays a comma-separated string so existing form state and parsing are
 * unchanged. Falls back to a text field when models cannot be listed.
 */
export function ModelAliasesField({
  id,
  value,
  onChange,
  disabled,
  placeholder = "All models",
  className,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  describedBy?: string | undefined;
}): React.ReactElement {
  const { options, state } = useModelOptions();
  if (state !== "ready") {
    return (
      <Input
        id={id}
        type="text"
        value={value}
        placeholder={state === "loading" ? "Loading models…" : "model-a, model-b"}
        className={cn("font-mono text-[13px]", className)}
        aria-describedby={describedBy}
        disabled={disabled || state === "loading"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <MultiSelect
      id={id}
      label="Allowed models"
      options={options}
      value={splitAliases(value)}
      onChange={(list) => onChange(list.join(", "))}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      aria-describedby={describedBy}
    />
  );
}

/** Pick one published model alias; falls back to a text field when models cannot be listed. */
export function ModelAliasSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
}): React.ReactElement {
  const { options, state } = useModelOptions();
  if (state !== "ready") {
    return (
      <Input
        id={id}
        type="text"
        maxLength={120}
        className="font-mono text-[13px]"
        value={value}
        placeholder={state === "loading" ? "Loading models…" : "gpt-4.1"}
        disabled={disabled || state === "loading"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const current = value.trim();
  const list = current && !options.some((o) => o.value === current)
    ? [...options, { value: current, label: current, hint: "not found" }]
    : options;
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled ?? false}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={list.length === 0 ? "No models yet" : "Choose a model"} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {list.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
            {o.hint && o.hint !== o.label ? <span className="font-mono text-[11px] text-muted-foreground"> · {o.hint}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Upstream model id for a provider: a dropdown of the provider's discovered
 * models when there are any, with a switch to type an id manually (for models
 * the provider has but discovery did not list). Plain text otherwise.
 */
export function UpstreamModelPicker({
  id,
  providerId,
  value,
  onChange,
  disabled,
}: {
  id: string;
  providerId: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
}): React.ReactElement {
  const [catalog, setCatalog] = useState<Array<{ upstreamModelId: string; displayName?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!providerId) {
      setCatalog([]);
      return;
    }
    setLoading(true);
    modelsApi
      .listProviderCatalog(providerId)
      .then((res) => {
        if (!cancelled) setCatalog(res.items);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const useDropdown = !manual && !loading && catalog.length > 0;
  const current = value.trim();
  const listed = catalog.some((c) => c.upstreamModelId === current);

  return (
    <div className="flex flex-col gap-1.5">
      {useDropdown ? (
        <Select value={current} onValueChange={onChange} disabled={disabled ?? false}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Choose a discovered model" />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {current && !listed ? (
              <SelectItem value={current}>
                <span className="font-mono text-[13px]">{current}</span>
                <span className="text-muted-foreground"> · not discovered</span>
              </SelectItem>
            ) : null}
            {catalog.map((c) => (
              <SelectItem key={c.upstreamModelId} value={c.upstreamModelId}>
                <span className="font-mono text-[13px]">{c.upstreamModelId}</span>
                {c.displayName && c.displayName !== c.upstreamModelId ? (
                  <span className="text-muted-foreground"> · {c.displayName}</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type="text"
          className="font-mono text-[13px]"
          value={value}
          placeholder={loading ? "Loading discovered models…" : providerId ? "gpt-4o-mini" : "Choose a provider first"}
          onChange={(e) => onChange(e.target.value)}
          required
          disabled={disabled || loading || !providerId}
        />
      )}
      {catalog.length > 0 && !loading ? (
        <button
          type="button"
          className="self-start rounded-sm text-xs text-muted-foreground underline decoration-border underline-offset-4 outline-none hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setManual((m) => !m);
            onChange("");
          }}
          disabled={disabled}
        >
          {manual ? `Choose from ${catalog.length} discovered model${catalog.length === 1 ? "" : "s"}` : "Type an id instead"}
        </button>
      ) : providerId && !loading ? (
        <span className="text-xs text-muted-foreground">No discovered models for this provider. Run Discover on the Providers page, or type the id.</span>
      ) : null}
    </div>
  );
}
