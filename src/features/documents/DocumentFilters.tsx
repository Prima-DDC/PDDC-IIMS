"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
} from "@/modules/evidence/shared";

/** Which filters the document library offers (PRD 7.3). */
export function DocumentFilters({
  tags,
}: {
  tags: Array<{ key: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath="/documents"
      idPrefix="documents"
      searchLabel="Search documents"
      searchPlaceholder="Identifier, title or file name"
      selects={[
        {
          param: "documentType",
          label: "Kind",
          anyLabel: "Any kind",
          width: "w-48",
          options: optionsFrom(DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS),
        },
        {
          param: "tag",
          label: "Tag",
          anyLabel: "Any tag",
          width: "w-40",
          options: tags.map((tag) => ({ value: tag.key, label: tag.name })),
        },
        {
          param: "approval",
          label: "Approval",
          anyLabel: "Any state",
          width: "w-44",
          options: [{ value: "approved", label: "Approved only" }],
        },
      ]}
    />
  );
}
