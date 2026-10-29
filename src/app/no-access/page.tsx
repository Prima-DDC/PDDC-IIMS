import type { Metadata } from "next";
import { Lock, MailQuestion, ShieldOff, UserX } from "lucide-react";
import { ButtonLink, Card } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/features/auth/SignOutButton";

export const metadata: Metadata = { title: "No access" };

/**
 * The blocking screen.
 *
 * A signed-in person who cannot use the platform gets a specific explanation
 * rather than being bounced back to a sign-in form that would succeed and then
 * bounce them again. Each reason comes from the per-request checks in
 * lib/auth/session.
 */
const REASONS = {
  no_iims_access: {
    icon: UserX,
    title: "No access to the investigation platform",
    body:
      "Your PDDC account is recognised, but it has not been granted access to the IIMS. Access is granted deliberately rather than automatically, because case material is need-to-know. Ask an administrator to provision your account.",
  },
  account_suspended: {
    icon: ShieldOff,
    title: "Your account is suspended",
    body:
      "An administrator has suspended this account. Your records are intact. Contact an administrator to have access restored.",
  },
  account_locked: {
    icon: Lock,
    title: "Your account is locked",
    body:
      "This account is temporarily locked after repeated failed sign-in attempts. It unlocks automatically after a short period, or an administrator can unlock it for you.",
  },
  session_revoked: {
    icon: ShieldOff,
    title: "This session was ended",
    body:
      "An administrator signed this session out. Sign in again to continue.",
  },
} as const;

type Reason = keyof typeof REASONS;

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const key: Reason =
    reason && reason in REASONS ? (reason as Reason) : "no_iims_access";
  const { icon: Icon, title, body } = REASONS[key];

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <Card>
          <div className="flex flex-col items-center text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-full bg-warn/12 text-warn">
              <Icon className="size-6" aria-hidden="true" />
            </span>

            <h1 className="text-lg font-semibold tracking-tight text-body">{title}</h1>
            <p className="mt-2 text-sm text-muted">{body}</p>

            {user?.email && (
              <p className="mt-4 rounded-md bg-surface-sunken px-3 py-1.5 text-xs text-muted">
                Signed in as <span className="font-id">{user.email}</span>
              </p>
            )}

            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <SignOutButton />
              <ButtonLink href="https://primaddc.com" tone="ghost" size="sm">
                <MailQuestion className="size-4" aria-hidden="true" />
                PDDC staff portal
              </ButtonLink>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
