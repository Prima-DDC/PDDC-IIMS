import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { PageHeader, TableSkeleton } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getAiProviders } from "@/features/ai/queries";
import { AiProviders } from "@/features/ai/AiViews";

export const metadata: Metadata = { title: "AI providers" };

/**
 * The provider allow-list (PRD 22.4).
 *
 * `ai:configure` is granted to no role in the seed, so this is reachable by
 * the Administrator's wildcard alone. That is deliberate rather than an
 * oversight: recording what a third party's terms say about retaining and
 * training on PDDC's material is not a delegable act, and an administrator
 * can grant it through the Permission Builder if PDDC decide otherwise.
 */
export default async function AiProvidersPage() {
  const actor = await requireActor();

  // `view` rather than `configure`, so somebody who may use AI can see which
  // providers exist and why the assistant is unavailable, without being able
  // to change the list.
  if (!(await can(actor, "ai", "view"))) {
    forbidden();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI providers"
        description="The allow-list that decides whether anything may leave the platform at all, and what each provider may receive."
      />

      <Suspense fallback={<TableSkeleton rows={4} />}>
        <Providers />
      </Suspense>
    </div>
  );
}

async function Providers() {
  const view = await getAiProviders();
  return (
    <AiProviders
      providers={view.providers}
      keysPresent={view.keysPresent}
      mayConfigure={view.mayConfigure}
    />
  );
}
