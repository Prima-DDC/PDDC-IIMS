import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { assertRiskApprovedForAssignment, casework } from "@/modules/casework";
import { crm } from "@/modules/crm";
import { iam } from "@/modules/iam";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/**
 * Read models for the case screens.
 *
 * Each repository call opens its own transaction, and that is deliberate
 * rather than careless. Batching a screen's reads into one transaction looks
 * like the obvious saving, and it was tried and measured: ten trivial reads
 * are indeed four times faster that way, because postgres.js pipelines
 * concurrent queries down one connection. On the real queries it was twice as
 * SLOW: the case page went from 6.9s to 12.6s, and the register from 3.4s to
 * 12.6s. The reason is that these queries are not trivial, so what dominates
 * is their execution rather than the round trip, and one transaction means
 * one connection means one at a time. The pool runs them side by side.
 *
 * The round-trip cost that remains is latency to a database 127ms away. With
 * the application deployed in the database's region it is a few milliseconds
 * per trip, which is the fix: see docs/PROGRESS.md.
 */

export async function listCases(params: {
  search?: string;
  stageKey?: string;
  openness?: string;
  priority?: string;
  riskLevel?: string;
  caseType?: string;
  clientId?: string;
  mine?: boolean;
  overdueOnly?: boolean;
  sort?: string;
  page?: number;
  perPage?: number;
  onlyDeleted?: boolean;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = casework(actor);
  const [result, summary, definition, caseTypes, allowed] = await Promise.all([
    api.cases.list({
      search: params.search,
      stageKey: params.stageKey,
      openness:
        (params.openness as "open" | "closed" | "all" | undefined) ?? "open",
      priority: params.priority as never,
      riskLevel: params.riskLevel as never,
      caseType: params.caseType,
      clientId: params.clientId,
      assignedTo: params.mine ? actor.userId : undefined,
      overdueOnly: params.overdueOnly,
      onlyDeleted: params.onlyDeleted,
      sort: params.sort as never,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.cases.summary(actor.userId),
    api.workflow.defaultDefinition(),
    api.workflow.caseTypes(),
    canAll(actor, [
      { resource: "cases", action: "create" },
      { resource: "cases", action: "edit" },
      { resource: "cases", action: "assign" },
      { resource: "cases", action: "delete" },
    ]),
  ]);

  return {
    ...result,
    summary,
    stages: definition.stages,
    caseTypes,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: {
      create: allowed["cases:create"],
      edit: allowed["cases:edit"],
      assign: allowed["cases:assign"],
      remove: allowed["cases:delete"],
    },
  };
}

/** Everything one case's page needs. */
export async function getCaseDetail(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const record = await api.cases.findById(caseRecordId);
  if (!record) return null;

  const [
    objective,
    assignments,
    assignmentHistory,
    riskAssessments,
    scopeVersions,
    scopeChanges,
    communications,
    transitions,
    definition,
    caseTypes,
    allowed,
    directory,
    org,
  ] = await Promise.all([
    api.cases.objective(caseRecordId),
    api.cases.assignments(caseRecordId),
    api.cases.assignments(caseRecordId, true),
    api.cases.riskAssessments(caseRecordId),
    api.cases.scopeVersions(caseRecordId),
    api.cases.scopeChangeRequests(caseRecordId),
    api.cases.communications(caseRecordId),
    api.workflow.transitionsFrom(record.stageId),
    api.workflow.defaultDefinition(),
    api.workflow.caseTypes(),
    canAll(actor, [
      { resource: "cases", action: "edit" },
      { resource: "cases", action: "assign" },
      { resource: "cases", action: "approve" },
      { resource: "cases", action: "delete" },
      { resource: "cases", action: "close" },
    ]),
    staffDirectory(actor),
    Promise.all([
      iam(actor).org.offices(),
      iam(actor).org.countries(),
      classificationLevels(actor),
    ]),
  ]);

  const [offices, countries, levels] = org;

  const latestRisk = riskAssessments[0] ?? null;

  // Whether assignment is currently possible, worked out here so the screen
  // can say why not rather than offering a form that would be refused.
  let assignmentBlocker: string | null = null;
  try {
    assertRiskApprovedForAssignment({
      riskLevel: record.riskLevel,
      latestRiskApprovedAt: latestRisk?.approvedAt ?? null,
    });
  } catch (error) {
    assignmentBlocker =
      error instanceof Error ? error.message : "Assignment is blocked.";
  }

  return {
    record,
    objective,
    assignments,
    // Only the people who have come off, which is what the history panel shows.
    assignmentHistory: assignmentHistory.filter((a) => a.unassignedAt !== null),
    riskAssessments,
    latestRisk,
    scopeVersions,
    scopeChanges,
    pendingScopeChange:
      scopeChanges.find((r) => r.status === "pending") ?? null,
    communications,
    /** The legal next stages, loaded rather than inferred (PRD 4.3). */
    transitions,
    stages: definition.stages,
    caseTypes,
    offices,
    countries,
    levels,
    people: directory,
    assignmentBlocker,
    /** True when this actor raised the pending change, so they cannot decide it. */
    isOwnScopeChange:
      scopeChanges.find((r) => r.status === "pending")?.requestedBy ===
      actor.userId,
    can: {
      edit: allowed["cases:edit"],
      assign: allowed["cases:assign"],
      approve: allowed["cases:approve"],
      remove: allowed["cases:delete"],
      close: allowed["cases:close"],
    },
  };
}

/**
 * The reference data the "new case" form needs.
 *
 * Only engagements PDDC has committed to are offered, because PRD 4.1 runs
 * Engagement Approval before Case Creation and the action refuses anything
 * else. Offering a draft engagement would mean showing a choice that always
 * fails.
 */
export async function getCaseFormData() {
  const actor = await requireActor();

  const api = casework(actor);

  const [caseTypes, offices, countries, levels, engagements] =
    await Promise.all([
      api.workflow.caseTypes(),
      iam(actor).org.offices(),
      iam(actor).org.countries(),
      classificationLevels(actor),
      crm(actor).engagements.list({ status: "all", limit: 200 }),
    ]);

  const openForCases = engagements.rows.filter(
    (e) => e.status === "approved" || e.status === "active",
  );

  return {
    caseTypes,
    offices,
    countries,
    levels,
    engagements: openForCases.map((e) => ({
      id: e.id,
      clientId: e.clientId,
      name: `${e.engagementId}: ${e.title} (${e.clientName})`,
    })),
    /** Whether anything is available to open a case against at all. */
    hasEligibleEngagement: openForCases.length > 0,
  };
}
