/**
 * Billing surface — charge helpers + model access.
 *
 * Domain ownership:
 *  - charges / estimate → domains/billing/*
 *  - preFlight → domains/billing/workflow.ts
 *  - settle → domains/settlement/settle.ts (Effect; run on ManagedRuntime)
 */

import type { ModelDoc, ModelEntryDoc } from "@tokenpanel/db";
import type { ChatMessage, ChatResponse } from "../providers/index.ts";
import type { CacheAccountingMode } from "../providers/provider-usage.ts";
import {
  estimatePromptTokens as estimatePromptTokensDomain,
  resolveCompletionCap as resolveCompletionCapDomain,
  worstCaseActiveEntryPrice as worstCaseActiveEntryPriceDomain,
} from "../domains/billing/estimate.ts";
import {
  applyTokenSchedule as applyTokenScheduleDomain,
  cacheAccountingForProtocol as cacheAccountingForProtocolDomain,
  computeCharges as computeChargesDomain,
  resolveCacheAccounting as resolveCacheAccountingDomain,
  type ChargeSchedule as ChargeScheduleDomain,
} from "../domains/billing/charges.ts";
import {
  SettlementGuardError,
  type SettlementActor,
} from "../domains/settlement/settle.ts";
import { throwBilling, billingAppError } from "./billing-errors.ts";

export {
  DEFAULT_COMPLETION_CAP,
  DEFAULT_COMPLETION_CAP_TOKENS,
} from "../domains/billing/policy.ts";

export { SettlementGuardError, type SettlementActor };
export type ChargeSchedule = ChargeScheduleDomain;

/**
 * @deprecated Prefer AppError tags via throwBilling / billingAppError.
 */
export class BillingError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown> | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  toAppError() {
    return billingAppError(this.status, this.code, this.message, this.extra);
  }
}

export { throwBilling, billingAppError } from "./billing-errors.ts";

export async function checkModelAccess(
  apiKeyModelWhitelist: string[],
  aliasId: string,
): Promise<void> {
  if (apiKeyModelWhitelist.length === 0) return;
  if (!apiKeyModelWhitelist.includes(aliasId)) {
    throwBilling(
      403,
      "model_not_allowed",
      `Your API key does not allow model '${aliasId}'`,
    );
  }
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return estimatePromptTokensDomain(messages);
}

export function worstCaseActiveEntryPrice(model: ModelDoc): {
  inputUnitsPerMillion: number;
  outputUnitsPerMillion: number;
} {
  return worstCaseActiveEntryPriceDomain(model);
}

export function resolveCompletionCap(
  maxCompletionTokens: number | undefined,
  model: ModelDoc,
): number {
  return resolveCompletionCapDomain(maxCompletionTokens, model);
}

export function cacheAccountingForProtocol(
  protocol: "openai" | "anthropic",
): CacheAccountingMode {
  return cacheAccountingForProtocolDomain(protocol);
}

export function resolveCacheAccounting(
  usage: ChatResponse["usage"],
  fallback?: CacheAccountingMode,
): CacheAccountingMode {
  return resolveCacheAccountingDomain(usage, fallback);
}

export function applyTokenSchedule(
  schedule: ChargeSchedule,
  usage: ChatResponse["usage"],
  opts?: { cacheAccounting?: CacheAccountingMode | undefined } | undefined,
): number {
  return applyTokenScheduleDomain(schedule, usage, opts);
}

export function computeCharges(params: {
  entry: ModelEntryDoc;
  model: ModelDoc;
  usage: ChatResponse["usage"];
  cacheAccounting?: CacheAccountingMode | undefined;
}): { costUnits: number; priceUnits: number; currency: string } {
  return computeChargesDomain(params);
}
