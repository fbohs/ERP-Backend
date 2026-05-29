import type { Productstatus, Producttype, Productverificationstatus } from '../../types/db.js';

export interface VariantView {
  id: string;
  sku: string;
  listPrice: string;
  compareAtPrice: string | null;
  standardCost: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListView {
  id: string;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  type: Producttype;
  status: Productstatus;
  categoryId: string;
  uomCode: string;
  tags: string[];
  hsnCode: string | null;
  isPublished: boolean;
  isSuspendedByOperator?: boolean; // admin-only
  verificationStatus: Productverificationstatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductView extends ProductListView {
  variants: VariantView[];
}

export interface ProductActor {
  userId: string;
  tenantId: string;
  role: string;
}

export interface MediaEntry {
  url: string;
  altText: string | null;
  mediaType: 'image';
  sortOrder: number;
  isPrimary: boolean;
}

export interface PresignImageView {
  s3Key: string;
  uploadUrl: string;
  expiresAt: string;
}
