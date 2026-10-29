"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Input, Select } from "@/components/ui";

/**
 * Filters for the audit trail, held in the URL so a filtered view is
 * shareable and the back button behaves (PRD 21.2).
 */
export function AuditFilters({ actions }: { actions: string[] }) {
  const router = useRouter();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `/admin/audit?${query}` : "/admin/audit");
  }

  const hasFilters = params.get("action") || params.get("from") || params.get("to");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-56">
        <label htmlFor="audit-action" className="sr-only">
          Action
        </label>
        <Select
          id="audit-action"
          value={params.get("action") ?? ""}
          onChange={(e) => setParam("action", e.target.value)}
        >
          <option value="">Any action</option>
          {actions.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-40">
        <label htmlFor="audit-from" className="mb-1 block text-[11px] text-muted">
          From
        </label>
        <Input
          id="audit-from"
          type="date"
          value={params.get("from") ?? ""}
          onChange={(e) => setParam("from", e.target.value)}
        />
      </div>

      <div className="w-40">
        <label htmlFor="audit-to" className="mb-1 block text-[11px] text-muted">
          To
        </label>
        <Input
          id="audit-to"
          type="date"
          value={params.get("to") ?? ""}
          onChange={(e) => setParam("to", e.target.value)}
        />
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={() => router.replace("/admin/audit")}
          className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-sunken hover:text-body"
        >
          <X className="size-3.5" aria-hidden="true" />
          Clear
        </button>
      )}
    </div>
  );
}
