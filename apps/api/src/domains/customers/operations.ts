/**
 * Customer lifecycle + balance operations shared by admin & management (task 8.2).
 * Surface-specific authz stays outside this module.
 */
import { Effect } from "effect";
import type { CustomerDoc, BalanceAdjustmentDoc } from "@tokenpanel/db";
import type { CustomerStatus } from "@tokenpanel/contracts";
import {
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
} from "../../errors/families.ts";
import type { HexId, PageQuery, PageResult, RepoError } from "../ports/common.ts";
import { CustomerRepository } from "../ports/customer-repository.ts";
import { OrganizationRepository } from "../ports/organization-repository.ts";
import { normalizePageQuery } from "../pagination/range.ts";
import type { ValidationError } from "../../errors/families.ts";

export type CustomerDomainError =
  | ConflictError
  | NotFoundError
  | InsufficientBalanceError
  | ValidationError
  | RepoError;

export type CreateCustomerInput = {
  readonly organizationId: HexId;
  readonly name: string;
  readonly externalId?: string | undefined;
  readonly email?: string | undefined;
  readonly startingBalance?:
    | { readonly amountUnits: number; readonly currency: string }
    | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Optional ledger note for non-zero opening balance (management provenance). */
  readonly openingNote?: string | null | undefined;
};

export const listCustomers = (input: {
  readonly organizationId: HexId;
  readonly status?: CustomerStatus | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
}): Effect.Effect<
  PageResult<CustomerDoc>,
  CustomerDomainError,
  CustomerRepository
> =>
  Effect.gen(function* () {
    const page = yield* normalizePageQuery({
      limit: input.limit,
      skip: input.skip,
    });
    const customers = yield* CustomerRepository;
    return yield* customers.list(
      {
        organizationId: input.organizationId,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.q !== undefined ? { q: input.q } : {}),
      },
      page,
    );
  });

export const getCustomer = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
}): Effect.Effect<CustomerDoc, CustomerDomainError, CustomerRepository> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    const doc = yield* customers.findById(
      input.organizationId,
      input.customerId,
    );
    if (!doc) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    return doc;
  });

export const createCustomer = (
  input: CreateCustomerInput,
): Effect.Effect<
  CustomerDoc,
  CustomerDomainError,
  CustomerRepository | OrganizationRepository
> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    // Org is single-currency: always stamp opening balance with org currency.
    let orgCurrency = "USD";
    const orgs = yield* OrganizationRepository;
    const org = yield* orgs.findById(input.organizationId);
    if (org) orgCurrency = org.defaultCurrency;
    const starting = {
      amountUnits: input.startingBalance?.amountUnits ?? 0,
      currency: orgCurrency,
    };
    const conflictFields: {
      externalId?: string | undefined;
      email?: string | undefined;
    } = {};
    if (input.externalId !== undefined)
      conflictFields.externalId = input.externalId;
    if (input.email !== undefined) conflictFields.email = input.email;
    if (
      conflictFields.externalId !== undefined ||
      conflictFields.email !== undefined
    ) {
      const conflict = yield* customers.findConflict(
        input.organizationId,
        conflictFields,
      );
      if (conflict) {
        return yield* Effect.fail(
          new ConflictError({
            code: "duplicate_external_id_or_email",
            message: "Duplicate externalId or email",
            fields: ["externalId", "email"],
          }),
        );
      }
    }

    const doc = yield* customers
      .insertWithOpeningBalance(
        {
          organizationId: input.organizationId,
          externalId: input.externalId ?? null,
          name: input.name,
          email: input.email ?? null,
          balance: {
            amountUnits: starting.amountUnits,
            currency: starting.currency,
            reservedUnits: 0,
          },
          status: "active",
          metadata: input.metadata ?? {},
        },
        input.openingNote ??
          (starting.amountUnits !== 0 ? "opening balance" : null),
      )
      .pipe(
        Effect.mapError((e) =>
          e._tag === "PersistenceDuplicateKeyError"
            ? new ConflictError({
                code: "duplicate_external_id_or_email",
                message: "Duplicate externalId or email",
                fields: ["externalId", "email"],
              })
            : e,
        ),
      );
    return doc;
  });

