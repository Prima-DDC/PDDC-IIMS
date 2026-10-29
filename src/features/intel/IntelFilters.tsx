"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  FINDING_STATUSES,
  FINDING_STATUS_LABELS,
  INFORMATION_CREDIBILITIES,
  INFORMATION_CREDIBILITY_LABELS,
  RESOLUTION_STATUSES,
  RESOLUTION_STATUS_LABELS,
  SOURCE_RELIABILITIES,
  SOURCE_RELIABILITY_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
} from "@/modules/intel/shared";

/** Which filters each intelligence register offers (PRD screens 10, 14, 17). */

export function EntityFilters() {
  return (
    <UrlFilters
      basePath="/entities"
      idPrefix="entities"
      searchLabel="Search subjects"
      searchPlaceholder="Name, alias, identifier or registration number"
      selects={[
        {
          param: "entityType",
          label: "Type",
          anyLabel: "Any type",
          width: "w-44",
          options: optionsFrom(ENTITY_TYPES, ENTITY_TYPE_LABELS),
        },
        {
          param: "resolution",
          label: "Resolution",
          anyLabel: "Any state",
          width: "w-48",
          options: optionsFrom(RESOLUTION_STATUSES, RESOLUTION_STATUS_LABELS),
        },
        {
          param: "flagged",
          label: "Duplicates",
          anyLabel: "Flagged or not",
          width: "w-44",
          options: [{ value: "open", label: "Awaiting a decision" }],
        },
      ]}
    />
  );
}

export function SourceFilters() {
  return (
    <UrlFilters
      basePath="/sources"
      idPrefix="sources"
      searchLabel="Search sources"
      searchPlaceholder="Identifier or description"
      selects={[
        {
          param: "sourceType",
          label: "Kind",
          anyLabel: "Any kind",
          width: "w-48",
          options: optionsFrom(SOURCE_TYPES, SOURCE_TYPE_LABELS),
        },
        {
          param: "reliability",
          label: "Reliability",
          anyLabel: "Any reliability",
          width: "w-44",
          options: optionsFrom(SOURCE_RELIABILITIES, SOURCE_RELIABILITY_LABELS),
        },
      ]}
    />
  );
}

export function InformationFilters() {
  return (
    <UrlFilters
      basePath="/information"
      idPrefix="information"
      searchLabel="Search information"
      searchPlaceholder="Identifier or what the source said"
      selects={[
        {
          param: "credibility",
          label: "Credibility",
          anyLabel: "Any credibility",
          width: "w-44",
          options: optionsFrom(
            INFORMATION_CREDIBILITIES,
            INFORMATION_CREDIBILITY_LABELS,
          ),
        },
        {
          param: "corroboration",
          label: "Corroboration",
          anyLabel: "Borne out or not",
          width: "w-48",
          options: [{ value: "none", label: "Nothing bears it out" }],
        },
      ]}
    />
  );
}

export function FindingFilters() {
  return (
    <UrlFilters
      basePath="/findings"
      idPrefix="findings"
      searchLabel="Search findings"
      searchPlaceholder="Identifier or the statement"
      selects={[
        {
          param: "status",
          label: "Status",
          anyLabel: "Any status",
          width: "w-48",
          options: optionsFrom(FINDING_STATUSES, FINDING_STATUS_LABELS),
        },
      ]}
    />
  );
}
