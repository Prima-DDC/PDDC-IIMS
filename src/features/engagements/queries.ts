import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { allowedEngagementTransitions, crm } from "@/modules/crm";
import { iam } from "@/modules/iam";

/** Read models for the engagement screens. */

export async function listEngagements(params: {
  search?: string;
  status?: string;
  engagementType?: string;
  clientId?: string;
  responsibleManagerId?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = crm(actor);
  const [result, allowed, clients, directory] = await Promise.all([
    api.engagements.list({
      search: params.search,
      status: (params.status as "all" | undefined) ?? "all",
      engagementType: params.engagementType as never,
      clientId: params.clientId,
      responsibleManagerId: params.responsibleManagerId,
      sort: params.sort as never,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    canAll(actor, [
      { resource: "engagements", action: "create" },
      { resource: "engagements", action: "edit" },
      { resource: "engagements", action: "approve" },
      { resource: "engagements", action: "delete" },
    ]),
    api.clients.list({ status: "all", limit: 200 }),
    iam(actor).users.list({ status: "active", limit: 200 }),
  ]);

  return {
    ...result,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    clients: clients.rows.map((c) => ({
      id: c.id,
      name: `${c.organisationName} (${c.clientId})`,
    })),
    managers: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    can: {
      create: allowed["engagements:create"],
      edit: allowed["engagements:edit"],
      approve: allowed["engagements:approve"],
      remove: allowed["engagements:delete"],
    },
  };
}

export async function getEngagementDetail(engagementId: string) {
  const actor = await requireActor();
  const api = crm(actor);

  const engagement = await api.engagements.findById(engagementId);
  if (!engagement) return null;

  const [check, allowed, directory, org] = await Promise.all([
    api.intake.latestCheckFor({
      engagementId,
      ...(engagement.enquiryId ? { enquiryId: engagement.enquiryId } : {}),
    }),
    canAll(actor, [
      { resource: "engagements", action: "edit" },
      { resource: "engagements", action: "approve" },
      { resource: "engagements", action: "delete" },
      { resource: "conflicts", action: "view" },
      { resource: "cases", action: "create" },
    ]),
    iam(actor).users.list({ status: "active", limit: 200 }),
    Promise.all([
      iam(actor).org.offices(),
      iam(actor).org.countries(),
      iam(actor).org.classificationLevels(),
    ]),
  ]);

  const [offices, countries, levels] = org;

  return {
    engagement,
    check,
    transitions: allowedEngagementTransitions(engagement.status),
    /**
     * Whether this actor could approve it, which is not the same as whether it
     * is approvable: somebody who raised an engagement cannot sign off their
     * own, so the button is hidden rather than offered and then refused
     * (separation of duties, PRD 16).
     */
    isAuthor: engagement.createdBy === actor.userId,
    offices,
    countries,
    levels,
    people: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    can: {
      edit: allowed["engagements:edit"],
      approve: allowed["engagements:approve"],
      remove: allowed["engagements:delete"],
      viewConflicts: allowed["conflicts:view"],
      createCase: allowed["cases:create"],
    },
  };
}

/** The reference data the "new engagement" form needs. */
export async function getEngagementFormData() {
  const actor = await requireActor();
  const api = iam(actor);

  const [offices, countries, levels, directory, clients, enquiries] =
    await Promise.all([
      api.org.offices(),
      api.org.countries(),
      api.org.classificationLevels(),
      api.users.list({ status: "active", limit: 200 }),
      crm(actor).clients.list({ status: "all", limit: 200 }),
      // Only accepted enquiries, because an engagement records an instruction
      // PDDC has agreed to take.
      crm(actor).intake.listEnquiries({ status: "accepted", limit: 100 }),
    ]);

  return {
    offices,
    countries,
    levels,
    people: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    clients: clients.rows.map((c) => ({
      id: c.id,
      name: `${c.organisationName} (${c.clientId})`,
    })),
    enquiries: enquiries.rows.map((e) => ({
      id: e.id,
      name: `${e.enquiryId}: ${e.subject}`,
    })),
  };
}
