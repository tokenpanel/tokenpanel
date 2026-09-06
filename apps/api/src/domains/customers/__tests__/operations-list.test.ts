/**
 * Customer domain operations: list/get/create/update/close/listBalanceHistory
 * against recording fake repositories (org currency stamping, conflict checks,
 * pagination forwarding). Style matches admin-session.test.ts.
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  BalanceAdjustmentDoc,
  CustomerDoc,
  OrganizationDoc,
} from "@tokenpanel/db";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  closeCustomer,
  listBalanceHistory,
} from "../operations.ts";
import {
  CustomerRepository,
  type CustomerListFilter,
  type CustomerRepositoryService,
  type NewCustomerRecord,
} from "../../ports/customer-repository.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import type { PageQuery } from "../../ports/common.ts";
import { PersistenceDuplicateKeyError } from "../../../errors/families.ts";
import { normalizePageQuery } from "../../pagination/range.ts";

const ORG_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();
const NOW = new Date();

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function dupError(): PersistenceDuplicateKeyError {
  return new PersistenceDuplicateKeyError({
    code: "persistence_duplicate_key",
    message: "dup",
    retryClass: "never",
  });
}

function customerDoc(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: new ObjectId(CUSTOMER_ID),
    organizationId: new ObjectId(ORG_ID),
    externalId: "ext-1",
    name: "Acme",
    email: "acme@example.com",
    balance: { amountMicros: 0, reservedMicros: 0, currency: "EUR" },
    status: "active",
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function orgDoc(defaultCurrency: string): OrganizationDoc {
  return {
    _id: new ObjectId(ORG_ID),
    name: "default",
    slug: "default",
    ownerId: new ObjectId(),
    defaultCurrency,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function adjustmentDoc(over: Partial<BalanceAdjustmentDoc> = {}): BalanceAdjustmentDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(ORG_ID),
    customerId: new ObjectId(CUSTOMER_ID),
    amountMicros: 5_000_000,
    currency: "EUR",
    reason: "topup",
    note: null,
    idempotencyKey: null,
    createdAt: NOW,
    ...over,
  } as unknown as BalanceAdjustmentDoc;
}

type ListArgs = {
  readonly organizationId: string;
  readonly status?: string | undefined;
  readonly q?: string | undefined;
  readonly email?: string | undefined;
};

function customerStore(overrides?: {
  readonly findConflictResult?: unknown;
  readonly updateResult?: CustomerDoc | null;
  readonly closeResult?: CustomerDoc | null;
}) {
  const listArgs: { readonly args: ListArgs; readonly page: unknown }[] = [];
  const conflictArgs: unknown[] = [];
  const insertArgs: unknown[] = [];
  const updateArgs: unknown[] = [];
  const closeArgs: unknown[] = [];
  const historyArgs: unknown[] = [];
  const service: CustomerRepositoryService = {
    list: (args: CustomerListFilter, page: PageQuery) =>
      Effect.sync(() => {
        listArgs.push({ args, page });
        return { items: [customerDoc()], total: 1 };
      }),
    findById: (_org: string, id: string) =>
      Effect.sync(() => (id === CUSTOMER_ID ? customerDoc() : null)),
    findConflict: (...args: unknown[]) =>
      Effect.sync(() => {
        conflictArgs.push(args);
        return (overrides?.findConflictResult ?? null) as never;
      }),
    insertWithOpeningBalance: (record: NewCustomerRecord, adjustment: string | null) =>
      Effect.sync(() => {
        insertArgs.push({ record, adjustment });
        return customerDoc({
          balance: record.balance,
          metadata: record.metadata,
        });
      }),
    update: (_org: string, id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        updateArgs.push({ id, patch });
        return overrides?.updateResult !== undefined
          ? overrides.updateResult
          : customerDoc({ name: String(patch.name ?? "Acme") });
      }),
    close: (_org: string, id: string) =>
      Effect.sync(() => {
        closeArgs.push(id);
        return overrides?.closeResult !== undefined
          ? overrides.closeResult
          : customerDoc({ status: "closed" });
      }),
    adjustBalance: neverCall,
    listBalanceHistory: (org: string, id: string, page: unknown) =>
      Effect.sync(() => {
        historyArgs.push({ org, id, page });
        return {
          items: [adjustmentDoc()],
          total: 1,
        };
      }),
  } as unknown as CustomerRepositoryService;
  return {
    listArgs,
    conflictArgs,
    insertArgs,
    updateArgs,
    closeArgs,
    historyArgs,
    layer: Layer.succeed(CustomerRepository, service),
  };
}

function orgLayer(defaultCurrency = "EUR") {
  return Layer.succeed(OrganizationRepository, {
    findById: (id: string) =>
      Effect.sync(() => (id === ORG_ID ? orgDoc(defaultCurrency) : null)),
  } as unknown as OrganizationRepositoryService);
}

async function run<E, A>(
  program: Effect.Effect<A, E, never>,
): Promise<{ tag: "Right"; value: A } | { tag: "Left"; error: E }> {
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") return { tag: "Right", value: exit.value };
  if (exit.cause._tag === "Fail") return { tag: "Left", error: exit.cause.error };
  throw new Error(`unexpected non-fail cause: ${exit.cause._tag}`);
}

test("listCustomers forwards filters and normalized page to repository", async () => {
  const store = customerStore();
  const result = await run(
    listCustomers({
      organizationId: ORG_ID,
      status: "active",
      q: "ac",
      email: "acme@example.com",
      limit: 10,
      skip: 5,
    }).pipe(Effect.provide(store.layer)),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.total).toBe(1);
  const call = store.listArgs[0];
  expect(call?.args.organizationId).toBe(ORG_ID);
  expect(call?.args.status).toBe("active");
  expect(call?.args.q).toBe("ac");
  expect(call?.args.email).toBe("acme@example.com");
  const expectedPage = await Effect.runPromise(
    normalizePageQuery({ limit: 10, skip: 5 }),
  );
  expect(call?.page).toEqual(expectedPage);
});

test("listCustomers omits undefined filters from repository args", async () => {
  const store = customerStore();
  await run(
    listCustomers({ organizationId: ORG_ID }).pipe(Effect.provide(store.layer)),
  );
  const call = store.listArgs[0];
  expect(call).toBeDefined();
  expect("status" in (call?.args ?? {})).toBe(false);
  expect("q" in (call?.args ?? {})).toBe(false);
  expect("email" in (call?.args ?? {})).toBe(false);
});

test("getCustomer: found doc passes through; miss → customer not_found", async () => {
  const store = customerStore();
  const ok = await run(
    getCustomer({ organizationId: ORG_ID, customerId: CUSTOMER_ID }).pipe(
      Effect.provide(store.layer),
    ),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") expect(ok.value._id.toHexString()).toBe(CUSTOMER_ID);
  const bad = await run(
    getCustomer({
      organizationId: ORG_ID,
      customerId: new ObjectId().toHexString(),
    }).pipe(Effect.provide(store.layer)),
  );
  expect(bad.tag).toBe("Left");
  if (bad.tag !== "Left") return;
  expect(bad.error.code).toBe("not_found");
  expect(bad.error._tag).toBe("NotFoundError");
  if (bad.error._tag !== "NotFoundError") return;
  expect(bad.error.resource).toBe("customer");
});

test("createCustomer stamps opening balance with org currency", async () => {
  const store = customerStore();
  const result = await run(
    createCustomer({
      organizationId: ORG_ID,
      name: "Fresh Co",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, orgLayer("EUR")))),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.balance.currency).toBe("EUR");
  expect(result.value.balance.amountMicros).toBe(0);
  const call = store.insertArgs[0] as
    | {
        record: {
          balance: { currency: string };
          externalId: string | null;
          email: string | null;
          status: string;
          metadata: Record<string, unknown>;
        };
        adjustment: unknown;
      }
    | undefined;
  expect(call?.record.balance.currency).toBe("EUR");
  expect(call?.record.externalId).toBeNull();
  expect(call?.record.email).toBeNull();
  expect(call?.record.status).toBe("active");
  expect(call?.adjustment).toBeNull();
});

test("createCustomer skips conflict lookup when neither externalId nor email present", async () => {
  const store = customerStore();
  await run(
    createCustomer({ organizationId: ORG_ID, name: "Fresh Co" }).pipe(
      Effect.provide(Layer.mergeAll(store.layer, orgLayer())),
    ),
  );
  expect(store.conflictArgs).toHaveLength(0);
});

test("createCustomer externalId conflict → duplicate_external_id_or_email", async () => {
  const store = customerStore({ findConflictResult: customerDoc() });
  const result = await run(
    createCustomer({
      organizationId: ORG_ID,
      name: "Fresh Co",
      externalId: "ext-1",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, orgLayer()))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("duplicate_external_id_or_email");
  expect(result.error._tag).toBe("ConflictError");
  if (result.error._tag !== "ConflictError") return;
  expect(result.error.fields).toEqual(["externalId", "email"]);
});

test("createCustomer duplicate-key insert failure maps to same conflict code", async () => {
  const conflictStore = Layer.succeed(CustomerRepository, {
    ...neverCallCustomerSurface(),
    findConflict: () => Effect.succeed(null),
    insertWithOpeningBalance: () => Effect.fail(dupError()),
  } as unknown as CustomerRepositoryService);
  const result = await run(
    createCustomer({
      organizationId: ORG_ID,
      name: "Fresh Co",
      email: "acme@example.com",
    }).pipe(Effect.provide(Layer.mergeAll(conflictStore, orgLayer()))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("duplicate_external_id_or_email");
});

test("updateCustomer: string fields conflict-check; null clears skip check", async () => {
  const store = customerStore();
  const result = await run(
    updateCustomer({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      patch: { externalId: null, email: "new@example.com" },
    }).pipe(Effect.provide(store.layer)),
  );
  expect(result.tag).toBe("Right");
  const call = store.conflictArgs[0] as
    | [string, { externalId?: string; email?: string }, string]
    | undefined;
  expect(call).toBeDefined();
  expect(call?.[1].externalId).toBeUndefined();
  expect(call?.[1].email).toBe("new@example.com");
  expect(call?.[2]).toBe(CUSTOMER_ID);
});

test("updateCustomer conflict → duplicate_external_id_or_email without update", async () => {
  const store = customerStore({ findConflictResult: customerDoc() });
  const result = await run(
    updateCustomer({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      patch: { email: "acme@example.com" },
    }).pipe(Effect.provide(store.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("duplicate_external_id_or_email");
  expect(store.updateArgs).toHaveLength(0);
});

test("updateCustomer: null update → customer not_found", async () => {
  const store = customerStore({ updateResult: null });
  const result = await run(
    updateCustomer({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      patch: { name: "Renamed" },
    }).pipe(Effect.provide(store.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("NotFoundError");
  if (result.error._tag !== "NotFoundError") return;
  expect(result.error.resource).toBe("customer");
  expect(result.error.id).toBe(CUSTOMER_ID);
});

test("closeCustomer: returns closed status; miss → not_found", async () => {
  const store = customerStore();
  const ok = await run(
    closeCustomer({ organizationId: ORG_ID, customerId: CUSTOMER_ID }).pipe(
      Effect.provide(store.layer),
    ),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") expect(ok.value.status).toBe("closed");
  const store2 = customerStore({ closeResult: null });
  const bad = await run(
    closeCustomer({ organizationId: ORG_ID, customerId: CUSTOMER_ID }).pipe(
      Effect.provide(store2.layer),
    ),
  );
  expect(bad.tag).toBe("Left");
  if (bad.tag !== "Left") return;
  expect(bad.error.code).toBe("not_found");
});

test("listBalanceHistory forwards page without requiring customer existence", async () => {
  const store = customerStore();
  const result = await run(
    listBalanceHistory({
      organizationId: ORG_ID,
      customerId: "nonexistent",
      limit: 25,
      skip: 75,
    }).pipe(Effect.provide(store.layer)),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.total).toBe(1);
  const call = store.historyArgs[0] as
    | { org: string; id: string; page: { limit: number; skip: number } }
    | undefined;
  expect(call?.id).toBe("nonexistent");
  expect(call?.page.limit).toBe(25);
  expect(call?.page.skip).toBe(75);
});

function neverCallCustomerSurface(): Partial<CustomerRepositoryService> {
  return {
    list: neverCall,
    findById: neverCall,
    findConflict: neverCall,
    insertWithOpeningBalance: neverCall,
    update: neverCall,
    close: neverCall,
    adjustBalance: neverCall,
    listBalanceHistory: neverCall,
  };
}
