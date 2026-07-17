/**
 * Customer + balance-adjustment schemas — Effect Schema production path (§11).
 */
import {
  CUSTOMER_STATUSES,
  BALANCE_ADJUSTMENT_REASONS,
} from "@tokenpanel/contracts";
import {
  CustomerDoc as CustomerDocSchema,
  CustomerCreateInput as CustomerCreateInputSchema,
  CustomerUpdateInput as CustomerUpdateInputSchema,
  BalanceAdjustmentDoc as BalanceAdjustmentDocSchema,
  BalanceAdjustmentCreateInput as BalanceAdjustmentCreateInputSchema,
  CustomerStatus,
  BalanceAdjustmentReason,
  MoneyMinor,
} from "./effect/customer.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";

export { CUSTOMER_STATUSES, BALANCE_ADJUSTMENT_REASONS };

export const customerDoc = withParseApi(CustomerDocSchema);
export const customerCreateInput = withParseApi(CustomerCreateInputSchema);
export const customerUpdateInput = withParseApi(CustomerUpdateInputSchema);
export const balanceAdjustmentDoc = withParseApi(BalanceAdjustmentDocSchema);
export const balanceAdjustmentCreateInput = withParseApi(
  BalanceAdjustmentCreateInputSchema,
);
export const customerStatus = withParseApi(CustomerStatus);
export const balanceAdjustmentReason = withParseApi(BalanceAdjustmentReason);
export const _balanceMoneyMinor = withParseApi(MoneyMinor);

export type CustomerDoc = MutableDeep<
  import("effect").Schema.Schema.Type<typeof CustomerDocSchema>
>;
export type CustomerCreateInput = MutableDeep<
  import("effect").Schema.Schema.Type<typeof CustomerCreateInputSchema>
>;
export type CustomerUpdateInput = MutableDeep<
  import("effect").Schema.Schema.Type<typeof CustomerUpdateInputSchema>
>;
export type BalanceAdjustmentDoc = MutableDeep<
  import("effect").Schema.Schema.Type<typeof BalanceAdjustmentDocSchema>
>;
export type BalanceAdjustmentCreateInput = MutableDeep<
  import("effect").Schema.Schema.Type<typeof BalanceAdjustmentCreateInputSchema>
>;
