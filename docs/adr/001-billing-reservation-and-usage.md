# ADR 001: Authoritative usage, reservation, and rate-window policy

Status: accepted (initial dual-write stage)  
Date: 2026-07-13  
Related: `CODEBASE_REFACTORING_PLAN.md` Workstream 4 / Phases 6–7

## Context

Pre-flight used guessed token counts (`chars/4`, fixed 768 non-text, default 4096 completion cap). Provider adapters mapped missing usage to zeros, so billable upstream calls could settle free. Balance and rate checks were separate from writes (TOCTOU overspend). Settlement failures could disappear into logs.

## Decisions

### 1. Provider usage is discriminated

```ts
type ProviderUsage =
  | { status: "reported"; usage: TokenUsage }
  | { status: "missing"; reason: string; providerRequestId?: string };
```

Missing usage must not settle as a zero-cost completed charge. Persist a `settlement_outbox` row (`pending`) for reconciliation.

### 2. Rate windows remain fixed buckets until dual-read completes

Current implementation floors timestamps into window buckets (tumbling). Product language said “rolling.” **Decision for this stage:** keep tumbling-window algorithm names honest in code comments; dual-write comparison and sliding-window migration are deferred behind metrics. Document as **fixed window** in operator docs until Phase 7 canary switches.

### 3. Reservation schema is additive

`settlement_outbox` collection (pre migration) holds durable pending work. Customer `balance.reservedMinor` (default 0) holds estimated spend for canary orgs.

**Dual-write / canary (implemented):**
- Every preFlight **shadow-compares** legacy `amountMinor >= need` vs `available = amount − reserved` and logs `reservation_shadow_mismatch` when they diverge (low-cardinality JSON, no PII).
- Rate path dual-reads `checkLimits` and logs `rate_shadow_mismatch` on disagreement (same fixed-window algorithm until a second implementation lands).
- **Enforcement** of atomic holds is gated by `RESERVATION_CANARY_ORG_IDS` (comma-separated org ObjectIds). Listed orgs: `reserveBalance` on preFlight, `settleBalanceWithReservation` (or release on upstream fail) on settle; hold amount frozen into outbox context as `reservedMinor`. Unlisted orgs: legacy `checkBalance` + settle `$gte amountMinor` only.
- Rate **enforcement** remains tumbling-window `checkLimits` / `recordUsage` for all orgs (ADR decision until sliding-window dual-write).

### 4. Fallback policy

Fallback only for pre-stream-commit eligible failures (`ProviderError.fallbackEligible` or connection TypeError). After first client-visible stream delta: no provider switch.

### 5. Token counting (near-term)

Until tokenizer/provider count endpoints land, preflight still uses conservative estimates but characterization tests document them. Strict activation policy for unknown limits is deferred; discovery must not invent `200_000` / `0` sentinels as authoritative.

## Consequences

- Outbox dual-write can run without changing customer-facing enforcement immediately.
- Missing-usage responses should surface a stable error or 200 with outbox (product chose durable pending + no free settle).
- Rollback: stop reading outbox for enforcement; continue writing for diagnosis.

## Follow-ups

- ~~Atomic balance reservation (`reservedMinor`) with org canary.~~ (`services/reservation.ts`, `RESERVATION_CANARY_ORG_IDS`).
- Sliding-window rate algorithm dual-write (still fixed/tumbling for enforcement).
- Expand canary to 100% after concurrency metrics pass; then drop legacy reader.
- Official tokenizer / provider count for admission.
- ~~Reconciliation worker with bounded backoff.~~ (in-process worker:
  `services/settlement-reconcile.ts`, started from API boot; drains
  `settlement_outbox` with attempt backoff and pricing/actor snapshots.)
