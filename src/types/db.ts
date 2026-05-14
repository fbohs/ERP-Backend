import type { ColumnType } from "kysely";
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export const UserRole = {
    ADMIN: "ADMIN",
    INVENTORY_MANAGER: "INVENTORY_MANAGER",
    PURCHASING_MANAGER: "PURCHASING_MANAGER",
    SALES_MANAGER: "SALES_MANAGER",
    WAREHOUSE_OPERATOR: "WAREHOUSE_OPERATOR",
    ACCOUNTANT: "ACCOUNTANT",
    VIEWER: "VIEWER"
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const PartyType = {
    INDIVIDUAL: "INDIVIDUAL",
    BUSINESS: "BUSINESS"
} as const;
export type PartyType = (typeof PartyType)[keyof typeof PartyType];
export const ProductType = {
    GOODS: "GOODS",
    SERVICE: "SERVICE"
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];
export const ProductStatus = {
    DRAFT: "DRAFT",
    ACTIVE: "ACTIVE",
    DISCONTINUED: "DISCONTINUED",
    ARCHIVED: "ARCHIVED"
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];
export const SerialStatus = {
    IN_STOCK: "IN_STOCK",
    RESERVED: "RESERVED",
    SHIPPED: "SHIPPED",
    RETURNED: "RETURNED",
    SCRAPPED: "SCRAPPED"
} as const;
export type SerialStatus = (typeof SerialStatus)[keyof typeof SerialStatus];
export const PriceListType = {
    SALES: "SALES",
    PURCHASE: "PURCHASE"
} as const;
export type PriceListType = (typeof PriceListType)[keyof typeof PriceListType];
export const WarehouseType = {
    STANDARD: "STANDARD",
    TRANSIT: "TRANSIT",
    QUARANTINE: "QUARANTINE",
    RETURNS: "RETURNS",
    VIRTUAL: "VIRTUAL"
} as const;
export type WarehouseType = (typeof WarehouseType)[keyof typeof WarehouseType];
export const StockMovementType = {
    PURCHASE_RECEIPT: "PURCHASE_RECEIPT",
    SALES_ISSUE: "SALES_ISSUE",
    SALES_RETURN: "SALES_RETURN",
    PURCHASE_RETURN: "PURCHASE_RETURN",
    ADJUSTMENT_IN: "ADJUSTMENT_IN",
    ADJUSTMENT_OUT: "ADJUSTMENT_OUT",
    TRANSFER_OUT: "TRANSFER_OUT",
    TRANSFER_IN: "TRANSFER_IN",
    OPENING_BALANCE: "OPENING_BALANCE",
    PRODUCTION_IN: "PRODUCTION_IN",
    PRODUCTION_OUT: "PRODUCTION_OUT"
} as const;
export type StockMovementType = (typeof StockMovementType)[keyof typeof StockMovementType];
export const AdjustmentReason = {
    CYCLE_COUNT: "CYCLE_COUNT",
    DAMAGE: "DAMAGE",
    THEFT: "THEFT",
    EXPIRY: "EXPIRY",
    CORRECTION: "CORRECTION",
    OTHER: "OTHER"
} as const;
export type AdjustmentReason = (typeof AdjustmentReason)[keyof typeof AdjustmentReason];
export const TransferStatus = {
    DRAFT: "DRAFT",
    IN_TRANSIT: "IN_TRANSIT",
    RECEIVED: "RECEIVED",
    CANCELLED: "CANCELLED"
} as const;
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];
export const PurchaseOrderStatus = {
    DRAFT: "DRAFT",
    SUBMITTED: "SUBMITTED",
    APPROVED: "APPROVED",
    SENT: "SENT",
    PARTIALLY_RECEIVED: "PARTIALLY_RECEIVED",
    RECEIVED: "RECEIVED",
    BILLED: "BILLED",
    CLOSED: "CLOSED",
    CANCELLED: "CANCELLED"
} as const;
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];
export const GoodsReceiptStatus = {
    DRAFT: "DRAFT",
    POSTED: "POSTED",
    REVERSED: "REVERSED"
} as const;
export type GoodsReceiptStatus = (typeof GoodsReceiptStatus)[keyof typeof GoodsReceiptStatus];
export const SalesOrderStatus = {
    DRAFT: "DRAFT",
    CONFIRMED: "CONFIRMED",
    ALLOCATED: "ALLOCATED",
    PARTIALLY_FULFILLED: "PARTIALLY_FULFILLED",
    FULFILLED: "FULFILLED",
    INVOICED: "INVOICED",
    CLOSED: "CLOSED",
    CANCELLED: "CANCELLED",
    ON_HOLD: "ON_HOLD"
} as const;
export type SalesOrderStatus = (typeof SalesOrderStatus)[keyof typeof SalesOrderStatus];
export const ShipmentStatus = {
    PENDING: "PENDING",
    PICKED: "PICKED",
    PACKED: "PACKED",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    RETURNED: "RETURNED",
    CANCELLED: "CANCELLED"
} as const;
export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];
export const SupplierStatus = {
    PENDING_APPROVAL: "PENDING_APPROVAL",
    ACTIVE: "ACTIVE",
    INACTIVE: "INACTIVE",
    BLOCKED: "BLOCKED"
} as const;
export type SupplierStatus = (typeof SupplierStatus)[keyof typeof SupplierStatus];
export type Address = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    label: string | null;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    country: string;
    postalCode: string;
    supplierId: string | null;
    customerId: string | null;
    isDefault: Generated<boolean>;
    isShipping: Generated<boolean>;
    isBilling: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type BinLocation = {
    id: Generated<string>;
    tenantId: string;
    warehouseId: string;
    code: string;
    description: string | null;
    isActive: Generated<boolean>;
};
export type Brand = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    name: string;
    slug: string;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type Category = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    name: string;
    slug: string;
    description: string | null;
    parentId: string | null;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type Customer = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    code: string;
    legalName: string;
    displayName: string | null;
    partyType: Generated<PartyType>;
    email: string | null;
    phone: string | null;
    taxId: string | null;
    paymentTerms: string | null;
    creditLimit: string | null;
    currency: Generated<string>;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type DocumentSequence = {
    id: Generated<string>;
    tenantId: string;
    code: string;
    prefix: string;
    nextNumber: Generated<number>;
    padding: Generated<number>;
    updatedAt: Generated<Timestamp>;
};
export type GoodsReceipt = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    poId: string;
    warehouseId: string;
    status: Generated<GoodsReceiptStatus>;
    receivedAt: Generated<Timestamp>;
    supplierDeliveryNote: string | null;
    notes: string | null;
    postedAt: Timestamp | null;
    postedById: string | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
    createdById: string | null;
};
export type GoodsReceiptLine = {
    id: Generated<string>;
    tenantId: string;
    receiptId: string;
    poLineId: string;
    variantId: string;
    lotId: string | null;
    quantityReceived: string;
    quantityRejected: Generated<string>;
    unitCost: string;
    notes: string | null;
};
export type PriceList = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    name: string;
    type: Generated<PriceListType>;
    currency: Generated<string>;
    isDefault: Generated<boolean>;
    validFrom: Timestamp | null;
    validTo: Timestamp | null;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type PriceListItem = {
    id: Generated<string>;
    tenantId: string;
    priceListId: string;
    variantId: string;
    unitPrice: string;
    minQty: Generated<string>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type Product = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    sku: string;
    name: string;
    slug: string;
    description: string | null;
    type: Generated<ProductType>;
    status: Generated<ProductStatus>;
    categoryId: string;
    brandId: string | null;
    uomId: string;
    isStockTracked: Generated<boolean>;
    isBatchTracked: Generated<boolean>;
    isSerialTracked: Generated<boolean>;
    images: Generated<string[]>;
    hsnCode: string | null;
    weight: string | null;
    weightUom: string | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
    createdById: string | null;
};
export type ProductAttribute = {
    id: Generated<string>;
    tenantId: string;
    name: string;
    createdAt: Generated<Timestamp>;
};
export type ProductAttributeValue = {
    id: Generated<string>;
    tenantId: string;
    attributeId: string;
    value: string;
    sortOrder: Generated<number>;
};
export type ProductSupplier = {
    id: Generated<string>;
    tenantId: string;
    productId: string;
    supplierId: string;
    supplierSku: string | null;
    cost: string;
    currency: Generated<string>;
    leadTimeDays: Generated<number>;
    minOrderQty: Generated<string>;
    isPrimary: Generated<boolean>;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type ProductVariant = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    productId: string;
    sku: string;
    barcode: string | null;
    name: string | null;
    uomId: string;
    listPrice: string;
    standardCost: string | null;
    weight: string | null;
    weightUom: string | null;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type ProductVariantAttribute = {
    variantId: string;
    attributeValueId: string;
};
export type PurchaseOrder = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    supplierId: string;
    warehouseId: string;
    status: Generated<PurchaseOrderStatus>;
    orderDate: Generated<Timestamp>;
    expectedDate: Timestamp | null;
    currency: Generated<string>;
    subtotal: Generated<string>;
    taxTotal: Generated<string>;
    shippingTotal: Generated<string>;
    grandTotal: Generated<string>;
    notes: string | null;
    supplierRef: string | null;
    approvedAt: Timestamp | null;
    approvedById: string | null;
    sentAt: Timestamp | null;
    closedAt: Timestamp | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
    createdById: string | null;
};
export type PurchaseOrderLine = {
    id: Generated<string>;
    tenantId: string;
    poId: string;
    lineNumber: number;
    variantId: string;
    description: string | null;
    quantityOrdered: string;
    quantityReceived: Generated<string>;
    quantityCancelled: Generated<string>;
    unitCost: string;
    discountPct: Generated<string>;
    taxRate: Generated<string>;
    lineSubtotal: string;
    lineTax: Generated<string>;
    lineTotal: string;
    expectedDate: Timestamp | null;
};
export type SalesOrder = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    customerId: string;
    warehouseId: string;
    status: Generated<SalesOrderStatus>;
    orderDate: Generated<Timestamp>;
    requestedDate: Timestamp | null;
    currency: Generated<string>;
    subtotal: Generated<string>;
    taxTotal: Generated<string>;
    discountTotal: Generated<string>;
    shippingTotal: Generated<string>;
    grandTotal: Generated<string>;
    customerRef: string | null;
    notes: string | null;
    confirmedAt: Timestamp | null;
    closedAt: Timestamp | null;
    cancelledAt: Timestamp | null;
    shippingAddress: unknown | null;
    billingAddress: unknown | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
    createdById: string | null;
};
export type SalesOrderLine = {
    id: Generated<string>;
    tenantId: string;
    soId: string;
    lineNumber: number;
    variantId: string;
    description: string | null;
    quantityOrdered: string;
    quantityShipped: Generated<string>;
    quantityCancelled: Generated<string>;
    unitPrice: string;
    discountPct: Generated<string>;
    taxRate: Generated<string>;
    lineSubtotal: string;
    lineTax: Generated<string>;
    lineTotal: string;
};
export type Session = {
    id: Generated<string>;
    token: string;
    userId: string;
    expiresAt: Timestamp;
    createdAt: Generated<Timestamp>;
};
export type Shipment = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    soId: string;
    status: Generated<ShipmentStatus>;
    carrier: string | null;
    trackingNumber: string | null;
    shippedAt: Timestamp | null;
    deliveredAt: Timestamp | null;
    postedAt: Timestamp | null;
    postedById: string | null;
    notes: string | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
    createdById: string | null;
};
export type ShipmentLine = {
    id: Generated<string>;
    tenantId: string;
    shipmentId: string;
    soLineId: string;
    lotId: string | null;
    quantityShipped: string;
};
export type StockAdjustment = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    warehouseId: string;
    reason: AdjustmentReason;
    notes: string | null;
    postedAt: Timestamp | null;
    createdAt: Generated<Timestamp>;
    createdById: string | null;
};
export type StockAdjustmentLine = {
    id: Generated<string>;
    tenantId: string;
    adjustmentId: string;
    variantId: string;
    lotId: string | null;
    quantity: string;
    unitCost: string | null;
    notes: string | null;
};
export type StockLevel = {
    id: Generated<string>;
    tenantId: string;
    variantId: string;
    warehouseId: string;
    onHand: Generated<string>;
    reserved: Generated<string>;
    incoming: Generated<string>;
    reorderPoint: string | null;
    reorderQty: string | null;
    maxStockLevel: string | null;
    updatedAt: Generated<Timestamp>;
};
export type StockLot = {
    id: Generated<string>;
    tenantId: string;
    variantId: string;
    lotNumber: string;
    expiryDate: Timestamp | null;
    manufacturedAt: Timestamp | null;
    receivedAt: Generated<Timestamp>;
    notes: string | null;
};
export type StockMovement = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    variantId: string;
    warehouseId: string;
    lotId: string | null;
    type: StockMovementType;
    quantity: string;
    unitCost: string | null;
    sourceGoodsReceiptLineId: string | null;
    sourceShipmentLineId: string | null;
    sourceAdjustmentLineId: string | null;
    sourceTransferLineId: string | null;
    occurredAt: Generated<Timestamp>;
    createdAt: Generated<Timestamp>;
    createdById: string | null;
    notes: string | null;
};
export type StockReservation = {
    id: Generated<string>;
    tenantId: string;
    variantId: string;
    warehouseId: string;
    quantity: string;
    salesOrderLineId: string | null;
    expiresAt: Timestamp | null;
    createdAt: Generated<Timestamp>;
    createdById: string | null;
};
export type StockSerial = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    variantId: string;
    warehouseId: string | null;
    lotId: string | null;
    serialNumber: string;
    status: Generated<SerialStatus>;
    goodsReceiptLineId: string | null;
    shipmentLineId: string | null;
    notes: string | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type StockTransfer = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    docNumber: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    status: Generated<TransferStatus>;
    shippedAt: Timestamp | null;
    receivedAt: Timestamp | null;
    notes: string | null;
    createdAt: Generated<Timestamp>;
    createdById: string | null;
};
export type StockTransferLine = {
    id: Generated<string>;
    tenantId: string;
    transferId: string;
    variantId: string;
    lotId: string | null;
    quantityShipped: string;
    quantityReceived: Generated<string>;
};
export type Supplier = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    code: string;
    legalName: string;
    displayName: string | null;
    partyType: Generated<PartyType>;
    status: Generated<SupplierStatus>;
    email: string | null;
    phone: string | null;
    website: string | null;
    taxId: string | null;
    pan: string | null;
    paymentTerms: string | null;
    creditLimit: string | null;
    currency: Generated<string>;
    notes: string | null;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type SupplierContact = {
    id: Generated<string>;
    tenantId: string;
    supplierId: string;
    name: string;
    designation: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: Generated<boolean>;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type Tenant = {
    id: Generated<string>;
    publicId: Generated<string>;
    name: string;
    slug: string;
    isActive: Generated<boolean>;
    plan: Generated<string>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type UnitOfMeasure = {
    id: Generated<string>;
    code: string;
    name: string;
    category: string;
    baseUnitCode: string | null;
    conversion: string | null;
    isActive: Generated<boolean>;
};
export type User = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    email: string;
    phone: string | null;
    name: string;
    password: string;
    role: Generated<UserRole>;
    isActive: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type Warehouse = {
    id: Generated<string>;
    publicId: Generated<string>;
    tenantId: string;
    code: string;
    name: string;
    type: Generated<WarehouseType>;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
    isActive: Generated<boolean>;
    allowsNegative: Generated<boolean>;
    createdAt: Generated<Timestamp>;
    updatedAt: Generated<Timestamp>;
};
export type DB = {
    Address: Address;
    BinLocation: BinLocation;
    Brand: Brand;
    Category: Category;
    Customer: Customer;
    DocumentSequence: DocumentSequence;
    GoodsReceipt: GoodsReceipt;
    GoodsReceiptLine: GoodsReceiptLine;
    PriceList: PriceList;
    PriceListItem: PriceListItem;
    Product: Product;
    ProductAttribute: ProductAttribute;
    ProductAttributeValue: ProductAttributeValue;
    ProductSupplier: ProductSupplier;
    ProductVariant: ProductVariant;
    ProductVariantAttribute: ProductVariantAttribute;
    PurchaseOrder: PurchaseOrder;
    PurchaseOrderLine: PurchaseOrderLine;
    SalesOrder: SalesOrder;
    SalesOrderLine: SalesOrderLine;
    Session: Session;
    Shipment: Shipment;
    ShipmentLine: ShipmentLine;
    StockAdjustment: StockAdjustment;
    StockAdjustmentLine: StockAdjustmentLine;
    StockLevel: StockLevel;
    StockLot: StockLot;
    StockMovement: StockMovement;
    StockReservation: StockReservation;
    StockSerial: StockSerial;
    StockTransfer: StockTransfer;
    StockTransferLine: StockTransferLine;
    Supplier: Supplier;
    SupplierContact: SupplierContact;
    Tenant: Tenant;
    UnitOfMeasure: UnitOfMeasure;
    User: User;
    Warehouse: Warehouse;
};
