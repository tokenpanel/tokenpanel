# TokenPanel

Open-source AI reseller gateway with customer billing, usage controls, and a real admin dashboard.

TokenPanel sits between AI providers and your customers. Connect upstream providers, create customer API keys, publish your own model aliases, set prices and limits, and track usage, revenue, cost, and profit from one self-hosted control plane.

No enterprise feature wall. No paid source tier for core features. TokenPanel is licensed under AGPLv3 so the platform stays open when modified and offered as a hosted service.

## Why TokenPanel

Most LLM gateways focus on routing requests across providers. TokenPanel focuses on operating an AI business on top of that gateway.

Use it when you need:

- Customer accounts, prepaid balances, subscriptions, and API keys
- OpenAI-compatible and Anthropic-compatible APIs for your customers
- Model aliases with provider fallback chains
- Per-model pricing, upstream cost tracking, and margin visibility
- Token, request, and spend limits over custom windows like 1h, 5h, weekly, or 30d
- Usage analytics by customer, model, cost, revenue, and profit
- A self-hosted dashboard your team can actually run day to day

If LiteLLM is the provider gateway, TokenPanel is the open-source customer, billing, and dashboard layer around AI resale.

## Features

**Customer management**

- Create customers with balances, status, metadata, and external IDs
- Issue customer API keys with one-time secret display
- Restrict keys to specific model aliases
- Suspend or close customers without rotating provider credentials

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

**Billing and limits**

- Store money as integer minor units, never floats
- Track upstream cost separately from customer price
- Debit customer balances after successful usage
- Record append-only usage and balance ledgers
- Enforce rolling token, request, and spend limits
- Define plan defaults and per-customer overrides

**Dashboard**

- Overview of customers, models, providers, plans, and balances
- Customer drawer with balance history, subscriptions, usage, and keys
- Plan editor with included credit, included tokens, and custom limits
- Analytics for requests, tokens, cost, revenue, and profit
- Admin playground for testing one or more models before customers use them
- Multi-organization console with invites and per-organization roles

**Operations**

- One-line Linux installer
- Docker-based production deployment
- MongoDB replica set for transactional billing and migrations
- Pre/post migration flow with destructive-operation safety checks
- Backups, restore, update, rollback, diagnostics, and optional Caddy HTTPS

## Install

Production install on a Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/tokenpanel/tokenpanel/refs/heads/stable/manager/get.tokenpanel.sh | sudo bash
```

Branded installer URL, once DNS is pointed at the repository-hosted script:

```bash
curl -fsSL https://get.tokenpanel.sh | sudo bash
```

The installer:

- Installs Docker if missing
- Clones the stable TokenPanel release to `/opt/tokenpanel`
- Stores config in `/etc/tokenpanel`
- Stores MongoDB data, backups, and certificates in `/var/tokenpanel/shared`
- Starts an interactive setup wizard for domain, HTTPS, MongoDB, and admin settings

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

Core data lives in MongoDB with zod-backed TypeScript schemas. Billing settlement uses MongoDB transactions so usage records, customer balance debits, balance ledger entries, and rate-limit counters commit together.

## Open Source Promise

TokenPanel is built as an open-source alternative to closed feature tiers around AI gateway operations. The goal is simple: if the feature exists, self-hosted users should have it.

You can self-host it, inspect it, modify it, and run it for your customers. If you modify TokenPanel and offer it as a hosted network service, AGPLv3 requires you to make the corresponding source code available to users of that service.

## License

TokenPanel is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

This is not legal advice. If you plan to redistribute TokenPanel or offer a modified hosted service, review the license with counsel.
