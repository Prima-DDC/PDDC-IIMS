import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Alert, PageHeader, TableSkeleton } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getWorkflowAdmin } from "@/features/admin-workflows/queries";
import {
  CaseTypesPanel,
  LifecyclePanel,
} from "@/features/admin-workflows/WorkflowPanels";

export const metadata: Metadata = { title: "Case lifecycle" };

/**
 * Administering the case lifecycle and the case types (PRD 4.3).
 *
 * Reading it needs `cases:view`, because the stage names are not a secret and
 * a supervisor may reasonably want to see how the lifecycle is wired.
 * Changing it needs `settings:configure`, which is what the row-level
 * policies on `config.workflow_*` ask for.
 */
export default async function WorkflowsPage() {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "view"))) {
    forbidden();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Case lifecycle"
        description="The stages a case moves through and the moves each one allows, as data rather than code."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Case lifecycle" },
        ]}
      />

      <Alert tone="info" title="What a change here does">
        Every case screen reads this: the progress rail, the stage dropdown and
        the register&apos;s filters are all built from it, so a change takes effect
        at once and applies to cases already open. The platform refuses a move
        this lifecycle does not permit, which is what makes PRD 4.2&apos;s illegal
        transitions impossible rather than merely discouraged.
      </Alert>

      <Suspense fallback={<TableSkeleton rows={6} />}>
        <Lifecycle />
      </Suspense>
    </div>
  );
}

async function Lifecycle() {
  const admin = await getWorkflowAdmin();

  return (
    <div className="space-y-5">
      <LifecyclePanel
        definition={admin.definition}
        stages={admin.stages}
        totalCases={admin.totalCases}
        canConfigure={admin.can.configure}
      />

      <CaseTypesPanel
        caseTypes={admin.caseTypes}
        canConfigure={admin.can.configure}
      />
    </div>
  );
}
