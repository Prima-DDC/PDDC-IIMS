"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { assertClientRemovable, crm, isCrmError } from "@/modules/crm";
import { isIamError } from "@/modules/iam";
import {
  addContactSchema,
  addDocumentSchema,
  addKycSchema,
  clientStatusSchema,
  createClientSchema,
  removeClientSchema,
  removeContactSchema,
  removeDocumentSchema,
  updateClientSchema,
  updateContactSchema,
  updateKycSchema,
} from "./schema";

/**
 * Client management actions (PRD 8.1, 8.2, 3.5).
 *
 * Every one does the same four things in the same order, as the user
 * administration actions do:
 *
 *   1. Resolve the actor, which runs the full per-request gate.
 *   2. Check the permission server-side. This is authoritative; RLS is the
 *      second line of defence, not the first (PRD 14).
 *   3. Apply the domain rules the database cannot express.
 *   4. Mutate, with the audit row written in the same transaction.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCrmError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    // Never let a database message reach the interface.
    console.error("clients action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

/** Refreshes every screen a client appears on. */
function revalidateClient(clientId?: string) {
  refreshPath("/clients");
  if (clientId) refreshPath(`/clients/${clientId}`);
}

/* ------------------------------------------------------------------ client */

export async function createClient(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "create");

    const parsed = createClientSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    // Re-checked with the classification the form asked for. The RLS policy
    // would refuse it anyway, but as an opaque constraint violation; this way
    // the person is told they cannot classify a record above their own
    // clearance, which is what the field's hint promises.
    await requirePermission(actor, "clients", "create", parsed.data.classification);

    const client = await crm(actor).clients.create(parsed.data);

    revalidateClient();
    return {
      ...EMPTY_FORM_STATE,
      success: `${client.organisationName} created as ${client.clientId}. Record its KYC checks next.`,
    };
  });
}

export async function updateClient(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = updateClientSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "clients", "edit", parsed.data.classification);

    const { clientId, ...input } = parsed.data;
    await crm(actor).clients.update(clientId, input);

    revalidateClient(clientId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function changeClientStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = clientStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { clientId, status, reason } = parsed.data;
    await crm(actor).clients.setStatus(clientId, status, reason);

    revalidateClient(clientId);
    return { ...EMPTY_FORM_STATE, success: `The client is now ${status}.` };
  });
}

export async function removeClient(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "delete");

    const parsed = removeClientSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { clientId, reason } = parsed.data;
    const api = crm(actor);

    // An engagement whose client has vanished is worse than a refusal, so the
    // domain rule is checked before anything is written.
    const activeEngagementCount = await api.clients.activeEngagementCount(clientId);
    assertClientRemovable({ activeEngagementCount });

    await api.clients.softDelete(clientId, reason);

    revalidateClient(clientId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Client removed. It can be restored from the recycle bin.",
    };
  });
}

export async function restoreClient(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = removeClientSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { clientId, reason } = parsed.data;
    await crm(actor).clients.restore(clientId, reason);

    revalidateClient(clientId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Client restored." };
  });
}

/* ---------------------------------------------------------------- contacts */

export async function addContact(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = addContactSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const contact = await crm(actor).clients.addContact(parsed.data);

    revalidateClient(parsed.data.clientId);
    return { ...EMPTY_FORM_STATE, success: `${contact.fullName} added.` };
  });
}

export async function updateContact(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = updateContactSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { contactId, ...input } = parsed.data;
    const contact = await crm(actor).clients.updateContact(contactId, input);

    revalidateClient(contact.clientId);
    return { ...EMPTY_FORM_STATE, success: "Contact saved." };
  });
}

export async function removeContact(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = removeContactSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await crm(actor).clients.removeContact(parsed.data.contactId, parsed.data.reason);

    refreshPath("/clients");
    return { ...EMPTY_FORM_STATE, success: "Contact removed." };
  });
}

/* --------------------------------------------------------------- documents */

export async function addDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = addDocumentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    // A document may be classified above the person registering it only if
    // they hold that clearance themselves, which requirePermission checks
    // against the classification it is given.
    await requirePermission(actor, "clients", "edit", parsed.data.classification);

    await crm(actor).clients.addDocument(parsed.data);

    revalidateClient(parsed.data.clientId);
    return { ...EMPTY_FORM_STATE, success: `${parsed.data.title} registered.` };
  });
}

export async function removeDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = removeDocumentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await crm(actor).clients.removeDocument(parsed.data.documentId, parsed.data.reason);

    refreshPath("/clients");
    return { ...EMPTY_FORM_STATE, success: "Document removed." };
  });
}

/* --------------------------------------------------------------------- KYC */

export async function addKycRecord(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = addKycSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = crm(actor);
    await api.clients.addKycRecord(parsed.data);
    // The stored status is derived from the records, so it is recomputed here
    // rather than typed in by anybody.
    const client = await api.clients.refreshKycStatus(parsed.data.clientId);

    revalidateClient(parsed.data.clientId);
    return {
      ...EMPTY_FORM_STATE,
      success: `Check recorded. KYC is now ${client.kycStatus.replace(/_/g, " ")}.`,
    };
  });
}

export async function updateKycRecord(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = updateKycSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { kycId, ...input } = parsed.data;
    const api = crm(actor);
    const record = await api.clients.updateKycRecord(kycId, input);
    const client = await api.clients.refreshKycStatus(record.clientId);

    revalidateClient(record.clientId);
    return {
      ...EMPTY_FORM_STATE,
      success: `Check updated. KYC is now ${client.kycStatus.replace(/_/g, " ")}.`,
    };
  });
}
