import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  listCatalogModels,
  listCatalogSources,
  type CatalogSourceSummary,
  type FetchedModel,
} from "../api/catalog.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_RENDERED = 200;

interface FetchModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (model: FetchedModel) => void;
}

interface SearchEntry {
  model: FetchedModel;
  key: string;
  haystack: string;
  price: string;
}

function formatPrice(m: FetchedModel): string {
  return m.cost
    ? `$${(m.cost.inputUnitsPerMillion / 100).toFixed(2)} / $${(m.cost.outputUnitsPerMillion / 100).toFixed(2)}`
    : "no price";
}

function buildKey(m: FetchedModel): string {
  return `${m.subProvider ?? ""}/${m.upstreamModelId}`;
}

function buildHaystack(m: FetchedModel): string {
  return `${m.upstreamModelId} ${m.displayName} ${m.subProvider ?? ""}`.toLowerCase();
}

/**
 * Memoized row. Re-renders only when its own model or selected flag changes,
 * not on every keystroke. Without this, all 200 visible rows re-render on
 * each query change because the parent re-renders.
 */
const ModelRow = memo(function ModelRow({
  model,
  price,
  active,
  onSelect,
}: {
  model: FetchedModel;
  price: string;
  active: boolean;
  onSelect: (m: FetchedModel) => void;
}): React.ReactElement {
  return (
    <li key={`${model.subProvider ?? ""}/${model.upstreamModelId}`}>
      <button
        type="button"
        className={cn(
          "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
          active && "bg-primary/10",
        )}
        onClick={() => onSelect(model)}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{model.displayName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{price}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">{model.upstreamModelId}</span>
          {model.subProvider ? <span className="shrink-0">via {model.subProvider}</span> : null}
        </span>
      </button>
    </li>
  );
});

export function FetchModelDialog({
  open,
  onOpenChange,
  onApply,
}: FetchModelDialogProps): React.ReactElement {
  const [sources, setSources] = useState<CatalogSourceSummary[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const [sourceId, setSourceId] = useState<string>("");
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FetchedModel | null>(null);

  // Defer the filter input so typing stays responsive even when the model
  // list is huge. React yields back to the browser between keystrokes and
  // renders the filtered list at lower priority.
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSourcesLoading(true);
    setSourcesError(null);
    listCatalogSources()
      .then((res) => {
        if (cancelled) return;
        setSources(res.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcesError(err instanceof ApiError ? err.message : "Failed to load providers.");
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Fetch models when a source is chosen. Cached on the backend, so re-opening
  // the dialog and re-selecting the same source is fast.
  useEffect(() => {
    if (!open || !sourceId) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    setSelected(null);
    setQuery("");
    setModels([]);
    listCatalogModels(sourceId)
      .then((res) => {
        if (cancelled) return;
        setModels(res.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setModelsError(err instanceof ApiError ? err.message : "Failed to load models.");
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceId]);

  // Precompute search index ONCE per models change — not per keystroke.
  // Each entry carries the lowercase haystack + precomputed display strings
  // so the filter loop allocates nothing per keystroke.
  const searchIndex = useMemo<SearchEntry[]>(() => {
    return models.map((m) => ({
      model: m,
      key: buildKey(m),
      haystack: buildHaystack(m),
      price: formatPrice(m),
    }));
  }, [models]);

  // Single filter pass over the precomputed index. Replaces the prior double
  // scan (filtered + truncated memos each did a full O(n) loop rebuilding
  // haystacks). Now: one loop, cached haystacks, short-circuit at MAX_RENDERED.
  const { visible, truncated } = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const out: SearchEntry[] = [];
    let totalHits = 0;
    for (const entry of searchIndex) {
      if (q === "" || entry.haystack.includes(q)) {
        totalHits++;
        if (out.length < MAX_RENDERED) {
          out.push(entry);
        }
      }
    }
    return { visible: out, truncated: totalHits > MAX_RENDERED };
  }, [searchIndex, deferredQuery]);

  const handleApply = useCallback(() => {
    if (!selected) return;
    onApply(selected);
    onOpenChange(false);
  }, [selected, onApply, onOpenChange]);

  const resetOnClose = useCallback(() => {
    // Keep source list cached; clear transient selection state when closing
    // so re-opening feels fresh.
    setSourceId("");
    setModels([]);
    setQuery("");
    setSelected(null);
    setModelsError(null);
    setSourcesError(null);
  }, []);

  const selectedKey = selected ? buildKey(selected) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetOnClose();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Fetch Model Information</DialogTitle>
          <DialogDescription>
            Pick a catalog provider, then choose a model to pre-fill the form.
          </DialogDescription>
        </DialogHeader>

        {sourcesError ? (
          <Alert variant="destructive">
            <AlertDescription>{sourcesError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fmd-prov">Provider</Label>
          <Select
            value={sourceId}
            onValueChange={(v) => setSourceId(v)}
            disabled={sourcesLoading || modelsLoading}
          >
            <SelectTrigger id="fmd-prov">
              <SelectValue placeholder={sourcesLoading ? "Loading…" : "Select provider…"} />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fmd-q">Models</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="fmd-q"
              type="text"
              className="pl-8"
              placeholder={sourceId ? "Search models…" : "Select a provider first"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={!sourceId || modelsLoading}
            />
          </div>

          {modelsError ? (
            <Alert variant="destructive">
              <AlertDescription>{modelsError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-card">
            {!sourceId ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Choose a provider to load models.
              </div>
            ) : modelsLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading models…
              </div>
            ) : visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {deferredQuery.trim() ? "No models match your search." : "No models returned."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((entry) => (
                  <ModelRow
                    key={entry.key}
                    model={entry.model}
                    price={entry.price}
                    active={selectedKey === entry.key}
                    onSelect={setSelected}
                  />
                ))}
                {truncated ? (
                  <li className="px-3 py-2 text-center text-xs text-muted-foreground">
                    Showing the first {MAX_RENDERED} matches. Refine your search to narrow further.
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply} disabled={!selected}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}