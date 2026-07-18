/**
 * Shared admin + management domain operations (task 8.7).
 *
 * ## Purpose
 * Admin JWT routes (`routes/customers.ts`, `routes/plans.ts`, …) and
 * management API-key routes (`routes/management/{read,write}.ts`) previously
 * duplicated customer lifecycle, balance adjustment, subscription, and usage
 * aggregation. Surface-specific authorization (admin role vs management scope)
 * and response redaction stay in HTTP adapters; business steps live here.
 *
 * ## Shared operations (import from domain modules)
 *
 * | Concern              | Domain module                         | Operations |
 * |----------------------|---------------------------------------|------------|
 * | Customers            | `domains/customers`                   | createCustomer, updateCustomer, closeCustomer, listCustomers, getCustomer |
 * | Balance              | `domains/customers`                   | adjustCustomerBalance, listBalanceHistory, redactCustomerBalance |
 * | Subscriptions        | `domains/plans`                       | subscribeCustomer, getActiveSubscription, addInterval |
 * | Plans / limits       | `domains/plans`                       | listPlans, createPlan, updatePlan, deactivatePlan, listCustomerLimits, listCustomerBudgets |
 * | Models (read DTO)    | `domains/models`                      | listActiveModels, toModelCapability |
 * | Analytics            | `domains/analytics`                   | customerUsage, analyticsSummary |
 * | Pagination / range   | `domains/pagination/range`            | normalizePageQuery, parseDateRange |
 * | Authz decisions      | `domains/auth/authz`                  | requireRole, requireManagementScope, hasManagementScope |
 *
 * ## Dual path
 * Routes use domain Effects + ManagedRuntime (task 13.2–13.4). New work
 * and §10 migrations MUST invoke these operations so admin and management
 * cannot diverge on uniqueness, currency, subscription, or ledger invariants.
 *
 * ## Surface-specific (NOT domain)
 * - Admin: `requireAuth` + `requireRole("admin")`, JWT session variables
 * - Management: `requireManagementScope("customers:write")` etc., balance
 *   redaction when missing `balances:read`, ledger note provenance via key prefix
 * - HTTP status / body rendering: `http/renderers/*`
 */

export {
  createCustomer,
  updateCustomer,
  closeCustomer,
  listCustomers,
  getCustomer,
  adjustCustomerBalance,
  listBalanceHistory,
  redactCustomerBalance,
} from "../customers/operations.ts";

export {
  subscribeCustomer,
  getActiveSubscription,
  addInterval,
  listPlans,
  createPlan,
  updatePlan,
  deactivatePlan,
} from "../plans/index.ts";

export {
  listActiveModels,
  toModelCapability,
  listModels,
} from "../models/operations.ts";

export {
  customerUsage,
  analyticsSummary,
  dashboardSummary,
} from "../analytics/operations.ts";

export {
  normalizePageQuery,
  parseDateRange,
} from "../pagination/range.ts";

export {
  requireRole,
  requireManagementScope,
  hasManagementScope,
} from "../auth/authz.ts";
