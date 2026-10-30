import type { Metadata } from "next";
import { Suspense } from "react";
import { Search } from "lucide-react";
import { AppLink } from "@/components/AppLink";
import {
  Alert,
  Card,
  EmptyState,
  Id,
  Input,
  PageHeader,
  TableSkeleton,
} from "@/components/ui";
import { globalSearch } from "@/features/search/queries";

export const metadata: Metadata = { title: "Search" };

/**
 * Global search (PRD screen 4).
 *
 * A plain GET form rather than a live-filtering client component. Each
 * keystroke here is eleven permission-filtered queries across every schema,
 * so searching as somebody types would cost a hundred of them to answer one
 * question, and the answer would arrive while they were still deciding what
 * to ask. Enter is the right trigger for a search of this weight; the
 * command palette on Ctrl+K is the fast path to it.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Search"
        description="Cases, subjects, sources, information, findings, evidence, documents, reports, clients and engagements. You see only what you are authorised for."
      />

      <Card>
        <form action="/search" method="get" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            What are you looking for?
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={term}
            placeholder="A case number, a name, a registration number, a phrase"
            autoFocus
            className="flex-1"
          />
          <button
            type="submit"
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-signal px-3.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-signal-dark"
          >
            <Search className="size-4" aria-hidden="true" />
            Search
          </button>
        </form>
      </Card>

      {term.length === 0 ? (
        <EmptyState
          title="Nothing searched yet"
          description="Type at least two characters. Identifiers work as well as words: PDDC-2026-000014, EV-2026-000014-001 or F-001 will each find their record."
        />
      ) : (
        <Suspense key={term} fallback={<TableSkeleton rows={6} />}>
          <Results term={term} />
        </Suspense>
      )}
    </div>
  );
}

async function Results({ term }: { term: string }) {
  const result = await globalSearch(term);

  if (result.tooShort) {
    return (
      <Alert tone="info">
        Two characters at least. A single letter would match most of the
        platform and tell you nothing.
      </Alert>
    );
  }

  if (result.groups.length === 0) {
    return (
      <EmptyState
        title={`Nothing matches "${term}"`}
        description="Either there is no such record, or it is outside what you are authorised to see. Those look the same from here, deliberately: PRD 7.4 keeps the existence of a restricted record from being discoverable."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        {result.total} {result.total === 1 ? "match" : "matches"} across{" "}
        {result.groups.length}{" "}
        {result.groups.length === 1 ? "kind of record" : "kinds of record"}.
      </p>

      {result.groups.map((group) => (
        <Card
          key={group.key}
          title={group.label}
          description={
            group.total > group.hits.length
              ? `${group.hits.length} of ${group.total}`
              : `${group.total} ${group.total === 1 ? "match" : "matches"}`
          }
          actions={
            group.total > group.hits.length ? (
              <AppLink
                href={group.href}
                className="text-xs font-medium text-signal-dark hover:underline"
              >
                See all {group.total}
              </AppLink>
            ) : undefined
          }
        >
          <ul className="divide-y divide-line">
            {group.hits.map((hit) => (
              <li key={hit.id}>
                <AppLink
                  href={hit.href}
                  className="block py-2.5 transition-colors first:pt-0 last:pb-0 hover:text-signal"
                >
                  <span className="flex flex-wrap items-baseline gap-2">
                    {hit.reference && <Id>{hit.reference}</Id>}
                    <span className="text-sm font-medium text-body">
                      {hit.title}
                    </span>
                  </span>
                  {hit.meta && (
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {hit.meta}
                    </span>
                  )}
                </AppLink>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
