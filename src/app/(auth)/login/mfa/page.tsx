import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MfaForm } from "@/features/auth/MfaForm";
import { EnrolMfa } from "@/features/auth/EnrolMfa";

export const metadata: Metadata = { title: "Two-factor authentication" };

/**
 * Second factor.
 *
 * Handles both branches: completing a challenge for an enrolled factor, and
 * first-time enrolment. MFA is mandatory (PRD 14), so a user with no factor is
 * enrolled here rather than being allowed past it.
 */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") {
    redirect(next && next.startsWith("/") ? next : "/dashboard");
  }

  const { data: factorData } = await supabase.auth.mfa.listFactors();
  const verified = factorData?.totp?.find((f) => f.status === "verified");

  return (
    <div className="animate-fade-up">
      <Card>
        {verified ? (
          <>
            <div className="mb-5">
              <h1 className="text-lg font-semibold tracking-tight text-body">
                Enter your authentication code
              </h1>
              <p className="mt-1 text-xs text-muted">
                Signed in as {user.email}.
              </p>
            </div>
            <MfaForm factorId={verified.id} next={next} />
          </>
        ) : (
          <>
            <div className="mb-5">
              <h1 className="text-lg font-semibold tracking-tight text-body">
                Set up two-factor authentication
              </h1>
              <p className="mt-1 text-xs text-muted">
                This is required before you can use the platform.
              </p>
            </div>
            <Alert tone="info">
              Scan the code with an authenticator app such as Google
              Authenticator, 1Password or Authy, then enter the six digits it
              shows.
            </Alert>
            <div className="mt-4">
              <EnrolMfa next={next} />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
