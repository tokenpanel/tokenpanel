import { Layer } from "effect";
import {
  getAdapter,
  listAdapters,
  registerAdapter,
} from "../../providers/registry.ts";
import {
  ProviderRegistry,
  type ProviderRegistryService,
} from "../services/provider-registry.ts";

function makeService(): ProviderRegistryService {
  return {
    getAdapter,
    listAdapters,
    registerAdapter,
  };
}

/**
 * Live registry wraps the process-global adapters map.
 * Built-ins register on providers/index import.
 */
export const ProviderRegistryLive = Layer.succeed(
  ProviderRegistry,
  makeService(),
);

export const ProviderRegistryTest = ProviderRegistryLive;
