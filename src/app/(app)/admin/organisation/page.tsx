import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";
import {
  CountriesPanel,
  DepartmentsPanel,
  OfficesPanel,
} from "@/features/admin-org/OrgPanels";

export const metadata: Metadata = { title: "Offices and departments" };

export default async function OrganisationPage() {
  const actor = await requireActor();
  if (!(await can(actor, "settings", "configure"))) {
    forbidden();
  }

  const api = iam(actor);
  const [countries, offices, departments] = await Promise.all([
    api.org.countries(),
    api.org.offices(),
    api.org.departments(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Offices and departments"
        description="Organisation units, held as configuration so PDDC can open an office without a release."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Offices and departments" },
        ]}
      />

      <CountriesPanel countries={countries} />
      <OfficesPanel offices={offices} countries={countries} />
      <DepartmentsPanel departments={departments} />
    </div>
  );
}
