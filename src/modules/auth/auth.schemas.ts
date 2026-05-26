import { z } from 'zod';

export const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginBody = z.infer<typeof LoginBodySchema>;

export const LoginSuccessResponseSchema = z.object({
  requiresPasswordChange: z.literal(false),
  token: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
  }),
  tenant: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
});

export const LoginPasswordChangeRequiredResponseSchema = z.object({
  requiresPasswordChange: z.literal(true),
  setupToken: z.string(),
});

export const LoginResponseSchema = z.discriminatedUnion('requiresPasswordChange', [
  LoginSuccessResponseSchema,
  LoginPasswordChangeRequiredResponseSchema,
]);

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const ForgotPasswordBodySchema = z.object({
  email: z.string().email(),
});

export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;

export const ResetPasswordBodySchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

export const SetupPasswordBodySchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export type SetupPasswordBody = z.infer<typeof SetupPasswordBodySchema>;
