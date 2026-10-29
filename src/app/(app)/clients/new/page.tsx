import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, Card, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getClientFormData } from "@/features/clients/queries";
import { ClientForm } from "@/features/clients/ClientForm";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  const actor = await requireActor();
  if (!(await can(actor, "clients", "create"))) {
    forbidden();
  }

  const { offices, countries, levels, people } = await getClientFormData();

  return (
    <div className="space-y-5">
      <PageHeader
        title="New client"
        description="The client identifier is allocated by the system, in the CLI-YYYY-NNNNNN format."
        breadcrumb={[{ label: "Clients", href: "/clients" }, { label: "New client" }]}
      />

      <Alert tone="info" title="What happens next">
        Creating the client does not clear it for work. Record its KYC checks, then run
        a conflict check against PDDC&apos;s existing records before an engagement can
        be approved.
      </Alert>

      <Card>
        <ClientForm
          offices={offices}
          countries={countries}
          levels={levels}
          people={people}
        />
      </Card>
    </div>
  );
}
