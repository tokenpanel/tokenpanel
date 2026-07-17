/**
 * Settlement outbox schemas — Effect Schema production path (§11).
 */
import {
  SettlementOutboxStatus as SettlementOutboxStatusSchema,
  SettlementOutboxDoc as SettlementOutboxDocSchema,
  SettlementOutboxCreateInput as SettlementOutboxCreateInputSchema,
  SettlementOutboxUpdateInput as SettlementOutboxUpdateInputSchema,
} from "./effect/settlement-outbox.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const settlementOutboxStatus = withParseApi(SettlementOutboxStatusSchema);
export type SettlementOutboxStatus = Schema.Schema.Type<typeof SettlementOutboxStatusSchema>;

export const settlementOutboxDoc = withParseApi(SettlementOutboxDocSchema);
export const settlementOutboxCreateInput = withParseApi(SettlementOutboxCreateInputSchema);
export const settlementOutboxUpdateInput = withParseApi(SettlementOutboxUpdateInputSchema);
export type SettlementOutboxDoc = MutableDeep<Schema.Schema.Type<typeof SettlementOutboxDocSchema>>;
export type SettlementOutboxCreateInput = MutableDeep<Schema.Schema.Type<typeof SettlementOutboxCreateInputSchema>>;
export type SettlementOutboxUpdateInput = MutableDeep<Schema.Schema.Type<typeof SettlementOutboxUpdateInputSchema>>;
