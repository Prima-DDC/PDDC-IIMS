import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, DescriptionList, Id, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { CLASSIFICATION_LABELS } from "@/modules/iam";
import { getUserDetail } from "@/features/admin-users/queries";
import { UserStatusBadge } from "@/features/admin-users/UserStatusBadge";
import {
  EditDetailsPanel,
  EffectivePermissionsPanel,
  FeaturesPanel,
  OverridesPanel,
  RolesPanel,
  SecurityPanel,
  StatusPanel,
} from "@/features/admin-users/UserDetailPanels";

export const metadata: Metadata = { title: "User" };

/**
 * One user's complete record: identity, roles, overrides, features, security
 * and effective permissions (PRD 3.3 screens 26 and 28).
 *
 * The page answers the question an administrator actually arrives with, which
 * is not "what are this person's settings" but "why can or cannot this person
 * do X", so the effective-permissions panel names the role or override behind
 * every entry.
 */
export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requireActor();

  const [detail, mayEdit, mayAssign, mayDelete] = await Promise.all([
    getUserDetail(id),
    can(actor, "users", "edit"),
    can(actor, "users", "assign"),
    can(actor, "users", "delete"),
  ]);

  if (!detail) notFound();

  const { user } = detail;
  const options = {
    roles: detail.roles,
    offices: detail.offices,
    departments: detail.departments,
    countries: detail.countries,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={user.fullName ?? user.email}
        description={user.jobTitle ?? "No job title recorded."}
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Users", href: "/admin/users" },
          { label: user.fullName ?? user.email },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <UserStatusBadge status={user.status} lockedUntil={user.lockedUntil} />
            {detail.isAdministrator && <Badge tone="warn">Administrator</Badge>}
            {user.deletedAt && <Badge tone="danger">In recycle bin</Badge>}
          </div>
        }
      />

      <Card title="Identity" description="Name and email come from the shared PDDC staff directory and are maintained there.">
        <DescriptionList
          items={[
            { label: "Email", value: <Id>{user.email}</Id> },
            { label: "Employee number", value: user.employeeId ?? "not set" },
            {
              label: "Clearance",
              value: (
                <Badge tone="signal">{CLASSIFICATION_LABELS[user.clearance]}</Badge>
              ),
            },
            { label: "Office", value: user.officeName ?? "not set" },
            { label: "Department", value: user.departmentName ?? "not set" },
            { label: "Country", value: user.countryCode ?? "not set" },
            { label: "Work phone", value: user.workPhone ?? "not set" },
            {
              label: "MFA",
              value: user.mfaEnrolledAt ? (
                <Badge tone="ok">
                  Enrolled {new Date(user.mfaEnrolledAt).toLocaleDateString("en-GB")}
                </Badge>
              ) : (
                <Badge tone="danger">Not enrolled</Badge>
              ),
            },
            {
              label: "Last seen",
              value: user.lastSeenAt
                ? new Date(user.lastSeenAt).toLocaleString("en-GB")
                : "never signed in",
            },
            {
              label: "Session timeout",
              value: `${user.sessionTimeoutMinutes} minutes`,
            },
            {
              label: "Created",
              value: new Date(user.createdAt).toLocaleDateString("en-GB"),
            },
            { label: "Record version", value: <Id>v{user.version}</Id> },
          ]}
        />
        {user.notes && (
          <p className="mt-4 rounded-md bg-surface-sunken p-3 text-xs text-muted">
            {user.notes}
          </p>
        )}
      </Card>

      <EditDetailsPanel user={user} options={options} canEdit={mayEdit} />

      <RolesPanel user={user} roles={detail.roles} canAssign={mayAssign} />

      <EffectivePermissionsPanel
        permissions={detail.permissions}
        isAdministrator={detail.isAdministrator}
        status={user.status}
      />

      <OverridesPanel
        user={user}
        permissions={detail.allPermissions}
        overrides={detail.overrides}
        canAssign={mayAssign}
      />

      <FeaturesPanel
        user={user}
        features={detail.features}
        overrides={detail.featureOverrides}
        canAssign={mayAssign}
      />

      <StatusPanel user={user} canEdit={mayEdit} canDelete={mayDelete} />

      <SecurityPanel
        user={user}
        sessions={detail.sessions}
        loginHistory={detail.loginHistory}
        canEdit={mayEdit}
      />
    </div>
  );
}
