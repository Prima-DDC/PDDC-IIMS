"use client";

import { useState } from "react";
import { Mail, UserPlus } from "lucide-react";
import { Alert, Badge, Card, Field, Id, Input, Select, Table, Td, Th } from "@/components/ui";
import {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_LEVELS,
  type Role,
} from "@/modules/iam/shared";
import { ActionForm } from "@/components/ActionForm";
import { inviteUser, provisionUser } from "./actions";

interface Options {
  roles: Role[];
  offices: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
}

/** Role checkboxes, shared by both provisioning paths. */
function RolePicker({ roles }: { roles: Role[] }) {
  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-medium text-body">Roles</legend>
      <p className="mb-2 text-[11px] text-muted">
        Effective permissions are the union of every role. The baseline Employee
        role is added automatically and cannot be removed. Granting
        Administrator raises a request for a second administrator to approve.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {roles
          .filter((role) => !role.isBaseline)
          .map((role) => (
            <label
              key={role.id}
              className="flex items-start gap-2 rounded-md border border-line p-2 text-xs transition-colors hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                name="roleIds"
                value={role.id}
                className="mt-0.5 accent-signal"
              />
              <span className="min-w-0">
                <span className="block font-medium text-body">
                  {role.name}
                  {role.isAdministrator && (
                    <Badge tone="warn">needs approval</Badge>
                  )}
                </span>
                {role.description && (
                  <span className="block text-[11px] text-muted">
                    {role.description}
                  </span>
                )}
              </span>
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function ClearanceField({ error }: { error?: string }) {
  return (
    <Field
      label="Clearance"
      htmlFor="clearance"
      required
      hint="The highest classification this person may open. Assigned per person, never by a role."
      error={error}
    >
      <Select id="clearance" name="clearance" defaultValue="INTERNAL">
        {CLASSIFICATION_LEVELS.map((level) => (
          <option key={level} value={level}>
            {CLASSIFICATION_LABELS[level]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Grant access to somebody already in the shared staff directory.
 *
 * This is the normal path: the person can already sign in to primaddc.com with
 * the same credentials, and what is being created here is their IIMS record.
 */
export function ProvisionFromDirectory({
  candidates,
  options,
}: {
  candidates: Array<{
    userId: string;
    email: string;
    fullName: string | null;
    websiteRole: string | null;
    hasIimsAccess: boolean;
  }>;
  options: Options;
}) {
  const [selected, setSelected] = useState<string>("");
  const chosen = candidates.find((c) => c.userId === selected);

  return (
    <Card
      title="Grant access to existing staff"
      description="Everybody with a PDDC staff account appears here. They already share one set of credentials with the staff portal, so no new password is needed."
    >
      {candidates.length === 0 ? (
        <Alert tone="info">
          Everybody in the staff directory already has an IIMS record. Use the
          invitation form below for somebody new to PDDC.
        </Alert>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th />
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Portal role</Th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr
                  key={candidate.userId}
                  className="cursor-pointer transition-colors hover:bg-surface-sunken/60"
                  onClick={() => setSelected(candidate.userId)}
                >
                  <Td>
                    <input
                      type="radio"
                      name="directoryChoice"
                      aria-label={`Select ${candidate.fullName ?? candidate.email}`}
                      checked={selected === candidate.userId}
                      onChange={() => setSelected(candidate.userId)}
                      className="accent-signal"
                    />
                  </Td>
                  <Td className="font-medium text-body">
                    {candidate.fullName ?? "Name not set"}
                  </Td>
                  <Td>
                    <Id>{candidate.email}</Id>
                  </Td>
                  <Td className="text-xs text-muted">
                    {candidate.websiteRole ?? "not set"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          {chosen && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-3 text-xs font-medium text-body">
                Provision access for {chosen.fullName ?? chosen.email}
              </p>

              <ActionForm
                action={provisionUser}
                submitLabel={
                  <>
                    <UserPlus className="size-4" aria-hidden="true" />
                    Grant access
                  </>
                }
                hidden={{ userId: chosen.userId }}
              >
                {(state) => (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ClearanceField error={state.fieldErrors?.clearance} />

                    <Field label="Activate immediately" htmlFor="status" required>
                      <Select id="status" name="status" defaultValue="active">
                        <option value="active">
                          Active, they can sign in now
                        </option>
                        <option value="invited">
                          Invited, activate later
                        </option>
                      </Select>
                    </Field>

                    <Field
                      label="Employee number"
                      htmlFor="employeeId"
                      error={state.fieldErrors?.employeeId}
                    >
                      <Input id="employeeId" name="employeeId" placeholder="PDDC-0001" />
                    </Field>

                    <Field label="Job title" htmlFor="jobTitle">
                      <Input id="jobTitle" name="jobTitle" />
                    </Field>

                    <Field label="Office" htmlFor="officeId">
                      <Select id="officeId" name="officeId" defaultValue="">
                        <option value="">Not set</option>
                        {options.offices.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Department" htmlFor="departmentId">
                      <Select id="departmentId" name="departmentId" defaultValue="">
                        <option value="">Not set</option>
                        {options.departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Country" htmlFor="countryCode">
                      <Select id="countryCode" name="countryCode" defaultValue="">
                        <option value="">Not set</option>
                        {options.countries.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field
                      label="Session timeout (minutes)"
                      htmlFor="sessionTimeoutMinutes"
                    >
                      <Input
                        id="sessionTimeoutMinutes"
                        name="sessionTimeoutMinutes"
                        type="number"
                        min={5}
                        max={1440}
                        defaultValue={480}
                      />
                    </Field>

                    <div className="sm:col-span-2">
                      <RolePicker roles={options.roles} />
                    </div>
                  </div>
                )}
              </ActionForm>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Invite somebody who has no PDDC account at all.
 *
 * Supabase sends the invitation; the invitee sets a password and enrols MFA on
 * first sign-in (PRD 3.3).
 */
export function InviteByEmail({ options }: { options: Options }) {
  return (
    <Card
      title="Invite somebody new"
      description="For a person with no PDDC staff account yet. They receive an email, set a password and enrol two-factor authentication on first sign-in."
    >
      <ActionForm
        action={inviteUser}
        submitLabel={
          <>
            <Mail className="size-4" aria-hidden="true" />
            Send invitation
          </>
        }
      >
        {(state) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Work email"
              htmlFor="invite-email"
              required
              error={state.fieldErrors?.email}
            >
              <Input
                id="invite-email"
                name="email"
                type="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="name@primaddc.com"
              />
            </Field>

            <ClearanceField error={state.fieldErrors?.clearance} />

            <Field label="Job title" htmlFor="invite-job">
              <Input id="invite-job" name="jobTitle" />
            </Field>

            <Field label="Office" htmlFor="invite-office">
              <Select id="invite-office" name="officeId" defaultValue="">
                <option value="">Not set</option>
                {options.offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Department" htmlFor="invite-department">
              <Select id="invite-department" name="departmentId" defaultValue="">
                <option value="">Not set</option>
                {options.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <RolePicker roles={options.roles} />
            </div>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}
