import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { ShieldCheck, ShieldX } from "lucide-react";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Id,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";
import { AuditFilters } from "@/features/admin-audit/AuditFilters";

export const metadata: Metadata = { title: "Audit trail" };

interface Params {
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
}

/**
 * The audit trail (PRD 13, screen 22).
 *
 * Reads go through audit.read_audit_log, which is SECURITY DEFINER because
 * the application role has no SELECT on the table at all. That function checks
 * the audit permission itself and records the read in audit.access_log:
 * viewing the audit log is itself audited.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "audit", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit trail"
        description="Append-only and hash-chained. No role can edit or delete an entry; corrections are added as new ones."
        breadcrumb={[{ label: "Administration", href: "/admin" }, { label: "Audit trail" }]}
      />

      <Suspense fallback={<div className="skeleton h-20 w-full rounded-xl" />}>
        <ChainStatus />
      </Suspense>

      <Suspense fallback={<div className="skeleton h-9 w-full" />}>
        <Filters />
      </Suspense>

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton />}>
        <Entries params={params} />
      </Suspense>
    </div>
  );
}

async function ChainStatus() {
  const actor = await requireActor();
  const result = await iam(actor).audit.verifyChain();

  if (result.ok) {
    return (
      <Alert tone="ok" title="Chain verified">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {result.checked} entries recomputed, every hash matching the one
          before it. Tampering with any row would break the chain from that
          point on.
        </span>
      </Alert>
    );
  }

  return (
    <Alert tone="danger" title="Chain integrity FAILED">
      <span className="inline-flex items-center gap-1.5">
        <ShieldX className="size-3.5" aria-hidden="true" />
        The chain diverges at sequence {result.firstBadSeq}. An entry has been
        altered or removed outside the application. Treat the trail from that
        point as unreliable and escalate immediately.
      </span>
    </Alert>
  );
}

async function Filters() {
  const actor = await requireActor();
  const actions = await iam(actor).audit.distinctActions();
  return <AuditFilters actions={actions} />;
}

async function Entries({ params }: { params: Params }) {
  const actor = await requireActor();

  const entries = await iam(actor).audit.read({
    action: params.action ?? null,
    actorUserId: params.actor ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    limit: 200,
  });

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No entries match those filters"
        description="Widen the dates, or clear the action filter."
      />
    );
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>Action</Th>
            <Th>Record</Th>
            <Th>Reason</Th>
            <Th>Chain</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.auditId} className="align-top">
              <Td className="text-xs whitespace-nowrap text-muted">
                {new Date(entry.occurredAt).toLocaleString("en-GB")}
                <span className="font-id block text-[10.5px] text-faint">
                  seq {entry.seq}
                </span>
              </Td>

              <Td className="text-xs">
                {entry.actorEmail ? (
                  <Id>{entry.actorEmail}</Id>
                ) : (
                  <span className="text-faint">system</span>
                )}
                {entry.ip && (
                  <span className="font-id block text-[10.5px] text-faint">
                    {entry.ip}
                  </span>
                )}
              </Td>

              <Td>
                <Badge tone={toneFor(entry.action)}>{entry.action}</Badge>
              </Td>

              <Td className="text-xs text-muted">
                {entry.recordType && <Id>{entry.recordType}</Id>}
                {entry.recordId && (
                  <span className="font-id block max-w-48 truncate text-[10.5px] text-faint">
                    {entry.recordId}
                  </span>
                )}
              </Td>

              <Td className="max-w-64 text-xs text-muted">
                {entry.reason ?? <span className="text-faint">not given</span>}
              </Td>

              <Td>
                <span
                  className="font-id text-[10.5px] text-faint"
                  title={`row ${entry.rowHash}\nprev ${entry.prevHash}`}
                >
                  {entry.rowHash.slice(0, 8)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="mt-4 text-xs text-muted">
        Showing the most recent {entries.length} entries. Opening this page is
        itself recorded in the access log.
      </p>
    </Card>
  );
}

/** Security-relevant actions should stand out when scanning the list. */
function toneFor(action: string): "neutral" | "warn" | "danger" | "signal" {
  if (/removed|deleted|revoked|purge|reset/.test(action)) return "danger";
  if (/suspend|status_changed|override|incompatibility/.test(action)) return "warn";
  if (/created|provisioned|approved|restored/.test(action)) return "signal";
  return "neutral";
}

function TableSkeleton() {
  return (
    <div className="card space-y-2 rounded-xl p-5">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="skeleton h-9 w-full" />
      ))}
    </div>
  );
}
