/**
 * Repository ports + live Layers (task 13.1).
 *
 * - §7 validated repos (ObjectId API, Effect Schema decode): OrganizationsRepo, …
 * - Domain-facing ports (HexId API, Effect Schema decode): UserRepository, … via live.ts
 * Production graph merges both via ValidatedRepositoriesLive + RepositoryLive.
 */

export type {
  RepoError,
  RepoNotFoundError,
  RepoIdError,
  SessionOpts,
  OrgScopedId,
  ListByOrgParams,
  FindEffect,
  GetEffect,
  WriteEffect,
  PageEffect,
} from "./types.ts";

export {
  OrganizationsRepo,
  OrganizationsRepoLive,
  type OrganizationsRepoService,
} from "./organizations.ts";

export {
  IdentityRepo,
  IdentityRepoLive,
  type IdentityRepoService,
} from "./identity.ts";

export {
  CustomersRepo,
  CustomersRepoLive,
  type CustomersRepoService,
} from "./customers.ts";

export {
  ModelsRepo,
  ModelsRepoLive,
  type ModelsRepoService,
} from "./models.ts";

export {
  PlansRepo,
  PlansRepoLive,
  type PlansRepoService,
} from "./plans.ts";

export {
  KeysRepo,
  KeysRepoLive,
  type KeysRepoService,
} from "./keys.ts";

export {
  UsageRepo,
  UsageRepoLive,
  type UsageRepoService,
} from "./usage.ts";

export {
  SettlementOutboxRepo,
  SettlementOutboxRepoLive,
  type SettlementOutboxRepoService,
} from "./settlement-outbox.ts";

/** Merged §7 validated repository graph. */
export {
  UserRepositoryLive,
  InviteRepositoryLive,
  OrganizationRepositoryLive,
  CustomerRepositoryLive,
  PlanRepositoryLive,
  ModelRepositoryLive,
  ProviderRepositoryLive,
  KeyRepositoryLive,
  UsageRepositoryLive,
  RepositoryLive,
} from "./live.ts";

import { Layer } from "effect";
import { OrganizationsRepoLive } from "./organizations.ts";
import { IdentityRepoLive } from "./identity.ts";
import { CustomersRepoLive } from "./customers.ts";
import { ModelsRepoLive } from "./models.ts";
import { PlansRepoLive } from "./plans.ts";
import { KeysRepoLive } from "./keys.ts";
import { UsageRepoLive } from "./usage.ts";
import { SettlementOutboxRepoLive } from "./settlement-outbox.ts";

export const ValidatedRepositoriesLive = Layer.mergeAll(
  OrganizationsRepoLive,
  IdentityRepoLive,
  CustomersRepoLive,
  ModelsRepoLive,
  PlansRepoLive,
  KeysRepoLive,
  UsageRepoLive,
  SettlementOutboxRepoLive,
);
