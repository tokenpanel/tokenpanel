/**
 * Provider lifecycle + dependency checks (task 8.4).
 */
import { Effect } from "effect";
import type { ProviderDoc } from "@tokenpanel/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  SystemError,
} from "../../errors/families.ts";
import type { HexId, RepoError } from "../ports/common.ts";
import { ProviderRepository } from "../ports/provider-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";

export type ProviderDomainError =
  | ConflictError
  | NotFoundError
  | ValidationError
  | SystemError
  | RepoError;

export type ProviderView = Omit<ProviderDoc, "apiKeyEncrypted" | "headers"> & {
  readonly hasApiKey: true;
  /**
   * Header *names* only — values are secrets (Authorization, X-API-Key, …).
   * Full values are write-only via providers:write.
   */
  readonly headers: Readonly<Record<string, true>>;
};

export function maskProvider(doc: ProviderDoc): ProviderView {
  const { apiKeyEncrypted: _omit, headers: rawHeaders, ...rest } = doc;
  void _omit;
  const headers: Record<string, true> = {};
  for (const name of Object.keys(rawHeaders ?? {})) {
    headers[name] = true;
  }
  return { ...rest, headers, hasApiKey: true };
}

export type SdkTypeValidator = (sdkType: string) => boolean;

export const listProviders = (
  organizationId: HexId,
): Effect.Effect<readonly ProviderView[], RepoError, ProviderRepository> =>
  Effect.gen(function* () {
    const providers = yield* ProviderRepository;
    const docs = yield* providers.list(organizationId);
    return docs.map(maskProvider);
  });

export const getProvider = (input: {
  readonly organizationId: HexId;
  readonly providerId: HexId;
}): Effect.Effect<ProviderView, ProviderDomainError, ProviderRepository> =>
  Effect.gen(function* () {
    const providers = yield* ProviderRepository;
    const doc = yield* providers.findById(
      input.organizationId,
      input.providerId,
    );
    if (!doc) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Provider not found",
          resource: "provider",
          id: input.providerId,
        }),
      );
    }
    return maskProvider(doc);
  });

export const createProvider = (input: {
  readonly organizationId: HexId;
  readonly name: string;
  readonly sdkType: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly providerOrg?: string | null | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly isKnownSdkType: SdkTypeValidator;
}): Effect.Effect<
  ProviderView,
  ProviderDomainError,
  ProviderRepository | Crypto
> =>
  Effect.gen(function* () {
    if (!input.isKnownSdkType(input.sdkType)) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: `unknown_sdk_type: ${input.sdkType}`,
          mode: "default_400",
        }),
      );
    }
    const crypto = yield* Crypto;
    const encrypted = yield* crypto.encryptSecret(input.apiKey).pipe(
      Effect.mapError(
        (e) =>
          new SystemError({
            code: "system_error",
            message: "Failed to encrypt provider secret",
            diagnostic: e instanceof Error ? e.message : String(e),
          }),
      ),
    );
    const providers = yield* ProviderRepository;
    const doc = yield* providers.insert({
      organizationId: input.organizationId,
      name: input.name,
      sdkType: input.sdkType,
      apiKeyEncrypted: encrypted,
      baseUrl: input.baseUrl,
      providerOrg: input.providerOrg ?? null,
      headers: input.headers ?? {},
      active: true,
      metadata: input.metadata ?? {},
    });
    return maskProvider(doc);
  });

export const updateProvider = (input: {
  readonly organizationId: HexId;
  readonly providerId: HexId;
  readonly patch: {
    readonly name?: string | undefined;
    readonly sdkType?: string | undefined;
    readonly apiKey?: string | undefined;
    readonly baseUrl?: string | undefined;
    readonly providerOrg?: string | null | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly active?: boolean | undefined;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  };
  readonly isKnownSdkType: SdkTypeValidator;
}): Effect.Effect<
  ProviderView,
  ProviderDomainError,
  ProviderRepository | Crypto
> =>
  Effect.gen(function* () {
    if (
      input.patch.sdkType !== undefined &&
      !input.isKnownSdkType(input.patch.sdkType)
    ) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: `unknown_sdk_type: ${input.patch.sdkType}`,
          mode: "default_400",
        }),
      );
    }
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.patch)) {
      if (v === undefined) continue;
      if (k === "apiKey") {
        const crypto = yield* Crypto;
        $set.apiKeyEncrypted = yield* crypto.encryptSecret(v as string).pipe(
          Effect.mapError(
            (e) =>
              new SystemError({
                code: "system_error",
                message: "Failed to encrypt provider secret",
                diagnostic: e instanceof Error ? e.message : String(e),
              }),
          ),
        );
      } else {
        $set[k] = v;
      }
    }
    const providers = yield* ProviderRepository;
    const updated = yield* providers.update(
      input.organizationId,
      input.providerId,
      $set,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Provider not found",
          resource: "provider",
          id: input.providerId,
        }),
      );
    }
    return maskProvider(updated);
  });

/**
 * Delete provider only when no model entries reference it; cascade catalog.
 */
export const deleteProvider = (input: {
  readonly organizationId: HexId;
  readonly providerId: HexId;
}): Effect.Effect<{ ok: true }, ProviderDomainError, ProviderRepository> =>
  Effect.gen(function* () {
    const providers = yield* ProviderRepository;
    const existing = yield* providers.findById(
      input.organizationId,
      input.providerId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Provider not found",
          resource: "provider",
          id: input.providerId,
        }),
      );
    }
    const refCount = yield* providers.countModelRefs(
      input.organizationId,
      input.providerId,
    );
    if (refCount > 0) {
      return yield* Effect.fail(
        new ConflictError({
          code: "provider_in_use",
          message: `Provider is referenced by ${refCount} model(s)`,
        }),
      );
    }
    const ok = yield* providers.deleteWithCatalog(
      input.organizationId,
      input.providerId,
    );
    if (!ok) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Provider not found",
          resource: "provider",
          id: input.providerId,
        }),
      );
    }
    return { ok: true as const };
  });
