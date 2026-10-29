import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { allowedEnquiryTransitions, crm, matchSummary } from "@/modules/crm";
import { iam } from "@/modules/iam";

/** Read models for the intake screens. */

export async function listEnquiries(params: {
  search?: string;
  status?: string;
  urgency?: string;
  assignedTo?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = crm(actor);
  const [result, summary, allowed, directory] = await Promise.all([
    api.intake.listEnquiries({
      search: params.search,
      status: (params.status as "all" | undefined) ?? "all",
      urgency: params.urgency as never,
      assignedTo: params.assignedTo,
      sort: params.sort as never,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.intake.summary(),
    canAll(actor, [
      { resource: "clients", action: "create" },
      { resource: "clients", action: "edit" },
      { resource: "conflicts", action: "view" },
      { resource: "conflicts", action: "approve" },
      { resource: "engagements", action: "create" },
    ]),
    iam(actor).users.list({ status: "active", limit: 200 }),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    people: directory.rows.map((u) => ({
      id: u.id,
      name: u.fullName ?? u.email,
    })),
    can: {
      create: allowed["clients:create"],
      edit: allowed["clients:edit"],
      screen: allowed["conflicts:view"],
      decide: allowed["conflicts:approve"],
      createEngagement: allowed["engagements:create"],
    },
  };
}

export async function getEnquiryDetail(enquiryId: string) {
  const actor = await requireActor();
  const api = crm(actor);

  const enquiry = await api.intake.findEnquiry(enquiryId);
  if (!enquiry) return null;

  const [check, allowed, directory, clients, org] = await Promise.all([
    api.intake.latestCheckFor({ enquiryId }),
    canAll(actor, [
      { resource: "clients", action: "edit" },
      { resource: "conflicts", action: "view" },
      { resource: "conflicts", action: "approve" },
      { resource: "engagements", action: "create" },
    ]),
    iam(actor).users.list({ status: "active", limit: 200 }),
    api.clients.list({ status: "all", limit: 200 }),
    Promise.all([
      iam(actor).org.offices(),
      iam(actor).org.countries(),
      iam(actor).org.classificationLevels(),
    ]),
  ]);

  const [offices, countries, levels] = org;

  return {
    enquiry,
    check,
    // The stages this enquiry can actually move to, so the dropdown cannot
    // offer a transition the server would then refuse.
    transitions: allowedEnquiryTransitions(enquiry.status),
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
    can: {
      edit: allowed["clients:edit"],
      screen: allowed["conflicts:view"],
      decide: allowed["conflicts:approve"],
      createEngagement: allowed["engagements:create"],
    },
  };
}

/** The reference data the "new enquiry" form needs. */
export async function getEnquiryFormData() {
  const actor = await requireActor();
  const api = iam(actor);

  const [offices, countries, levels, directory, clients] = await Promise.all([
    api.org.offices(),
    api.org.countries(),
    api.org.classificationLevels(),
    api.users.list({ status: "active", limit: 200 }),
    crm(actor).clients.list({ status: "all", limit: 200 }),
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
  };
}

/* ------------------------------------------------------- conflict checks */

export async function listConflictChecks(params: {
  status?: string;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const [result, allowed] = await Promise.all([
    crm(actor).intake.listChecks({
      status: params.status ?? "all",
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    canAll(actor, [{ resource: "conflicts", action: "approve" }]),
  ]);

  return {
    ...result,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: { decide: allowed["conflicts:approve"] },
  };
}

export async function getConflictCheck(checkId: string) {
  const actor = await requireActor();

  const [check, allowed] = await Promise.all([
    crm(actor).intake.findCheck(checkId),
    canAll(actor, [{ resource: "conflicts", action: "approve" }]),
  ]);

  if (!check) return null;

  return {
    check,
    // The hedged sentence above the match list. It is generated from the
    // matches rather than written per screen, so the wording cannot drift
    // into claiming the system concluded anything (PRD 8.3).
    summary: matchSummary(
      check.matches.map((m) => ({
        searchedTerm: m.searchedTerm,
        matchedTable: m.matchedTable,
        matchedId: m.matchedId,
        matchedLabel: m.matchedLabel,
        similarity: m.similarity,
        phoneticMatch: m.phoneticMatch,
        matchReason: m.matchReason ?? "",
      })),
    ),
    can: { decide: allowed["conflicts:approve"] },
  };
}

/**
 * A live screening, without recording anything.
 *
 * Used by the "run a check" screen so the person can see what the terms turn
 * up before committing a check to the record. Recording happens only when
 * they press the button.
 */
export async function previewScreening(terms: string[], threshold = 0.3) {
  const actor = await requireActor();
  const candidates = await crm(actor).intake.screen(terms, threshold);
  return { candidates, summary: matchSummary(candidates) };
}
