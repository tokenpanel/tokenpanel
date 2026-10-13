import { useEffect, useState } from "react";
import * as modelsApi from "../api/models.ts";
import type { MultiSelectOption } from "@/components/MultiSelect";

export type ModelOptionsState = "loading" | "ready" | "unavailable";

/**
 * Published model aliases as select options. Resolves to "unavailable" when
 * the caller cannot list models (no models:read) or the request fails, so
 * callers can fall back to a free-text alias field.
 */
export function useModelOptions(): { options: MultiSelectOption[]; state: ModelOptionsState } {
  const [options, setOptions] = useState<MultiSelectOption[]>([]);
  const [state, setState] = useState<ModelOptionsState>("loading");

  useEffect(() => {
    let cancelled = false;
    modelsApi
      .listModels()
      .then((res) => {
        if (cancelled) return;
        setOptions(
          res.items
            .map((m) => ({ value: m.aliasId, label: m.displayName || m.aliasId, hint: m.aliasId }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { options, state };
}
