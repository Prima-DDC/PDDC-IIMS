"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
} from "@/modules/reporting/shared";

/** Which filters the report register offers (PRD 10, screen 18). */
export function ReportFilters() {
  return (
    <UrlFilters
      basePath="/reports"
      idPrefix="reports"
      searchLabel="Search reports"
      searchPlaceholder="Identifier or title"
      selects={[
        {
          param: "status",
          label: "Where it is",
          anyLabel: "Any stage",
          width: "w-48",
          options: optionsFrom(REPORT_STATUSES, REPORT_STATUS_LABELS),
        },
        {
          param: "queue",
          label: "Waiting on",
          anyLabel: "Anybody",
          width: "w-44",
          options: [{ value: "mine", label: "Somebody other than the author" }],
        },
      ]}
    />
  );
}
