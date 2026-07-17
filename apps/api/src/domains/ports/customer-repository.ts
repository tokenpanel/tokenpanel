/**
 * Customer + balance ledger persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type { CustomerDoc, BalanceAdjustmentDoc } from "@tokenpanel/db";
import type { CustomerStatus } from "@tokenpanel/contracts";
import type { HexId, PageQuery, PageResult, RepoError } from "./common.ts";

export type CustomerListFilter = {
  readonly organizationId: HexId;
  readonly status?: CustomerStatus | undefined;
  readonly q?: string | undefined;
};

export type NewCustomerRecord = {
  readonly organizationId: HexId;
  readonly externalId: string | null;
  readonly name: string;
  readonly email: string | null;
  readonly balance: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly reservedMinor: number;
  };
  readonly status: CustomerStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type BalanceAdjustInput = {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: "topup" | "adjustment" | "refund";
  readonly note: string | null;
  /** Currency currently stored on the customer (optimistic concurrency). */
  readonly expectedBalanceCurrency: string;
  /** When true, also set balance.currency (zero-balance currency switch). */
  readonly setCurrency: boolean;
};

export type CustomerRepositoryService = {
  readonly list: (
    filter: CustomerListFilter,
    page: PageQuery,
  ) => Effect.Effect<PageResult<CustomerDoc>, RepoError>;
  readonly findById: (
    organizationId: HexId,
    customerId: HexId,
  ) => Effect.Effect<CustomerDoc | null, RepoError>;
  /** Unscoped lookup by id (public key auth — org comes from customer). */
  readonly findByCustomerId: (
    customerId: HexId,
  ) => Effect.Effect<CustomerDoc | null, RepoError>;
  readonly findConflict: (
    organizationId: HexId,
    fields: { externalId?: string | undefined; email?: string | undefined },
    excludeCustomerId?: HexId,
  ) => Effect.Effect<CustomerDoc | null, RepoError>;
  /**
   * Insert customer (+ optional opening ledger row) atomically when
   * starting balance ≠ 0.
   */
  readonly insertWithOpeningBalance: (
    customer: NewCustomerRecord,
    openingNote: string | null,
  ) => Effect.Effect<CustomerDoc, RepoError>;
  readonly update: (
    organizationId: HexId,
    customerId: HexId,
    patch: {
      readonly externalId?: string | null | undefined;
      readonly name?: string | undefined;
      readonly email?: string | null | undefined;
      readonly status?: CustomerStatus | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ) => Effect.Effect<CustomerDoc | null, RepoError>;
  readonly close: (
    organizationId: HexId,
    customerId: HexId,
  ) => Effect.Effect<CustomerDoc | null, RepoError>;
  readonly adjustBalance: (
    input: BalanceAdjustInput,
  ) => Effect.Effect<
    { customer: CustomerDoc; adjustment: BalanceAdjustmentDoc } | null,
    RepoError
  >;
  readonly listBalanceHistory: (
    organizationId: HexId,
    customerId: HexId,
    page: PageQuery,
  ) => Effect.Effect<PageResult<BalanceAdjustmentDoc>, RepoError>;
};

export class CustomerRepository extends Context.Tag(
  "tokenpanel/CustomerRepository",
)<CustomerRepository, CustomerRepositoryService>() {}
