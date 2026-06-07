import type { Userrole } from '@/types/db.js';

// Single source of truth. `Permission` is derived from this array, so adding a
// permission is one line — the union updates with it. Same pattern as
// generated Userrole in src/types/db.ts.
const ALL_PERMISSIONS = [
  // categories
  'category:write',
  // products
  'product:read',
  'product:write',
  // inventory & warehouses
  'inventory:read',
  'inventory:write',
  'warehouse:read',
  'warehouse:write',
  // purchasing
  'purchase-order:read',
  'purchase-order:write',
  'purchase-order:approve',
  'goods-receipt:write',
  'supplier:read',
  'supplier:write',
  // sales
  'sales-order:read',
  'sales-order:write',
  'sales-order:confirm',
  'shipment:write',
  // pricing
  'price-list:read',
  'price-list:write',
  // users & tenancy
  'user:read',
  'user:write',
  // reporting
  'report:read',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Userrole, ReadonlySet<Permission>> = {
  ADMIN: new Set(ALL_PERMISSIONS),

  INVENTORY_MANAGER: new Set<Permission>([
    'product:read',
    'product:write',
    'inventory:read',
    'inventory:write',
    'warehouse:read',
    'warehouse:write',
    'report:read',
  ]),

  PURCHASING_MANAGER: new Set<Permission>([
    'product:read',
    'purchase-order:read',
    'purchase-order:write',
    'purchase-order:approve',
    'goods-receipt:write',
    'supplier:read',
    'supplier:write',
    'inventory:read',
    'report:read',
  ]),

  SALES_MANAGER: new Set<Permission>([
    'product:read',
    'sales-order:read',
    'sales-order:write',
    'sales-order:confirm',
    'shipment:write',
    'price-list:read',
    'price-list:write',
    'inventory:read',
    'report:read',
  ]),

  WAREHOUSE_OPERATOR: new Set<Permission>([
    'inventory:read',
    'inventory:write',
    'goods-receipt:write',
    'shipment:write',
    'warehouse:read',
  ]),

  MERCHANT: new Set<Permission>([
    'product:read',
    'product:write',
    'inventory:read',
    'price-list:read',
  ]),

  PRODUCT_VERIFIER: new Set<Permission>([
    'product:read',
    'product:write',
    'report:read',
  ]),

  CONTENT_MANAGER: new Set<Permission>([
    'product:read',
    'product:write',
    'report:read',
  ]),

  REPORT_VIEWER: new Set<Permission>([
    'report:read',
  ]),
};

