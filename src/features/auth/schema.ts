import { z } from "zod";

/**
 * Sign-in contracts. The same schemas validate the form and the server
 * action, so the two cannot drift (PRD 21.2).
 */

export const signInSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your work email address.")
    .email("That does not look like an email address.")
    .toLowerCase(),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const mfaChallengeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
  factorId: z.string().min(1),
});

export const mfaEnrolSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
  factorId: z.string().min(1),
});

/** Shape every auth action returns, for useActionState. */
export interface AuthFormState {
  error: string | null;
  fieldErrors?: Partial<Record<"email" | "password" | "code", string>>;
}

export const EMPTY_AUTH_STATE: AuthFormState = { error: null };
