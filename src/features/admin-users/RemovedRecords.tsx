import { AppLink } from "@/components/AppLink";
import type { ReactNode } from "react";
import { Card, EmptyState, Id, Muted, Table, Td, Th } from "@/components/ui";

/**
 * One kind of removed record in the recycle bin (PRD 3.5, screen 29).
 *
 * Nine record types are soft-deletable and screen 29 requires all of them
 * here. Written once rather than nine times: the table was identical in every
 * case apart from the column headings, and nine copies of it is nine places
 * for the restore control to be forgotten.
 */

export interface RemovedRow {
  id: string;
  /** What the record is, as a reader would recognise it. */
  title: string;
  /** Its human identifier. */
  reference: string;
  /** The case or client it belonged to, where it had one. */
  context?: string | null;
  /** Where the record itself can be opened, where it still can be. */
  href?: string;
  deletedAt: string | null;
  /** The restore control, which each feature provides for its own type. */
  restore?: ReactNode;
}

export function RemovedRecords({
  title,
  description,
  emptyTitle,
  emptyDescription,
  nameHeading = "Record",
  referenceHeading = "Identifier",
  contextHeading,
  rows,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  nameHeading?: string;
  referenceHeading?: string;
  contextHeading?: string;
  rows: RemovedRow[];
}) {
  return (
    <Card title={`${title} (${rows.length})`} description={description}>
      {rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{nameHeading}</Th>
              <Th>{referenceHeading}</Th>
              {contextHeading && <Th>{contextHeading}</Th>}
              <Th>Removed</Th>
              <Th className="text-right">Restore</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td className="font-medium text-body">
                  {row.href ? (
                    <AppLink
                      href={row.href}
                      className="hover:text-signal-dark hover:underline"
                    >
                      {row.title}
                    </AppLink>
                  ) : (
                    row.title
                  )}
                </Td>
                <Td>
                  <Id>{row.reference}</Id>
                </Td>
                {contextHeading && (
                  <Td className="text-xs text-muted">
                    {row.context ?? <Muted>none</Muted>}
                  </Td>
                )}
                <Td className="text-xs whitespace-nowrap text-muted">
                  {row.deletedAt
                    ? new Date(row.deletedAt).toLocaleString("en-GB")
                    : "unknown"}
                </Td>
                <Td>
                  <div className="flex justify-end">{row.restore}</div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
