# Schema Review — Learnings & Decisions

> This document captures the context, reasoning, and examples behind every schema change made during the initial design review of `prisma/schema.prisma`. It is meant to be a quick refresher — both on ERP/database concepts and on *why* specific decisions were made for this project.

---

## Project Context

This is a **multi-tenant SaaS ERP** — one running deployment serves multiple independent companies (tenants). Examples of tenants: Company A (steel manufacturer) and Company B (textile exporter). They share the same application but must never see each other's data.

The schema covers four core domains: **Product Catalog, Inventory, Purchasing, and Sales**.

The root `schema.prisma` file is the original reference/draft. The working schema lives at `prisma/schema.prisma`.

---

## Issue 1 — Multi-tenancy: Adding `tenantId` Everywhere

### What is multi-tenancy?

When one application serves multiple businesses, every row of data must be tagged with which business (tenant) it belongs to. Without this, a query that forgets a filter could leak Company A's stock levels to Company B.

```
Product table (BAD — no tenant isolation):
| id | name        |
|----|-------------|
| 1  | Steel Rod   |  ← could be anyone's
| 2  | Cotton Yarn |  ← could be anyone's
```

```
Product table (GOOD — tenant-scoped):
| id | tenantId | name        |
|----|----------|-------------|
| 1  | 101      | Steel Rod   |  ← Company A
| 2  | 102      | Cotton Yarn |  ← Company B
```

Every query in repository files must filter by `tenantId` explicitly. This is a **P0 security rule** — a missing filter is treated as a vulnerability, not a style issue.

### Decision

Add `tenantId BigInt` to every business table. The only exceptions are:
- `Tenant` — it is the source of truth for tenants
- `User` / `Session` — `User` has `tenantId` as FK to `Tenant`; `Session` is tied to a user
- `UnitOfMeasure` — a global shared lookup (EA, KG, LTR) shared by all tenants

### Changes made

- New `Tenant` model added (name, slug, plan, isActive)
- `tenantId BigInt` added to all 30+ business tables
- Unique constraints updated from e.g. `@unique` on `code` → `@@unique([tenantId, code])` so two different tenants can both have a supplier with code `SUP-00001` without conflict
- All indexes prefixed with `tenantId` e.g. `@@index([tenantId, status])`

---

## Issue 2 — Remove `BUNDLE` from `ProductType`

### The problem

The enum had three values: `GOODS`, `SERVICE`, `BUNDLE`. A bundle is a composite product — e.g. "Laptop Kit" = Laptop + Bag + Mouse.

But there was no `BundleComponent` table to define *what* a bundle contains. Setting `type = BUNDLE` on a product did nothing the system could act on.

### Decision

Remove `BUNDLE` from the enum until a `BundleComponent` table (with `bundleProductId → variantId + quantity`) is designed and ready to build.

```prisma
// Before
enum ProductType {
    GOODS
    SERVICE
    BUNDLE
}

// After
enum ProductType {
    GOODS   // physical, stock-tracked
    SERVICE // intangible, not stock-tracked
    // BUNDLE removed — add back with BundleComponent table when ready
}
```

Keeping an enum value that silently does nothing is worse than removing it — it misleads developers into thinking the feature works.

---

## Issue 3 — Serial Tracking: Add `StockSerial` Table

### What is serial tracking?

Some products need individual unit tracking — each physical unit has a unique serial number. Common examples: electronics, machinery, medical devices.

`Product.isSerialTracked = true` was already in the schema as a flag, but there was no table to actually store the serial numbers.

### What `StockSerial` tracks

One row per physical unit. A serial number is created when the unit is received and its `status` progresses through its lifecycle:

```
IN_STOCK → RESERVED → SHIPPED → (RETURNED → IN_STOCK)
                              → SCRAPPED
```

Key fields:
- `serialNumber` — the actual serial (e.g. `SN-2026-4401`)
- `variantId` — which product variant this unit is
- `warehouseId` — where it currently is (null until putaway)
- `lotId` — set when the product is also batch-tracked
- `goodsReceiptLineId` / `shipmentLineId` — source pointers (no FKs, same pattern as `StockMovement`)

### New enum added

```prisma
enum SerialStatus {
    IN_STOCK
    RESERVED
    SHIPPED
    RETURNED
    SCRAPPED
}
```

---

## Issue 4 — Fix Orphaned `lotId` Columns

### What is a lot/batch?

