import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  Id,
  NotSet,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getConflictCheck } from "@/features/intake/queries";
import { ConflictDecisionPanel } from "@/features/intake/ConflictDecision";
import { ConflictBadge } from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Conflict check" };

export default async function ConflictCheckPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "conflicts", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const result = await getConflictCheck(id);
  if (!result) notFound();

  const { check, summary } = result;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Conflict check ${check.checkId}`}
        description={`Searched for: ${check.searchedTerms.join(", ")}`}
        breadcrumb={[
          { label: "Intake", href: "/intake" },
          { label: "Conflict checks", href: "/intake/conflicts" },
          { label: check.checkId },
        ]}
        actions={<ConflictBadge status={check.status} />}
      />

      <Card title="What was searched">
        <DescriptionList
          items={[
            { label: "Check ID", value: <Id>{check.checkId}</Id> },
            {
              label: "Run",
              value: `${new Date(check.createdAt).toLocaleString("en-GB")}${
                check.createdByName ? ` by ${check.createdByName}` : ""
              }`,
            },
            {
              label: "Enquiry",
              value: check.enquiryId ? (
                <AppLink
                  href={`/intake/${check.enquiryId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{check.enquiryReference}</Id>
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Client",
              value: check.clientId ? (
                <AppLink
                  href={`/clients/${check.clientId}`}
                  className="text-signal-dark hover:underline"
                >
                  {check.clientName}
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Engagement",
              value: check.engagementId ? (
                <AppLink
                  href={`/engagements/${check.engagementId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{check.engagementReference}</Id>
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
            { label: "Matches found", value: String(check.matchCount) },
          ]}
        />

        <div className="mt-4 flex flex-wrap gap-1.5">
          {check.searchedTerms.map((term) => (
            <Badge key={term} tone="neutral">
              {term}
            </Badge>
          ))}
        </div>
      </Card>

      <Card
        title="Potential matches"
        description={summary}
      >
        {check.matches.length === 0 ? (
          <EmptyState
            title="No potential matches"
            description="Nothing in PDDC's records resembles the names searched for. A manager still records the clearance, so the check is on the file."
          />
        ) : (
          <>
            <Alert tone="info">
              Each row is a record that <strong>resembles</strong> one of the names
              searched for, with a score and the reason it was returned. The system does
              not decide whether any of these are the same party.
            </Alert>

            <div className="mt-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Searched for</Th>
                    <Th>Record on file</Th>
                    <Th>Score</Th>
                    <Th>Why it matched</Th>
                  </tr>
                </thead>
                <tbody>
                  {check.matches.map((match) => (
                    <tr key={match.id}>
                      <Td className="text-xs text-muted">{match.searchedTerm}</Td>
                      <Td>
                        {match.matchedTable === "crm.clients" ? (
                          <AppLink
                            href={`/clients/${match.matchedId}`}
                            className="font-medium text-body hover:text-signal-dark hover:underline"
                          >
                            {match.matchedLabel}
                          </AppLink>
                        ) : (
                          <span className="font-medium text-body">
                            {match.matchedLabel}
                          </span>
                        )}
                        <p className="text-[11px] text-faint">{match.matchedTable}</p>
                      </Td>
                      <Td>
                        <ScoreBar score={match.similarity} />
                      </Td>
                      <Td className="text-xs text-muted">
                        {match.matchReason}
                        {match.phoneticMatch && (
                          <span className="ml-1">
                            <Badge tone="info">sounds alike</Badge>
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </Card>

      <ConflictDecisionPanel check={check} canDecide={result.can.decide} />
    </div>
  );
}

/**
 * The similarity score, as a number and a bar.
 *
 * A bar as well as a figure because the reviewer's job is to triage a list,
 * and "0.62" sorts but does not read at a glance. The colour is deliberately
 * not a verdict: a high score means "look at this first", not "this is a
 * conflict".
 */
function ScoreBar({ score }: { score: number }) {
  const percent = Math.round(score * 100);
  const tone =
    score >= 0.8 ? "bg-danger" : score >= 0.5 ? "bg-warn" : "bg-ink-soft";

  return (
    <div className="min-w-24">
      <p className="font-id text-[12.5px] text-body">{score.toFixed(2)}</p>
      <div
        className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`Similarity ${percent} per cent`}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
