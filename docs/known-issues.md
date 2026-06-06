# Known Issues & Gotchas

> Things that will cost you an hour if you don't know them. Write the entry the moment you fight the problem, not six months later.

---

## Database / Prisma

### GIN indexes require raw SQL for `jsonb_path_ops`

**Affects:** `Product.specs`, `User.specs`

Prisma's `@@index([tags], type: Gin)` generates a standard GIN index, which is what `Product.tags` uses and it works fine. But for JSONB columns that need the `jsonb_path_ops` operator class (smaller, faster for `@>` containment queries), Prisma has no syntax — so those indexes are added via raw SQL in the migration:

```sql
-- from 20260527120000_product_ecommerce_marketplace_schema/migration.sql
CREATE INDEX "Product_specs_gin_idx" ON "Product" USING GIN ("specs" jsonb_path_ops);
CREATE INDEX "User_specs_gin_idx"    ON "User"    USING GIN ("specs" jsonb_path_ops);
```

**When it bites you:** Adding a new JSONB column and wondering why `@>` queries are slow. Prisma's migration generator will not add the `jsonb_path_ops` GIN index — you must add it manually in the migration SQL.

**Rule:** Any new JSONB column intended for containment queries (`@>`) needs a `jsonb_path_ops` GIN index written as raw SQL in its migration.

---

### Address mutual-exclusion constraint is not enforced at the DB level

**Affects:** `Address` table — `supplierId` / `customerId` columns

`prisma/schema.prisma` has a comment stating that a mutual-exclusion `CHECK` constraint was added in the migration:

```sql
-- CHECK ((supplierId IS NOT NULL)::int + (customerId IS NOT NULL)::int = 1)
```

**It is not in any migration.** The constraint exists only as a comment and as application-layer validation. An `Address` row with both columns `NULL`, or both set, will be accepted by Postgres.

**When it bites you:** Directly inserting Address rows via raw SQL (seed scripts, migrations, data fixes) without the application layer — nothing will stop a malformed row.

**Fix needed:** The next migration that touches `Address` should add the constraint:

```sql
ALTER TABLE "Address"
  ADD CONSTRAINT "Address_owner_exclusive"
  CHECK ((("supplierId" IS NOT NULL)::int + ("customerId" IS NOT NULL)::int) = 1);
```

---

## Infrastructure / Config

### `TRUST_PROXY` must match your proxy topology for IP allowlisting to work

**Affects:** `/platform/*` IP allowlist, Bull Board, Swagger UI

Fastify reads `request.ip` to enforce `PLATFORM_IP_ALLOWLIST`. When the app runs behind a load balancer or reverse proxy, the real client IP arrives in `X-Forwarded-For` — but Fastify only trusts that header when `TRUST_PROXY=true`.

| Scenario | `TRUST_PROXY` | `request.ip` value |
|---|---|---|
| Direct (no proxy) | `false` (default) | Real client IP ✓ |
| Behind proxy | `false` | Proxy's IP — allowlist checks wrong address ✗ |
| Behind proxy | `true` | Real client IP from `X-Forwarded-For` ✓ |
| Direct (no proxy) | `true` | Spoofable — client controls `X-Forwarded-For` ✗ |

**When it bites you:** Platform endpoints returning `404` to your own IP when behind a proxy, or — worse — the allowlist becoming bypassable because it's checking the proxy IP (which is always in the "allowed" range).

**Rule:** Set `TRUST_PROXY=true` **only** if there is exactly one trusted proxy between the internet and the app. See ADR 0002 for the platform identity design.

---

### Resend API key is domain-scoped — `EMAIL_FROM` must match

**Affects:** All outbound email (password reset, welcome emails, platform magic links)

Resend API keys are created scoped to a verified sending domain. If `EMAIL_FROM` uses a domain that doesn't match the key's scope, Resend will accept the API call but the email will not be delivered — **no error is thrown**, the send appears to succeed.

**Symptoms:** `emailWorker` logs show no errors, but emails never arrive. Resend dashboard shows sends with a delivery failure or domain mismatch status.

**Checklist when email stops working:**
1. Confirm `EMAIL_FROM` domain matches the Resend API key's verified domain.
2. Confirm the domain's DNS records (SPF, DKIM, DMARC) are still valid in Resend's dashboard.
3. Check the Resend dashboard for delivery events — the app logs alone won't surface this.

---

### S3 CORS must be configured for presigned URL flows

**Affects:** Any browser upload/download using presigned S3 URLs

The app generates presigned S3 URLs for direct browser-to-S3 transfers. Without a CORS policy on the bucket, browsers will block the cross-origin request and the transfer will silently fail from the user's perspective.

**Minimum CORS config for the S3 bucket:**

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedOrigins": ["https://your-frontend-domain.com"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**When it bites you:** Uploads or downloads work fine via `curl` or Postman (no browser CORS enforcement) but fail in the browser with a network error and no 4xx from S3.

**Checklist:**
1. Set the CORS policy on the S3 bucket (AWS Console → S3 → bucket → Permissions → CORS).
2. `AllowedOrigins` must list the exact frontend origin (no trailing slash, no wildcard in production).
3. `ExposeHeaders: ["ETag"]` is required if the frontend uses multipart uploads.
