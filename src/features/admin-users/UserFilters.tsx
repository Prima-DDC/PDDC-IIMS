"use client";

import { UrlFilters } from "@/components/UrlFilters";
import { USER_STATUS_LABELS, USER_STATUSES, type Role } from "@/modules/iam/shared";

/**
 * Search and filters for the user list.
 *
 * The URL-state machinery lives in UrlFilters, which every list in the
 * platform shares; this file is just which filters the user list offers.
 */
export function UserFilters({
  roles,
  offices,
  departments,
}: {
  roles: Role[];
  offices: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath="/admin/users"
      idPrefix="user"
      searchLabel="Search users"
      searchPlaceholder="Name, email or employee number"
      selects={[
        {
          param: "status",
          label: "Status",
          anyLabel: "Any status",
          width: "w-36",
          options: USER_STATUSES.map((status) => ({
            value: status,
            label: USER_STATUS_LABELS[status],
          })),
        },
        {
          param: "roleKey",
          label: "Role",
          anyLabel: "Any role",
          width: "w-44",
          options: roles.map((role) => ({ value: role.key, label: role.name })),
        },
        {
          param: "officeId",
          label: "Office",
          anyLabel: "Any office",
          options: offices.map((o) => ({ value: o.id, label: o.name })),
        },
        {
          param: "departmentId",
          label: "Department",
          anyLabel: "Any department",
          width: "w-44",
          options: departments.map((d) => ({ value: d.id, label: d.name })),
        },
      ]}
    />
  );
}
