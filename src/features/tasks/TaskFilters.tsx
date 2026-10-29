"use client";

import { UrlFilters, optionsFrom } from "@/components/UrlFilters";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
} from "@/modules/casework/shared";

/**
 * Filters for a task list, used both on the cross-case screen and inside a
 * case (where `basePath` is the case page and the case is already fixed).
 *
 * "Any status" means the open ones, because a list of work is about what is
 * still outstanding. Asking for the completed and cancelled ones is the
 * explicit choice, so it is an option rather than the default.
 */
export function TaskFilters({
  basePath = "/tasks",
  idPrefix = "task",
  people,
}: {
  basePath?: string;
  idPrefix?: string;
  people: Array<{ id: string; name: string }>;
}) {
  return (
    <UrlFilters
      basePath={basePath}
      idPrefix={idPrefix}
      searchLabel="Search tasks"
      searchPlaceholder="Title, task ID or detail"
      selects={[
        {
          param: "status",
          label: "Status",
          anyLabel: "Open tasks",
          width: "w-40",
          options: [
            ...optionsFrom(TASK_STATUSES, TASK_STATUS_LABELS),
            { value: "all", label: "Every status" },
          ],
        },
        {
          param: "priority",
          label: "Priority",
          anyLabel: "Any priority",
          width: "w-36",
          options: optionsFrom(CASE_PRIORITIES, CASE_PRIORITY_LABELS),
        },
        {
          param: "assignedTo",
          label: "Assignee",
          anyLabel: "Anybody",
          width: "w-48",
          options: people.map((person) => ({
            value: person.id,
            label: person.name,
          })),
        },
        {
          param: "sort",
          label: "Order",
          anyLabel: "Due date first",
          width: "w-40",
          options: [
            { value: "priority", label: "Priority first" },
            { value: "status", label: "Blocked first" },
            { value: "created", label: "Newest first" },
            { value: "title", label: "Title" },
          ],
        },
      ]}
    />
  );
}
