import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getFormOptions, listDirectory } from "@/features/admin-users/queries";
import {
  InviteByEmail,
  ProvisionFromDirectory,
} from "@/features/admin-users/ProvisionForms";
import { CsvImport } from "@/features/admin-users/CsvImport";

export const metadata: Metadata = { title: "Add a user" };

/**
 * Two ways in, because there are two situations.
 *
 * Most of the time the person already has a PDDC staff account and shares one
 * set of credentials with the staff portal, so there is no new password to
 * create: only an IIMS record to provision. Occasionally they are new to PDDC
 * entirely, which is what the invitation is for.
 */
export default async function NewUserPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "users", "create"))) {
    forbidden();
  }

  const { search } = await searchParams;

  const [directory, options] = await Promise.all([
    listDirectory({ search, onlyUnlinked: true }),
    getFormOptions(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Add a user"
        description="Grant access to existing PDDC staff, or invite somebody new."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Users", href: "/admin/users" },
          { label: "Add" },
        ]}
      />

      <Alert tone="info" title="Access is granted deliberately">
        A PDDC staff account does not by itself grant access to case material.
        Creating the record here is what grants it, which is why clearance and
        roles are set at the same time.
      </Alert>

      <ProvisionFromDirectory candidates={directory.rows} options={options} />

      <InviteByEmail options={options} />

      <CsvImport />
    </div>
  );
}
