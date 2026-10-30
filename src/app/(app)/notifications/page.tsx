import type { Metadata } from "next";
import { Suspense } from "react";
import { ButtonLink, PageHeader, TableSkeleton } from "@/components/ui";
import {
  getNotificationFeed,
  getNotificationPreferences,
} from "@/features/notifications/queries";
import { NotificationFeed } from "@/features/notifications/NotificationViews";

export const metadata: Metadata = { title: "Notifications" };

/**
 * The in-app feed (PRD 12, screen 23).
 *
 * No permission gate. A notification is addressed to one person, the policy
 * on `notify.notifications` admits only its recipient, and requiring a
 * permission to read your own feed would mean somebody could be told
 * something and then not allowed to see it.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; unread?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const unreadOnly = params.unread === "1";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description="Assignments, deadlines, reviews and alerts. Everything here points at the record it is about."
        actions={
          <ButtonLink href="/notifications/preferences" size="sm">
            Preferences
          </ButtonLink>
        }
      />

      <Suspense key={`${page}:${unreadOnly}`} fallback={<TableSkeleton rows={5} />}>
        <Feed page={page} unreadOnly={unreadOnly} />
      </Suspense>
    </div>
  );
}

async function Feed({ page, unreadOnly }: { page: number; unreadOnly: boolean }) {
  // The catalogue comes from the same place the preferences screen reads, so
  // a label shown on a notification and a label shown next to its switch are
  // one string rather than two that have to be kept in step.
  const [feed, catalogue] = await Promise.all([
    getNotificationFeed({ page, unreadOnly }),
    getNotificationPreferences(),
  ]);

  const labels = Object.fromEntries(
    catalogue.map((entry) => [entry.category, entry.label]),
  );

  return (
    <NotificationFeed
      notifications={feed.notifications}
      labels={labels}
      total={feed.total}
      page={feed.page}
      pageCount={feed.pageCount}
      unread={feed.unread}
      unreadOnly={feed.unreadOnly}
    />
  );
}
