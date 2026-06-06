# Architecture

> Return here first when re-entering the codebase cold. For deep rationale on any decision, see `docs/engineering-charter.md` or the relevant ADR in `docs/adr/`.

## System Components

```mermaid
graph TD
    Client["Client (HTTP)"]

    subgraph Process["Fastify Process (src/main.ts)"]
        Router["Route Handlers"]
        AuthMW["Auth Middleware"]
        Workers["Email Workers\n— BullMQ Worker\n— in-process today, splitting soon"]
    end

    PG[("PostgreSQL 18\nKysely — runtime queries\nPrisma — migrations only")]
    RedisS[("Redis — session\nREDIS_URL\nLRU evictable")]
    RedisQ[("Redis — queue\nQUEUE_REDIS_URL\nAOF-persisted")]

    Resend["Resend API\n(transactional email)"]
    S3["AWS S3\n(object storage)"]

    Client -->|"Bearer token / IP-checked"| Router
    Router --> AuthMW
    AuthMW -->|"fast path: cache lookup"| RedisS
    AuthMW -->|"slow path: session + user + tenant"| PG
    Router -->|"Kysely queries"| PG
    Router -->|"idempotency keys + enqueue jobs"| RedisQ
    Workers -->|"consume jobs"| RedisQ
    Workers -->|"send emails"| Resend
    Router -->|"presigned URLs / uploads"| S3
```

**Two Redis instances are intentional** — session cache (`REDIS_URL`) can be LRU-evicted without data loss; a lost session is just a logout. Queue Redis (`QUEUE_REDIS_URL`) must be AOF-persisted because losing it loses enqueued jobs.

**Email workers** currently start inside the same process as the HTTP server (via `startEmailWorkers()` in `buildApp()`). They will move to a dedicated worker process; when that happens, both processes connect to `QUEUE_REDIS_URL` independently.

---

## Startup Sequence

```mermaid
flowchart TD
    A["main.ts"] --> B["validateConfig()"]
    B -->|"invalid PORT\nor missing RESEND_API_KEY in prod"| X1["process.exit(1)"]
    B --> C["assertInfraReady()"]
    C -->|"Postgres or either Redis\nunreachable within 5 s"| X2["process.exit(1)"]
    C --> D["buildApp()"]
    D --> E["register Fastify plugins\n(swagger, error handler, modules)"]
    E --> F["start email workers\n(skipped if RESEND_API_KEY is empty)"]
    F --> G["app.listen(PORT)"]
    G -->|"bind error"| X3["process.exit(1)"]
    G --> H["accepting traffic"]
```

Nothing degrades silently — any failure before `app.listen` exits the process immediately.

---

## Request Lifecycle

### Tenant route (any route outside `/platform/*`)

```mermaid
sequenceDiagram
    participant C as Client
    participant F as Fastify
    participant A as authenticate hook
    participant RS as Redis (session)
    participant PG as Postgres
    participant Svc as Service
    participant Repo as Repository

    C->>F: GET /some/route\nAuthorization: Bearer <token>
    F->>A: onRequest
    A->>RS: GET session:<token>
    alt cache hit
        RS-->>A: { userId, tenantId, role }
    else cache miss
        A->>PG: SELECT Session JOIN User JOIN Tenant
        PG-->>A: row
        A->>RS: SETEX session:<token> <remainingTtl>
    end
    A-->>F: request.user = { userId, tenantId, role }
    F->>Svc: handler passes tenantId explicitly
    Svc->>Repo: query(db | tx, tenantId, ...)
    Repo->>PG: SELECT ... WHERE tenant_id = $1
    PG-->>Repo: rows
    Repo-->>Svc: typed result
    Svc-->>F: response payload
    F-->>C: 200 JSON
```

### Platform route (`/platform/*`)

Platform routes go through a separate middleware chain:

1. **IP allowlist check** — request IP must be in `PLATFORM_IP_ALLOWLIST`. Non-matching IPs receive `404` (not `403`) to avoid confirming the surface exists.
2. **`authenticate-platform` hook** — looks up `PlatformAdminSession` by SHA-256 token hash. No Redis cache — DB-only, so row deletion revokes instantly.
3. **No `tenantId`** — platform handlers are cross-tenant by design. All platform queries are unscoped.