export const updateCustomer = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly patch: {
    readonly externalId?: string | null | undefined;
    readonly name?: string | undefined;
    readonly email?: string | null | undefined;
    readonly status?: CustomerStatus | undefined;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  };
}): Effect.Effect<CustomerDoc, CustomerDomainError, CustomerRepository> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    if (
      input.patch.externalId !== undefined ||
      input.patch.email !== undefined
    ) {
      const fields: {
        externalId?: string | undefined;
        email?: string | undefined;
      } = {};
      if (typeof input.patch.externalId === "string")
        fields.externalId = input.patch.externalId;
      if (typeof input.patch.email === "string") fields.email = input.patch.email;
      if (fields.externalId !== undefined || fields.email !== undefined) {
        const dup = yield* customers.findConflict(
          input.organizationId,
          fields,
          input.customerId,
        );
        if (dup) {
          return yield* Effect.fail(
            new ConflictError({
              code: "duplicate_external_id_or_email",
              message: "Duplicate externalId or email",
              fields: ["externalId", "email"],
            }),
          );
        }
      }
    }
    const updated = yield* customers.update(
      input.organizationId,
      input.customerId,
      input.patch,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    return updated;
  });

export const closeCustomer = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
}): Effect.Effect<
  { ok: true; status: string },
  CustomerDomainError,
  CustomerRepository
> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    const updated = yield* customers.close(
      input.organizationId,
      input.customerId,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    return { ok: true as const, status: updated.status };
  });

export const adjustCustomerBalance = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly amountUnits: number;
  /** Ignored for write — org/customer balance currency is used. Kept for API shape. */
  readonly currency?: string | undefined;
  readonly reason?: "topup" | "adjustment" | "refund" | undefined;
  readonly note?: string | null | undefined;
}): Effect.Effect<
  { customer: CustomerDoc; adjustment: BalanceAdjustmentDoc },
  CustomerDomainError,
  CustomerRepository
> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    const customer = yield* customers.findById(
      input.organizationId,
      input.customerId,
    );
    if (!customer) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }

    // Single-currency org: always adjust in the customer's existing currency
    // (aligned with org via create/convert). Client-sent currency is ignored.
    const currency = customer.balance.currency;

    const result = yield* customers.adjustBalance({
      organizationId: input.organizationId,
      customerId: input.customerId,
      amountUnits: input.amountUnits,
      currency,
      reason: input.reason ?? "topup",
      note: input.note ?? null,
      expectedBalanceCurrency: customer.balance.currency,
      setCurrency: false,
    });
    if (!result) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    return result;
  });

export const listBalanceHistory = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
}): Effect.Effect<
  PageResult<BalanceAdjustmentDoc>,
  CustomerDomainError,
  CustomerRepository
> =>
  Effect.gen(function* () {
    const page: PageQuery = yield* normalizePageQuery({
      limit: input.limit,
      skip: input.skip,
    });
    // Existence not required for history listing parity with routes? Routes don't
    // check customer existence — empty page is fine. Keep same.
    const customers = yield* CustomerRepository;
    return yield* customers.listBalanceHistory(
      input.organizationId,
      input.customerId,
      page,
    );
  });

/**
 * Redact balance when caller lacks balances:read (management surface).
 * Shared pure helper for admin/management DTO mapping.
 */
export function maybeRedactCustomerBalance<T extends { balance: unknown }>(
  customer: T,
  hasBalancesRead: boolean,
): T | Omit<T, "balance"> {
  if (hasBalancesRead) return customer;
  const { balance: _drop, ...rest } = customer;
  void _drop;
  return rest;
}
