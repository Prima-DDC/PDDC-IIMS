import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Badge, Card, Id, PageHeader, Table, Td, Th } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";
import {
  PermissionBuilder,
  RoleFeatures,
  RoleSettings,
  RoleVersions,
} from "@/features/admin-roles/RolePanels";

export const metadata: Metadata = { title: "Role" };

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requireActor();
  if (!(await can(actor, "settings", "configure"))) {
    forbidden();
  }

  const api = iam(actor);
  const role = await api.roles.findById(id);
  if (!role) notFound();

  const [granted, allPermissions, features, roleFeatures, versions, members] =
    await Promise.all([
      api.roles.permissionsOf(id),
      api.permissions.list(),
      api.features.list(),
      api.roles.featuresOf(id),
      api.roles.versions(id),
      api.roles.members(id),
    ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={role.name}
        description={role.description ?? "No description recorded."}
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Roles", href: "/admin/roles" },
          { label: role.name },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Id>{role.key}</Id>
            {role.isAdministrator && <Badge tone="warn">Administrator</Badge>}
            {role.isBaseline && <Badge tone="info">Baseline</Badge>}
            <Badge tone={role.isActive ? "ok" : "neutral"}>
              {role.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
        }
      />

      <RoleSettings role={role} />

      <PermissionBuilder
        role={role}
        allPermissions={allPermissions}
        granted={granted}
      />

      <RoleFeatures
        role={role}
        features={features}
        enabled={roleFeatures.filter((f) => f.enabled).map((f) => f.featureKey)}
      />

      <Card
        title={`Members (${members.length})`}
        description="Everyone currently holding this role, at any scope."
      >
        {members.length === 0 ? (
          <p className="text-xs text-muted">Nobody holds this role.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <Td>
                    <AppLink
                      href={`/admin/users/${member.userId}`}
                      className="font-medium text-body hover:text-signal-dark hover:underline"
                    >
                      {member.fullName ?? "Name not set"}
                    </AppLink>
                  </Td>
                  <Td>
                    <Id>{member.email}</Id>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <RoleVersions role={role} versions={versions} />
    </div>
  );
}
