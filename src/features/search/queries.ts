import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import { crm } from "@/modules/crm";
import { evidence } from "@/modules/evidence";
import { intel } from "@/modules/intel";
import { reporting } from "@/modules/reporting";

/**
 * Global search (PRD screen 4, PRD 21.5).
 *
 * WHY THIS COMPOSES THE EXISTING SEARCHES RATHER THAN ADDING ITS OWN.
 *
 * The obvious implementation is one query over a materialised index of
 * everything, and it is the wrong one here. Every record in this platform is
 * reachable only through row-level security, case assignment and a
 * classification ceiling, and those rules differ per resource: an
 * investigator reads the cases they are assigned to, evidence they may see
 * under their clearance, and no client record at all. A single index would
 * have to reimplement all of that in its own filter, and the day it drifted
 * from the policies it would leak the one thing this platform exists to
 * protect: the existence of a case, a subject or a source.
 *
 * So global search asks each module the question it already answers. Ten
 * searches in parallel is more round trips than one, and it is the version
 * where "permission-filtered inside the query" (PRD 21.5) is true by
 * construction rather than by review: a result appears here only because the
 * same endpoint behind the same policy returned it to the screen that lists
 * it.
 *
 * The permission gate in front of each one is not redundant either. Without
 * it, somebody with no `clients:view` would run a client search that
 * correctly returned nothing, and the empty "Clients" heading would still
 * tell them the resource exists and that they matched nothing in it. Asking
 * only the questions somebody may ask keeps the shape of the answer honest.
 */

export interface SearchHit {
  id: string;
  /** The human-readable identifier, which is what people actually quote. */
  reference: string | null;
  title: string;
  meta: string | null;
  href: string;
}

export interface SearchGroup {
  key: string;
  label: string;
  hits: SearchHit[];
  /** Everything that matched, which may be more than is shown. */
  total: number;
  href: string;
}

/** Enough to be a search rather than a listing of the whole platform. */
const MIN_TERM = 2;
const PER_GROUP = 6;

export async function globalSearch(term: string): Promise<{
  term: string;
  tooShort: boolean;
  groups: SearchGroup[];
  total: number;
}> {
  const actor = await requireActor();
  const search = term.trim();

  if (search.length < MIN_TERM) {
    return { term: search, tooShort: search.length > 0, groups: [], total: 0 };
  }

  const allowed = await canAll(actor, [
    { resource: "cases", action: "view" },
    { resource: "tasks", action: "view" },
    { resource: "clients", action: "view" },
    { resource: "engagements", action: "view" },
    { resource: "entities", action: "view" },
    { resource: "sources", action: "view" },
    { resource: "information", action: "view" },
    { resource: "findings", action: "view" },
    { resource: "evidence", action: "view" },
    { resource: "documents", action: "view" },
    { resource: "reports", action: "view" },
  ]);

  const work = casework(actor);
  const clients = crm(actor);
  const intelligence = intel(actor);
  const files = evidence(actor);
  const reports = reporting(actor);

  const limit = PER_GROUP;
  const q = encodeURIComponent(search);

  // Each entry is a group that MIGHT be asked for. The gate decides whether
  // the question is asked at all, and an unasked group never appears.
  const lookups: Array<
    | false
    | Promise<SearchGroup>
  > = [
    allowed["cases:view"] &&
      work.cases.list({ search, openness: "all", limit }).then(
        (page): SearchGroup => ({
          key: "cases",
          label: "Cases",
          total: page.total,
          href: `/cases?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.caseId,
            title: row.title,
            meta: `${row.clientName} - ${row.stageName}`,
            href: `/cases/${row.id}`,
          })),
        }),
      ),

    allowed["tasks:view"] &&
      work.tasks.list({ search, status: "all", limit }).then(
        (page): SearchGroup => ({
          key: "tasks",
          label: "Tasks",
          total: page.total,
          href: `/tasks?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.taskId,
            title: row.title,
            meta: `${row.caseReference} - ${row.assignedToName ?? "unassigned"}`,
            href: `/tasks/${row.id}`,
          })),
        }),
      ),

    allowed["clients:view"] &&
      clients.clients.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "clients",
          label: "Clients",
          total: page.total,
          href: `/clients?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.clientId,
            title: row.organisationName,
            meta: row.clientType.replace(/_/g, " "),
            href: `/clients/${row.id}`,
          })),
        }),
      ),

    allowed["engagements:view"] &&
      clients.engagements.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "engagements",
          label: "Engagements",
          total: page.total,
          href: `/engagements?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.engagementId,
            title: row.title,
            meta: `${row.clientName} - ${row.status.replace(/_/g, " ")}`,
            href: `/engagements/${row.id}`,
          })),
        }),
      ),

    allowed["entities:view"] &&
      intelligence.entities.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "entities",
          label: "Subjects",
          total: page.total,
          href: `/entities?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.entityId,
            title: row.name,
            meta: row.entityType.replace(/_/g, " "),
            href: `/entities/${row.id}`,
          })),
        }),
      ),

    allowed["sources:view"] &&
      intelligence.sources.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "sources",
          label: "Sources",
          total: page.total,
          href: `/sources?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.sourceId,
            title: row.description,
            meta: row.sourceType.replace(/_/g, " "),
            href: `/sources/${row.id}`,
          })),
        }),
      ),

    allowed["information:view"] &&
      intelligence.information.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "information",
          label: "Information",
          total: page.total,
          href: `/information?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.informationId,
            title: row.description,
            meta: `${row.caseReference} - ${row.confidence}`,
            href: `/information/${row.id}`,
          })),
        }),
      ),

    allowed["findings:view"] &&
      intelligence.findings.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "findings",
          label: "Findings",
          total: page.total,
          href: `/findings?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.findingId,
            title: row.statement,
            meta: `${row.caseReference} - ${row.status.replace(/_/g, " ")}`,
            href: `/findings/${row.id}`,
          })),
        }),
      ),

    allowed["evidence:view"] &&
      files.items.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "evidence",
          label: "Evidence",
          total: page.total,
          href: `/evidence?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.evidenceId,
            title: row.description,
            meta: `${row.caseReference} - ${row.evidenceType.replace(/_/g, " ")}`,
            href: `/evidence/${row.id}`,
          })),
        }),
      ),

    allowed["documents:view"] &&
      files.documents.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "documents",
          label: "Documents",
          total: page.total,
          href: `/documents?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.documentId,
            title: row.title,
            meta: `${row.caseReference} - ${row.documentType.replace(/_/g, " ")}`,
            href: `/documents/${row.id}`,
          })),
        }),
      ),

    allowed["reports:view"] &&
      reports.reports.list({ search, limit }).then(
        (page): SearchGroup => ({
          key: "reports",
          label: "Reports",
          total: page.total,
          href: `/reports?search=${q}`,
          hits: page.rows.map((row) => ({
            id: row.id,
            reference: row.reportId,
            title: row.title,
            meta: `${row.caseReference} - ${row.status.replace(/_/g, " ")}`,
            href: `/reports/${row.id}`,
          })),
        }),
      ),
  ];

  const groups = (
    await Promise.all(lookups.filter((entry): entry is Promise<SearchGroup> => Boolean(entry)))
  ).filter((group) => group.hits.length > 0);

  return {
    term: search,
    tooShort: false,
    groups,
    total: groups.reduce((sum, group) => sum + group.total, 0),
  };
}
