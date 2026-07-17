# Contributing to TokenPanel

TokenPanel welcomes bug reports, documentation improvements, and focused pull requests.

## Before You Start

- Search existing issues and pull requests.
- Open an issue before large architectural or user-facing changes.
- Never include provider keys, customer keys, database dumps, or `.env` files.
- Use Bun only. Do not use npm, Node package scripts, Yarn, or pnpm.

## Local Setup

```bash
bun install
cp -f .env.example .env
bun run docker:start
```

Admin UI runs at `http://localhost:5173`; API runs at `http://localhost:3000`.

## Project Structure

- `apps/api` — Hono API on `Bun.serve`
- `apps/admin` — React and Vite admin console
- `packages/db` — MongoDB driver, Effect Schema schemas, and migrations
- `manager` — production deployment and update tooling

Read [AGENTS.md](AGENTS.md) for architecture, migration safety, and repository conventions.

## Quality Gates

Run before submitting:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

Add tests for behavior changes and failure paths. Keep TypeScript strict: no `any`, unchecked indexing, unused locals, or unused parameters.

## Database Changes

- Storage shapes originate from Effect Schema schemas in `packages/db/src/schemas`.
- Pre-deploy migrations must remain additive and safe while old code is serving.
- Destructive changes belong in post-deploy migrations.
- Never edit an applied migration; checksums intentionally reject this.

## Pull Requests

Keep each pull request focused. Explain why the change is needed, list verification performed, and call out security, migration, or compatibility effects. By contributing, you agree your work is licensed under `AGPL-3.0-only`.
