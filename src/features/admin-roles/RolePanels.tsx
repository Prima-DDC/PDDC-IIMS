"use client";

import { AppLink } from "@/components/AppLink";
import { useMemo, useState } from "react";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import {
  Alert,
  Badge,
  Card,
  Field,
  Id,
  Input,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import {
  CLASSIFICATION_LEVELS,
  PERMISSION_ACTIONS,
  PERMISSION_SCOPES,
  SCOPE_LABELS,
  type Feature,
  type Permission,
  type Role,
} from "@/modules/iam/shared";
import { ActionForm } from "@/components/ActionForm";
import {
  addIncompatibility,
  cloneRole,
  createPermission,
  createRole,
  deletePermission,
  deleteRole,
  removeIncompatibility,
  rollbackRole,
  setRoleFeatures,
  setRolePermissions,
  updateRole,
} from "./actions";

/* ------------------------------------------------------------- role list */

export function RoleList({ roles, canConfigure }: { roles: Role[]; canConfigure: boolean }) {
  return (
    <Card
      title="Roles"
      description="The starter catalogue is a default, not a policy. Add, clone, rename, deactivate or delete as PDDC changes."
    >
      <Table>
        <thead>
          <tr>
            <Th>Role</Th>
            <Th>Key</Th>
            <Th>Members</Th>
            <Th>Permissions</Th>
            <Th>State</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id} className="transition-colors hover:bg-surface-sunken/60">
              <Td>
                <AppLink
                  href={`/admin/roles/${role.id}`}
                  className="font-medium text-body hover:text-signal-dark hover:underline"
                >
                  {role.name}
                </AppLink>
                {role.description && (
                  <span className="block max-w-96 text-[11px] text-muted">
                    {role.description}
                  </span>
                )}
              </Td>
              <Td>
                <Id>{role.key}</Id>
              </Td>
              <Td className="text-xs text-muted">{role.memberCount ?? 0}</Td>
              <Td className="text-xs text-muted">
                {role.isAdministrator ? "all, by wildcard" : (role.permissionCount ?? 0)}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {role.isAdministrator && <Badge tone="warn">Administrator</Badge>}
                  {role.isBaseline && <Badge tone="info">Baseline</Badge>}
                  <Badge tone={role.isActive ? "ok" : "neutral"}>
                    {role.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </Td>
              <Td>
                {canConfigure && !role.isBaseline && !role.isAdministrator && (
                  <div className="flex justify-end">
                    <ActionForm
                      action={deleteRole}
                      submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
                      submitTone="ghost"
                      submitSize="sm"
                      hidden={{ roleId: role.id, reason: "role deleted by administrator" }}
                      confirm={`Delete the ${role.name} role? Its members must be reassigned first.`}
                      compact
                    />
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function CreateRoleForm() {
  return (
    <Card title="Create a role" description="It starts with no permissions.">
      <ActionForm
        action={createRole}
        submitLabel={
          <>
            <Plus className="size-4" aria-hidden="true" />
            Create role
          </>
        }
      >
        {(state) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="role-name" required error={state.fieldErrors?.name}>
              <Input id="role-name" name="name" placeholder="Regional Supervisor" />
            </Field>
            <Field
              label="Key"
              htmlFor="role-key"
              required
              hint="Stable machine name, for example regional_supervisor."
              error={state.fieldErrors?.key}
            >
              <Input id="role-key" name="key" placeholder="regional_supervisor" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="role-description">
                <Textarea id="role-description" name="description" rows={2} />
              </Field>
            </div>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

/* ------------------------------------------------------ permission builder */

export function PermissionBuilder({
  role,
  allPermissions,
  granted,
}: {
  role: Role;
  allPermissions: Permission[];
  granted: Permission[];
}) {
  const grantedIds = useMemo(() => new Set(granted.map((p) => p.id)), [granted]);
  const [filter, setFilter] = useState("");

  const byResource = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const permission of allPermissions) {
      if (
        filter &&
        !`${permission.resource}:${permission.action}`
          .toLowerCase()
          .includes(filter.toLowerCase())
      ) {
        continue;
      }
      const list = map.get(permission.resource) ?? [];
      list.push(permission);
      map.set(permission.resource, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allPermissions, filter]);

  if (role.isAdministrator) {
    return (
      <Card title="Permissions">
        <Alert tone="info" title="Administrator holds a wildcard grant">
          This role is granted every action on every resource at every
          clearance level, including resources added in future. That is
          deliberate: enumerating them would silently miss new modules. Audit
          and custody records remain append-only even for it.
        </Alert>
      </Card>
    );
  }

  return (
    <Card
      title="Permissions"
      description="Resource, action, scope and classification ceiling. Holders see a change without signing in again."
    >
      <div className="mb-3">
        <label htmlFor="builder-filter" className="sr-only">
          Filter permissions
        </label>
        <Input
          id="builder-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter, for example evidence or approve"
        />
      </div>

      <ActionForm
        action={setRolePermissions}
        submitLabel={
          <>
            <Save className="size-4" aria-hidden="true" />
            Save permissions
          </>
        }
        hidden={{ roleId: role.id }}
      >
        {(state) => (
          <div className="space-y-4">
            <Field
              label="Reason for the permission change"
              htmlFor="perm-reason"
              required
              hint="Recorded against the role version and in the audit trail."
              error={state.fieldErrors?.reason}
            >
              <Input
                id="perm-reason"
                name="reason"
                defaultValue="permissions reviewed"
              />
            </Field>

            <div className="max-h-[32rem] space-y-4 overflow-y-auto rounded-lg border border-line p-3">
              {byResource.length === 0 && (
                <p className="text-xs text-muted">Nothing matches that filter.</p>
              )}

              {byResource.map(([resource, permissions]) => (
                <fieldset key={resource}>
                  <legend className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                    {resource}
                  </legend>
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {permissions.map((permission) => (
                      <label
                        key={permission.id}
                        className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-surface-sunken"
                      >
                        <input
                          type="checkbox"
                          name="permissionIds"
                          value={permission.id}
                          defaultChecked={grantedIds.has(permission.id)}
                          className="mt-0.5 accent-signal"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-body">
                            {permission.action}
                          </span>
                          <span className="block text-[10.5px] text-muted">
                            {SCOPE_LABELS[permission.scope]}, up to{" "}
                            {permission.classificationCeiling.replace(/_/g, " ")}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

export function PermissionCatalogue({
  permissions,
}: {
  permissions: Permission[];
}) {
  const [resource, setResource] = useState("");
  const resources = [...new Set(permissions.map((p) => p.resource))].sort();

  return (
    <Card
      title="Permission catalogue"
      description="The grantable atoms. Add one for a resource or action that does not exist yet."
    >
      <ActionForm
        action={createPermission}
        submitLabel={
          <>
            <Plus className="size-4" aria-hidden="true" />
            Add permission
          </>
        }
        submitSize="sm"
      >
        {(state) => (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Resource"
              htmlFor="new-resource"
              required
              error={state.fieldErrors?.resource}
            >
              <Input id="new-resource" name="resource" placeholder="surveillance" />
            </Field>
            <Field label="Action" htmlFor="new-action" required>
              <Select id="new-action" name="action" defaultValue="view">
                {PERMISSION_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Scope" htmlFor="new-scope" required>
              <Select id="new-scope" name="scope" defaultValue="assigned">
                {PERMISSION_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {SCOPE_LABELS[scope]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Classification ceiling" htmlFor="new-ceiling" required>
              <Select
                id="new-ceiling"
                name="classificationCeiling"
                defaultValue="CONFIDENTIAL"
              >
                {CLASSIFICATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </ActionForm>

      <div className="mt-5 border-t border-line pt-4">
        <div className="mb-3 w-56">
          <label htmlFor="cat-resource" className="sr-only">
            Resource
          </label>
          <Select
            id="cat-resource"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
          >
            <option value="">All resources</option>
            {resources.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>

        <Table>
          <thead>
            <tr>
              <Th>Resource</Th>
              <Th>Action</Th>
              <Th>Scope</Th>
              <Th>Ceiling</Th>
              <Th className="text-right">Remove</Th>
            </tr>
          </thead>
          <tbody>
            {permissions
              .filter((p) => !resource || p.resource === resource)
              .map((permission) => (
                <tr key={permission.id}>
                  <Td>
                    <Id>{permission.resource}</Id>
                  </Td>
                  <Td className="text-xs text-body">{permission.action}</Td>
                  <Td className="text-xs text-muted">
                    {SCOPE_LABELS[permission.scope]}
                  </Td>
                  <Td className="text-xs text-muted">
                    {permission.classificationCeiling.replace(/_/g, " ")}
                  </Td>
                  <Td>
                    <div className="flex justify-end">
                      <ActionForm
                        action={deletePermission}
                        submitLabel={<X className="size-3.5" aria-hidden="true" />}
                        submitTone="ghost"
                        submitSize="sm"
                        hidden={{ permissionId: permission.id }}
                        compact
                      />
                    </div>
                  </Td>
                </tr>
              ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- role settings */

export function RoleSettings({ role }: { role: Role }) {
  return (
    <Card title="Role details" description="Every change is versioned with a reason.">
      <ActionForm
        action={updateRole}
        submitLabel={
          <>
            <Save className="size-4" aria-hidden="true" />
            Save role
          </>
        }
        hidden={{ roleId: role.id, expectedVersion: role.version }}
      >
        {(state) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="edit-name" required error={state.fieldErrors?.name}>
              <Input id="edit-name" name="name" defaultValue={role.name} />
            </Field>
            <Field
              label="Reason for the change"
              htmlFor="edit-reason"
              required
              error={state.fieldErrors?.reason}
            >
              <Input id="edit-reason" name="reason" placeholder="Why is this changing?" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="edit-description">
                <Textarea
                  id="edit-description"
                  name="description"
                  rows={2}
                  defaultValue={role.description ?? ""}
                />
              </Field>
            </div>
            {!role.isBaseline && (
              <label className="flex items-center gap-2 text-xs text-muted sm:col-span-2">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={role.isActive}
                  className="accent-signal"
                />
                Active. An inactive role grants nothing, without being deleted.
              </label>
            )}
          </div>
        )}
      </ActionForm>

      {!role.isBaseline && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium text-body">Clone this role</p>
          <p className="mb-3 text-xs text-muted">
            Copies every permission and feature, which is the quick way to make
            a variant for another office or country.
          </p>
          <ActionForm
            action={cloneRole}
            submitLabel={
              <>
                <Copy className="size-4" aria-hidden="true" />
                Clone
              </>
            }
            submitSize="sm"
            hidden={{ roleId: role.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="New name" htmlFor="clone-name" required error={state.fieldErrors?.name}>
                  <Input id="clone-name" name="name" defaultValue={`${role.name} (copy)`} />
                </Field>
                <Field label="New key" htmlFor="clone-key" required error={state.fieldErrors?.key}>
                  <Input id="clone-key" name="key" defaultValue={`${role.key}_copy`} />
                </Field>
              </div>
            )}
          </ActionForm>
        </div>
      )}
    </Card>
  );
}

export function RoleFeatures({
  role,
  features,
  enabled,
}: {
  role: Role;
  features: Feature[];
  enabled: string[];
}) {
  const on = new Set(enabled);

  return (
    <Card title="Features" description="Modules and capabilities this role unlocks.">
      <ActionForm
        action={setRoleFeatures}
        submitLabel={
          <>
            <Save className="size-4" aria-hidden="true" />
            Save features
          </>
        }
        hidden={{ roleId: role.id }}
      >
        <div className="grid gap-1.5 sm:grid-cols-2">
          {features.map((feature) => (
            <label
              key={feature.key}
              className="flex items-start gap-2 rounded-md border border-line p-2 text-xs transition-colors hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                name="featureKeys"
                value={feature.key}
                defaultChecked={on.has(feature.key)}
                className="mt-0.5 accent-signal"
              />
              <span className="min-w-0">
                <span className="block font-medium text-body">{feature.name}</span>
                <Id>{feature.key}</Id>
              </span>
            </label>
          ))}
        </div>
      </ActionForm>
    </Card>
  );
}

export function RoleVersions({
  role,
  versions,
}: {
  role: Role;
  versions: Array<{
    id: string;
    version: number;
    reason: string;
    changedAt: string;
  }>;
}) {
  return (
    <Card
      title="Version history"
      description="Every change keeps a before and after, so a role can be rolled back."
    >
      {versions.length === 0 ? (
        <p className="text-xs text-muted">No recorded versions yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>When</Th>
              <Th className="text-right">Roll back</Th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.id}>
                <Td>
                  <Id>v{version.version}</Id>
                </Td>
                <Td className="max-w-72 text-xs text-muted">{version.reason}</Td>
                <Td className="text-xs whitespace-nowrap text-muted">
                  {new Date(version.changedAt).toLocaleString("en-GB")}
                </Td>
                <Td>
                  <div className="flex justify-end">
                    <ActionForm
                      action={rollbackRole}
                      submitLabel="Roll back to this"
                      submitTone="ghost"
                      submitSize="sm"
                      hidden={{
                        roleId: role.id,
                        versionId: version.id,
                        reason: `rolled back to v${version.version}`,
                      }}
                      confirm={`Roll ${role.name} back to version ${version.version}?`}
                      compact
                    />
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/* ------------------------------------------------- separation of duties */

export function IncompatibilityPanel({
  roles,
  pairs,
}: {
  roles: Role[];
  pairs: Array<{
    roleAId: string;
    roleBId: string;
    roleAName: string;
    roleBName: string;
    reason: string;
  }>;
}) {
  return (
    <Card
      title="Separation of duties"
      description="Role pairs nobody may hold at once. Checked whenever a role is assigned."
    >
      {pairs.length === 0 ? (
        <p className="text-xs text-muted">No incompatible pairs defined.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Cannot be combined</Th>
              <Th>Reason</Th>
              <Th className="text-right">Remove</Th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair) => (
              <tr key={`${pair.roleAId}-${pair.roleBId}`}>
                <Td className="text-xs font-medium text-body">
                  {pair.roleAName} with {pair.roleBName}
                </Td>
                <Td className="max-w-96 text-xs text-muted">{pair.reason}</Td>
                <Td>
                  <div className="flex justify-end">
                    <ActionForm
                      action={removeIncompatibility}
                      submitLabel={<X className="size-3.5" aria-hidden="true" />}
                      submitTone="ghost"
                      submitSize="sm"
                      hidden={{ roleAId: pair.roleAId, roleBId: pair.roleBId }}
                      compact
                    />
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-3 text-xs font-medium text-body">Add a rule</p>
        <ActionForm
          action={addIncompatibility}
          submitLabel={
            <>
              <Plus className="size-4" aria-hidden="true" />
              Add rule
            </>
          }
          submitSize="sm"
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Role" htmlFor="pair-a" required>
                <Select id="pair-a" name="roleAId" defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Must not be held with" htmlFor="pair-b" required>
                <Select id="pair-b" name="roleBId" defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Why these conflict"
                htmlFor="pair-reason"
                required
                error={state.fieldErrors?.reason}
              >
                <Input id="pair-reason" name="reason" placeholder="Why these conflict" />
              </Field>
            </div>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}
