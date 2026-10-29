"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
  type CaseType,
  type WorkflowStage,
} from "@/modules/casework/shared";

/**
 * Which filters the case list offers.
 *
 * The stage and type options are passed in rather than imported, because both
 * are administrator-configurable: compiling them into the bundle would make
 * PRD 4.3's "without code changes" untrue for the one screen people use most.
 */
export function CaseFilters({
  stages,
  caseTypes,
}: {
  stages: WorkflowStage[];
  caseTypes: CaseType[];
}) {
  return (
    <UrlFilters
      basePath="/cases"
      idPrefix="case"
      searchLabel="Search cases"
      searchPlaceholder="Title, case ID or client"
      selects={[
        {
          param: "openness",
          label: "Open or closed",
          anyLabel: "Open cases",
          width: "w-36",
          options: [
            { value: "closed", label: "Closed cases" },
            { value: "all", label: "All cases" },
          ],
        },
        {
          param: "stageKey",
          label: "Stage",
          anyLabel: "Any stage",
          width: "w-48",
          options: stages.map((s) => ({ value: s.key, label: s.name })),
        },
        {
          param: "priority",
          label: "Priority",
          anyLabel: "Any priority",
          width: "w-36",
          options: optionsFrom(CASE_PRIORITIES, CASE_PRIORITY_LABELS),
        },
        {
          param: "riskLevel",
          label: "Risk",
          anyLabel: "Any risk",
          width: "w-32",
          options: optionsFrom(RISK_LEVELS, RISK_LEVEL_LABELS),
        },
        {
          param: "caseType",
          label: "Type",
          anyLabel: "Any type",
          width: "w-48",
          options: caseTypes.map((t) => ({ value: t.key, label: t.name })),
        },
      ]}
    />
  );
}
