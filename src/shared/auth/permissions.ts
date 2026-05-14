import type { UserRole } from '../../types/db.js';

export type Permission =
  // products
  | 'product:read'
  | 'product:write'
  // inventory & warehouses
  | 'inventory:read'
  | 'inventory:write'
  | 'warehouse:read'
  | 'warehouse:write'
  // purchasing
  | 'purchase-order:read'
  | 'purchase-order:write'
  | 'purchase-order:approve'
  | 'goods-receipt:write'
  | 'supplier:read'
  | 'supplier:write'
  // sales
  | 'sales-order:read'
  | 'sales-order:write'
  | 'sales-order:confirm'
  | 'shipment:write'
  // pricing
  | 'price-list:read'
  | 'price-list:write'
  // users & tenancy
  | 'user:read'
  | 'user:write'
  // reporting
  | 'report:read';

const ALL_PERMISSIONS: Permission[] = [
  'product:read',
  'product:write',
  'inventory:read',
  'inventory:write',
  'warehouse:read',
  'warehouse:write',
  'purchase-order:read',
  'purchase-order:write',
  'purchase-order:approve',
  'goods-receipt:write',
  'supplier:read',
  'supplier:write',
  'sales-order:read',
  'sales-order:write',
  'sales-order:confirm',
  'shipment:write',
  'price-list:read',
  'price-list:write',
  'user:read',
  'user:write',
  'report:read',
];

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
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

  ACCOUNTANT: new Set<Permission>([
    'purchase-order:read',
    'sales-order:read',
    'supplier:read',
    'inventory:read',
    'product:read',
    'price-list:read',
    'report:read',
  ]),

  VIEWER: new Set<Permission>([
    'product:read',
    'inventory:read',
    'purchase-order:read',
    'sales-order:read',
    'supplier:read',
    'warehouse:read',
    'price-list:read',
    'report:read',
  ]),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
