import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { SignInForm } from "@/features/auth/SignInForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="animate-fade-up">
      <Card>
        <div className="mb-5">
          <h1 className="text-lg font-semibold tracking-tight text-body">
            Sign in to the investigation platform
          </h1>
          <p className="mt-1 text-xs text-muted">
            Two-factor authentication is required on every account.
          </p>
        </div>

        <SignInForm next={next} />
      </Card>
    </div>
  );
}
