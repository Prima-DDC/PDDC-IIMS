import { AppLink } from "@/components/AppLink";
import {
  ArrowRight,
  Check,
  Copy,
  FileWarning,
  Link2,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
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
  COPY_STATUS_LABELS,
  CUSTODY_EVENT_LABELS,
  EVIDENCE_STATUS_LABELS,
  EVIDENCE_TYPE_LABELS,
  INTEGRITY_STATUS_LABELS,
  type CustodyEvent,
  type EvidenceItem,
  type IntegrityStatus,
} from "@/modules/evidence/shared";

/**
 * Reading the evidence register (PRD 6).
 *
 * Server components: none of this needs state, so none of it goes into the
 * client bundle. The two things worth looking at closely are the seal and the
 * ledger, because they are what an investigator has to be able to trust.
 */

function when(value: string) {
  return new Date(value).toLocaleString("en-GB");
}

/**
 * The integrity seal.
 *
 * Four states, and the distinction between two of them is the point. A
 * declared hash means the browser computed one before the upload; a verified
 * hash means the server read the stored file back and got the same answer.
 * Showing both as "hashed" would be the lie that matters most here, so they
 * are different badges with different words.
 */
export function IntegritySeal({
  status,
  verifiedAt,
}: {
  status: IntegrityStatus;
  verifiedAt?: string | null;
}) {
  if (status === "no_file") {
    return <Muted>no file</Muted>;
  }

  if (status === "verified") {
    return (
      <Badge tone="ok">
        <ShieldCheck className="size-3" aria-hidden="true" />
        {INTEGRITY_STATUS_LABELS.verified}
        {verifiedAt ? ` ${new Date(verifiedAt).toLocaleDateString("en-GB")}` : ""}
      </Badge>
    );
  }

  if (status === "mismatch") {
    return (
      <Badge tone="danger">
        <ShieldAlert className="size-3" aria-hidden="true" />
        {INTEGRITY_STATUS_LABELS.mismatch}
      </Badge>
    );
  }

  return (
    <Badge tone="warn">
      <ShieldQuestion className="size-3" aria-hidden="true" />
      {INTEGRITY_STATUS_LABELS.hash_unverified}
    </Badge>
  );
}

export function EvidenceStatusBadge({ item }: { item: EvidenceItem }) {
  const tone =
    item.status === "released"
      ? "warn"
      : item.status === "archived"
        ? "neutral"
        : item.status === "returned"
          ? "info"
          : "neutral";
  return <Badge tone={tone}>{EVIDENCE_STATUS_LABELS[item.status]}</Badge>;
}

