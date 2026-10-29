import { AppLink } from "@/components/AppLink";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Car,
  CheckCircle2,
  FileSearch,
  FileText,
  Landmark,
  Link2,
  Merge,
  Radio,
  Scale,
  User,
  Wallet,
} from "lucide-react";
import {
  Badge,
  EmptyState,
  Id,
  Muted,
  NotSet,
  Table,
  Td,
  Th,
} from "@/components/ui";
import {
  CONFIDENCE_LABELS,
  ENTITY_TYPE_LABELS,
  FINDING_STATUS_LABELS,
  INFORMATION_CREDIBILITY_LABELS,
  MATCH_FLAG_STATUS_LABELS,
  MATCH_FLAG_TYPE_LABELS,
  RELATIONSHIP_TYPE_LABELS,
  RESOLUTION_STATUS_LABELS,
  SOURCE_RELIABILITY_LABELS,
  SOURCE_TYPE_LABELS,
  SUBJECT_ROLE_LABELS,
  type CaseSubject,
  type ConfidenceLevel,
  type Entity,
  type EntityMerge,
  type EntityType,
  type Finding,
  type FindingStatus,
  type Information,
  type InformationCredibility,
  type MatchFlag,
  type Relationship,
  type Source,
  type SourceReliability,
  type Traceability,
} from "@/modules/intel/shared";

/**
 * Reading the intelligence register (PRD 6.4, 8.4, 15).
 *
 * Server components: none of this holds state. Two things here are the
 * module's whole point and are built to be read carefully.
 *
 * The reliability and credibility badges are DIFFERENT badges with different
 * words, because PRD 6.4 rates the source and the statement separately. They
 * are shown side by side and never combined, so a reliable source reporting
 * something unconfirmed reads as exactly that.
 *
 * The traceability strip is the platform's purpose in one component: given a
 * conclusion, walk back to the evidence and the information behind it, and
 * the source behind that. Every hop is a link, because a strip you cannot
 * follow is decoration.
 */

function when(value: string) {
  return new Date(value).toLocaleDateString("en-GB");
}

const ENTITY_ICONS: Record<EntityType, typeof User> = {
  person: User,
  company: Building2,
  organisation: Building2,
  government_body: Landmark,
  property: Landmark,
  vehicle: Car,
  account: Wallet,
  asset: Wallet,
  other: FileText,
};

export function EntityTypeBadge({ entityType }: { entityType: EntityType }) {
  const Icon = ENTITY_ICONS[entityType];
  return (
    <Badge tone="neutral">
      <Icon className="size-3" aria-hidden="true" />
      {ENTITY_TYPE_LABELS[entityType]}
    </Badge>
  );
}

/**
 * How far what this source says can be relied on, in general.
 *
 * A property of the source. Never shown as the quality of anything it said.
 */
export function ReliabilityBadge({
  reliability,
}: {
  reliability: SourceReliability;
}) {
  const tone =
    reliability === "reliable"
      ? "ok"
      : reliability === "usually_reliable"
        ? "info"
        : reliability === "unknown"
          ? "neutral"
          : "warn";
  return (
    <Badge tone={tone}>
      <Radio className="size-3" aria-hidden="true" />
      Source: {SOURCE_RELIABILITY_LABELS[reliability]}
    </Badge>
  );
}

/**
 * How far this particular statement is borne out.
 *
 * A property of the information. "Confirmed" means something else bears it
 * out, which the platform refuses to let anybody claim without linking it.
 */
export function CredibilityBadge({
  credibility,
}: {
  credibility: InformationCredibility;
}) {
  const tone =
    credibility === "confirmed"
      ? "ok"
      : credibility === "probable"
        ? "info"
        : credibility === "possible"
          ? "neutral"
          : "warn";
  return (
    <Badge tone={tone}>
      <Scale className="size-3" aria-hidden="true" />
      Information: {INFORMATION_CREDIBILITY_LABELS[credibility]}
    </Badge>
  );
}

export function ConfidenceBadge({
  confidence,
  label = "Confidence",
}: {
  confidence: ConfidenceLevel;
  label?: string;
}) {
  const tone =
    confidence === "high"
      ? "ok"
      : confidence === "moderate"
        ? "info"
        : confidence === "low"
          ? "warn"
          : "neutral";
  return (
    <Badge tone={tone}>
      {label}: {CONFIDENCE_LABELS[confidence]}
    </Badge>
  );
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  const tone =
    status === "accepted"
      ? "ok"
      : status === "submitted"
        ? "info"
        : status === "returned"
          ? "warn"
          : status === "withdrawn"
            ? "neutral"
            : "neutral";
  return <Badge tone={tone}>{FINDING_STATUS_LABELS[status]}</Badge>;
}

