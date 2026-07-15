# TokenPanel configuration reference

Canonical inventory of environment variables. Owners and consumers must stay aligned with code at:

- API: `apps/api/src/config/runtime.ts`
- DB library: `packages/db/src/config.ts` + migrator `packages/db/src/migrator/env.ts`
- Admin public: `apps/admin/src/config/public.ts`
- Vite proxy: `apps/admin/vite.config.ts`
- Manager/Compose: `manager/`, `compose.yml`

## Application runtime (API)

| Variable | Owner | Required | Default | Type | Secret | Notes |
|---|---|---|---|---|---|---|
| `JWT_SECRET` | API | yes | — | string (exact bytes) | **yes** | JWT + AES-GCM for provider keys. Production: ≥32 chars; reject known samples. Never log. Do not rotate casually. |
| `MONGODB_URI` | API / migrator | yes | — | `mongodb://` or `mongodb+srv://` | often | Parsed at executable boundary; passed to `configureDb`. |
| `MONGODB_DB` | API / migrator | no | `tokenpanel` | DB name 1–63 | no | Same default documented everywhere. |
| `PORT` | API | no | `3000` | int 1–65535 | no | Listener only. |
| `CORS_ORIGINS` | API | no | unset → dev reflect / prod fail-closed | comma exact origins | no | http(s) only; no path/query/credentials. |
| `NODE_ENV` | API | no | `development` | `development` \| `test` \| `production` | no | Behavior enum. |
| `RESERVATION_CANARY_ORG_IDS` | API | no | empty | comma 24-hex org ids | no | Orgs where atomic `balance.reservedMinor` holds are **enforced**. Empty = shadow-compare only (legacy `checkBalance`). See ADR 001. |
| ~~`TOKENPANEL_TEST_HOOKS`~~ | — | removed | — | — | — | Removed; use route DI (`createModelRoutes`) in tests. |

## Admin (build-time / Vite)

| Variable | Owner | Required | Default | Type | Secret | Notes |
|---|---|---|---|---|---|---|
| `VITE_API_BASE_URL` | admin public config | no | empty (same-origin) | http(s) URL | **no** (embedded) | Trailing slash stripped. |
| `VITE_DEV_API_URL` | Vite config only | no | `http://localhost:3000` | http(s) URL | no | Proxy target; not in browser bundle. |

## Docker Compose / manager (deployment)

| Variable | Owner | Notes |
|---|---|---|
| `MONGO_USER`, `MONGO_PASS` | Compose | Mongo credentials; never to admin container. |
| `MONGO_USER_URI`, `MONGO_PASS_URI` | Compose | Percent-encoded URI parts. |
| `MONGO_HOST_PORT` | Compose | Host bind for Mongo. |
| `API_PORT`, `ADMIN_HOST_PORT` | manager/Compose | Host ports. |
| `DOMAIN`, `ADMIN_EMAIL`, `USE_CADDY` | manager | Production routing/TLS. |
| `TOKENPANEL_*_DIR` | manager | Install paths; not passed to app containers. |
| `SMTP_*` | legacy | Not used by runtime mail (none yet); tolerate legacy lines. |

## Dependency direction

```
@tokenpanel/contracts  (no env)
        ↑
@tokenpanel/db  ← configureDb({ uri, databaseName })
        ↑
API executable ← parseApiRuntimeConfig(process.env)
Admin browser  ← import.meta.env only via config/public.ts
```

Historical migrations must **not** import live contracts or runtime config.
