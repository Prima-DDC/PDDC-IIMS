import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Alert, PageHeader, TableSkeleton } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getFieldView } from "@/features/safety/queries";
import { FieldMode } from "@/features/safety/FieldMode";

export const metadata: Metadata = { title: "Safety" };

/**
 * The field screen (PRD screen 25).
 *
 * Deliberately personal rather than administrative: it answers "where am I
 * expected, what are the hazards, and am I due to check in", for the person
 * looking at it. The case-wide view of who is out and what has happened is on
 * the case page, where a supervisor is already working.
 */
export default async function SafetyPage() {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "view"))) {
    forbidden();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Safety"
        description="Your cases, the hazards on them, and your check-ins. Built for a phone."
      />

      <Alert tone="info">
        Recording something here puts it on the case record. It does not ring
        anybody: if you are in trouble, telephone the emergency contact as well.
      </Alert>

      <Suspense fallback={<TableSkeleton rows={3} />}>
        <Field />
      </Suspense>
    </div>
  );
}

async function Field() {
  const view = await getFieldView();
  return (
    <FieldMode cases={view.cases} myOpenIncidents={view.myOpenIncidents} />
  );
}