For batch-tracked products (e.g. pharmaceuticals, food), each incoming shipment is assigned a **lot number** with metadata like expiry date and manufacture date. This allows:
- Product recall tracing ("which customers received Lot #BCH-441?")
- FEFO picking (First Expired, First Out)
- Shelf-life visibility

`StockLot` stores this metadata. The `lotId` column on various tables says "this line involved this specific batch."

### The problem

`GoodsReceiptLine`, `ShipmentLine`, `StockTransferLine`, and `StockAdjustmentLine` all had `lotId BigInt?` but **no Prisma `@relation`** pointing to `StockLot`. The database had no FK constraint — a wrong or stale `lotId` would silently pass through.

Compare this to `StockMovement`, which also has no FK on its source pointers — but that is *intentional and documented* because `StockMovement` is an append-only immutable ledger. These four tables have no such justification.

### Fix

Added proper `@relation` to `StockLot` on all four tables:

```prisma
// Example: GoodsReceiptLine (before)
lotId     BigInt?
// no relation

// After
lotId     BigInt?
lot       StockLot? @relation(fields: [lotId], references: [id])
```

Also added back-relations on `StockLot` itself:

```prisma
model StockLot {
    ...
    adjustmentLines   StockAdjustmentLine[]
    transferLines     StockTransferLine[]
    goodsReceiptLines GoodsReceiptLine[]
    shipmentLines     ShipmentLine[]
}
```

---

## Issue 5 — Reorder Parameters on `StockLevel`

### The problem

`StockLevel` tracked `onHand`, `reserved`, and `incoming` — enough to answer "how much do we have?" But not enough to answer "should we order more?"

Without reorder thresholds, a warehouse manager has to manually review every SKU in every warehouse and make that judgement themselves.

### How reorder parameters work

```
Steel Bolts M8×20 — Mumbai Warehouse:
  reorderPoint:  500 units   ← alert fires when (onHand - reserved) drops to this
  reorderQty:    2000 units  ← suggested order quantity
  maxStockLevel: 5000 units  ← don't order beyond this

Monday:   onHand = 800  → fine
Tuesday:  SO ships 350  → onHand = 450
          450 < reorderPoint(500) → 🔔 "Reorder Steel Bolts in Mumbai, suggest 2000 units"
```

### Why per warehouse (on `StockLevel`) rather than per product (on `ProductVariant`)

The same SKU can have different thresholds in different locations:

```
Steel Bolts M8×20:
  Mumbai warehouse  → reorderPoint: 500  (high volume, reorder early)
  Delhi warehouse   → reorderPoint: 100  (slow moving, smaller buffer)
```

`StockLevel` is already keyed by `(variantId, warehouseId)` — the natural home for per-location thresholds.

### Fields added to `StockLevel`

```prisma
reorderPoint  Decimal? @db.Decimal(18, 4)
reorderQty    Decimal? @db.Decimal(18, 4)
maxStockLevel Decimal? @db.Decimal(18, 4)
```

All nullable — existing rows need no backfill. Thresholds are set by warehouse managers per SKU.

---

## Issue 6 — Scope `DocumentSequence` Per Tenant

### The problem

`DocumentSequence` generates human-readable document numbers: `SO-2026-00001`, `PO-2026-00001`, etc. The original table had a single global sequence — one counter shared across all tenants.

In a multi-tenant deployment this means:
- Tenant A creates `SO-2026-00001`
- Tenant B creates `SO-2026-00002` (skipping 1 — looks wrong to their users)
- Both tenants can infer the other exists from gaps in their numbering

### Fix

Added `tenantId` to `DocumentSequence` and changed the unique key:

```prisma
// Before
model DocumentSequence {
    code      String @unique
    ...
}

// After
model DocumentSequence {
    tenantId  BigInt
    code      String
    ...
    @@unique([tenantId, code])
}
```

Now Tenant A and Tenant B each start from `SO-2026-00001` independently.

---

## Issue 7 — Remove `Category.path`, Use Recursive CTE

### What was the problem?

The original schema had a `path String?` column storing a materialized path like `/electronics/audio/headphones`. This enables fast subtree queries:

```sql
WHERE path LIKE '/electronics/%'  -- get all descendants
```

But Postgres does not maintain this column automatically. If a category is moved (its `parentId` changes), the `path` on that category **and all its descendants** must be updated in the same transaction. If any code forgets to do this, the path silently goes stale.

**Example of the bug:**