export function CopyStatusBadge({ item }: { item: EvidenceItem }) {
  if (item.copyStatus === "original") {
    return (
      <Badge tone="info">
        {COPY_STATUS_LABELS.original}
        {item.storagePath ? ", write-once" : ""}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Copy className="size-3" aria-hidden="true" />
      {COPY_STATUS_LABELS.working_copy}
    </Badge>
  );
}

/** The register, as a table. */
export function EvidenceTable({
  items,
  showCase = true,
}: {
  items: EvidenceItem[];
  showCase?: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No evidence matches those filters"
        description="Clear the filters, or register what has been collected."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Item</Th>
          {showCase && <Th>Case</Th>}
          <Th>Type</Th>
          <Th>Integrity</Th>
          <Th>Custodian</Th>
          <Th className="text-right">Collected</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/evidence/${item.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {item.description.length > 90
                  ? `${item.description.slice(0, 90)}...`
                  : item.description}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{item.evidenceId}</Id>
                {item.exhibitNo && <Badge tone="neutral">Exhibit {item.exhibitNo}</Badge>}
                <CopyStatusBadge item={item} />
                <EvidenceStatusBadge item={item} />
              </span>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${item.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {item.caseReference}
                </AppLink>
              </Td>
            )}
            <Td className="text-xs text-muted">
              {EVIDENCE_TYPE_LABELS[item.evidenceType]}
              {item.fileName && (
                <p className="max-w-48 truncate text-[11px] text-faint">
                  {item.fileName}
                </p>
              )}
            </Td>
            <Td>
              <IntegritySeal status={item.integrityStatus} verifiedAt={item.verifiedAt} />
            </Td>
            <Td className="text-xs text-muted">
              {item.currentCustodianName ?? <Muted>unassigned</Muted>}
            </Td>
            <Td className="text-right text-xs whitespace-nowrap text-muted">
              {new Date(item.collectedAt).toLocaleDateString("en-GB")}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The chain of custody, as a ledger.
 *
 * Oldest first, because a chain is read forwards from collection. Each entry
 * carries the hash that links it to the one before, which is what lets the
 * chain be shown to be unbroken rather than asserted to be. A corrected entry
 * stays visible with the correction beside it: PRD 6.2 allows no other way to
 * put something right.
 */
export function CustodyLedger({
  events,
  chain,
}: {
  events: CustodyEvent[];
  chain: { events: number; intact: boolean; brokeAt: string | null };
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No custody events"
        description="Every item gets one when it is registered, so this should not be empty."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {chain.intact ? (
          <Badge tone="ok">
            <Check className="size-3" aria-hidden="true" />
            Chain intact across {chain.events}{" "}
            {chain.events === 1 ? "entry" : "entries"}
          </Badge>
        ) : (
          <Badge tone="danger">
            <FileWarning className="size-3" aria-hidden="true" />
            Chain broken at entry {chain.brokeAt}
          </Badge>
        )}
        <Muted>
          Each entry is hashed with the one before it, so a change anywhere
          shows up here.
        </Muted>
      </div>

      <ol className="space-y-0">
        {events.map((event, index) => (
          <li
            key={event.id}
            className={`relative border-l-2 pl-4 pb-4 ${
              event.correctedByEventId !== null
                ? "border-line"
                : event.correctsEventId !== null
                  ? "border-warn/60"
                  : "border-signal/40"
            } ${index === events.length - 1 ? "pb-0" : ""}`}
          >
            <span
              className={`absolute -left-[5px] top-1.5 size-2 rounded-full ${
                event.correctedByEventId !== null ? "bg-line-strong" : "bg-signal"
              }`}
              aria-hidden="true"
            />

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-xs font-semibold ${
                  event.correctedByEventId !== null
                    ? "text-muted line-through decoration-1"
                    : "text-body"
                }`}
              >
                {CUSTODY_EVENT_LABELS[event.eventType]}
              </span>
              {event.correctsEventId !== null && (
                <Badge tone="warn">Corrects an earlier entry</Badge>
              )}
              {event.correctedByEventId !== null && (
                <Badge tone="info">Superseded by a later entry</Badge>
              )}
              <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                {when(event.occurredAt)}
              </span>
            </div>

            <p className="mt-1 text-xs text-body">{event.purpose}</p>

            {(event.releasedByName || event.receivedByName) && (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {event.releasedByName ?? "nobody"}
                <ArrowRight className="size-3" aria-hidden="true" />
                {event.receivedByName ?? "nobody"}
              </p>
            )}

            {event.correctionReason && (
              <p className="mt-1 text-[11px] text-warn">
                Correction: {event.correctionReason}
              </p>
            )}

            <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-faint">
              {event.location && <span>At {event.location}</span>}
              {event.condition && <span>Condition: {event.condition}</span>}
              {event.confirmation && <span>Confirmed: {event.confirmation}</span>}
              <span>
                Recorded {when(event.recordedAt)}
                {event.recordedByName ? ` by ${event.recordedByName}` : ""}
              </span>
            </p>

            <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-faint">
              <Link2 className="size-2.5" aria-hidden="true" />
              {event.rowHash.slice(0, 16)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What the server found when it last read the file back (PRD 6.3). */
export function IntegrityHistory({
  checks,
}: {
  checks: Array<{
    id: string;
    checkedAt: string;
    expectedSha256: string;
    actualSha256: string | null;
    result: "match" | "mismatch" | "unreadable";
    checkedByName: string | null;
    notes: string | null;
  }>;
}) {
  if (checks.length === 0) {
    return (
      <EmptyState
        title="Not verified yet"
        description="The file has a hash declared by the browser. Verification reads the stored file back and computes the server's own."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {checks.map((check) => (
        <li key={check.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            {check.result === "match" ? (
              <Badge tone="ok">Matched</Badge>
            ) : check.result === "mismatch" ? (
              <Badge tone="danger">Did not match</Badge>
            ) : (
              <Badge tone="warn">Could not be read</Badge>
            )}
            <span className="ml-auto text-[11px] text-muted">
              {when(check.checkedAt)}
              {check.checkedByName ? ` by ${check.checkedByName}` : ", scheduled"}
            </span>
          </div>

          <dl className="mt-2 space-y-1 font-mono text-[10px] text-faint">
            <div>
              <dt className="inline">expected </dt>
              <dd className="inline">{check.expectedSha256}</dd>
            </div>
            <div>
              <dt className="inline">actual&nbsp;&nbsp; </dt>
              <dd className="inline">{check.actualSha256 ?? <NotSet />}</dd>
            </div>
          </dl>

          {check.notes && (
            <p className="mt-1.5 text-[11px] text-muted">{check.notes}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
