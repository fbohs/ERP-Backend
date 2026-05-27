import { z } from 'zod';

// ---------------------------------------------------------------------------
// Subordinate roles — tenant admin can only assign these (never ADMIN itself)
// ---------------------------------------------------------------------------
export const SUBORDINATE_ROLES = [
  'INVENTORY_MANAGER',
  'PURCHASING_MANAGER',
  'SALES_MANAGER',
  'WAREHOUSE_OPERATOR',
  'MERCHANT',
  'PRODUCT_VERIFIER',
  'CONTENT_MANAGER',
  'REPORT_VIEWER',
] as const;

export type SubordinateRole = (typeof SUBORDINATE_ROLES)[number];

// ---------------------------------------------------------------------------
// specs shapes — discriminated by role
// ---------------------------------------------------------------------------

const MerchantSpecsSchema = z.object({
  merchant: z.object({
    businessName: z.string().min(1),
    registrationNumber: z.string().min(1),
    address: z.string().min(1),
    phoneNumber: z.string().min(1),
    website: z.string().url().optional(),
  }),
});

const VerifierSpecsSchema = z.object({
  verifier: z.object({
    badgeId: z.string().min(1),
    certificationLevel: z.enum(['JUNIOR', 'SENIOR', 'LEAD']),
    specializations: z.array(z.string().min(1)).min(1),
    // ISO-8601 date string — stored as-is in JSONB, no DB column to coerce
    certifiedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  }),
});

// ---------------------------------------------------------------------------
// Create user — discriminated union so specs requirement is role-aware
// ---------------------------------------------------------------------------

const BaseCreateFields = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

export const CreateUserBodySchema = z.discriminatedUnion('role', [
  BaseCreateFields.extend({
    role: z.literal('MERCHANT'),
    specs: MerchantSpecsSchema,
  }),
  BaseCreateFields.extend({
    role: z.literal('PRODUCT_VERIFIER'),
    specs: VerifierSpecsSchema,
  }),
  BaseCreateFields.extend({ role: z.literal('INVENTORY_MANAGER'), specs: z.null() }),
  BaseCreateFields.extend({ role: z.literal('PURCHASING_MANAGER'), specs: z.null() }),
  BaseCreateFields.extend({ role: z.literal('SALES_MANAGER'), specs: z.null() }),
  BaseCreateFields.extend({ role: z.literal('WAREHOUSE_OPERATOR'), specs: z.null() }),
  BaseCreateFields.extend({ role: z.literal('CONTENT_MANAGER'), specs: z.null() }),
  BaseCreateFields.extend({ role: z.literal('REPORT_VIEWER'), specs: z.null() }),
]);

export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

// ---------------------------------------------------------------------------
// PATCH — suspend / reactivate
// ---------------------------------------------------------------------------

export const SetUserActiveBodySchema = z.object({
  isActive: z.boolean(),
});

export type SetUserActiveBody = z.infer<typeof SetUserActiveBodySchema>;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const UserParamsSchema = z.object({
  id: z.string().uuid(),
});

export type UserParams = z.infer<typeof UserParamsSchema>;
