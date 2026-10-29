"use client";

import { Plus, Save, Trash2 } from "lucide-react";
import {
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
import type { Feature } from "@/modules/iam/shared";
import { ActionForm } from "@/components/ActionForm";
import {
  createDepartment,
  createOffice,
  deleteDepartment,
  deleteFeature,
  deleteOffice,
  saveCountry,
  saveFeature,
  toggleCountry,
  updateDepartment,
  updateOffice,
} from "./actions";

/* --------------------------------------------------------------- countries */

export function CountriesPanel({
  countries,
}: {
  countries: Array<{ code: string; name: string; isActive: boolean }>;
}) {
  return (
    <Card
      title="Countries and jurisdictions"
      description="Every record carries a country tag, which is what makes per-jurisdiction access rules and data-residency options possible."
    >
      <Table>
        <thead>
          <tr>
            <Th>Code</Th>
            <Th>Name</Th>
            <Th>State</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {countries.map((country) => (
            <tr key={country.code}>
              <Td>
                <Id>{country.code}</Id>
              </Td>
              <Td className="font-medium text-body">{country.name}</Td>
              <Td>
                <Badge tone={country.isActive ? "ok" : "neutral"}>
                  {country.isActive ? "Active" : "Inactive"}
                </Badge>
              </Td>
              <Td>
                <div className="flex justify-end">
                  <ActionForm
                    action={toggleCountry}
                    submitLabel={country.isActive ? "Deactivate" : "Activate"}
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{
                      code: country.code,
                      isActive: country.isActive ? "false" : "true",
                    }}
                    compact
                  />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-3 text-xs font-medium text-body">Add or update a country</p>
        <ActionForm
          action={saveCountry}
          submitLabel={
            <>
              <Plus className="size-4" aria-hidden="true" />
              Save country
            </>
          }
          submitSize="sm"
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="ISO code"
                htmlFor="country-code"
                required
                hint="Two letters, for example GH."
                error={state.fieldErrors?.code}
              >
                <Input id="country-code" name="code" maxLength={2} placeholder="GH" />
              </Field>
              <Field
                label="Name"
                htmlFor="country-name"
                required
                error={state.fieldErrors?.name}
              >
                <Input id="country-name" name="name" placeholder="Ghana" />
              </Field>
              <div className="sm:col-span-2">
                <Field
                  label="Data-residency note"
                  htmlFor="country-note"
                  hint="Any rule about where records for this jurisdiction may be stored."
                >
                  <Textarea id="country-note" name="residencyNote" rows={2} />
                </Field>
              </div>
            </div>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- offices */

export function OfficesPanel({
  offices,
  countries,
}: {
  offices: Array<{
    id: string;
    code: string;
    name: string;
    countryCode: string;
    timezone: string;
    isActive: boolean;
  }>;
  countries: Array<{ code: string; name: string }>;
}) {
  return (
    <Card title="Offices" description="Used for role scoping and for workload reporting.">
      {offices.length === 0 ? (
        <p className="text-xs text-muted">No offices yet.</p>
      ) : (
        <div className="space-y-3">
          {offices.map((office) => (
            <div key={office.id} className="rounded-lg border border-line p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium text-body">{office.name}</span>
                  <Id>
                    {office.code}, {office.countryCode}
                  </Id>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={office.isActive ? "ok" : "neutral"}>
                    {office.isActive ? "Active" : "Inactive"}
                  </Badge>
                  <ActionForm
                    action={deleteOffice}
                    submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{ officeId: office.id }}
                    confirm={`Delete ${office.name}? Any users assigned to it must be moved first.`}
                    compact
                  />
                </div>
              </div>

              <ActionForm
                action={updateOffice}
                submitLabel={
                  <>
                    <Save className="size-4" aria-hidden="true" />
                    Save
                  </>
                }
                submitSize="sm"
                hidden={{ officeId: office.id }}
                compact
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name" htmlFor={`office-name-${office.id}`}>
                    <Input
                      id={`office-name-${office.id}`}
                      name="name"
                      defaultValue={office.name}
                    />
                  </Field>
                  <Field label="Time zone" htmlFor={`office-tz-${office.id}`}>
                    <Input
                      id={`office-tz-${office.id}`}
                      name="timezone"
                      defaultValue={office.timezone}
                      placeholder="Africa/Accra"
                    />
                  </Field>
                  <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      name="isActive"
                      defaultChecked={office.isActive}
                      className="accent-signal"
                    />
                    Active
                  </label>
                </div>
              </ActionForm>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-3 text-xs font-medium text-body">Add an office</p>
        <ActionForm
          action={createOffice}
          submitLabel={
            <>
              <Plus className="size-4" aria-hidden="true" />
              Create office
            </>
          }
          submitSize="sm"
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Code" htmlFor="office-code" required error={state.fieldErrors?.code}>
                <Input id="office-code" name="code" placeholder="ACC" />
              </Field>
              <Field label="Name" htmlFor="office-new-name" required error={state.fieldErrors?.name}>
                <Input id="office-new-name" name="name" placeholder="Accra" />
              </Field>
              <Field label="Country" htmlFor="office-country" required>
                <Select id="office-country" name="countryCode" defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Time zone" htmlFor="office-new-tz">
                <Input id="office-new-tz" name="timezone" placeholder="Africa/Accra" />
              </Field>
            </div>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- departments */

export function DepartmentsPanel({
  departments,
}: {
  departments: Array<{ id: string; code: string; name: string; isActive: boolean }>;
}) {
  return (
    <Card
      title="Departments"
      description="Changing somebody's department prompts a role review, as the joiner-mover-leaver process requires."
    >
      <Table>
        <thead>
          <tr>
            <Th>Code</Th>
            <Th>Name</Th>
            <Th>State</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {departments.map((department) => (
            <tr key={department.id}>
              <Td>
                <Id>{department.code}</Id>
              </Td>
              <Td>
                <ActionForm
                  action={updateDepartment}
                  submitLabel="Save"
                  submitTone="ghost"
                  submitSize="sm"
                  hidden={{ departmentId: department.id }}
                  compact
                >
                  <div className="flex items-center gap-2">
                    <Input
                      name="name"
                      defaultValue={department.name}
                      aria-label={`Name for ${department.code}`}
                      className="max-w-56"
                    />
                    <label className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
                      <input
                        type="checkbox"
                        name="isActive"
                        defaultChecked={department.isActive}
                        className="accent-signal"
                      />
                      Active
                    </label>
                  </div>
                </ActionForm>
              </Td>
              <Td>
                <Badge tone={department.isActive ? "ok" : "neutral"}>
                  {department.isActive ? "Active" : "Inactive"}
                </Badge>
              </Td>
              <Td>
                <div className="flex justify-end">
                  <ActionForm
                    action={deleteDepartment}
                    submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{ departmentId: department.id }}
                    confirm={`Delete ${department.name}? Any users in it must be moved first.`}
                    compact
                  />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-3 text-xs font-medium text-body">Add a department</p>
        <ActionForm
          action={createDepartment}
          submitLabel={
            <>
              <Plus className="size-4" aria-hidden="true" />
              Create department
            </>
          }
          submitSize="sm"
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Code" htmlFor="dept-code" required error={state.fieldErrors?.code}>
                <Input id="dept-code" name="code" placeholder="SUR" />
              </Field>
              <Field label="Name" htmlFor="dept-name" required error={state.fieldErrors?.name}>
                <Input id="dept-name" name="name" placeholder="Surveillance" />
              </Field>
            </div>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- features */

export function FeaturesAdminPanel({ features }: { features: Feature[] }) {
  return (
    <Card
      title="Feature definitions"
      description="Switch modules and capabilities on per role, and override per user. Adding one here makes it available to grant."
    >
      <Table>
        <thead>
          <tr>
            <Th>Key</Th>
            <Th>Name</Th>
            <Th>State</Th>
            <Th className="text-right">Remove</Th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <tr key={feature.key}>
              <Td>
                <Id>{feature.key}</Id>
              </Td>
              <Td>
                <span className="font-medium text-body">{feature.name}</span>
                {feature.description && (
                  <span className="block max-w-96 text-[11px] text-muted">
                    {feature.description}
                  </span>
                )}
              </Td>
              <Td>
                <Badge tone={feature.isActive ? "ok" : "neutral"}>
                  {feature.isActive ? "Active" : "Inactive"}
                </Badge>
              </Td>
              <Td>
                <div className="flex justify-end">
                  <ActionForm
                    action={deleteFeature}
                    submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{ featureKey: feature.key }}
                    confirm={`Remove the ${feature.name} feature? Role and user settings for it are removed too.`}
                    compact
                  />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-3 text-xs font-medium text-body">Add or update a feature</p>
        <ActionForm
          action={saveFeature}
          submitLabel={
            <>
              <Plus className="size-4" aria-hidden="true" />
              Save feature
            </>
          }
          submitSize="sm"
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Key"
                htmlFor="feature-key"
                required
                hint="Dotted lower case, for example module.surveillance."
                error={state.fieldErrors?.key}
              >
                <Input id="feature-key" name="key" placeholder="module.surveillance" />
              </Field>
              <Field label="Name" htmlFor="feature-name" required error={state.fieldErrors?.name}>
                <Input id="feature-name" name="name" placeholder="Surveillance module" />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description" htmlFor="feature-description">
                  <Input id="feature-description" name="description" />
                </Field>
              </div>
            </div>
          )}
        </ActionForm>
      </div>
    </Card>
  );
}
