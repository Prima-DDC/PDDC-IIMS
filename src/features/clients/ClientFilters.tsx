"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  CLIENT_STATUS_LABELS,
  CLIENT_STATUSES,
  CLIENT_TYPE_LABELS,
  CLIENT_TYPES,
  KYC_STATUS_LABELS,
  KYC_STATUSES,
  RISK_RATING_LABELS,
  RISK_RATINGS,
} from "@/modules/crm/shared";

/** Which filters the client list offers. The machinery is in UrlFilters. */
export function ClientFilters({
  managers,
}: {
  managers: Array<{ id: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath="/clients"
      idPrefix="client"
      searchLabel="Search clients"
      searchPlaceholder="Organisation, client ID, contact or email"
      selects={[
        {
          param: "status",
          label: "Status",
          anyLabel: "Any status",
          width: "w-36",
          options: optionsFrom(CLIENT_STATUSES, CLIENT_STATUS_LABELS),
        },
        {
          param: "clientType",
          label: "Type",
          anyLabel: "Any type",
          width: "w-44",
          options: optionsFrom(CLIENT_TYPES, CLIENT_TYPE_LABELS),
        },
        {
          param: "kycStatus",
          label: "KYC",
          anyLabel: "Any KYC state",
          width: "w-36",
          options: optionsFrom(KYC_STATUSES, KYC_STATUS_LABELS),
        },
        {
          param: "riskRating",
          label: "Risk",
          anyLabel: "Any risk",
          width: "w-32",
          options: optionsFrom(RISK_RATINGS, RISK_RATING_LABELS),
        },
        {
          param: "accountManagerId",
          label: "Account manager",
          anyLabel: "Any manager",
          width: "w-44",
          options: managers.map((m) => ({ value: m.id, label: m.name })),
        },
      ]}
    />
  );
}