```
Before move:
  Electronics      → path: /electronics
  └── Audio        → path: /electronics/audio
      └── Headphones → path: /electronics/audio/headphones

Admin moves Audio under "Home & Living":
  Code updates Audio.parentId ✓
  Code forgets to update paths ✗

Result:
  Headphones still has path: /electronics/audio/headphones  ← STALE
  Query "products under Electronics" → still returns Headphones  ← WRONG
  Query "products under Home & Living" → returns nothing  ← WRONG
```

### The alternative: WITH RECURSIVE CTE

Drop the `path` column entirely. Use a Postgres recursive query to traverse the tree on demand:

```sql
WITH RECURSIVE subtree AS (
  SELECT id, name, parentId, 1 AS depth
  FROM "Category"
  WHERE slug = 'electronics'

  UNION ALL

  SELECT c.id, c.name, c.parentId, s.depth + 1
  FROM "Category" c
  INNER JOIN subtree s ON c."parentId" = s.id
)
SELECT * FROM subtree;
```

In Kysely this uses `.withRecursive(...)`. For ERP-scale category trees (typically 3–5 levels, a few hundred nodes), this runs in milliseconds.

### Decision

Remove `Category.path`. Subtree queries use `WITH RECURSIVE` CTE. Always correct, zero maintenance.

---

## Issue 8 — Add `PriceList` and `PriceListItem` Tables

### The problem

`ProductVariant.listPrice` was a single flat price — one number per SKU. This cannot support:
- **Customer tiers** — retail customers pay ₹500, wholesale customers pay ₹380
- **Date-effective pricing** — price changes on 1st June; old orders must keep the old price
- **Volume pricing** — buy 1–9 units at ₹500, buy 10+ at ₹420

### New tables

```
PriceList         → named list (e.g. "Wholesale 2026", "Retail", "Export USD")
  ↓
PriceListItem     → (priceListId, variantId, minQty, unitPrice)
```

**Lookup order at order time:**
1. Find active `PriceListItem` matching this customer's assigned price list + the variant + the quantity threshold
2. If no match → fall back to `ProductVariant.listPrice`

`listPrice` on `ProductVariant` is now the **default fallback**, not the only price.

### Key fields on `PriceList`

```prisma
name      String        // "Wholesale 2026"
type      PriceListType // SALES or PURCHASE
currency  String        // "INR", "USD"
isDefault Boolean       // tenant's default list
validFrom DateTime?     // date-effective window
validTo   DateTime?
```

---

## Issue 9 — `Address` CHECK Constraint

### The problem

`Address` can belong to either a `Supplier` or a `Customer` — never both, never neither. But the schema only had two nullable columns:

```prisma
supplierId BigInt?
customerId BigInt?
```

Nothing stopped inserting an address with both set, or neither set. A stale import or a bug in the service layer would silently create orphan or dual-owner address rows.

### Fix

A Postgres `CHECK` constraint enforces exactly one is set:

```sql
CONSTRAINT address_owner_check CHECK (
  (supplier_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int = 1
)
```

Prisma cannot express `CHECK` constraints in schema syntax — this must be added as **raw SQL** in the migration file after running `prisma migrate dev`. The constraint is documented in a comment on the `Address` model in the schema.

---

## Summary of All Changes

| # | What changed | Key concept |
|---|-------------|-------------|
| 1 | `tenantId` on all business tables + `Tenant` model | Multi-tenancy, data isolation |
| 2 | Removed `BUNDLE` from `ProductType` enum | Don't ship unusable placeholder values |
| 3 | Added `StockSerial` table + `SerialStatus` enum | Individual unit lifecycle tracking |
| 4 | Added `@relation` on `lotId` in 4 line tables | Referential integrity vs intentional loose coupling |
| 5 | Added `reorderPoint`, `reorderQty`, `maxStockLevel` to `StockLevel` | Per-location replenishment thresholds |
| 6 | `DocumentSequence` scoped per tenant | Independent numbering per company |
| 7 | Removed `Category.path`, use recursive CTE | Avoid silent staleness on reparent |
| 8 | Added `PriceList` + `PriceListItem` tables | Customer-tier and date-effective pricing |
| 9 | `Address` CHECK constraint (raw SQL in migration) | DB-level exclusivity enforcement |

---

## Pending (not yet built)

- **`BundleComponent` table** — when ready, add back `BUNDLE` to `ProductType` and define `(bundleProductId → variantId + quantity)`
- **Raw SQL CHECK on `Address`** — must be hand-added to the Prisma migration file
- **Prisma migration** — `prisma migrate dev` has not been run yet; schema is design-only at this stage
