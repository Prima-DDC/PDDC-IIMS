import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, Card, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getEngagementFormData } from "@/features/engagements/queries";
import { EngagementForm } from "@/features/engagements/EngagementForms";

export const metadata: Metadata = { title: "New engagement" };

type Params = { clientId?: string; enquiryId?: string };

export default async function NewEngagementPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "engagements", "create"))) {
    forbidden();
  }

  const params = await searchParams;
  const reference = await getEngagementFormData();

  return (
    <div className="space-y-5">
      <PageHeader
        title="New engagement"
        description="The engagement identifier is allocated by the system, in the ENG-YYYY-NNNNNN format."
        breadcrumb={[
          { label: "Engagements", href: "/engagements" },
          { label: "New engagement" },
        ]}
      />

      <Alert tone="info" title="It starts as a draft">
        Creating the engagement does not commit PDDC to the work. Settle the scope and
        the commercial terms, submit it for approval, and have somebody other than
        yourself approve it. A decided conflict check is required before approval.
      </Alert>

      <Card>
        <EngagementForm
            idempotencyKey={crypto.randomUUID()}
          reference={reference}
          defaultClientId={params.clientId}
          defaultEnquiryId={params.enquiryId}
        />
      </Card>
    </div>
  );
}
