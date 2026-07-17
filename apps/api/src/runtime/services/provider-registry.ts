/**
 * Provider adapter registry port (task 3.3).
 */
import { Context } from "effect";
import type { ProviderAdapter } from "../../providers/types.ts";

export type ProviderRegistryService = {
  readonly getAdapter: (sdkType: string) => ProviderAdapter | undefined;
  readonly listAdapters: () => readonly string[];
  readonly registerAdapter: (adapter: ProviderAdapter) => void;
};

export class ProviderRegistry extends Context.Tag("tokenpanel/ProviderRegistry")<
  ProviderRegistry,
  ProviderRegistryService
>() {}
