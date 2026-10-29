import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { assessKyc, crm } from "@/modules/crm";
import { iam } from "@/modules/iam";

/**
 * Read models for the client screens.
 *
 * Separate from actions.ts so the read path stays free of mutation concerns,
 * matching the command/query split in PRD 21.1. Permission answers are fetched
 * with canAll rather than one call each, because each one is a round trip to a
 * hosted database.
 */

export async function listClients(params: {
  search?: string;
  status?: string;
  clientType?: string;
  kycStatus?: string;
  riskRating?: string;
  accountManagerId?: string;
  sort?: string;
  page?: number;
  perPage?: number;
  onlyDeleted?: boolean;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = crm(actor);
  const [result, summary, allowed, managers] = await Promise.all([
    api.clients.list({
      search: params.search,
      status: (params.status as "all" | undefined) ?? "all",
      clientType: params.clientType as never,
      kycStatus: params.kycStatus,
      riskRating: params.riskRating as never,
      accountManagerId: params.accountManagerId,
      sort: params.sort as never,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.clients.summary(),
    canAll(actor, [
      { resource: "clients", action: "create" },
      { resource: "clients", action: "edit" },
      { resource: "clients", action: "delete" },
      { resource: "engagements", action: "view" },
    ]),
    iam(actor).users.list({ status: "active", limit: 200 }),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    managers: managers.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    can: {
      create: allowed["clients:create"],
      edit: allowed["clients:edit"],
      remove: allowed["clients:delete"],
      viewEngagements: allowed["engagements:view"],
    },
  };
}

/** Everything one client's page needs, in as few round trips as possible. */
export async function getClientDetail(clientId: string) {
  const actor = await requireActor();
  const api = crm(actor);

  const client = await api.clients.findById(clientId);
  if (!client) return null;

  const [
    contacts,
    documents,
    kycRecords,
    engagements,
    checks,
    allowed,
    directory,
    org,
  ] = await Promise.all([
    api.clients.contacts(clientId),
    api.clients.documents(clientId),
    api.clients.kycRecords(clientId),
    api.engagements.list({ clientId, limit: 50 }),
    api.intake.listChecks({ clientId, limit: 20 }),
    canAll(actor, [
      { resource: "clients", action: "edit" },
      { resource: "clients", action: "delete" },
      { resource: "engagements", action: "create" },
      { resource: "conflicts", action: "view" },
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
    client,
    contacts,
    documents,
    kycRecords,
    engagements: engagements.rows,
    conflictChecks: checks.rows,
    // The authoritative KYC position, recomputed from the records on file.
    kyc: assessKyc(kycRecords, client.riskRating),
    offices,
    countries,
    levels,
    people: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    can: {
      edit: allowed["clients:edit"],
      remove: allowed["clients:delete"],
      createEngagement: allowed["engagements:create"],
      viewConflicts: allowed["conflicts:view"],
    },
  };
}

/** The reference data the "new client" form needs. */
export async function getClientFormData() {
  const actor = await requireActor();
  const api = iam(actor);

  const [offices, countries, levels, directory] = await Promise.all([
    api.org.offices(),
    api.org.countries(),
    api.org.classificationLevels(),
    api.users.list({ status: "active", limit: 200 }),
  ]);

  return {
    offices,
    countries,
    levels,
    people: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
  };
}
