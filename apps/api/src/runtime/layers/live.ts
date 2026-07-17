/**
 * Production Layer graph pieces (task 3.4 / 3.5 / 10.9).
 * Memoized assembly lives in app-runtime.ts.
 *
 * AppServices = core runtime ports + domain repository ports so route handlers
 * can run domain Effects on the process ManagedRuntime.
 */
import { Layer } from "effect";
import type { ApiRuntimeConfig } from "../../config/runtime.ts";
import { makeAppConfigLayer } from "./app-config.ts";
import { ClockLive } from "./clock.ts";
import { CryptoLive } from "./crypto.ts";
import { LoggerLive } from "./logger.ts";
import { MongoLive, makeMongoLayer, type MongoUnavailableError } from "./mongo.ts";
import { ProviderRegistryLive } from "./provider-registry.ts";
import { TelemetryLive } from "./telemetry.ts";
import { makeWorkerControlLive } from "./worker-control.ts";
import type { AppConfig } from "../services/app-config.ts";
import type { Clock } from "../services/clock.ts";
import type { Crypto } from "../services/crypto.ts";
import type { Logger } from "../services/logger.ts";
import type { MongoDb, MongoDbService } from "../services/mongo-db.ts";
import type { ProviderRegistry } from "../services/provider-registry.ts";
import type { Telemetry } from "../services/telemetry.ts";
import type { WorkerControl } from "../services/worker-control.ts";
import type { UserRepository } from "../../domains/ports/user-repository.ts";
import type { InviteRepository } from "../../domains/ports/invite-repository.ts";
import type { OrganizationRepository } from "../../domains/ports/organization-repository.ts";
import type { CustomerRepository } from "../../domains/ports/customer-repository.ts";
import type { PlanRepository } from "../../domains/ports/plan-repository.ts";
import type { ModelRepository } from "../../domains/ports/model-repository.ts";
import type { ProviderRepository } from "../../domains/ports/provider-repository.ts";
import type { KeyRepository } from "../../domains/ports/key-repository.ts";
import type { UsageRepository } from "../../domains/ports/usage-repository.ts";
import { RepositoryLive } from "../../infrastructure/mongo/repositories/live.ts";
import {
  ValidatedRepositoriesLive,
  type OrganizationsRepo,
  type IdentityRepo,
  type CustomersRepo,
  type ModelsRepo,
  type PlansRepo,
  type KeysRepo,
  type UsageRepo,
  type SettlementOutboxRepo,
} from "../../infrastructure/mongo/repositories/index.ts";

/** Core infrastructure tags (no domain repositories). */
export type CoreAppServices =
  | AppConfig
  | Clock
  | Crypto
  | Logger
  | MongoDb
  | ProviderRegistry
  | Telemetry
  | WorkerControl;

/** Domain-facing repository ports (HexId API, schema-decoding adapters). */
export type DomainRepositoryServices =
  | UserRepository
  | InviteRepository
  | OrganizationRepository
  | CustomerRepository
  | PlanRepository
  | ModelRepository
  | ProviderRepository
  | KeyRepository
  | UsageRepository;

/** §7 validated Effect Schema repository tags (ObjectId API). */
export type ValidatedRepositoryServices =
  | OrganizationsRepo
  | IdentityRepo
  | CustomersRepo
  | ModelsRepo
  | PlansRepo
  | KeysRepo
  | UsageRepo
  | SettlementOutboxRepo;

/** Domain repository tags provided by RepositoryLive. */
export type RepositoryServices =
  | DomainRepositoryServices
  | ValidatedRepositoryServices;

/** All application service tags provided by the production graph. */
export type AppServices = CoreAppServices | RepositoryServices;

/**
 * Core live services that do not open Mongo (safe for unit tests + dual-path).
 */
export function makeCoreLiveLayer(
  config: ApiRuntimeConfig,
): Layer.Layer<
  AppConfig | Clock | Crypto | Logger | ProviderRegistry | Telemetry | WorkerControl
> {
  return Layer.mergeAll(
    makeAppConfigLayer(config),
    ClockLive,
    CryptoLive,
    LoggerLive,
    ProviderRegistryLive,
    TelemetryLive,
    makeWorkerControlLive(config),
  );
}

/**
 * Provide schema-decoding domain ports + §7 validated repos on top of a base
 * Layer that already has MongoDb + Clock (and typically the rest of core).
 */
export function withRepositories<E, R>(
  base: Layer.Layer<CoreAppServices, E, R>,
): Layer.Layer<AppServices, E, R> {
  const repos = Layer.mergeAll(RepositoryLive, ValidatedRepositoriesLive);
  return Layer.provideMerge(repos, base) as Layer.Layer<AppServices, E, R>;
}

/**
 * Full production graph including scoped Mongo (requires network).
 * Layer error channel: MongoUnavailableError on connect/ping failure.
 */
export function makeAppLiveLayer(
  config: ApiRuntimeConfig,
): Layer.Layer<AppServices, MongoUnavailableError> {
  const configLayer = makeAppConfigLayer(config);
  const mongo = MongoLive.pipe(Layer.provide(configLayer));
  const base = Layer.mergeAll(
    makeCoreLiveLayer(config),
    mongo,
  ) as Layer.Layer<CoreAppServices, MongoUnavailableError>;
  return withRepositories(base);
}

/**
 * Production graph using an already-connected Mongo handle (boot path:
 * migrations/getDb already ran). No Layer connect error channel.
 */
export function makeAppLiveLayerWithMongo(
  config: ApiRuntimeConfig,
  mongo: MongoDbService,
): Layer.Layer<AppServices> {
  const base = Layer.mergeAll(
    makeCoreLiveLayer(config),
    makeMongoLayer(mongo),
  ) as Layer.Layer<CoreAppServices>;
  return withRepositories(base);
}
