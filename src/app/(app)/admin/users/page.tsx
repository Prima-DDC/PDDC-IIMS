import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ShieldAlert, UserPlus } from "lucide-react";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  FiltersSkeleton,
  Id,
  PageHeader,
  Pagination,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { CLASSIFICATION_LABELS } from "@/modules/iam";
import { getFormOptions, listUsers } from "@/features/admin-users/queries";
import { UserFilters } from "@/features/admin-users/UserFilters";
import { UserStatusBadge } from "@/features/admin-users/UserStatusBadge";

export const metadata: Metadata = { title: "Users" };

// A type alias rather than an interface, so TypeScript gives it the implicit
// index signature that Pagination's `params` needs. An interface does not get
// one, which is the only difference that matters here.
type Params = {
  search?: string;
  status?: string;
  roleKey?: string;
  officeId?: string;
  departmentId?: string;
  page?: string;
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  const mayCreate = await can(actor, "users", "create");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        description="Everyone with access to the investigation platform. A PDDC staff account alone does not grant access."
        breadcrumb={[{ label: "Administration", href: "/admin" }, { label: "Users" }]}
        actions={
          mayCreate ? (
            <ButtonLink href="/admin/users/new" tone="primary" size="sm">
              <UserPlus className="size-4" aria-hidden="true" />
              Add or invite
            </ButtonLink>
          ) : undefined
        }
      />

      <Suspense fallback={<FiltersSkeleton />}>
        <Filters />
      </Suspense>

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton />}>
        <UserTable params={params} />
      </Suspense>
    </div>
  );
}

async function Filters() {
  const { roles, offices, departments } = await getFormOptions();
  return <UserFilters roles={roles} offices={offices} departments={departments} />;
}

async function UserTable({ params }: { params: Params }) {
  const result = await listUsers({
    search: params.search,
    status: params.status,
    roleKey: params.roleKey,
    officeId: params.officeId,
    departmentId: params.departmentId,
    page: params.page ? Number(params.page) : 1,
  });

  if (result.rows.length === 0) {
    return (
      <EmptyState
        title="No users match those filters"
        description="Clear the filters, or provision access for somebody from the PDDC staff directory."
        action={
          <ButtonLink href="/admin/users/new" tone="primary" size="sm">
            <UserPlus className="size-4" aria-hidden="true" />
            Add or invite a user
          </ButtonLink>
        }
      />
    );
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Employee no.</Th>
            <Th>Roles</Th>
            <Th>Clearance</Th>
            <Th>Office</Th>
            <Th>Status</Th>
            <Th>MFA</Th>
            <Th className="text-right">Last seen</Th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((user) => (
            <tr key={user.id} className="transition-colors hover:bg-surface-sunken/60">
              <Td>
                <AppLink
                  href={`/admin/users/${user.id}`}
                  className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                >
                  {user.fullName ?? "Name not set"}
                </AppLink>
                <span className="font-id block truncate text-[11px] text-muted">
                  {user.email}
                </span>
              </Td>

              <Td>
                {user.employeeId ? <Id>{user.employeeId}</Id> : <span className="text-faint">not set</span>}
              </Td>

              <Td>
                <div className="flex flex-wrap gap-1">
                  {user.roles.length === 0 && (
                    <span className="text-[11px] text-faint">none</span>
                  )}
                  {user.roles.slice(0, 3).map((role) => (
                    <Badge key={role.id} tone={role.isPrimary ? "signal" : "neutral"}>
                      {role.roleName}
                    </Badge>
                  ))}
                  {user.roles.length > 3 && (
                    <span className="self-center text-[11px] text-muted">
                      +{user.roles.length - 3}
                    </span>
                  )}
                </div>
              </Td>

              <Td className="whitespace-nowrap text-xs text-muted">
                {CLASSIFICATION_LABELS[user.clearance]}
              </Td>

              <Td className="text-xs text-muted">
                {user.officeName ?? <span className="text-faint">not set</span>}
              </Td>

              <Td>
                <UserStatusBadge status={user.status} lockedUntil={user.lockedUntil} />
              </Td>

              <Td>
                {user.mfaEnrolledAt ? (
                  <Badge tone="ok">Enrolled</Badge>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-danger">
                    <ShieldAlert className="size-3.5" aria-hidden="true" />
                    Missing
                  </span>
                )}
              </Td>

              <Td className="text-right text-xs whitespace-nowrap text-muted">
                {user.lastSeenAt
                  ? new Date(user.lastSeenAt).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })
                  : "never"}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Pagination
        basePath="/admin/users"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        params={params}
        unit="user"
      />
    </Card>
  );
}
