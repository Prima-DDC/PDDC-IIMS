"use client";

import { Save, UserPlus } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { Field, Input, Select, Textarea } from "@/components/ui";
import {
  CLIENT_STATUS_LABELS,
  CLIENT_STATUSES,
  CLIENT_TYPE_LABELS,
  CLIENT_TYPES,
  RISK_RATING_LABELS,
  RISK_RATINGS,
  type Client,
} from "@/modules/crm/shared";
import { createClient, updateClient } from "./actions";

/**
 * The client form, used both to create and to edit.
 *
 * One component for both, because a field that exists on one and not the other
 * is how the two drift apart. `client` being present is what makes it an edit:
 * it supplies the defaults, the record id and the version for optimistic
 * concurrency.
 */
export function ClientForm({
  client,
  offices,
  countries,
  levels,
  people,
  idempotencyKey,
}: {
  client?: Client;
  offices: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
  levels: Array<{ code: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  /**
   * A token from the server component rendering this form (PRD 21.7).
   *
   * Only the "new" pages pass one, because only creating mints a record: an
   * edit carries `expectedVersion`, so a duplicate gets a 409 rather than a
   * second row.
   */
  idempotencyKey?: string;
}) {
  const editing = client !== undefined;

  return (
    <ActionForm
      action={editing ? updateClient : createClient}
      idempotencyKey={idempotencyKey}
      submitLabel={
        editing ? (
          <>
            <Save className="size-4" aria-hidden="true" />
            Save changes
          </>
        ) : (
          <>
            <UserPlus className="size-4" aria-hidden="true" />
            Create client
          </>
        )
      }
      hidden={
        editing
          ? { clientId: client.id, expectedVersion: client.version }
          : undefined
      }
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Organisation name"
              htmlFor="organisationName"
              required
              hint="As it appears on the certificate of registration."
              error={state.fieldErrors?.organisationName}
            >
              <Input
                id="organisationName"
                name="organisationName"
                defaultValue={client?.organisationName ?? ""}
                autoComplete="organization"
              />
            </Field>
          </div>

          <Field
            label="Client type"
            htmlFor="clientType"
            required
            error={state.fieldErrors?.clientType}
          >
            <Select
              id="clientType"
              name="clientType"
              defaultValue={client?.clientType ?? "corporate"}
            >
              {CLIENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CLIENT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Industry" htmlFor="industry" error={state.fieldErrors?.industry}>
            <Input id="industry" name="industry" defaultValue={client?.industry ?? ""} />
          </Field>

          <Field
            label="Main contact"
            htmlFor="contactPerson"
            error={state.fieldErrors?.contactPerson}
          >
            <Input
              id="contactPerson"
              name="contactPerson"
              defaultValue={client?.contactPerson ?? ""}
            />
          </Field>

          <Field
            label="Their position"
            htmlFor="position"
            error={state.fieldErrors?.position}
          >
            <Input id="position" name="position" defaultValue={client?.position ?? ""} />
          </Field>

          <Field label="Telephone" htmlFor="telephone" error={state.fieldErrors?.telephone}>
            <Input
              id="telephone"
              name="telephone"
              type="tel"
              defaultValue={client?.telephone ?? ""}
            />
          </Field>

          <Field label="Email" htmlFor="email" error={state.fieldErrors?.email}>
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={client?.email ?? ""}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Address" htmlFor="address" error={state.fieldErrors?.address}>
              <Textarea
                id="address"
                name="address"
                rows={2}
                defaultValue={client?.address ?? ""}
              />
            </Field>
          </div>

          <Field
            label="Country"
            htmlFor="countryCode"
            error={state.fieldErrors?.countryCode}
          >
            <Select
              id="countryCode"
              name="countryCode"
              defaultValue={client?.countryCode ?? ""}
            >
              <option value="">Not recorded</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="PDDC office" htmlFor="officeId" error={state.fieldErrors?.officeId}>
            <Select id="officeId" name="officeId" defaultValue={client?.officeId ?? ""}>
              <option value="">Not assigned</option>
              {offices.map((office) => (
                <option key={office.id} value={office.id}>
                  {office.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Risk rating"
            htmlFor="riskRating"
            required
            hint="High and critical clients need sanctions and PEP screening before KYC counts as complete."
            error={state.fieldErrors?.riskRating}
          >
            <Select
              id="riskRating"
              name="riskRating"
              defaultValue={client?.riskRating ?? "medium"}
            >
              {RISK_RATINGS.map((rating) => (
                <option key={rating} value={rating}>
                  {RISK_RATING_LABELS[rating]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Account manager"
            htmlFor="accountManagerId"
            error={state.fieldErrors?.accountManagerId}
          >
            <Select
              id="accountManagerId"
              name="accountManagerId"
              defaultValue={client?.accountManagerId ?? ""}
            >
              <option value="">Not assigned</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status" htmlFor="status" required error={state.fieldErrors?.status}>
            <Select id="status" name="status" defaultValue={client?.status ?? "prospect"}>
              {CLIENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CLIENT_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Date onboarded"
            htmlFor="dateOnboarded"
            error={state.fieldErrors?.dateOnboarded}
          >
            <Input
              id="dateOnboarded"
              name="dateOnboarded"
              type="date"
              defaultValue={client?.dateOnboarded?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="Classification"
            htmlFor="classification"
            required
            hint="Who may open this record at all. You cannot set it above your own clearance."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="classification"
              name="classification"
              defaultValue={client?.classification ?? "CONFIDENTIAL"}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="notes" error={state.fieldErrors?.notes}>
              <Textarea
                id="notes"
                name="notes"
                rows={3}
                defaultValue={client?.notes ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}
