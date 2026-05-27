import { z } from 'zod';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateCategoryBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(120).regex(SLUG_RE, 'Lowercase alphanumeric and hyphens only'),
  description: z.string().max(1000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(120).regex(SLUG_RE, 'Lowercase alphanumeric and hyphens only').optional(),
  description: z.string().max(1000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;

export const CategoryParamsSchema = z.object({
  id: z.string().uuid(),
});
export type CategoryParams = z.infer<typeof CategoryParamsSchema>;
