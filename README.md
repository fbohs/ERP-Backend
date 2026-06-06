# ERP Backend

Open-source ERP backend covering accounting, HR, and inventory. Money moves through it — correctness and audit integrity are non-negotiable.

## Stack

| Concern | Version |
|---|---|
| Node.js | 24.15.0 (LTS "Krypton") |
| TypeScript | 6.0.x |
| Fastify | 5.x |
| PostgreSQL | 18 (alpine) |
| Redis / BullMQ | Redis OSS 8.6.x + BullMQ (queue), Redis 8.6.x (session cache) |
| Prisma | 7.8.x (schema + migrations only) |
| Kysely | 0.29.0 (runtime queries) |
| Testing | Vitest + Supertest + Testcontainers |

## Local Setup

**Prerequisites:** Node 24, Docker

```bash
# 1. Clone and install
git clone <repo-url>
cd ERP-Backend
npm install

# 2. Configure environment
cp .env.local.example .env.local
# Edit .env.local — fill in any placeholder values (RESEND_API_KEY, AWS_*, etc.)

# 3. Start infrastructure
docker compose up -d

# 4. Run migrations and generate types
npm run db:migrate
npm run db:codegen

# 5. Start the dev server
npm run dev
```

Server starts on `http://localhost:3000` (or `PORT` from `.env.local`).

## Environment Variables

All variables live in `.env.local` (never `.env`). Copy `.env.local.example` to get the full list with inline docs. Key groups:

| Group | Variables |
|---|---|
| Server | `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`, `APP_BASE_URL` |
| Database | `DATABASE_URL`, `POSTGRES_*` |
| Session cache | `REDIS_URL`, `REDIS_PASSWORD`, `REDIS_PORT` |
| BullMQ queue | `QUEUE_REDIS_URL`, `QUEUE_REDIS_PASSWORD`, `QUEUE_REDIS_PORT` |
| Email (Resend) | `RESEND_API_KEY`, `EMAIL_FROM` |
| Storage (S3) | `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Platform API | `PLATFORM_IP_ALLOWLIST`, `TRUST_PROXY` |

## Scripts

```bash
npm run dev              # dev server with hot reload
npm run build            # compile to dist/
npm run start            # run compiled output

npm run db:migrate       # run pending Prisma migrations (dev)
npm run db:migrate:deploy  # run migrations (CI/prod, no prompts)
npm run db:generate      # regenerate Prisma client
npm run db:codegen       # regenerate Kysely DB types from live schema
npm run db:studio        # open Prisma Studio

npm run test             # run all tests (Vitest)
npm run test:watch       # watch mode
npm run test:coverage    # with coverage report

npm run lint             # ESLint
npm run format           # Prettier
```

## Platform Admin (Superadmin CLI)

The `/platform/*` surface is restricted by IP allowlist (`PLATFORM_IP_ALLOWLIST`). Use these one-shot scripts to manage superadmin accounts:

```bash
npm run platform:create-admin   # create a platform admin
npm run platform:update-admin   # update credentials / role
npm run platform:revoke-sessions  # revoke all active sessions
```

## Project Structure

```
src/
  modules/<domain>/   # auth, users, products, categories, platform, health
  shared/             # tenancy, auth, cache, queue, errors, logging, config
  workers/            # BullMQ workers (separate process)
prisma/               # schema + migrations
docs/                 # engineering charter, ADRs
```

See `docs/engineering-charter.md` for architecture decisions, conventions, and hard rules.
