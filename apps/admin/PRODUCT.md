# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operators of a self-hosted TokenPanel instance: platform/infra engineers, product teams metering AI for their customers, and agencies allocating AI budget per client. They split time roughly equally between two jobs:

- **Configure:** connect providers, publish model aliases with provider routing and pricing, define plans with limits, issue customer API keys and management keys, invite teammates with scoped permissions.
- **Monitor and act:** watch spend, tokens, and requests; check customer balances and subscriptions; top up, refund, suspend, or close accounts; test models in the playground before rollout.

Members may hold only some panel permissions; every surface must degrade gracefully when data or actions are redacted.

## Product Purpose

TokenPanel is an open-source (AGPLv3), self-hosted access, billing, and dashboard layer for AI usage. It exposes an OpenAI- and Anthropic-compatible gateway and adds who can use what, at what cost, under which limits. Success: an operator can see where money and tokens go, and change access, prices, and limits, without leaving the console or touching provider credentials.

## Positioning

If LiteLLM is the provider gateway, TokenPanel is the access, billing, and dashboard layer on top: customers with prepaid balances and subscriptions, per-model price vs. upstream cost, rolling token/request/spend limits over custom windows (1h, 5h, weekly, 30d), and scoped API keys. No enterprise feature wall.

## Operating Context

- Admin SPA (`apps/admin`, Vite + React 19 + Tailwind 4 + Radix/shadcn primitives) served by the API in production; dev on `:5173` proxied to API `:3000`.
- Multi-organization console: users switch active organization; page state remounts on switch.
- First run: `/signup` creates the first admin and a default organization. Later users join via invite links (`/signup#/token=…`). Everyone else signs in at `/login`.
- Sessions are long and repeated; operators work at desktop widths but must be able to check and act from a phone.

## Capabilities and Constraints

- Routes: Dashboard, Analytics, Providers, Models, Plans, Customers, API Keys, Management Keys, Playground, Organizations, Settings, plus Login and Signup/Invite.
- Money is integer micros + ISO currency; admins enter decimal major units. Upstream cost and charged price are tracked separately.
- One-time secret display for API keys, management keys, and invite links.
- Panel permissions gate each route and action (`dashboard:read`, `customers:write`, `balances:read`, etc.).
- Redesign scope: frontend look, feel, and interaction only. No API, database, contract, or data-shape changes.

## Brand Commitments

- Name: TokenPanel.
- Logo: the "TP" mark with blue circuit traces (`apps/admin/public/logo.png`) and its electric blue are binding.
- Themes: ship light and dark, following system preference by default with a manual toggle.

## Evidence on Hand

- README feature list and positioning (repo root `README.md`).
- No customer logos, testimonials, or benchmarks exist; do not invent any.

## Product Principles

1. Money and limits are the product: amounts, currencies, cost vs. price, and remaining headroom must be legible at a glance and never ambiguous.
2. Dense but calm: operators scan many rows; favor tabular clarity over decoration.
3. Dangerous actions are deliberate: revoking keys, deleting, suspending, and balance changes need clear confirmation and consequences.
4. Respect partial permissions: hide or explain what a member cannot see instead of showing broken states.
5. Secrets are shown once and handled carefully.
