import { AppLink } from "@/components/AppLink";
import { ChevronRight } from "lucide-react";

/**
 * Source -> Information -> Evidence -> Finding.
 *
 * The PRD's central promise is that every conclusion resolves to the evidence
 * behind it in one click (§20.2 "Traceability"). This strip renders that chain
 * inline on every finding, with each hop a link.
 *
 * It is also an honesty device: a missing hop renders as a visible gap
 * labelled "not linked", so an unsupported finding looks unsupported rather
 * than merely looking finished.
 */
export interface TraceHop {
  kind: "source" | "information" | "evidence" | "finding";
  id: string;
  label: string;
  href?: string;
  /** Source reliability or information credibility, where it applies. */
  rating?: string;
}

const KIND_LABEL: Record<TraceHop["kind"], string> = {
  source: "Source",
  information: "Information",
  evidence: "Evidence",
  finding: "Finding",
};

const ORDER: ReadonlyArray<TraceHop["kind"]> = [
  "source",
  "information",
  "evidence",
  "finding",
];

export function TraceabilityStrip({
  hops,
  className = "",
}: {
  hops: TraceHop[];
  className?: string;
}) {
  const byKind = new Map(hops.map((h) => [h.kind, h]));

  return (
    <nav
      aria-label="Traceability chain"
      className={`no-scrollbar flex items-stretch gap-1 overflow-x-auto ${className}`}
    >
      {ORDER.map((kind, index) => {
        const hop = byKind.get(kind);

        return (
          <div key={kind} className="flex shrink-0 items-center gap-1">
            {index > 0 && (
              <ChevronRight
                className="size-3.5 shrink-0 text-faint"
                aria-hidden="true"
              />
            )}

            {hop ? (
              <HopChip hop={hop} />
            ) : (
              <span
                className="rounded-md border border-dashed border-line-strong px-2.5 py-1.5 text-[11px] text-faint italic"
                title={`No ${KIND_LABEL[kind].toLowerCase()} is linked to this finding.`}
              >
                {KIND_LABEL[kind]} not linked
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function HopChip({ hop }: { hop: TraceHop }) {
  const body = (
    <>
      <span className="text-[9.5px] font-semibold tracking-[0.12em] text-faint uppercase">
        {KIND_LABEL[hop.kind]}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-id text-[11px] font-semibold text-signal-dark">
          {hop.id}
        </span>
        <span className="max-w-36 truncate text-[11px] text-body">{hop.label}</span>
      </span>
      {hop.rating && (
        <span className="text-[10px] text-muted">{hop.rating}</span>
      )}
    </>
  );

  const shell =
    "flex flex-col gap-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5 transition-colors";

  return hop.href ? (
    <AppLink href={hop.href} className={`${shell} hover:border-signal/50 hover:bg-signal/5`}>
      {body}
    </AppLink>
  ) : (
    <div className={shell}>{body}</div>
  );
}
