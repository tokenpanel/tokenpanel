import { useCallback, useEffect, useMemo, useState } from "react";
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return models;
    const out: FetchedModel[] = [];
    for (const m of models) {
      const haystack = `${m.upstreamModelId} ${m.displayName} ${m.subProvider ?? ""}`.toLowerCase();
      if (haystack.includes(q)) {
        out.push(m);
        if (out.length >= MAX_RENDERED) break;
      }
    }
    return out;
  }, [models, query]);

  const truncated = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return models.length > MAX_RENDERED;
    let hits = 0;
    for (const m of models) {
      const haystack = `${m.upstreamModelId} ${m.displayName} ${m.subProvider ?? ""}`.toLowerCase();
      if (haystack.includes(q)) {
        hits++;
        if (hits > MAX_RENDERED) return true;
      }
    }
    return false;
  }, [models, query]);

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
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {query.trim() ? "No models match your search." : "No models returned."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((m) => {
                  const active = selected?.upstreamModelId === m.upstreamModelId
                    && selected?.subProvider === m.subProvider;
                  const price = m.cost
                    ? `$${(m.cost.inputMinorPerMillion / 100).toFixed(2)} / $${(m.cost.outputMinorPerMillion / 100).toFixed(2)}`
                    : "no price";
                  return (
                    <li key={`${m.subProvider ?? ""}/${m.upstreamModelId}`}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                          active && "bg-primary/10",
                        )}
                        onClick={() => setSelected(m)}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{m.displayName}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{price}</span>
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate font-mono">{m.upstreamModelId}</span>
                          {m.subProvider ? <span className="shrink-0">via {m.subProvider}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
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
