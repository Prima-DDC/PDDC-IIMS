import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Briefcase } from "lucide-react";
import { Alert, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getCaseFormData } from "@/features/cases/queries";
import { CaseForm } from "@/features/cases/CaseForm";

export const metadata: Metadata = { title: "Open a case" };

type Params = { engagementId?: string };

export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "create"))) {
    forbidden();
  }

  const params = await searchParams;
  const reference = await getCaseFormData();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Open a case"
        description="The case identifier is allocated by the system, in the PDDC-YYYY-NNNNNN format."
        breadcrumb={[{ label: "Cases", href: "/cases" }, { label: "Open a case" }]}
      />

      {!reference.hasEligibleEngagement ? (
        <EmptyState
          title="No engagement is ready to carry a case"
          description="A case belongs to an engagement PDDC has committed to, and an engagement is approved only once its conflict check has been decided. Approve one first."
          action={
            <ButtonLink href="/engagements" tone="primary" size="sm">
              <Briefcase className="size-4" aria-hidden="true" />
              Go to engagements
            </ButtonLink>
          }
        />
      ) : (
        <>
          <Alert tone="info" title="The order matters">
            A case hangs off an engagement rather than off a client directly, because
            the engagement is what carries the instruction, the commercial terms and
            the decided conflict check.
          </Alert>

          <Card>
            <CaseForm
            idempotencyKey={crypto.randomUUID()}
              reference={{
                caseTypes: reference.caseTypes,
                offices: reference.offices,
                countries: reference.countries,
                levels: reference.levels,
              }}
              engagements={reference.engagements}
              defaultEngagementId={params.engagementId}
            />
          </Card>
        </>
      )}
    </div>
  );
}
