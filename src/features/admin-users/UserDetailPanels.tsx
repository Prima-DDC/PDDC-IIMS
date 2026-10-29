"use client";

import { useState } from "react";
import {
  KeyRound,
  Lock,
  LogOut,
  RotateCcw,
  Save,
  ShieldOff,
  Star,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
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
  CLASSIFICATION_LABELS,
  CLASSIFICATION_LEVELS,
  ROLE_SCOPE_TYPES,
  SCOPE_LABELS,
  allowedUserStatusTransitions,
  type EffectivePermission,
  type Feature,
  type IamUser,
  type Permission,
  type Role,
  type UserStatus,
} from "@/modules/iam/shared";
import { ActionForm } from "@/components/ActionForm";
import { RestoreUserButton } from "./RestoreUserButton";
import {
  addOverride,
  assignRole,
  changeUserStatus,
  clearFeatureOverride,
  removeOverride,
  removeRoleAssignment,
  resetMfa,
  resetPassword,
  revokeSessions,
  removeUser,
  setFeatureOverride,
  setPrimaryRole,
  unlockAccount,
  updateUser,
} from "./actions";

/**
 * Every editable panel on a user's record.
 *
 * Grouped in one client module because they all share the ActionForm wrapper
 * and the same option lists, and splitting them into a dozen files would add
 * imports without adding clarity.
 */

interface Options {
  roles: Role[];
  offices: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
}

/* ------------------------------------------------------------------ details */

