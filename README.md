<p align="center">
  <img src="apps/admin/public/logo.png" alt="TokenPanel logo" width="112" height="112">
</p>

# TokenPanel

## AI spend control and access management

TokenPanel is an open-source, self-hosted platform for tracking AI usage, managing users and accounts, enforcing budgets and rolling limits, and exposing a governed OpenAI- and Anthropic-compatible API.

Connect providers, issue API keys, set model prices and budgets, enforce limits, and see cost and usage from one dashboard — whether for internal teams, clients, or product metering.

No enterprise feature wall. No paid source tier for core features. TokenPanel is licensed under AGPLv3 so the platform stays open when modified and offered as a hosted service.

## Who is this for?

- Platform and infra teams centralizing AI provider access
- Product teams metering AI usage for customers
- Agencies allocating AI budget per client
- Teams that need per-user or per-account AI budgets and limits

## Why TokenPanel

Most LLM gateways focus on routing requests across providers. TokenPanel adds who can use what, at what cost, and under which limits.

Use it when you need:

- Accounts, prepaid balances, subscriptions, and API keys
- OpenAI-compatible and Anthropic-compatible APIs for your apps and users
- Model aliases with provider fallback chains
- Per-model pricing and upstream cost tracking
- Token, request, and spend limits over custom windows like 1h, 5h, weekly, or 30d
- Usage analytics by account, model, cost, and spend
- A self-hosted dashboard your team can actually run day to day

If LiteLLM is the provider gateway, TokenPanel is the open-source access, billing, and dashboard layer on top.

## Quick Start

Install TokenPanel on a Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/tokenpanel/tokenpanel/main/manager/install.sh | sudo bash
```

Prefer local development? Jump to [Local Development](#local-development).

## Features

**Accounts and access**

- Create accounts with balances, status, metadata, and external IDs
- Issue API keys with one-time secret display
- Restrict keys to specific model aliases
- Suspend or close accounts without rotating provider credentials

**AI gateway**

- OpenAI-compatible `/v1/models` and `/v1/chat/completions`
- Anthropic-compatible `/v1/messages`
- Streaming and non-streaming responses
- API-key auth, brute-force throttling, and per-key last-used tracking

**Provider and model control**

- Connect OpenAI-compatible and Anthropic-compatible providers
- Store provider secrets encrypted at rest
- Discover upstream models from providers
- Import model metadata and costs from models.dev
- Publish your own model aliases instead of exposing upstream names
- Configure ordered fallback chains across providers and upstream models

**Budgets and limits**

- Store money as integer minor units, never floats
- Track upstream cost separately from charged price
- Debit account balances after successful usage
- Record append-only usage and balance ledgers
- Enforce rolling token, request, and spend limits
- Define plan defaults and per-account overrides

**Dashboard**

- Overview of accounts, models, providers, plans, and balances
- Account drawer with balance history, subscriptions, usage, and keys
- Plan editor with included credit, included tokens, and custom limits
- Analytics for requests, tokens, cost, and spend
- Admin playground for testing one or more models before rollout
- Multi-organization console with invites and per-organization roles

**Operations**

- One-line Linux installer
- Docker-based production deployment
- MongoDB replica set for transactional billing and migrations
- Pre/post migration flow with destructive-operation safety checks
- Backups, restore, update, rollback, diagnostics, and optional Caddy HTTPS

## Production Install

Production install on a Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/tokenpanel/tokenpanel/main/manager/install.sh | sudo bash
```

The installer:

- Installs Docker if missing
- Clones the stable `main` branch to `/opt/tokenpanel`
- Stores config in `/etc/tokenpanel`
- Stores MongoDB data, backups, and certificates in `/var/tokenpanel/shared`
- Starts an interactive setup wizard for domain, HTTPS, MongoDB, and admin settings
- Keeps prompts interactive even when launched as `curl | sudo bash`

After install:

```bash
tokenpanel status
tokenpanel backup
tokenpanel update
tokenpanel logs -f
```

## Use The API

Create a customer and API key in the dashboard, then point OpenAI-compatible clients at your TokenPanel domain:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "tp_live_your_customer_key",
  baseURL: "https://your-tokenpanel-domain.com/v1",
});

const response = await client.chat.completions.create({
  model: "default-chat",
  messages: [{ role: "user", content: "Write a short welcome email." }],
});

console.log(response.choices[0]?.message.content);
```

Anthropic-compatible clients can call the same customer key through `Authorization: Bearer`:

```bash
curl https://your-tokenpanel-domain.com/v1/messages \
  -H "Authorization: Bearer tp_live_your_customer_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default-chat",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Explain token resale in one paragraph."}]
  }'
```

## Local Development

TokenPanel uses Bun workspaces and Docker Compose.

```bash
bun install
cp -f .env.example .env
bun run docker:start
```

Local URLs:

- Admin: `http://localhost:5173`
- API: `http://localhost:3000`
- Health: `http://localhost:3000/health`

Useful commands:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

## Architecture

TokenPanel has two API surfaces:

- Admin API under `/admin/*` for users managing organizations, providers, models, customers, plans, API keys, invites, analytics, and playground requests
- Public API under `/v1/*` for customer API keys calling OpenAI-compatible and Anthropic-compatible endpoints

Core data lives in MongoDB with Effect Schema TypeScript schemas. Billing settlement uses MongoDB transactions so usage records, customer balance debits, balance ledger entries, and rate-limit counters commit together.

## Open Source Promise

TokenPanel is built as an open-source alternative to closed feature tiers around AI gateway operations. The goal is simple: if the feature exists, self-hosted users should have it.

You can self-host it, inspect it, modify it, and run it for your customers. If you modify TokenPanel and offer it as a hosted network service, AGPLv3 requires you to make the corresponding source code available to users of that service.

## Project Status

TokenPanel is under active development. Review release notes and back up production data before upgrades. APIs, configuration, and deployment behavior may change before the first stable release.

Security reports should follow [SECURITY.md](SECURITY.md). Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).

## License

TokenPanel is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

This is not legal advice. If you plan to redistribute TokenPanel or offer a modified hosted service, review the license with counsel.
