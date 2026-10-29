"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  COPY_STATUSES,
  COPY_STATUS_LABELS,
  EVIDENCE_STATUSES,
  EVIDENCE_STATUS_LABELS,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
} from "@/modules/evidence/shared";

/** Which filters the evidence register offers (PRD 6.1). */
export function EvidenceFilters() {
  return (
    <UrlFilters
      basePath="/evidence"
      idPrefix="evidence"
      searchLabel="Search evidence"
      searchPlaceholder="Identifier, exhibit number, description or file name"
      selects={[
        {
          param: "evidenceType",
          label: "Type",
          anyLabel: "Any type",
          width: "w-48",
          options: optionsFrom(EVIDENCE_TYPES, EVIDENCE_TYPE_LABELS),
        },
        {
          param: "status",
          label: "Status",
          anyLabel: "Any status",
          width: "w-40",
          options: optionsFrom(EVIDENCE_STATUSES, EVIDENCE_STATUS_LABELS),
        },
        {
          param: "copyStatus",
          label: "Original or copy",
          anyLabel: "Originals and copies",
          width: "w-44",
          options: optionsFrom(COPY_STATUSES, COPY_STATUS_LABELS),
        },
        {
          param: "integrity",
          label: "Integrity",
          anyLabel: "Any integrity state",
          width: "w-48",
          options: [
            {
              value: "concerns",
              label: "Unverified or mismatched",
            },
          ],
        },
      ]}
    />
  );
}
