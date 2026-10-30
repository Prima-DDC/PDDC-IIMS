import "server-only";
import { requireActor, type Actor } from "@/lib/auth/session";
import { notify } from "@/modules/notify";

/**
 * Read models for the feed and the preferences screen (PRD 12, screen 23).
 *
 * There is no permission check in this file, and that is correct rather than
 * an omission: a notification is addressed to one person, the row-level
 * policy admits only its recipient, and asking for a permission on top would
 * mean an employee could be sent something and then not allowed to read it.
 */

export async function getNotificationFeed(filter: {
  page?: number;
  unreadOnly?: boolean;
}) {
  const actor = await requireActor();
  const api = notify(actor);

  const pageSize = 25;
  const [feed, unread] = await Promise.all([
    api.feed({ ...filter, pageSize }),
    api.unreadCount(),
  ]);

  return {
    notifications: feed.rows,
    total: feed.total,
    page: filter.page ?? 1,
    pageCount: Math.max(1, Math.ceil(feed.total / pageSize)),
    unread,
    unreadOnly: filter.unreadOnly ?? false,
  };
}

export async function getNotificationPreferences() {
  const actor = await requireActor();
  return notify(actor).preferences();
}

/**
 * The number on the bell.
 *
 * Takes the actor rather than fetching one, because the only caller is the
 * application shell, which has already established it. Returns zero rather
 * than throwing if the count cannot be read: a failure here would take down
 * every page in the platform, and the bell is the least important thing on
 * any of them.
 */
export async function getUnreadNotificationCount(actor: Actor): Promise<number> {
  try {
    return await notify(actor).unreadCount();
  } catch (error) {
    console.error("[notify] unread count failed", error);
    return 0;
  }
}
