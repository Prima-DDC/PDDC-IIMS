import { Bell } from "lucide-react";
import { AppLink } from "@/components/AppLink";

/**
 * The bell in the top bar.
 *
 * A server component with no client bundle and no polling. Nothing in this
 * platform is cached, so every navigation re-renders the shell and the count
 * is as fresh as the page it sits on; a poller would add a request every few
 * seconds to tell somebody something they will see the moment they move.
 *
 * PRD 12.2 asks for an in-app notification within five seconds of the event.
 * That is the realtime channel's job and it is still to come; until then this
 * is honest rather than approximate, and the feed itself is the record.
 */
export function NotificationBell({ unread }: { unread: number }) {
  const label =
    unread === 0
      ? "Notifications"
      : `Notifications, ${unread} unread`;

  return (
    <AppLink
      href={unread > 0 ? "/notifications?unread=1" : "/notifications"}
      aria-label={label}
      title={label}
      className="relative grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-sunken hover:text-body"
    >
      <Bell className="size-4" aria-hidden="true" />

      {unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-signal px-1 text-[10px] leading-4 font-semibold text-white"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </AppLink>
  );
}