---

## API Surfaces

| Surface | Prefix | Auth | Who |
|---|---|---|---|
| Tenant API | `/*` (everything else) | Bearer opaque token → `Session` table | Tenant users |
| Platform API | `/platform/*` | IP allowlist + Bearer → `PlatformAdminSession` | Superadmins only |
| Swagger UI | `/platform/docs` | IP allowlist (same hook, 404 to non-listed) | Superadmins only |
| Bull Board | `/platform/queues` | IP allowlist (same hook, 404 to non-listed) | Superadmins only |
| Health | `/health` | None | Load balancer / monitoring |

`PLATFORM_IP_ALLOWLIST` is a comma-separated list of exact IPs and IPv4 CIDR ranges. Empty = fail-closed (deny all). See ADR 0002.

---

## Domain Model

Five bounded domains. Cross-domain relations flow through stable IDs — no FK constraints across domain boundaries.

```mermaid
graph TD
    subgraph Identity
        Tenant --> User
        User --> Session
        User --> PasswordResetToken
        PlatformAdmin --> PlatformAdminSession
        PlatformAdmin --> PlatformAdminLoginToken
    end

    subgraph Catalog["Product Catalog"]
        Category
        Brand
        Product --> ProductVariant
        UnitOfMeasure
        PriceList --> PriceListItem
    end

    subgraph Inventory
        Warehouse --> StockLevel
        ProductVariant --> StockLevel
        StockMovement["StockMovement (immutable ledger)"]
        StockLot
        StockSerial
    end

    subgraph Purchasing
        Supplier --> PurchaseOrder
        PurchaseOrder --> GoodsReceipt
        GoodsReceipt -->|"writes"| StockMovement
    end

    subgraph Sales
        Customer --> SalesOrder
        SalesOrder --> Shipment
        Shipment -->|"writes"| StockMovement
    end

    User -.->|"tenantId scopes all business tables"| Tenant
```

**Key invariants:**
- `StockMovement` is an **immutable ledger** — never updated, never deleted. Corrections are offsetting rows. `StockLevel` is a materialized snapshot rebuildable by summing movements.
- `AuditLog` is also immutable — written in the same transaction as the change it records.
- `UnitOfMeasure` is the only global (non-tenant-scoped) business table. Every other business table carries `tenantId`.

For full column detail, see `prisma/schema.prisma`.

---

## Module Map

See [`docs/file-index.md`](./file-index.md) for a full file-level reference.

| Module / Directory | Owns |
|---|---|
| `src/main.ts` | Process entry point — startup sequence |
| `src/app.ts` | `buildApp()` — plugin registration, worker startup, graceful shutdown |
| `src/modules/auth/` | Tenant login, logout, password reset, session management |
| `src/modules/platform/` | Tenant provisioning, platform admin auth (magic-link), platform-scoped ops |
| `src/modules/users/` | Tenant user CRUD, role management, user welcome email |
| `src/modules/categories/` | Category tree (recursive), CRUD |
| `src/modules/products/` | Product + variant catalog, pricing, verification flow |
| `src/modules/health/` | `GET /health` — liveness probe |
| `src/shared/auth/` | Session lookup, IP allowlist, permissions, token hashing |
| `src/shared/db/` | Kysely instance (`AppDb`), Prisma owns migrations only |
| `src/shared/cache/` | ioredis client factory |
| `src/shared/queue/` | BullMQ connection factory, Bull Board plugin |
| `src/shared/audit/` | Tenant `AuditRepository`, platform `PlatformAuditRepository` |
| `src/shared/email/` | Resend client, HTML email templates |
| `src/shared/storage/` | S3 client, presigned URL helpers |
| `src/shared/idempotency/` | Idempotency key store (backed by queue Redis) |
| `src/shared/errors/` | Error base classes, Fastify error handler |
| `src/shared/config/` | Typed config object, `validateConfig()` |
| `src/shared/infra/` | `assertInfraReady()` — startup probes |
| `src/shared/logging/` | Pino logger instance |
| `src/workers/email.worker.ts` | BullMQ workers for all email queues |
| `src/scripts/` | CLI scripts for platform admin lifecycle (run outside HTTP server) |
| `src/types/` | Kysely `DB` type (codegen output), Fastify type augmentations |