export function EditDetailsPanel({
  user,
  options,
  canEdit,
}: {
  user: IamUser;
  options: Options;
  canEdit: boolean;
}) {
  if (!canEdit) {
    return (
      <Card title="Details">
        <Alert tone="info">You have view-only access to this record.</Alert>
      </Card>
    );
  }

  return (
    <Card title="Details" description="Changes are recorded in the audit trail.">
      <ActionForm
        action={updateUser}
        submitLabel={
          <>
            <Save className="size-4" aria-hidden="true" />
            Save changes
          </>
        }
        hidden={{ userId: user.id, expectedVersion: user.version }}
      >
        {(state) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Employee number"
              htmlFor="employeeId"
              error={state.fieldErrors?.employeeId}
            >
              <Input
                id="employeeId"
                name="employeeId"
                defaultValue={user.employeeId ?? ""}
                placeholder="PDDC-0001"
              />
            </Field>

            <Field label="Job title" htmlFor="jobTitle" error={state.fieldErrors?.jobTitle}>
              <Input id="jobTitle" name="jobTitle" defaultValue={user.jobTitle ?? ""} />
            </Field>

            <Field label="Work phone" htmlFor="workPhone" error={state.fieldErrors?.workPhone}>
              <Input id="workPhone" name="workPhone" defaultValue={user.workPhone ?? ""} />
            </Field>

            <Field
              label="Clearance"
              htmlFor="clearance"
              required
              hint="Assigned per person. A role never grants clearance on its own."
              error={state.fieldErrors?.clearance}
            >
              <Select id="clearance" name="clearance" defaultValue={user.clearance}>
                {CLASSIFICATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {CLASSIFICATION_LABELS[level]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Office" htmlFor="officeId">
              <Select id="officeId" name="officeId" defaultValue={user.officeId ?? ""}>
                <option value="">Not set</option>
                {options.offices.map((office) => (
                  <option key={office.id} value={office.id}>
                    {office.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Department" htmlFor="departmentId">
              <Select
                id="departmentId"
                name="departmentId"
                defaultValue={user.departmentId ?? ""}
              >
                <option value="">Not set</option>
                {options.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Country" htmlFor="countryCode">
              <Select
                id="countryCode"
                name="countryCode"
                defaultValue={user.countryCode ?? ""}
              >
                <option value="">Not set</option>
                {options.countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Session timeout (minutes)"
              htmlFor="sessionTimeoutMinutes"
              hint="Enforced by the platform on every request."
              error={state.fieldErrors?.sessionTimeoutMinutes}
            >
              <Input
                id="sessionTimeoutMinutes"
                name="sessionTimeoutMinutes"
                type="number"
                min={5}
                max={1440}
                defaultValue={user.sessionTimeoutMinutes}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Notes" htmlFor="notes" error={state.fieldErrors?.notes}>
                <Textarea id="notes" name="notes" rows={3} defaultValue={user.notes ?? ""} />
              </Field>
            </div>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

/* ------------------------------------------------------------------- status */

export function StatusPanel({
  user,
  canEdit,
  canDelete,
}: {
  user: IamUser;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const transitions = allowedUserStatusTransitions(user.status);
  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();

  // A removed account still has a page, because the audit trail links to it.
  // It gets the removal notice and a way back instead of the status controls,
  // which would otherwise offer transitions that cannot apply. The notice has
  // to live here rather than in the removal form's own success banner: the
  // removal hides that form, which destroyed the confirmation with it.
  if (user.deletedAt !== null) {
    return (
      <Card title="Account status">
        <Alert tone="warn" title="Account removed">
          This account was removed on{" "}
          {new Date(user.deletedAt).toLocaleString("en-GB")} and is in the
          recycle bin. Its records remain for accountability. Restoring it
          brings it back deactivated, so sign-in stays blocked until somebody
          reactivates it.
          {canEdit && (
            <div className="mt-3">
              <RestoreUserButton userId={user.id} name={user.fullName ?? user.email} />
            </div>
          )}
        </Alert>
      </Card>
    );
  }

  return (
    <Card
      title="Account status"
      description="Suspension takes effect immediately: sign-in is blocked and every open session is revoked."
    >
      <div className="space-y-4">
        {locked && (
          <Alert tone="danger" title="Locked out">
            After {user.failedLoginCount} failed sign-in attempts this account is
            locked until {new Date(user.lockedUntil!).toLocaleString("en-GB")}.
            <div className="mt-2">
              <ActionForm
                action={unlockAccount}
                submitLabel={
                  <>
                    <Lock className="size-4" aria-hidden="true" />
                    Unlock now
                  </>
                }
                submitSize="sm"
                submitTone="secondary"
                hidden={{ userId: user.id }}
                compact
              />
            </div>
          </Alert>
        )}

        {transitions.length === 0 ? (
          <Alert tone="info">
            An archived account is final. Its records remain for accountability.
          </Alert>
        ) : (
          <ActionForm
            action={changeUserStatus}
            submitLabel={
              <>
                <UserCheck className="size-4" aria-hidden="true" />
                Apply status change
              </>
            }
            hidden={{ userId: user.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <Field label="New status" htmlFor="status" required>
                  <Select id="status" name="status" defaultValue={transitions[0]}>
                    {transitions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Reason for the status change"
                  htmlFor="status-reason"
                  required
                  hint="Recorded in the audit trail."
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="status-reason"
                    name="reason"
                    placeholder="Why is this changing?"
                  />
                </Field>
              </div>
            )}
          </ActionForm>
        )}

        {canDelete && user.deletedAt === null && (
          <div className="border-t border-line pt-4">
            <p className="mb-2 text-xs font-medium text-body">Remove access</p>
            <p className="mb-3 text-xs text-muted">
              A recoverable removal. The record moves to the recycle bin and the
              audit trail keeps their name for accountability. Reassign any open
              cases, tasks and evidence custody first.
            </p>
            <ActionForm
              action={removeUser}
              submitLabel={
                <>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Remove this account
                </>
              }
              submitTone="danger"
              submitSize="sm"
              hidden={{ userId: user.id }}
              confirm="Remove this account? It can be restored from the recycle bin."
            >
              {(state) => (
                <Field
                  label="Reason for removal"
                  htmlFor="remove-reason"
                  required
                  error={state.fieldErrors?.reason}
                >
                  <Input id="remove-reason" name="reason" placeholder="Left the company" />
                </Field>
              )}
            </ActionForm>
          </div>
        )}
      </div>

      {!canEdit && (
        <Alert tone="info">You do not have permission to change this account.</Alert>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------- roles */

export function RolesPanel({
  user,
  roles,
  canAssign,
}: {
  user: IamUser;
  roles: Role[];
  canAssign: boolean;
}) {
  const [scopeType, setScopeType] = useState("all");
  const held = new Set(user.roles.map((r) => r.roleId));
  const available = roles.filter((r) => !held.has(r.id));

  return (
    <Card
      title="Roles"
      description="Effective permissions are the union of every active role, minus any denies."
    >
      {user.roles.length === 0 ? (
        <Alert tone="warn">
          This account holds no roles, so it can reach nothing beyond its own
          profile.
        </Alert>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Scope</Th>
              <Th>Valid</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {user.roles.map((assignment) => {
              const expired =
                assignment.validTo && new Date(assignment.validTo) < new Date();
              const pending = new Date(assignment.validFrom) > new Date();

              return (
                <tr key={assignment.id}>
                  <Td>
                    <span className="font-medium text-body">{assignment.roleName}</span>
                    {assignment.isPrimary && (
                      <Badge tone="signal">
                        <Star className="size-3" aria-hidden="true" />
                        Primary
                      </Badge>
                    )}
                  </Td>
                  <Td className="text-xs text-muted">
                    {assignment.scopeType}
                    {assignment.scopeId ? `: ${assignment.scopeId}` : ""}
                  </Td>
                  <Td className="text-xs">
                    {expired ? (
                      <Badge tone="neutral">Expired</Badge>
                    ) : pending ? (
                      <Badge tone="info">Starts later</Badge>
                    ) : (
                      <Badge tone="ok">Active</Badge>
                    )}
                    {assignment.validTo && (
                      <span className="mt-0.5 block text-[11px] text-muted">
                        until {new Date(assignment.validTo).toLocaleDateString("en-GB")}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {canAssign && (
                      <div className="flex justify-end gap-1.5">
                        {!assignment.isPrimary && (
                          <ActionForm
                            action={setPrimaryRole}
                            submitLabel="Make primary"
                            submitTone="ghost"
                            submitSize="sm"
                            hidden={{ userId: user.id, assignmentId: assignment.id }}
                            compact
                          />
                        )}
                        <ActionForm
                          action={removeRoleAssignment}
                          submitLabel={<X className="size-3.5" aria-hidden="true" />}
                          submitTone="ghost"
                          submitSize="sm"
                          hidden={{
                            userId: user.id,
                            assignmentId: assignment.id,
                            reason: "role removed by administrator",
                          }}
                          confirm={`Remove the ${assignment.roleName} role?`}
                          compact
                        />
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {canAssign && available.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-3 text-xs font-medium text-body">Assign another role</p>
          <ActionForm
            action={assignRole}
            submitLabel="Assign role"
            submitSize="sm"
            hidden={{ userId: user.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Role" htmlFor="roleId" required>
                  <Select id="roleId" name="roleId" defaultValue="">
                    <option value="" disabled>
                      Choose a role
                    </option>
                    {available.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                        {role.isAdministrator ? " (needs a second approver)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Scope" htmlFor="scopeType">
                  {/* Uncontrolled: React resets a controlled field on
                      hydration, which discards a choice made before the
                      JavaScript arrived. The state only decides whether the
                      scope field below is shown. */}
                  <Select
                    id="scopeType"
                    name="scopeType"
                    defaultValue={scopeType}
                    onChange={(e) => setScopeType(e.target.value)}
                  >
                    {ROLE_SCOPE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type === "all" ? "Everything" : type}
                      </option>
                    ))}
                  </Select>
                </Field>

                {scopeType !== "all" && (
                  <Field
                    label="Scope value"
                    htmlFor="scopeId"
                    hint="Office or department id, country code, team or case id."
                  >
                    <Input id="scopeId" name="scopeId" />
                  </Field>
                )}

                <Field
                  label="Valid until"
                  htmlFor="validTo"
                  hint="Leave empty for an open-ended assignment. Set it for temporary cover."
                >
                  <Input id="validTo" name="validTo" type="date" />
                </Field>

                <div className="sm:col-span-2">
                  <Field
                    label="Reason for the assignment"
                    htmlFor="assign-reason"
                    error={state.fieldErrors?.reason}
                  >
                    <Input
                      id="assign-reason"
                      name="reason"
                      placeholder="Covering for a colleague on leave"
                    />
                  </Field>
                </div>

                <label className="flex items-center gap-2 text-xs text-muted sm:col-span-2">
                  <input type="checkbox" name="isPrimary" className="accent-signal" />
                  Make this the primary role shown in the interface
                </label>
              </div>
            )}
          </ActionForm>
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- overrides */

export function OverridesPanel({
  user,
  permissions,
  overrides,
  canAssign,
}: {
  user: IamUser;
  permissions: Permission[];
  overrides: Array<{
    id: string;
    resource: string;
    action: string;
    scope: string;
    classificationCeiling: string;
    effect: "allow" | "deny";
    reason: string;
    expiresAt: string | null;
  }>;
  canAssign: boolean;
}) {
  const [resource, setResource] = useState("");
  const resources = [...new Set(permissions.map((p) => p.resource))].sort();
  const forResource = permissions.filter((p) => p.resource === resource);

  return (
    <Card
      title="Permission overrides"
      description="Per-user grants and denies. An explicit deny always beats an allow, whatever the roles say."
    >
      {overrides.length === 0 ? (
        <p className="text-xs text-muted">
          No overrides. This account gets exactly what its roles grant.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Effect</Th>
              <Th>Permission</Th>
              <Th>Reason</Th>
              <Th>Expires</Th>
              <Th className="text-right">Remove</Th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((override) => (
              <tr key={override.id}>
                <Td>
                  <Badge tone={override.effect === "deny" ? "danger" : "ok"}>
                    {override.effect}
                  </Badge>
                </Td>
                <Td>
                  <Id>
                    {override.resource}:{override.action}
                  </Id>
                  <span className="block text-[11px] text-muted">
                    {SCOPE_LABELS[override.scope as keyof typeof SCOPE_LABELS] ??
                      override.scope}
                    , up to {override.classificationCeiling}
                  </span>
                </Td>
                <Td className="max-w-56 text-xs text-muted">{override.reason}</Td>
                <Td className="text-xs text-muted">
                  {override.expiresAt
                    ? new Date(override.expiresAt).toLocaleDateString("en-GB")
                    : "no expiry"}
                </Td>
                <Td>
                  {canAssign && (
                    <div className="flex justify-end">
                      <ActionForm
                        action={removeOverride}
                        submitLabel={<X className="size-3.5" aria-hidden="true" />}
                        submitTone="ghost"
                        submitSize="sm"
                        hidden={{
                          userId: user.id,
                          overrideId: override.id,
                          reason: "override removed by administrator",
                        }}
                        compact
                      />
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {canAssign && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-3 text-xs font-medium text-body">Add an override</p>
          <ActionForm
            action={addOverride}
            submitLabel={
              <>
                <KeyRound className="size-4" aria-hidden="true" />
                Add override
              </>
            }
            submitSize="sm"
            hidden={{ userId: user.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Override resource" htmlFor="override-resource">
                  <Select
                    id="override-resource"
                    value={resource}
                    onChange={(e) => setResource(e.target.value)}
                  >
                    <option value="">Choose a resource</option>
                    {resources.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Override permission" htmlFor="permissionId" required>
                  <Select id="permissionId" name="permissionId" defaultValue="">
                    <option value="" disabled>
                      {resource ? "Choose a permission" : "Choose a resource first"}
                    </option>
                    {forResource.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.action}, {p.scope}, up to {p.classificationCeiling}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Override effect" htmlFor="effect" required>
                  <Select id="effect" name="effect" defaultValue="deny">
                    <option value="deny">Deny, overrides every allow</option>
                    <option value="allow">Allow, in addition to the roles</option>
                  </Select>
                </Field>

                <Field
                  label="Override expires"
                  htmlFor="expiresAt"
                  hint="Optional. An expired override stops applying automatically."
                >
                  <Input id="expiresAt" name="expiresAt" type="date" />
                </Field>

                <div className="sm:col-span-2">
                  <Field
                    label="Reason for the override"
                    htmlFor="override-reason"
                    required
                    hint="Mandatory. Overrides without a stated reason are impossible to review later."
                    error={state.fieldErrors?.reason}
                  >
                    <Input
                      id="override-reason"
                      name="reason"
                      placeholder="Temporary access for the ABC engagement"
                    />
                  </Field>
                </div>
              </div>
            )}
          </ActionForm>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- features */

export function FeaturesPanel({
  user,
  features,
  overrides,
  canAssign,
}: {
  user: IamUser;
  features: Feature[];
  overrides: Array<{ featureKey: string; enabled: boolean; reason: string }>;
  canAssign: boolean;
}) {
  const byKey = new Map(overrides.map((o) => [o.featureKey, o]));

  return (
    <Card
      title="Features"
      description="Module access, on top of the role defaults. A per-user setting wins."
    >
      <Table>
        <thead>
          <tr>
            <Th>Feature</Th>
            <Th>Effective</Th>
            <Th className="text-right">Set for this user</Th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => {
            const override = byKey.get(feature.key);

            return (
              <tr key={feature.key}>
                <Td>
                  <span className="font-medium text-body">{feature.name}</span>
                  <Id>{feature.key}</Id>
                  {feature.description && (
                    <span className="block text-[11px] text-muted">
                      {feature.description}
                    </span>
                  )}
                </Td>
                <Td>
                  {override ? (
                    <Badge tone={override.enabled ? "ok" : "danger"}>
                      {override.enabled ? "Enabled" : "Disabled"} for this user
                    </Badge>
                  ) : (
                    <Badge tone="neutral">Role default</Badge>
                  )}
                </Td>
                <Td>
                  {canAssign && (
                    <div className="flex justify-end gap-1.5">
                      <ActionForm
                        action={setFeatureOverride}
                        submitLabel="Enable"
                        submitTone="ghost"
                        submitSize="sm"
                        hidden={{
                          userId: user.id,
                          featureKey: feature.key,
                          enabled: "true",
                          reason: "enabled for this user by an administrator",
                        }}
                        compact
                      />
                      <ActionForm
                        action={setFeatureOverride}
                        submitLabel="Disable"
                        submitTone="ghost"
                        submitSize="sm"
                        hidden={{
                          userId: user.id,
                          featureKey: feature.key,
                          enabled: "false",
                          reason: "disabled for this user by an administrator",
                        }}
                        compact
                      />
                      {override && (
                        <ActionForm
                          action={clearFeatureOverride}
                          submitLabel={
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                          }
                          submitTone="ghost"
                          submitSize="sm"
                          hidden={{ userId: user.id, featureKey: feature.key }}
                          compact
                        />
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

/* ----------------------------------------------------------------- security */

export function SecurityPanel({
  user,
  sessions,
  loginHistory,
  canEdit,
}: {
  user: IamUser;
  sessions: Array<{
    sessionId: string;
    createdAt: string;
    updatedAt: string | null;
    userAgent: string | null;
    ip: string | null;
  }>;
  loginHistory: Array<{
    id: string;
    succeeded: boolean;
    failureKind: string | null;
    ip: string | null;
    attemptedAt: string;
  }>;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-5">
      <Card title="Security actions">
        {canEdit ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <ActionForm
              action={resetPassword}
              submitLabel={
                <>
                  <KeyRound className="size-4" aria-hidden="true" />
                  Send password reset
                </>
              }
              submitSize="sm"
              submitTone="secondary"
              hidden={{ email: user.email }}
            />
            <ActionForm
              action={revokeSessions}
              submitLabel={
                <>
                  <LogOut className="size-4" aria-hidden="true" />
                  Revoke all sessions
                </>
              }
              submitSize="sm"
              submitTone="secondary"
              hidden={{ userId: user.id, reason: "sessions revoked by administrator" }}
              confirm="Revoke every session for this user? They will have to sign in again."
            />
            <ActionForm
              action={resetMfa}
              submitLabel={
                <>
                  <ShieldOff className="size-4" aria-hidden="true" />
                  Reset MFA enrolment
                </>
              }
              submitSize="sm"
              submitTone="danger"
              hidden={{ userId: user.id }}
              confirm="Remove this user's authenticator? They must enrol again at next sign-in."
            />
          </div>
        ) : (
          <Alert tone="info">You do not have permission to change security settings.</Alert>
        )}
      </Card>

      <Card
        title="Active sessions"
        description="Revoking a session stops its access token on the very next request."
      >
        {sessions.length === 0 ? (
          <p className="text-xs text-muted">No active sessions.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Last active</Th>
                <Th>Device</Th>
                <Th>IP</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.sessionId}>
                  <Td className="text-xs whitespace-nowrap text-muted">
                    {new Date(session.createdAt).toLocaleString("en-GB")}
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted">
                    {session.updatedAt
                      ? new Date(session.updatedAt).toLocaleString("en-GB")
                      : "unknown"}
                  </Td>
                  <Td className="max-w-56 truncate text-xs text-muted">
                    {session.userAgent ?? "unknown"}
                  </Td>
                  <Td>
                    <Id>{session.ip ?? "unknown"}</Id>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Sign-in history" description="The last 20 attempts.">
        {loginHistory.length === 0 ? (
          <p className="text-xs text-muted">No recorded attempts.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Result</Th>
                <Th>IP</Th>
              </tr>
            </thead>
            <tbody>
              {loginHistory.map((attempt) => (
                <tr key={attempt.id}>
                  <Td className="text-xs whitespace-nowrap text-muted">
                    {new Date(attempt.attemptedAt).toLocaleString("en-GB")}
                  </Td>
                  <Td>
                    {attempt.succeeded ? (
                      <Badge tone="ok">Signed in</Badge>
                    ) : (
                      <Badge tone="danger">{attempt.failureKind ?? "failed"}</Badge>
                    )}
                  </Td>
                  <Td>
                    <Id>{attempt.ip ?? "unknown"}</Id>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------- effective permissions */

export function EffectivePermissionsPanel({
  permissions,
  isAdministrator,
  status,
}: {
  permissions: EffectivePermission[];
  isAdministrator: boolean;
  status: UserStatus;
}) {
  const [filter, setFilter] = useState("");

  const rows = permissions.filter((p) =>
    filter
      ? `${p.resource}:${p.action}`.toLowerCase().includes(filter.toLowerCase())
      : true,
  );

  return (
    <Card
      title="Effective permissions"
      description="What this account can actually do, after the role union, the user grants and the denies. Each row names what produced it."
    >
      {status !== "active" && (
        <Alert tone="warn" title={`The account is ${status}`}>
          These permissions are what the roles would grant. While the account is
          not active it holds none of them.
        </Alert>
      )}

      {isAdministrator && (
        <Alert tone="info" title="Administrator">
          This account holds a wildcard grant on every resource and every
          clearance level, including modules added in future. Audit and custody
          records remain append-only even for it.
        </Alert>
      )}

      <div className="mt-3 mb-3">
        <label htmlFor="perm-filter" className="sr-only">
          Filter permissions
        </label>
        <Input
          id="perm-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter, for example evidence or approve"
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted">
          {permissions.length === 0
            ? "No permissions. This account can reach nothing beyond its own profile."
            : "Nothing matches that filter."}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Resource</Th>
              <Th>Action</Th>
              <Th>Scope</Th>
              <Th>Up to</Th>
              <Th>Granted by</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.resource}:${p.action}:${p.scope}:${p.source}`}>
                <Td>
                  <Id>{p.resource}</Id>
                </Td>
                <Td className="text-xs text-body">{p.action}</Td>
                <Td className="text-xs text-muted">{SCOPE_LABELS[p.scope] ?? p.scope}</Td>
                <Td className="text-xs text-muted">
                  {p.classificationCeiling.replace(/_/g, " ")}
                </Td>
                <Td>
                  <Badge tone={p.source.startsWith("override") ? "warn" : "neutral"}>
                    {p.source}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