/* ------------------------------------------------------------- entities */

export function EntityTable({ entities }: { entities: Entity[] }) {
  if (entities.length === 0) {
    return (
      <EmptyState
        title="No subjects match those filters"
        description="Clear the filters, or register the person or company under investigation."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Subject</Th>
          <Th>Type</Th>
          <Th>Country</Th>
          <Th>Cases</Th>
          <Th className="text-right">Resolution</Th>
        </tr>
      </thead>
      <tbody>
        {entities.map((entity) => (
          <tr key={entity.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/entities/${entity.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {entity.name}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{entity.entityId}</Id>
                {entity.aliases.length > 0 && (
                  <Muted>
                    also {entity.aliases.map((alias) => alias.alias).join(", ")}
                  </Muted>
                )}
              </span>
            </Td>
            <Td>
              <EntityTypeBadge entityType={entity.entityType} />
            </Td>
            <Td className="text-xs text-muted">
              {entity.countryName ?? <NotSet />}
            </Td>
            <Td className="text-xs tabular-nums text-muted">{entity.caseCount}</Td>
            <Td className="text-right">
              {entity.openMatchFlags > 0 ? (
                <Badge tone="warn">
                  <AlertTriangle className="size-3" aria-hidden="true" />
                  {entity.openMatchFlags} to decide
                </Badge>
              ) : entity.resolutionStatus === "merged" ? (
                <Badge tone="neutral">
                  <Merge className="size-3" aria-hidden="true" />
                  Merged
                </Badge>
              ) : (
                <Muted>{RESOLUTION_STATUS_LABELS[entity.resolutionStatus]}</Muted>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function AliasList({ entity }: { entity: Entity }) {
  if (entity.aliases.length === 0) {
    return (
      <Muted>
        No other names recorded. An alias is what makes a search for the name
        somebody actually used find this record.
      </Muted>
    );
  }

  return (
    <ul className="space-y-1.5">
      {entity.aliases.map((alias) => (
        <li key={alias.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-body">{alias.alias}</span>
          <Muted>{alias.aliasType.replace(/_/g, " ")}</Muted>
          {alias.sourceNote && (
            <span className="text-[11px] text-faint">{alias.sourceNote}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The relationships around one subject, in both directions.
 *
 * Direction is kept because "A is a director of B" and "B is a director of A"
 * are different statements, and an arrow is the clearest way to say which.
 * Each one carries what it rests on: a relationship citing nothing is a
 * rumour, and the screen says so rather than hiding it.
 */
export function RelationshipList({
  entityId,
  relationships,
}: {
  entityId: string;
  relationships: Relationship[];
}) {
  if (relationships.length === 0) {
    return (
      <EmptyState
        title="No relationships recorded"
        description="Directorships, holdings and associations are what turn a list of names into an investigation."
      />
    );
  }

  return (
    <ul className="space-y-2">
      {relationships.map((relationship) => {
        const outward = relationship.fromEntityId === entityId;
        const other = outward
          ? {
              id: relationship.toEntityId,
              name: relationship.toEntityName,
              reference: relationship.toEntityReference,
            }
          : {
              id: relationship.fromEntityId,
              name: relationship.fromEntityName,
              reference: relationship.fromEntityReference,
            };

        return (
          <li key={relationship.id} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {outward ? (
                <>
                  <span className="font-medium text-body">
                    {RELATIONSHIP_TYPE_LABELS[relationship.relationshipType]}
                  </span>
                  <ArrowRight className="size-3 text-faint" aria-hidden="true" />
                </>
              ) : (
                <Muted>is the subject of</Muted>
              )}
              <AppLink
                href={`/entities/${other.id}`}
                className="font-medium text-signal-dark hover:underline"
              >
                {other.name}
              </AppLink>
              <Id>{other.reference}</Id>
              {!outward && (
                <Muted>
                  ({RELATIONSHIP_TYPE_LABELS[relationship.relationshipType]})
                </Muted>
              )}
              {relationship.percentage !== null && (
                <Badge tone="info">{relationship.percentage}%</Badge>
              )}
              <span className="ml-auto">
                <ConfidenceBadge confidence={relationship.confidence} />
              </span>
            </div>

            {relationship.description && (
              <p className="mt-1 text-[11px] text-muted">
                {relationship.description}
              </p>
            )}

            <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-faint">
              {(relationship.heldFrom || relationship.heldTo) && (
                <span>
                  {relationship.heldFrom ? when(relationship.heldFrom) : "unknown"}
                  {" to "}
                  {relationship.heldTo ? when(relationship.heldTo) : "present"}
                </span>
              )}
              {relationship.sourceReference ? (
                <AppLink
                  href={`/sources/${relationship.sourceId}`}
                  className="inline-flex items-center gap-1 text-signal-dark hover:underline"
                >
                  <Link2 className="size-2.5" aria-hidden="true" />
                  {relationship.sourceReference}
                </AppLink>
              ) : relationship.evidenceReference ? (
                <AppLink
                  href={`/evidence/${relationship.evidenceItemId}`}
                  className="inline-flex items-center gap-1 text-signal-dark hover:underline"
                >
                  <Link2 className="size-2.5" aria-hidden="true" />
                  {relationship.evidenceReference}
                </AppLink>
              ) : (
                <span className="text-warn">Nothing cited for this yet</span>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Records that might be the same thing (PRD 8.4).
 *
 * Shown to whoever opens the record, because a duplicate nobody looked for is
 * a duplicate. Never merged automatically, and the wording is deliberately
 * "might be": the platform has found a similarity, not made a decision.
 */
export function MatchFlagList({
  entityId,
  flags,
}: {
  entityId: string;
  flags: MatchFlag[];
}) {
  if (flags.length === 0) {
    return <Muted>Nothing flagged against this record.</Muted>;
  }

  return (
    <ul className="space-y-2">
      {flags.map((flag) => {
        const other =
          flag.entityAId === entityId
            ? { id: flag.entityBId, name: flag.entityBName, reference: flag.entityBReference }
            : { id: flag.entityAId, name: flag.entityAName, reference: flag.entityAReference };

        return (
          <li
            key={flag.id}
            className={`rounded-lg border p-3 ${
              flag.status === "open" ? "border-warn/40 bg-warn/5" : "border-line"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={flag.status === "open" ? "warn" : "neutral"}>
                {MATCH_FLAG_TYPE_LABELS[flag.flagType]}
              </Badge>
              <AppLink
                href={`/entities/${other.id}`}
                className="font-medium text-signal-dark hover:underline"
              >
                {other.name}
              </AppLink>
              <Id>{other.reference}</Id>
              {flag.similarityScore !== null && (
                <Muted>{Math.round(flag.similarityScore * 100)}% alike</Muted>
              )}
              <span className="ml-auto text-[11px] text-muted">
                {MATCH_FLAG_STATUS_LABELS[flag.status]}
              </span>
            </div>

            {flag.notes && (
              <p className="mt-1 text-[11px] text-muted">{flag.notes}</p>
            )}

            {flag.decisionReason && (
              <p className="mt-1 text-[11px] text-faint">
                {flag.decidedByName ?? "Somebody"} on{" "}
                {flag.decidedAt ? when(flag.decidedAt) : "an unknown date"}:{" "}
                {flag.decisionReason}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function MergeHistory({ merges }: { merges: EntityMerge[] }) {
  if (merges.length === 0) {
    return <Muted>This record has never been merged.</Muted>;
  }

  return (
    <ul className="space-y-2">
      {merges.map((merge) => (
        <li key={merge.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Id>{merge.mergedEntityReference}</Id>
            <ArrowRight className="size-3 text-faint" aria-hidden="true" />
            <Id>{merge.survivingEntityReference}</Id>
            {merge.reversedAt ? (
              <Badge tone="warn">Reversed</Badge>
            ) : (
              <Badge tone="info">
                <Merge className="size-3" aria-hidden="true" />
                In force
              </Badge>
            )}
            <span className="ml-auto text-[11px] text-muted">
              {when(merge.mergedAt)}
              {merge.mergedByName ? ` by ${merge.mergedByName}` : ""}
            </span>
          </div>

          <p className="mt-1 text-[11px] text-muted">{merge.reason}</p>

          <p className="mt-1 text-[11px] text-faint">
            Moved:{" "}
            {[
              merge.moved.caseSubjects
                ? `${merge.moved.caseSubjects} case subject${merge.moved.caseSubjects === 1 ? "" : "s"}`
                : null,
              merge.moved.aliases ? `${merge.moved.aliases} alias` : null,
              (merge.moved.relationshipsFrom ?? 0) + (merge.moved.relationshipsTo ?? 0)
                ? `${(merge.moved.relationshipsFrom ?? 0) + (merge.moved.relationshipsTo ?? 0)} relationships`
                : null,
              merge.moved.information
                ? `${merge.moved.information} pieces of information`
                : null,
            ]
              .filter(Boolean)
              .join(", ") || "nothing"}
            . Nothing was deleted.
          </p>

          {merge.reversalReason && (
            <p className="mt-1 text-[11px] text-warn">
              Reversed by {merge.reversedByName ?? "somebody"}:{" "}
              {merge.reversalReason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SubjectList({ subjects }: { subjects: CaseSubject[] }) {
  if (subjects.length === 0) {
    return (
      <EmptyState
        title="No subjects on this case"
        description="A case with no subject is a case with nobody to investigate."
      />
    );
  }

  return (
    <ul className="space-y-2">
      {subjects.map((subject) => (
        <li key={subject.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <AppLink
              href={`/entities/${subject.entityId}`}
              className="font-medium text-body hover:text-signal-dark hover:underline"
            >
              {subject.entityName}
            </AppLink>
            <Id>{subject.entityReference}</Id>
            <EntityTypeBadge entityType={subject.entityType} />
            <Badge
              tone={subject.subjectRole === "primary_subject" ? "info" : "neutral"}
            >
              {SUBJECT_ROLE_LABELS[subject.subjectRole]}
            </Badge>
            {subject.removedAt && <Badge tone="warn">Taken off the case</Badge>}
          </div>

          {subject.relationshipToCase && (
            <p className="mt-1 text-[11px] text-muted">
              {subject.relationshipToCase}
            </p>
          )}

          {subject.removalReason && (
            <p className="mt-1 text-[11px] text-warn">
              Taken off on {when(subject.removedAt!)}: {subject.removalReason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------- sources, information */

export function SourceTable({
  sources,
  showCase = true,
}: {
  sources: Source[];
  showCase?: boolean;
}) {
  if (sources.length === 0) {
    return (
      <EmptyState
        title="No sources match those filters"
        description="A source is a particular acquisition of material: a search of the registry on a day, by a person."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Source</Th>
          {showCase && <Th>Case</Th>}
          <Th>Kind</Th>
          <Th>Reliability</Th>
          <Th>Information</Th>
          <Th className="text-right">Obtained</Th>
        </tr>
      </thead>
      <tbody>
        {sources.map((source) => (
          <tr key={source.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/sources/${source.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {source.description.length > 90
                  ? `${source.description.slice(0, 90)}...`
                  : source.description}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{source.sourceId}</Id>
                {source.identityRestricted && (
                  <Badge tone="warn">Identity protected</Badge>
                )}
              </span>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${source.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {source.caseReference}
                </AppLink>
              </Td>
            )}
            <Td className="text-xs text-muted">
              {SOURCE_TYPE_LABELS[source.sourceType]}
            </Td>
            <Td>
              <ReliabilityBadge reliability={source.sourceReliability} />
            </Td>
            <Td className="text-xs tabular-nums text-muted">
              {source.informationCount}
            </Td>
            <Td className="text-right text-xs whitespace-nowrap text-muted">
              {when(source.dateObtained)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The information register.
 *
 * Both ratings on every row, never combined. This is the table where the
 * distinction PRD 6.4 draws is most visible: a column of reliable sources
 * next to a column of unverified statements is an honest picture of where an
 * investigation stands.
 */
export function InformationTable({
  information,
  showCase = true,
}: {
  information: Information[];
  showCase?: boolean;
}) {
  if (information.length === 0) {
    return (
      <EmptyState
        title="No information matches those filters"
        description="A piece of information is something a source said, rated separately from the source itself."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Information</Th>
          {showCase && <Th>Case</Th>}
          <Th>Source</Th>
          <Th>Ratings</Th>
          <Th className="text-right">Borne out by</Th>
        </tr>
      </thead>
      <tbody>
        {information.map((piece) => (
          <tr key={piece.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/information/${piece.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {piece.description.length > 110
                  ? `${piece.description.slice(0, 110)}...`
                  : piece.description}
              </AppLink>
              <Id>{piece.informationId}</Id>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${piece.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {piece.caseReference}
                </AppLink>
              </Td>
            )}
            <Td className="text-xs">
              <AppLink
                href={`/sources/${piece.sourceId}`}
                className="text-signal-dark hover:underline"
              >
                <Id>{piece.sourceReference}</Id>
              </AppLink>
              <p className="text-[11px] text-faint">
                {SOURCE_TYPE_LABELS[piece.sourceType]}
              </p>
            </Td>
            <Td>
              <div className="flex flex-col items-start gap-1">
                <CredibilityBadge credibility={piece.informationCredibility} />
                <ReliabilityBadge reliability={piece.sourceReliability} />
              </div>
            </Td>
            <Td className="text-right text-xs whitespace-nowrap">
              {piece.corroborationCount + piece.evidenceCount === 0 ? (
                <Badge tone="warn">Nothing yet</Badge>
              ) : (
                <Muted>
                  {piece.corroborationCount} source
                  {piece.corroborationCount === 1 ? "" : "s"},{" "}
                  {piece.evidenceCount} exhibit
                  {piece.evidenceCount === 1 ? "" : "s"}
                </Muted>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ------------------------------------------------------------- findings */

/**
 * The traceability strip (PRD 23, screen 17).
 *
 * The platform's purpose, in one row of chips: Source, Information,
 * Evidence, and what else the finding names. Every hop is a link, and a
 * finding with nothing behind it says so in the plainest words available,
 * because that is the state somebody has to act on.
 */
export function TraceabilityStrip({ trace }: { trace: Traceability }) {
  if (trace.unsupported) {
    return (
      <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          Nothing supports this finding
        </p>
        <p className="mt-1 text-[11px] text-muted">
          Link the information or the evidence it rests on. A conclusion that
          cannot be traced back is one PDDC cannot defend if the report is
          challenged, and it cannot be put forward for review until it can.
        </p>
      </div>
    );
  }

  const ICONS = {
    source: Radio,
    information: Scale,
    evidence: FileSearch,
    document: FileText,
    entity: User,
  } as const;

  return (
    <nav
      aria-label={`What ${trace.findingReference} rests on`}
      className="no-scrollbar -mx-1 overflow-x-auto px-1"
    >
      <ol className="flex min-w-max items-center gap-1.5">
        {trace.hops.map((hop, index) => {
          const Icon = ICONS[hop.kind];
          return (
            <li key={`${hop.kind}-${hop.id}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <ArrowRight className="size-3 shrink-0 text-faint" aria-hidden="true" />
              )}
              <AppLink
                href={hop.href}
                className="group inline-flex max-w-56 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 transition-colors hover:border-signal/50 hover:bg-signal/5"
              >
                <Icon className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[10px] text-faint">
                    {hop.reference}
                  </span>
                  <span className="block truncate text-[11px] text-body group-hover:text-signal-dark">
                    {hop.label}
                  </span>
                </span>
                {hop.rating && (
                  <span className="shrink-0 text-[10px] text-muted">
                    {hop.rating.replace(/_/g, " ")}
                  </span>
                )}
              </AppLink>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * One finding, as a card (screen 17).
 *
 * The statement first, because that is what a reader came for, then its
 * confidence and status, then what it rests on. A card that put the links
 * first would read like a bibliography rather than a conclusion.
 */
export function FindingCard({
  finding,
  trace,
  children,
}: {
  finding: Finding;
  trace?: Traceability | null;
  children?: React.ReactNode;
}) {
  const supported = finding.links.some(
    (link) => link.linkType === "information" || link.linkType === "evidence",
  );

  return (
    <article
      className={`rounded-xl border p-4 ${
        finding.status === "accepted"
          ? "border-ok/35 bg-ok/5"
          : finding.status === "returned"
            ? "border-warn/40 bg-warn/5"
            : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AppLink
          href={`/findings/${finding.id}`}
          className="font-mono text-xs font-semibold text-signal-dark hover:underline"
        >
          {finding.findingId}
        </AppLink>
        <FindingStatusBadge status={finding.status} />
        <ConfidenceBadge confidence={finding.confidence} />
        {finding.status === "accepted" && (
          <Badge tone="ok">
            <CheckCircle2 className="size-3" aria-hidden="true" />
            Citable in a report
          </Badge>
        )}
        {!supported && <Badge tone="warn">Rests on nothing</Badge>}
      </div>

      <p className="mt-2 text-sm text-body">{finding.statement}</p>

      {finding.detail && (
        <p className="mt-1.5 text-xs whitespace-pre-line text-muted">
          {finding.detail}
        </p>
      )}

      <p className="mt-2 text-[11px] text-faint">
        {finding.analystName ?? "An analyst"} on {when(finding.findingDate)}
        {finding.reviewerName
          ? `, reviewed by ${finding.reviewerName} on ${
              finding.reviewedAt ? when(finding.reviewedAt) : ""
            }`
          : ""}
      </p>

      {finding.status === "returned" && finding.reviewNotes && (
        <p className="mt-2 rounded-lg border border-warn/40 bg-warn/5 p-2 text-[11px] text-body">
          Returned: {finding.reviewNotes}
        </p>
      )}

      {trace && (
        <div className="mt-3 border-t border-line pt-3">
          <TraceabilityStrip trace={trace} />
        </div>
      )}

      {children}
    </article>
  );
}
