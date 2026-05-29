import { z } from 'zod';

const priceSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Must be a non-negative decimal with up to 4 decimal places');

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, digits, and hyphens');

export const CreateProductBodySchema = z.object({
  name: z.string().min(1).max(255),
  sku: z.string().min(1).max(100),
  categoryId: z.string().uuid(),
  uomCode: z.string().min(1).max(20),
  listPrice: priceSchema,
  slug: slugSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(['GOODS', 'SERVICE']).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  hsnCode: z.string().max(20).nullable().optional(),
  variantSku: z.string().min(1).max(100).optional(),
  compareAtPrice: priceSchema.nullable().optional(),
});

export const UpdateProductBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  sku: z.string().min(1).max(100).optional(),
  slug: slugSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(['GOODS', 'SERVICE']).optional(),
  status: z.enum(['DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED']).optional(),
  categoryId: z.string().uuid().optional(),
  uomCode: z.string().min(1).max(20).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  hsnCode: z.string().max(20).nullable().optional(),
});

export const UpdateVariantBodySchema = z.object({
  sku: z.string().min(1).max(100).optional(),
  listPrice: priceSchema.optional(),
  compareAtPrice: priceSchema.nullable().optional(),
  standardCost: priceSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const ProductParamsSchema = z.object({
  id: z.string().uuid(),
});

export const VariantParamsSchema = z.object({
  id: z.string().uuid(),
  variantId: z.string().uuid(),
});

export const ListProductsQuerySchema = z.object({
  status: z.enum(['DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED']).optional(),
  categoryId: z.string().uuid().optional(),
});

export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
export type UpdateVariantBody = z.infer<typeof UpdateVariantBodySchema>;
