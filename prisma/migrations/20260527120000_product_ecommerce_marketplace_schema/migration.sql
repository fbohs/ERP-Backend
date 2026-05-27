-- =============================================================================
-- Migration: product_ecommerce_marketplace_schema
-- =============================================================================
-- Summary of changes:
--   1. UserRole enum  — remove ACCOUNTANT + VIEWER; add MERCHANT, PRODUCT_VERIFIER,
--                       CONTENT_MANAGER, REPORT_VIEWER
--   2. ProductStatus  — rename ACTIVE → READY (via type recreation)
--   3. New enum       — ProductVerificationStatus
--   4. User           — add specs JSONB (domain-specific user metadata)
--   5. Product        — drop images; add merchantId, isPublished,
--                       isSuspendedByOperator, verificationStatus, verifiedById,
--                       verifiedAt, tags, specs, media; new indexes
--   6. ProductVariant — add compareAtPrice
--
-- Note on GIN indexes:
--   Prisma's @@index([tags], type: Gin) generates the tags GIN index below.
--   Product.specs and User.specs GIN indexes use jsonb_path_ops (best for @>
--   containment queries) and are added as raw SQL because Prisma cannot express
--   the operator class in schema.prisma.
--
--   In production, GIN indexes on large tables should be created with
--   CREATE INDEX CONCURRENTLY outside a transaction block. For this dev migration
--   they run inside the transaction — safe because the table is empty.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. UserRole: migrate data off removed values, then recreate type
-- -----------------------------------------------------------------------------

-- Migrate any existing rows away from values being dropped before the type
-- recreation. Must use a value that exists in the CURRENT (old) enum — newly
-- added enum values are not visible within the same transaction they are added
-- in (PostgreSQL limitation, even in PG18). ADMIN exists in both old and new
-- types and is a safe intermediate. In a fresh dev DB this is a no-op.
UPDATE "User" SET "role" = 'ADMIN' WHERE "role" IN ('VIEWER', 'ACCOUNTANT');

-- AlterEnum — recreate without ACCOUNTANT and VIEWER
CREATE TYPE "UserRole_new" AS ENUM (
  'ADMIN',
  'INVENTORY_MANAGER',
  'PURCHASING_MANAGER',
  'SALES_MANAGER',
  'WAREHOUSE_OPERATOR',
  'MERCHANT',
  'PRODUCT_VERIFIER',
  'CONTENT_MANAGER',
  'REPORT_VIEWER'
);
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'REPORT_VIEWER'::"UserRole_new";
DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";

-- -----------------------------------------------------------------------------
-- 2. ProductStatus: migrate ACTIVE → READY, then recreate type
-- -----------------------------------------------------------------------------

-- ACTIVE → DRAFT as intermediate (same transaction limitation — READY does not
-- exist in the old enum yet). The type recreation below introduces READY.
-- In a fresh dev DB this is a no-op; re-assign status manually after migration
-- if real ACTIVE products need to become READY rather than DRAFT.
UPDATE "Product" SET "status" = 'DRAFT' WHERE "status" = 'ACTIVE';

-- AlterEnum — recreate without ACTIVE, with READY
CREATE TYPE "ProductStatus_new" AS ENUM ('DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED');
ALTER TABLE "Product" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Product" ALTER COLUMN "status" TYPE "ProductStatus_new" USING ("status"::text::"ProductStatus_new");
ALTER TABLE "Product" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"ProductStatus_new";
DROP TYPE "ProductStatus";
ALTER TYPE "ProductStatus_new" RENAME TO "ProductStatus";

-- -----------------------------------------------------------------------------
-- 3. New enum: ProductVerificationStatus
-- -----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "ProductVerificationStatus" AS ENUM (
  'UNVERIFIED',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'FLAGGED'
);

-- -----------------------------------------------------------------------------
-- 4. User: add specs JSONB
-- -----------------------------------------------------------------------------

-- AlterTable
-- specs is JSONB (Prisma Json = PostgreSQL JSONB). Shape is discriminated by
-- role: MERCHANT → { merchant: {...} }, PRODUCT_VERIFIER → { verifier: {...} }.
ALTER TABLE "User" ADD COLUMN "specs" JSONB;

-- GIN index on User.specs — supports @> containment and ? key-exists queries.
-- jsonb_path_ops is smaller and faster than the default jsonb_ops for @> queries.
CREATE INDEX "User_specs_gin_idx" ON "User" USING GIN ("specs" jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- 5. Product: drop images, add marketplace + discovery columns
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "images";

ALTER TABLE "Product"
  -- marketplace ownership (scalar FK to User.id, no FK constraint by design —
  -- same loose-coupling pattern as createdById; null = platform-owned product)
  ADD COLUMN "merchantId"            BIGINT,
  -- visibility flags: merchant-controlled publish, operator-controlled suspend
  ADD COLUMN "isPublished"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isSuspendedByOperator" BOOLEAN NOT NULL DEFAULT false,
  -- compliance signal set by PRODUCT_VERIFIER role users
  ADD COLUMN "verificationStatus"    "ProductVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  -- scalar FK to User.id of the verifier (no FK constraint — same pattern)
  ADD COLUMN "verifiedById"          BIGINT,
  ADD COLUMN "verifiedAt"            TIMESTAMPTZ,
  -- search & discovery tags (GIN-indexed array)
  ADD COLUMN "tags"                  TEXT[] NOT NULL DEFAULT '{}',
  -- domain-specific structured metadata (JSONB — Prisma Json = PostgreSQL JSONB)
  -- e-commerce shape: { seo?: { metaTitle, metaDescription, canonicalUrl, ogImage },
  --                     shipping?: { shippingClass, originCountry } }
  -- future domains add their own top-level key without changing this column
  ADD COLUMN "specs"                 JSONB,
  -- ordered media list (JSONB — Prisma Json = PostgreSQL JSONB)
  -- shape: [{ url, altText, mediaType, sortOrder, isPrimary, variantId? }]
  -- variantId null = product-level; set = variant-specific (ProductVariant.publicId)
  ADD COLUMN "media"                 JSONB;

-- B-tree indexes for the new filterable columns
CREATE INDEX "Product_tenantId_merchantId_idx"         ON "Product"("tenantId", "merchantId");
CREATE INDEX "Product_tenantId_isPublished_idx"        ON "Product"("tenantId", "isPublished");
CREATE INDEX "Product_tenantId_verificationStatus_idx" ON "Product"("tenantId", "verificationStatus");

-- GIN index on tags array — generated from @@index([tags], type: Gin) in schema
CREATE INDEX "Product_tags_idx" ON "Product" USING GIN ("tags");

-- GIN index on Product.specs — raw SQL because Prisma cannot express jsonb_path_ops.
-- jsonb_path_ops is optimal for @> containment queries (e.g. filter by seo.metaTitle
-- or shipping.shippingClass). Smaller index than default jsonb_ops.
CREATE INDEX "Product_specs_gin_idx" ON "Product" USING GIN ("specs" jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- 6. ProductVariant: add compareAtPrice
-- -----------------------------------------------------------------------------

-- AlterTable
-- compareAtPrice is the strike-through "was" price for promotional storefront display.
-- null means no promotional pricing is active for this variant.
ALTER TABLE "ProductVariant" ADD COLUMN "compareAtPrice" DECIMAL(18, 4);
