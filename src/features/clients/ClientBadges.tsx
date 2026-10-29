import { CaseStatusTimeline } from "@/components/CaseStatusTimeline";
import { Badge } from "@/components/ui";
import {
  CLIENT_STATUS_LABELS,
  CONFLICT_STATUS_LABELS,
  ENGAGEMENT_STATUS_LABELS,
  ENQUIRY_STATUS_LABELS,
  KYC_STATUS_LABELS,
  RISK_RATING_LABELS,
  URGENCY_LABELS,
  type ClientStatus,
  type ConflictStatus,
  type EngagementStatus,
  type EnquiryStatus,
  type KycStatus,
  type RiskRating,
  type UrgencyLevel,
} from "@/modules/crm/shared";

/**
 * The CRM's status badges, in one file.
 *
 * Colour carries meaning here rather than decoration, and it is the same
 * meaning everywhere: amber is "somebody has to do something", red is "this
 * blocks the work", green is "settled". A conflict that has been declined and
 * KYC that has failed therefore look alike on purpose.
 *
 * Server components: they render text and a class, and need no interactivity.
 */

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "signal";

const CLIENT_TONES: Record<ClientStatus, Tone> = {
  prospect: "info",
  active: "ok",
  dormant: "neutral",
  suspended: "warn",
  closed: "neutral",
};

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return <Badge tone={CLIENT_TONES[status]}>{CLIENT_STATUS_LABELS[status]}</Badge>;
}

const KYC_TONES: Record<KycStatus, Tone> = {
  not_started: "neutral",
  in_progress: "warn",
  completed: "ok",
  failed: "danger",
  expired: "danger",
};

export function KycBadge({ status }: { status: KycStatus }) {
  return <Badge tone={KYC_TONES[status]}>KYC: {KYC_STATUS_LABELS[status]}</Badge>;
}

const RISK_TONES: Record<RiskRating, Tone> = {
  low: "ok",
  medium: "neutral",
  high: "warn",
  critical: "danger",
};

export function RiskBadge({ rating }: { rating: RiskRating }) {
  return <Badge tone={RISK_TONES[rating]}>{RISK_RATING_LABELS[rating]} risk</Badge>;
}

const ENGAGEMENT_TONES: Record<EngagementStatus, Tone> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  active: "ok",
  on_hold: "warn",
  completed: "neutral",
  cancelled: "neutral",
};

export function EngagementStatusBadge({ status }: { status: EngagementStatus }) {
  return (
    <Badge tone={ENGAGEMENT_TONES[status]}>{ENGAGEMENT_STATUS_LABELS[status]}</Badge>
  );
}

const ENQUIRY_TONES: Record<EnquiryStatus, Tone> = {
  new: "info",
  assessing: "warn",
  conflict_check: "warn",
  quoted: "signal",
  accepted: "ok",
  declined: "neutral",
  lapsed: "neutral",
};

export function EnquiryStatusBadge({ status }: { status: EnquiryStatus }) {
  return <Badge tone={ENQUIRY_TONES[status]}>{ENQUIRY_STATUS_LABELS[status]}</Badge>;
}

const URGENCY_TONES: Record<UrgencyLevel, Tone> = {
  low: "neutral",
  normal: "neutral",
  high: "warn",
  urgent: "danger",
};

export function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  // Low and normal are the common case, and a badge on every row for the
  // unremarkable would be noise.
  if (urgency === "low" || urgency === "normal") return null;
  return <Badge tone={URGENCY_TONES[urgency]}>{URGENCY_LABELS[urgency]}</Badge>;
}

const CONFLICT_TONES: Record<ConflictStatus, Tone> = {
  open: "warn",
  cleared: "ok",
  further_review: "warn",
  declined: "danger",
};

export function ConflictBadge({ status }: { status: ConflictStatus | null }) {
  if (status === null) {
    // The absence of a check is itself information, and the thing the approval
    // gate refuses on, so it is shown rather than left blank.
    return <Badge tone="warn">No conflict check</Badge>;
  }
  return <Badge tone={CONFLICT_TONES[status]}>{CONFLICT_STATUS_LABELS[status]}</Badge>;
}

/* ---------------------------------------------------------- progress rails */

/**
 * The intake pipeline as a rail (PRD 4.1, 23).
 *
 * Only the happy path is a progression. "Declined" and "Lapsed" are not later
 * stages of the same journey, so for those the rail is not rendered at all:
 * drawing a half-finished progress bar for an enquiry that is closed would
 * imply it is still moving. The page shows the decline reason instead.
 */
export const INTAKE_PIPELINE = [
  "New",
  "Being assessed",
  "Conflict check",
  "Quoted",
  "Accepted",
] as const;

export function IntakePipeline({ status }: { status: EnquiryStatus }) {
  if (status === "declined" || status === "lapsed") return null;
  return (
    <CaseStatusTimeline
      current={ENQUIRY_STATUS_LABELS[status]}
      stages={INTAKE_PIPELINE}
      label="Intake progress"
    />
  );
}

/**
 * The engagement progression as a rail.
 *
 * "On hold" and "Cancelled" are off the path for the same reason as above. An
 * engagement on hold shows its badge, not a rail that suggests it is still
 * advancing.
 */
export const ENGAGEMENT_PROGRESSION = [
  "Draft",
  "Pending approval",
  "Approved",
  "Active",
  "Completed",
] as const;

export function EngagementProgress({ status }: { status: EngagementStatus }) {
  if (status === "cancelled" || status === "on_hold") return null;
  return (
    <CaseStatusTimeline
      current={ENGAGEMENT_STATUS_LABELS[status]}
      stages={ENGAGEMENT_PROGRESSION}
      label="Engagement progress"
    />
  );
}
