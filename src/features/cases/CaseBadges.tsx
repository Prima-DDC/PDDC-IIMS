import { AlertTriangle, Clock } from "lucide-react";
import { CaseStatusTimeline } from "@/components/CaseStatusTimeline";
import { Badge } from "@/components/ui";
import {
  CASE_PRIORITY_LABELS,
  RISK_LEVEL_LABELS,
  type Case,
  type CasePriority,
  type RiskLevel,
  type WorkflowStage,
} from "@/modules/casework/shared";

/**
 * The casework badges.
 *
 * Colour means the same thing here as everywhere else in the platform: amber
 * is "somebody has to do something", red is "this blocks the work", green is
 * "settled". A critical risk and an overdue case therefore look alike, because
 * both are things a supervisor should look at today.
 */

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "signal";

const PRIORITY_TONES: Record<CasePriority, Tone> = {
  low: "neutral",
  medium: "neutral",
  high: "warn",
  urgent: "danger",
};

export function PriorityBadge({ priority }: { priority: CasePriority }) {
  // Low and medium are the common case, and a badge on every row for the
  // unremarkable is noise.
  if (priority === "low" || priority === "medium") return null;
  return <Badge tone={PRIORITY_TONES[priority]}>{CASE_PRIORITY_LABELS[priority]}</Badge>;
}

const RISK_TONES: Record<RiskLevel, Tone> = {
  low: "ok",
  medium: "neutral",
  high: "warn",
  critical: "danger",
};

export function RiskLevelBadge({ level }: { level: RiskLevel }) {
  return <Badge tone={RISK_TONES[level]}>{RISK_LEVEL_LABELS[level]} risk</Badge>;
}

/**
 * The lifecycle position.
 *
 * The tone comes from where the stage sits rather than from its key, because
 * the keys are administrator-configurable: a renamed or added stage still gets
 * a sensible colour.
 */
export function StageBadge({
  stageName,
  isTerminal,
  requiresApproval = false,
}: {
  stageName: string;
  isTerminal: boolean;
  requiresApproval?: boolean;
}) {
  const tone: Tone = isTerminal ? "neutral" : requiresApproval ? "warn" : "info";
  return <Badge tone={tone}>{stageName}</Badge>;
}

export function OverdueBadge({ record }: { record: Pick<Case, "isOverdue" | "daysToTarget"> }) {
  if (!record.isOverdue || record.daysToTarget === null) return null;
  const days = Math.abs(record.daysToTarget);
  return (
    <Badge tone="danger">
      <AlertTriangle className="size-3" aria-hidden="true" />
      {days} day{days === 1 ? "" : "s"} overdue
    </Badge>
  );
}

/** Shown when a target is approaching but has not passed. */
export function DueSoonBadge({
  record,
  withinDays = 7,
}: {
  record: Pick<Case, "isOverdue" | "daysToTarget" | "stageIsTerminal">;
  withinDays?: number;
}) {
  if (record.isOverdue || record.stageIsTerminal) return null;
  if (record.daysToTarget === null || record.daysToTarget > withinDays) return null;
  return (
    <Badge tone="warn">
      <Clock className="size-3" aria-hidden="true" />
      {record.daysToTarget === 0
        ? "Due today"
        : `Due in ${record.daysToTarget} day${record.daysToTarget === 1 ? "" : "s"}`}
    </Badge>
  );
}

/**
 * The case progress rail (PRD 23's signature element).
 *
 * The stages come from the configured lifecycle rather than from a constant,
 * which is the whole point of PRD 4.3: an administrator who adds a stage sees
 * it on the rail without a release.
 */
export function CaseProgress({
  stages,
  currentStageName,
}: {
  stages: WorkflowStage[];
  currentStageName: string;
}) {
  return (
    <CaseStatusTimeline
      current={currentStageName}
      stages={stages.map((s) => s.name)}
      label="Case progress"
    />
  );
}
