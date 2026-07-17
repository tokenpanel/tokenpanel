/**
 * Browser-safe subscription plan contracts.
 *
 * Policy version: 2026-07-15
 * Owned by @tokenpanel/contracts. DB storage schemas and admin UI derive from
 * these tuples. Migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect`.
 */
import { Schema } from "effect";
import { withParseApi } from "./parse.ts";

// ---------------------------------------------------------------------------
// Plan billing interval
// ---------------------------------------------------------------------------

export const PLAN_INTERVALS = ["day", "week", "month", "year"] as const;

export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export const planIntervalSchema = withParseApi(Schema.Literal(...PLAN_INTERVALS));

// ---------------------------------------------------------------------------
// Subscription instance status (persisted shape)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "canceled",
  "ended",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscriptionStatusSchema = withParseApi(
  Schema.Literal(...SUBSCRIPTION_STATUSES),
);
