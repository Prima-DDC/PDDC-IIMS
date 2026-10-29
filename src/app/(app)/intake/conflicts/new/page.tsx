import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, Card, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { crm } from "@/modules/crm";
import { runCheck } from "@/features/intake/actions";
import { ScreeningTermsForm } from "@/features/intake/IntakeForms";

export const metadata: Metadata = { title: "Run a conflict check" };

type Params = {
  enquiryId?: string;
  engagementId?: string;
  clientId?: string;
  /** Names to pre-fill, which the calling screen already knows. */
  term?: string | string[];
};

export default async function NewConflictCheckPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "conflicts", "view"))) {
    forbidden();
  }

  const params = await searchParams;
  const initialTerms = (
    Array.isArray(params.term) ? params.term : params.term ? [params.term] : []
  ).filter((t) => t.trim().length > 1);

  // Reached from the conflict list rather than from a record, so the form has
  // to ask which client the check is about.
  const subjectFixed = Boolean(
    params.enquiryId || params.engagementId || params.clientId,
  );
  const clients = subjectFixed
    ? []
    : (await crm(actor).clients.list({ status: "all", limit: 200 })).rows.map((c) => ({
        id: c.id,
        name: `${c.organisationName} (${c.clientId})`,
      }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Run a conflict check"
        description="Searches PDDC's records for potential matches on the names given."
        breadcrumb={[
          { label: "Intake", href: "/intake" },
          { label: "Conflict checks", href: "/intake/conflicts" },
          { label: "New check" },
        ]}
      />

      <Alert tone="info" title="What this does, and what it does not">
        <p>
          It finds <strong>potential</strong> matches and scores each one, using
          spelling similarity and how the names sound. It never merges records and it
          never concludes that two parties are the same. An authorised manager reads
          the matches and records the decision, which is then permanent.
        </p>
        <p className="mt-2">
          It searches the client register. Subjects, directors and related entities
          become searchable when the intelligence module lands; until then, screen
          their names here and the check records exactly what was searched, so what a
          clearance rests on stays legible afterwards.
        </p>
      </Alert>

      <Card
        title="Names to screen"
        description="The client, the subjects, companies, directors, shareholders, beneficial owners and any related entity. More names means a more useful check."
      >
        <ScreeningTermsForm
          initialTerms={initialTerms}
          enquiryId={params.enquiryId}
          engagementId={params.engagementId}
          clientId={params.clientId}
          clients={clients}
          action={runCheck}
        />
      </Card>
    </div>
  );
}
