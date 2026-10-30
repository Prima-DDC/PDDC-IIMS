import type { Metadata } from "next";
import { Suspense } from "react";
import { ButtonLink, PageHeader, TableSkeleton } from "@/components/ui";
import { getNotificationPreferences } from "@/features/notifications/queries";
import { NotificationPreferences } from "@/features/notifications/NotificationViews";

export const metadata: Metadata = { title: "Notification preferences" };

/** Per-category in-app and email choices (PRD 12.2). */
export default async function NotificationPreferencesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Notification preferences"
        description="Which notifications reach you, and where."
        actions={
          <ButtonLink href="/notifications" size="sm">
            Back to notifications
          </ButtonLink>
        }
      />

      <Suspense fallback={<TableSkeleton rows={6} />}>
        <Preferences />
      </Suspense>
    </div>
  );
}

async function Preferences() {
  const preferences = await getNotificationPreferences();
  return <NotificationPreferences preferences={preferences} />;
}
