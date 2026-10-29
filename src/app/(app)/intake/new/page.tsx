import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getEnquiryFormData } from "@/features/intake/queries";
import { EnquiryForm } from "@/features/intake/IntakeForms";

export const metadata: Metadata = { title: "Log an enquiry" };

export default async function NewEnquiryPage() {
  const actor = await requireActor();
  if (!(await can(actor, "clients", "create"))) {
    forbidden();
  }

  const reference = await getEnquiryFormData();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Log an enquiry"
        description="Log it whether or not it looks like work. The enquiry identifier is allocated by the system, and intake history is kept permanently."
        breadcrumb={[{ label: "Intake", href: "/intake" }, { label: "New enquiry" }]}
      />

      <Card>
        <EnquiryForm reference={reference} />
      </Card>
    </div>
  );
}
