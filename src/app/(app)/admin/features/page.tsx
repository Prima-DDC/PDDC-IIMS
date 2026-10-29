import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";
import { FeaturesAdminPanel } from "@/features/admin-org/OrgPanels";

export const metadata: Metadata = { title: "Features" };

export default async function FeaturesPage() {
  const actor = await requireActor();
  if (!(await can(actor, "settings", "configure"))) {
    forbidden();
  }

  const features = await iam(actor).features.list();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Features"
        description="Modules and capabilities, switched on per role and overridable per user."
        breadcrumb={[{ label: "Administration", href: "/admin" }, { label: "Features" }]}
      />

      <Alert tone="info" title="How a feature resolves">
        A user has a feature if any of their active roles enables it. A
        per-user override wins over the role default, in either direction. The
        Administrator role receives every feature, including ones added later.
      </Alert>

      <FeaturesAdminPanel features={features} />
    </div>
  );
}
