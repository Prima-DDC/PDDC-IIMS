"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { Search, X } from "lucide-react";
import { Input, Select } from "./ui";

/**
 * A search box and a row of dropdowns that keep their state in the URL.
 *
 * Filter state lives in the URL so a filtered view is shareable and the back
 * button works (PRD 21.2 "URL state"). Search is debounced at 300ms with the
 * previous navigation superseded, as PRD 21.6 requires.
 *
 * Generic because every list in the platform needs exactly this, and the
 * fiddly parts are the parts worth having once: the uncontrolled keyed input,
 * resetting the page on a filter change, and clearing everything.
 */

export interface FilterSelect {
  /** The query-string key this dropdown drives. */
  param: string;
  /** Accessible label. It is visually hidden, like the search box's. */
  label: string;
  /** The "no filter" option, for example "Any status". */
  anyLabel: string;
  options: Array<{ value: string; label: string }>;
  /** Tailwind width class. Defaults to a comfortable 10rem. */
  width?: string;
}

export function UrlFilters({
  basePath,
  searchLabel,
  searchPlaceholder,
  selects = [],
  idPrefix,
}: {
  /** Where to navigate, for example "/clients". */
  basePath: string;
  searchLabel: string;
  searchPlaceholder: string;
  selects?: FilterSelect[];
  /** Prefixes the control ids, so two filter bars can coexist on a page. */
  idPrefix: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The URL is the single source of truth for the search term, so the input is
  // uncontrolled and keyed on that value. Keying it means a change from
  // elsewhere, such as the clear button or the back button, remounts the field
  // with the new value, with no effect needed to sync it.
  const urlSearch = params.get("search") ?? "";

  function push(next: URLSearchParams) {
    next.delete("page"); // any filter change returns to the first page
    const query = next.toString();
    router.replace(query ? `${basePath}?${query}` : basePath);
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    push(next);
  }

  function onSearchChange(value: string) {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("search", value.trim()), 300);
  }

  const hasFilters =
    urlSearch !== "" || selects.some((s) => (params.get(s.param) ?? "") !== "");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <label htmlFor={`${idPrefix}-search`} className="sr-only">
          {searchLabel}
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            id={`${idPrefix}-search`}
            key={urlSearch}
            defaultValue={urlSearch}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
          />
        </div>
      </div>

      {selects
        .filter((select) => select.options.length > 0)
        .map((select) => (
          <div key={select.param} className={select.width ?? "w-40"}>
            <label htmlFor={`${idPrefix}-${select.param}`} className="sr-only">
              {select.label}
            </label>
            <Select
              id={`${idPrefix}-${select.param}`}
              value={params.get(select.param) ?? ""}
              onChange={(e) => setParam(select.param, e.target.value)}
            >
              <option value="">{select.anyLabel}</option>
              {select.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ))}

      {hasFilters && (
        <button
          type="button"
          onClick={() => router.replace(basePath)}
          className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-sunken hover:text-body"
        >
          <X className="size-3.5" aria-hidden="true" />
          Clear
        </button>
      )}
    </div>
  );
}

/** Turns a `{ value: label }` map into dropdown options, in the map's order. */
export function optionsFrom<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: labels[value] }));
}
