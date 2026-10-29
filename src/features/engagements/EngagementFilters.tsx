"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  ENGAGEMENT_STATUS_LABELS,
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TYPE_LABELS,
  ENGAGEMENT_TYPES,
} from "@/modules/crm/shared";

/** Which filters the engagement list offers. */
export function EngagementFilters({
  clients,
  managers,
}: {
  clients: Array<{ id: string; name: string }>;
  managers: Array<{ id: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath="/engagements"
      idPrefix="engagement"
      searchLabel="Search engagements"
      searchPlaceholder="Title, engagement ID, client or contract reference"
      selects={[
        {
          param: "status",
          label: "Status",
          anyLabel: "Any status",
          width: "w-40",
          options: optionsFrom(ENGAGEMENT_STATUSES, ENGAGEMENT_STATUS_LABELS),
        },
        {
          param: "engagementType",
          label: "Type",
          anyLabel: "Any type",
          width: "w-48",
          options: optionsFrom(ENGAGEMENT_TYPES, ENGAGEMENT_TYPE_LABELS),
        },
        {
          param: "clientId",
          label: "Client",
          anyLabel: "Any client",
          width: "w-48",
          options: clients.map((c) => ({ value: c.id, label: c.name })),
        },
        {
          param: "responsibleManagerId",
          label: "Responsible manager",
          anyLabel: "Any manager",
          width: "w-44",
          options: managers.map((m) => ({ value: m.id, label: m.name })),
        },
      ]}
    />
  );
}
