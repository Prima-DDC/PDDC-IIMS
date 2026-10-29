import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import {
  Alert,
  Card,
  DescriptionList,
  Id,
  Muted,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getEntityDetail } from "@/features/intel/queries";
import { intel } from "@/modules/intel";
import { evidence } from "@/modules/evidence";
import {
  AliasForm,
  AliasRemovalForm,
  EntityForm,
  EntityRemovalPanel,
  Expandable,
  FlagMatchForm,
  MatchDecisionForm,
  RelationshipForm,
  RemoveRelationshipForm,
  ReverseMergeForm,
  RevealIdReferenceForm,
} from "@/features/intel/IntelForms";
import {
  AliasList,
  EntityTypeBadge,
  MatchFlagList,
  MergeHistory,
  RelationshipList,
} from "@/features/intel/IntelViews";
import { RelationshipGraph } from "@/features/intel/RelationshipGraph";
import {
  RESOLUTION_STATUS_LABELS,
  SUBJECT_ROLE_LABELS,
} from "@/modules/intel/shared";

export const metadata: Metadata = { title: "Subject" };

export default async function EntityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "entities", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getEntityDetail(id);
  // 404 rather than 403, as the rest of the platform does it: whether a
  // record exists on a case this person cannot reach is not theirs to learn.
  if (!detail) notFound();

  const { entity } = detail;

  // The other subjects on the cases this one appears on, which is what a
  // relationship can usefully be drawn to. Read here rather than in the query
  // because only this screen needs it.
  const api = intel(actor);
  const others = (await api.entities.list({ limit: 200 })).rows.filter(
    (candidate) => candidate.id !== entity.id,
  );
  const caseIds = [...new Set(detail.appearances.map((a) => a.caseId))];
  const [sources, items] = await Promise.all([
    caseIds.length > 0
      ? api.sources.list({ caseId: caseIds[0], limit: 100 })
      : Promise.resolve({ rows: [], total: 0 }),
    caseIds.length > 0
      ? evidence(actor).items.list({ caseId: caseIds[0], limit: 100 })
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  const openFlags = detail.flags.filter((flag) => flag.status === "open");

  return (
    <div className="space-y-5">
      <ClassificationBanner level={entity.classification} />

      <PageHeader
        title={entity.name}
        description={
          entity.aliases.length > 0
            ? `Also known as ${entity.aliases.map((a) => a.alias).join(", ")}`
            : "No other names recorded"
        }
        breadcrumb={[
          { label: "Subjects", href: "/entities" },
          { label: entity.entityId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EntityTypeBadge entityType={entity.entityType} />
          </div>
        }
      />

      {entity.resolutionStatus === "merged" && (
        <Alert tone="info" title="This record has been merged">
          Everything about this subject is now recorded on{" "}
          <AppLink
            href={`/entities/${entity.mergedIntoId}`}
            className="font-medium text-signal-dark hover:underline"
          >
            {entity.mergedIntoReference}
          </AppLink>
          . Nothing was deleted, and the merge can be reversed from there.
        </Alert>
      )}

      {openFlags.length > 0 && (
        <Alert tone="warn" title="This may be the same thing as another record">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {openFlags.length}{" "}
            {openFlags.length === 1 ? "record is" : "records are"} flagged against
            this one and waiting for a decision. Nothing is merged until somebody
            decides, and says why.
          </span>
        </Alert>
      )}

      <Card title="The subject">
        <DescriptionList
          items={[
            { label: "Identifier", value: <Id>{entity.entityId}</Id> },
            { label: "Type", value: entity.entityType.replace(/_/g, " ") },
            {
              label: "Registration number",
              value: entity.registrationNo ?? <NotSet />,
            },
            {
              label: "Identity reference",
              value: entity.hasIdReference ? (
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono text-xs">
                    ending {entity.idReferenceHint}
                  </span>
                  <RevealIdReferenceForm entity={entity} />
                </span>
              ) : (
                <NotSet />
              ),
            },
            {
              label: entity.entityType === "person" ? "Date of birth" : "Incorporated",
              value:
                entity.entityType === "person"
                  ? (entity.dateOfBirth
                      ? new Date(entity.dateOfBirth).toLocaleDateString("en-GB")
                      : <NotSet />)
                  : (entity.incorporatedOn
                      ? new Date(entity.incorporatedOn).toLocaleDateString("en-GB")
                      : <NotSet />),
            },
            { label: "Nationality", value: entity.nationalityName ?? <NotSet /> },
            { label: "Country", value: entity.countryName ?? <NotSet /> },
            { label: "Address", value: entity.address ?? <NotSet /> },
            {
              label: "Resolution",
              value: RESOLUTION_STATUS_LABELS[entity.resolutionStatus],
            },
            {
              label: "Cases",
              value:
                detail.appearances.length === 0 ? (
                  <Muted>on no case</Muted>
                ) : (
                  <span className="flex flex-wrap gap-2">
                    {detail.appearances.map((appearance) => (
                      <AppLink
                        key={appearance.id}
                        href={`/cases/${appearance.caseId}?tab=subjects`}
                        className="text-xs text-signal-dark hover:underline"
                      >
                        {appearance.caseReference} (
                        {SUBJECT_ROLE_LABELS[appearance.subjectRole].toLowerCase()}
                        {appearance.removedAt ? ", taken off" : ""})
                      </AppLink>
                    ))}
                  </span>
                ),
            },
          ]}
        />
        {entity.notes && (
          <p className="mt-4 border-t border-line pt-4 text-xs whitespace-pre-line text-muted">
            {entity.notes}
          </p>
        )}
      </Card>

      <Expandable
        title="Other names"
        description="An alias is what makes a search for the name somebody actually used find this record. The conflict and duplicate checks read them too."
        openLabel="Record an alias"
        canOpen={detail.can.edit}
        summary={
          <div className="space-y-3">
            <AliasList entity={entity} />
            {detail.can.edit && entity.aliases.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                {entity.aliases.map((alias) => (
                  <AliasRemovalForm
                    key={alias.id}
                    entity={entity}
                    aliasId={alias.id}
                    alias={alias.alias}
                  />
                ))}
              </div>
            )}
          </div>
        }
      >
        <AliasForm entity={entity} />
      </Expandable>

      <Expandable
        title="Relationships"
        description="Directorships, holdings and associations, each with what it rests on. A relationship nobody can trace is a rumour, and the screen says so rather than hiding it."
        openLabel="Record a relationship"
        canOpen={detail.can.edit}
        summary={
          <div className="space-y-4">
            <RelationshipList
              entityId={entity.id}
              relationships={detail.relationships}
            />
            {detail.can.edit && detail.relationships.length > 0 && (
              <div className="space-y-3 border-t border-line pt-4">
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Remove a relationship
                </p>
                {detail.relationships.map((relationship) => (
                  <div
                    key={relationship.id}
                    className="rounded-lg border border-line p-3"
                  >
                    <p className="mb-2 text-xs text-body">
                      {relationship.fromEntityName}{" "}
                      {relationship.relationshipType.replace(/_/g, " ")}{" "}
                      {relationship.toEntityName}
                    </p>
                    <RemoveRelationshipForm
                      entity={entity}
                      relationship={relationship}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        }
      >
        <RelationshipForm
            entity={entity}
            candidates={others.map((candidate) => ({
              id: candidate.id,
              label: `${candidate.entityId} ${candidate.name}`,
            }))}
            sources={sources.rows.map((source) => ({
              id: source.id,
              label: `${source.sourceId} ${source.description.slice(0, 60)}`,
            }))}
            evidenceItems={items.rows.map((item) => ({
              id: item.id,
            label: `${item.evidenceId} ${item.description.slice(0, 60)}`,
          }))}
        />
      </Expandable>

      <Card
        title="How this connects"
        description="Two hops out from this subject. The chart is a picture of the register, and the list above says the same thing in words."
      >
        <RelationshipGraph
          entities={detail.graph.entities}
          relationships={detail.graph.relationships}
          focusIds={[entity.id]}
        />
      </Card>

      <Expandable
        title="Duplicates and matches"
        description="Two records that may be the same thing. Flagged, never merged automatically, and a merge is reversible (PRD 8.4)."
        openLabel="Flag a match"
        canOpen={detail.can.edit}
        summary={
          <div className="space-y-4">
            {detail.similar.length > 0 && (
              <Alert tone="info" title="These look alike">
                <ul className="mt-1 space-y-1">
                  {detail.similar.map((match) => (
                    <li key={match.entity.id} className="text-[11px]">
                      <AppLink
                        href={`/entities/${match.entity.id}`}
                        className="font-medium text-signal-dark hover:underline"
                      >
                        {match.entity.name}
                      </AppLink>{" "}
                      <Id>{match.entity.entityId}</Id>{" "}
                      {Math.round(match.score * 100)}% alike on {match.matchedOn}.
                      Nothing has been flagged for these yet.
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            {detail.flags.length === 0 ? (
              <Muted>Nothing flagged against this record.</Muted>
            ) : (
              <ul className="space-y-2">
                {detail.flags.map((flag) => (
                  <li key={flag.id}>
                    <div
                      className={`rounded-lg border p-3 ${
                        flag.status === "open"
                          ? "border-warn/40 bg-warn/5"
                          : "border-line"
                      }`}
                    >
                      <MatchFlagList entityId={entity.id} flags={[flag]} />
                      {detail.can.edit && (
                        <MatchDecisionForm
                          entity={entity}
                          flag={flag}
                          canMerge={detail.can.merge}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        }
      >
        <FlagMatchForm
          entity={entity}
          candidates={others.map((candidate) => ({
            id: candidate.id,
            label: `${candidate.entityId} ${candidate.name}`,
          }))}
        />
      </Expandable>

      {detail.merges.length > 0 && (
        <Card
          title="Merge history"
          description="PRD 8.4: merges are reversible through a retained log and never delete a source record."
        >
          <div className="space-y-4">
            <MergeHistory merges={detail.merges} />
            {detail.can.merge &&
              detail.merges
                .filter((merge) => merge.reversedAt === null)
                .map((merge) => (
                  <div
                    key={merge.id}
                    className="rounded-lg border border-line p-3"
                  >
                    <p className="mb-2 text-xs text-body">
                      Reverse the merge of {merge.mergedEntityReference}
                    </p>
                    <ReverseMergeForm
                      entity={entity}
                      mergeId={merge.id}
                      mergedReference={merge.mergedEntityReference}
                    />
                  </div>
                ))}
          </div>
        </Card>
      )}

      {detail.can.edit && entity.deletedAt === null && (
        <Card
          title="Details"
          description="Changing the classification changes who can open this record at all."
        >
          <EntityForm
            entity={entity}
            levels={detail.levels}
            defaultClassification={entity.classification}
          />
        </Card>
      )}

      <EntityRemovalPanel entity={entity} canRemove={detail.can.remove} />
    </div>
  );
}
