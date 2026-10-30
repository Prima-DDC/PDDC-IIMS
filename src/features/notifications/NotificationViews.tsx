import { AlertTriangle, Bell, CheckCheck, ShieldAlert } from "lucide-react";
import { AppLink } from "@/components/AppLink";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Muted,
  Pagination,
} from "@/components/ui";
import type {
  Notification,
  NotificationCategory,
  NotificationPreference,
} from "@/modules/notify/shared";
import {
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreference,
} from "./actions";

/**
 * The feed and the preferences screen (PRD 12, screen 23).
 *
 * Server components throughout. A notification list is read far more often
 * than it is acted on, and the only interaction is a form post, so there is
 * nothing here a client bundle would make better.
 */

/** Categories that mean somebody has to act now rather than read later. */
const URGENT: readonly NotificationCategory[] = [
  "safety_check_in_missed",
  "integrity_failure",
  "security_alert",
];

function tone(category: NotificationCategory) {
  if (URGENT.includes(category)) return "danger" as const;
  if (category === "task_overdue" || category === "deadline_approaching") {
    return "warn" as const;
  }
  return "neutral" as const;
}

function when(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`;
  return new Date(iso).toLocaleDateString();
}

function NotificationRow({
  notification,
  label,
}: {
  notification: Notification;
  label: string;
}) {
  const unread = notification.readAt === null;
  const urgent = URGENT.includes(notification.category);

  return (
    <li
      className={`relative flex gap-3 rounded-lg border p-3.5 transition-colors sm:p-4 ${
        unread
          ? "border-line bg-surface shadow-xs"
          : "border-line/60 bg-transparent"
      }`}
      data-unread={unread ? "true" : "false"}
      data-category={notification.category}
    >
      <span
        className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-md ${
          urgent
            ? "bg-danger/10 text-danger"
            : "bg-ink/6 text-muted dark:bg-paper/10"
        }`}
        aria-hidden="true"
      >
        {urgent ? (
          <ShieldAlert className="size-4" />
        ) : (
          <Bell className="size-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone(notification.category)}>{label}</Badge>
          <Muted>{when(notification.createdAt)}</Muted>
          {unread && (
            <span className="text-[10px] font-semibold tracking-wide text-signal uppercase">
              New
            </span>
          )}
        </div>

        <p
          className={`mt-1.5 text-sm ${unread ? "font-medium text-body" : "text-muted"}`}
        >
          {notification.title}
        </p>

        {notification.detail && (
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {notification.detail}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {notification.link && (
            <AppLink
              href={notification.link}
              className="text-xs font-medium text-signal hover:underline"
            >
              Open
            </AppLink>
          )}

          {unread && (
            <ActionForm
              action={markNotificationRead}
              submitLabel="Mark as read"
              submitTone="ghost"
              submitSize="sm"
              pendingLabel="Marking"
              hidden={{ notificationId: notification.id }}
              compact
            />
          )}
        </div>
      </div>
    </li>
  );
}

export function NotificationFeed({
  notifications,
  labels,
  total,
  page,
  pageCount,
  unread,
  unreadOnly,
}: {
  notifications: Notification[];
  /** Category key to the catalogue's own label, so the two cannot drift. */
  labels: Record<string, string>;
  total: number;
  page: number;
  pageCount: number;
  unread: number;
  unreadOnly: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1.5">
            <AppLink
              href="/notifications"
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                unreadOnly
                  ? "text-muted hover:bg-ink/5 dark:hover:bg-paper/10"
                  : "bg-ink text-on-ink"
              }`}
            >
              Everything
            </AppLink>
            <AppLink
              href="/notifications?unread=1"
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                unreadOnly
                  ? "bg-ink text-on-ink"
                  : "text-muted hover:bg-ink/5 dark:hover:bg-paper/10"
              }`}
            >
              Unread {unread > 0 && `(${unread})`}
            </AppLink>
          </div>

          {unread > 0 && (
            <ActionForm
              action={markAllNotificationsRead}
              submitLabel={
                <span className="inline-flex items-center gap-1.5">
                  <CheckCheck className="size-3.5" aria-hidden="true" />
                  Mark all as read
                </span>
              }
              submitTone="secondary"
              submitSize="sm"
              pendingLabel="Marking"
              compact
            />
          )}
        </div>
      </Card>

      {notifications.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "Nothing unread" : "Nothing yet"}
          description={
            unreadOnly
              ? "You have read everything that has come in."
              : "Assignments, approaching deadlines, reviews and alerts will appear here as they happen."
          }
        />
      ) : (
        <>
          <ul className="space-y-2.5">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                label={labels[notification.category] ?? notification.category}
              />
            ))}
          </ul>

          <Pagination
            basePath="/notifications"
            page={page}
            pageCount={pageCount}
            total={total}
            params={{ unread: unreadOnly ? "1" : undefined }}
            unit="notification"
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ preferences */

function PreferenceRow({ preference }: { preference: NotificationPreference }) {
  if (preference.isMandatory) {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-body">
            <AlertTriangle
              className="size-3.5 shrink-0 text-danger"
              aria-hidden="true"
            />
            {preference.label}
          </p>
          <p className="mt-0.5 text-xs text-muted">{preference.description}</p>
        </div>
        {/*
          No controls at all, rather than disabled ones. A disabled checkbox
          invites somebody to look for the setting that would enable it; a
          sentence saying it cannot be switched off is the truth and takes
          the same amount of room.
        */}
        <p className="shrink-0 text-xs font-medium text-danger">
          Always on
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-line bg-surface p-3.5">
      <ActionForm
        action={saveNotificationPreference}
        submitLabel="Save"
        submitTone="secondary"
        submitSize="sm"
        pendingLabel="Saving"
        hidden={{ category: preference.category }}
        compact
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-body">{preference.label}</p>
          <p className="mt-0.5 text-xs text-muted">{preference.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              name="inApp"
              defaultChecked={preference.inApp}
              className="size-4 rounded border-line accent-signal"
            />
            In app
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              name="email"
              defaultChecked={preference.email}
              className="size-4 rounded border-line accent-signal"
            />
            Email
          </label>
        </div>
      </ActionForm>
    </li>
  );
}

export function NotificationPreferences({
  preferences,
}: {
  preferences: NotificationPreference[];
}) {
  const mandatory = preferences.filter((p) => p.isMandatory);
  const optional = preferences.filter((p) => !p.isMandatory);

  return (
    <div className="space-y-5">
      <Alert tone="info" title="What an email can say">
        An email tells you that something is waiting and gives you a case
        reference and a link. It never carries a subject&apos;s name, a finding or
        anything from a piece of evidence, because an email is read outside
        everything this platform enforces. Sign in to see the detail, where
        your own clearance applies.
      </Alert>

      <Card
        title="Your choices"
        description="Switch a channel off and you stop receiving that kind of notification there. Anything already sent stays in your feed."
      >
        <ul className="space-y-2.5">
          {optional.map((preference) => (
            <PreferenceRow key={preference.category} preference={preference} />
          ))}
        </ul>
      </Card>

      <Card
        title="Not a choice"
        description="These three reach you whatever your settings say: one means somebody in the field may be in trouble, one means a stored exhibit can no longer be relied on, and one means something happened to your account that you have to know about."
      >
        <ul className="space-y-2.5">
          {mandatory.map((preference) => (
            <PreferenceRow key={preference.category} preference={preference} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
