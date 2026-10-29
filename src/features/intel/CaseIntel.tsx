import { Alert, Card, Muted, StatTile } from "@/components/ui";
import { intel } from "@/modules/intel";
import { requireActor } from "@/lib/auth/session";
import {
  getCaseFindings,
  getCaseSources,
  getCaseSubjects,
} from "./queries";
import {
  AddSubjectForm,
  EntityForm,
  Expandable,
  FindingForm,
  InformationForm,
  RemoveSubjectForm,
  SourceForm,
} from "./IntelForms";
import {
  FindingCard,
  InformationTable,
  SourceTable,
  SubjectList,
} from "./IntelViews";
import { RelationshipGraph } from "./RelationshipGraph";

/**
 * The three intelligence tabs of a case file (PRD screens 10, 14, 17).
 *
 * Each is its own server component so the case page streams it, and each
 * reads only what it shows.
 */

/* ------------------------------------------------------------- subjects */

export async function CaseSubjectsTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const data = await getCaseSubjects(caseRecordId);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Subjects" value={data.summary.total} />
        <StatTile label="People" value={data.summary.people} />
        <StatTile label="Companies" value={data.summary.companies} />
        <StatTile
          label="To decide"
          value={data.summary.openFlags}
          tone={data.summary.openFlags > 0 ? "warn" : "ok"}
          href="/entities?flagged=open"
        />
      </div>

      {data.summary.openFlags > 0 && (
        <Alert tone="warn" title="Records that may be the same thing">
          {data.summary.openFlags}{" "}
          {data.summary.openFlags === 1 ? "pair is" : "pairs are"} waiting for
          somebody to decide. Nothing is merged until they do, and a merge is
          reversible.
        </Alert>
      )}

      <Expandable
        title="Subjects"
        description="The people, companies and assets this case concerns, and what part each plays."
        openLabel="Register a subject"
        canOpen={data.can.create || data.can.edit}
        summary={
          <>
            <SubjectList subjects={data.subjects} />
            {data.removed.length > 0 && (
              <div className="border-t border-line pt-4">
                <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Taken off the case
                </p>
<SubjectList subjects={data.removed} />
              </div>
            )}
          </>
        }
      >
        <div className="space-y-4">
          {data.can.create && (
            <EntityForm
              levels={data.levels}
              defaultClassification={caseClassification}
              caseRecordId={caseRecordId}
            />
          )}

          {data.can.edit && (
            <div className="border-t border-line pt-4">
              <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                Or add one already in the register
              </p>
              <AddSubjectForm
                caseRecordId={caseRecordId}
                candidates={data.available.map((entity) => ({
                  id: entity.id,
                  label: `${entity.entityId} ${entity.name}${
                    entity.caseCount > 0 ? ` (on ${entity.caseCount} other)` : ""
                  }`,
                }))}
              />
            </div>
          )}
        </div>
      </Expandable>

      {data.can.edit && data.subjects.length > 0 && (
        <Card
          title="Take a subject off this case"
          description="Looking at somebody and ruling them out is part of what the investigation did, so it stays on the record with its reason."
        >
          <div className="space-y-4">
            {data.subjects.map((subject) => (
              <div
                key={subject.id}
                className="rounded-lg border border-line p-3"
              >
                <p className="mb-2 text-xs font-medium text-body">
                  {subject.entityName}
                </p>
                <RemoveSubjectForm
                  caseRecordId={caseRecordId}
                  subjectId={subject.id}
                  name={subject.entityName}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="How they connect"
        description="Directorships, holdings and associations within two hops of this case's subjects. The chart is a picture of the register, and the list below says the same thing in words."
      >
        <RelationshipGraph
          entities={data.graph.entities}
          relationships={data.graph.relationships}
          focusIds={data.subjects.map((subject) => subject.entityId)}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------- sources, information */

export async function CaseSourcesTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const actor = await requireActor();
  const data = await getCaseSources(caseRecordId);
  const subjects = await intel(actor).subjects.forCase(caseRecordId);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Sources" value={data.sourceSummary.total} />
        <StatTile
          label="Reliable sources"
          value={data.sourceSummary.reliable}
          tone="ok"
        />
        <StatTile label="Information" value={data.informationSummary.total} />
        <StatTile
          label="Nothing bears out"
          value={data.informationSummary.uncorroborated}
          tone={data.informationSummary.uncorroborated > 0 ? "warn" : "ok"}
        />
      </div>

      {data.informationSummary.contradicted > 0 && (
        <Alert tone="danger" title="Something has been contradicted">
          {data.informationSummary.contradicted}{" "}
          {data.informationSummary.contradicted === 1 ? "statement" : "statements"} on
          this case {data.informationSummary.contradicted === 1 ? "has" : "have"} been
          contradicted. Nothing contradicted can be recorded as confirmed, and a
          finding resting on one needs looking at again.
        </Alert>
      )}

      <Expandable
        title="Sources"
        description="Where the material came from, and how far the source can be relied on in general. A human source is strictly restricted automatically, and its identity is need-to-know."
        openLabel="Record a source"
        canOpen={data.can.createSource}
        summary={<SourceTable sources={data.sources} showCase={false} />}
      >
        <SourceForm
          caseRecordId={caseRecordId}
          people={data.people}
          levels={data.levels}
          defaultClassification={caseClassification}
          actorId={data.actorId}
        />
      </Expandable>

      <Expandable
        title="Information"
        description="What each source said, rated separately from the source itself. A reliable source can report something nobody has confirmed, and the two ratings never merge."
        openLabel="Record information"
        canOpen={data.can.createInformation}
        summary={
          <InformationTable information={data.information} showCase={false} />
        }
      >
        <InformationForm
            caseRecordId={caseRecordId}
            sources={data.sources.map((source) => ({
              id: source.id,
              label: `${source.sourceId} ${source.description.slice(0, 70)}`,
            }))}
            subjects={subjects.map((subject) => ({
              id: subject.entityId,
              label: `${subject.entityReference} ${subject.entityName}`,
            }))}
          levels={data.levels}
          defaultClassification={caseClassification}
        />
      </Expandable>
    </div>
  );
}

/* ------------------------------------------------------------- findings */

export async function CaseFindingsTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const data = await getCaseFindings(caseRecordId);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Findings" value={data.summary.total} />
        <StatTile label="Accepted" value={data.summary.accepted} tone="ok" />
        <StatTile
          label="Awaiting review"
          value={data.summary.awaitingReview}
          tone={data.summary.awaitingReview > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label="Rest on nothing"
          value={data.summary.unsupported}
          tone={data.summary.unsupported > 0 ? "danger" : "ok"}
        />
      </div>

      {data.summary.unsupported > 0 && (
        <Alert tone="warn" title="A finding rests on nothing">
          {data.summary.unsupported}{" "}
          {data.summary.unsupported === 1 ? "finding has" : "findings have"} no
          information or evidence linked. They cannot be put forward for review
          until they do: a conclusion that cannot be traced back is one PDDC
          cannot defend if the report is challenged.
        </Alert>
      )}

      <Expandable
        title="Findings"
        description="The investigation's conclusions, each resting on the information and evidence behind it. Only an accepted finding can be cited in a report."
        openLabel="Draft a finding"
        canOpen={data.can.create}
        summary={
          data.findings.length === 0 ? (
            <Muted>
              No findings yet. A finding is the answer to one of the questions
              the case was opened to answer.
            </Muted>
          ) : (
            <ul className="space-y-3">
              {data.findings.map((finding) => (
                <li key={finding.id}>
                  <FindingCard finding={finding} />
                </li>
              ))}
            </ul>
          )
        }
      >
        <FindingForm
          caseRecordId={caseRecordId}
          people={data.people}
          levels={data.levels}
          defaultClassification={caseClassification}
          actorId={data.actorId}
        />
      </Expandable>
    </div>
  );
}
