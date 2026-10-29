"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  ENQUIRY_STATUS_LABELS,
  ENQUIRY_STATUSES,
  URGENCY_LABELS,
  URGENCY_LEVELS,
} from "@/modules/crm/shared";

/** Which filters the enquiry list offers. The machinery is in UrlFilters. */
export function IntakeFilters({
  people,
}: {
  people: Array<{ id: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath="/intake"
      idPrefix="enquiry"
      searchLabel="Search enquiries"
      searchPlaceholder="Subject, enquiry ID, party or contact"
      selects={[
        {
          param: "status",
          label: "Stage",
          anyLabel: "Any stage",
          width: "w-40",
          options: optionsFrom(ENQUIRY_STATUSES, ENQUIRY_STATUS_LABELS),
        },
        {
          param: "urgency",
          label: "Urgency",
          anyLabel: "Any urgency",
          width: "w-36",
          options: optionsFrom(URGENCY_LEVELS, URGENCY_LABELS),
        },
        {
          param: "assignedTo",
          label: "Assigned to",
          anyLabel: "Anyone",
          width: "w-44",
          options: people.map((p) => ({ value: p.id, label: p.name })),
        },
      ]}
    />
  );
}
