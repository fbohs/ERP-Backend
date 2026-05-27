import { z } from 'zod';

export const RequestLinkBodySchema = z.object({
  email: z.string().email(),
});

export const VerifyBodySchema = z.object({
  token: z.string().min(1),
});

export const CreateTenantBodySchema = z.object({
  tenant: z.object({
    name: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase alphanumeric with hyphens'),
  }),
  admin: z.object({
    email: z.string().email(),
    name: z.string().min(1),
  }),
});

export type CreateTenantBody = z.infer<typeof CreateTenantBodySchema>;

export const UpdateTenantBodySchema = z.object({
  isActive: z.boolean(),
});

export const TenantParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface VerifyResponse {
  token: string;
}
