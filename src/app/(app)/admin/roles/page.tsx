import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";
import {
  CreateRoleForm,
  IncompatibilityPanel,
  PermissionCatalogue,
  RoleList,
} from "@/features/admin-roles/RolePanels";

export const metadata: Metadata = { title: "Roles and permissions" };

export default async function RolesPage() {
  const actor = await requireActor();
  if (!(await can(actor, "settings", "configure"))) {
    forbidden();
  }

  const api = iam(actor);
  const [roles, permissions, pairs] = await Promise.all([
    api.roles.list(true),
    api.permissions.list(),
    api.roles.incompatibilities(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles and permissions"
        description="Roles are data, not code. Add, clone, edit and delete them without a release."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Roles and permissions" },
        ]}
      />

      <RoleList roles={roles} canConfigure />
      <CreateRoleForm />
      <IncompatibilityPanel roles={roles} pairs={pairs} />
      <PermissionCatalogue permissions={permissions} />
    </div>
  );
}
