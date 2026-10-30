"use server";

import { refreshPath } from "@/lib/revalidate";
import {
  EMPTY_FORM_STATE,
  invalidForm,
  unexpectedFailure,
  type FormState,
} from "@/lib/forms";
import { requireActorOrThrow } from "@/lib/auth/session";
import { NotifyError, notify } from "@/modules/notify";
import { markReadSchema, setPreferenceSchema } from "./schema";

/**
 * Notification actions (PRD 12.2).
 *
 * All three act on the signed-in person's own records, so none of them takes
 * a permission: the row-level policy already restricts every one of these
 * statements to the caller's own rows, and a permission check on top would
 * only be able to make somebody's own feed unreadable to them.
 */

function run(work: () => Promise<FormState>, what: string): Promise<FormState> {
  return work().catch((error) => {
    if (error instanceof NotifyError) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error(`notification action failed: ${what}`, error);
    return unexpectedFailure(error, what);
  });
}

export async function markNotificationRead(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const parsed = markReadSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await notify(actor).markRead(parsed.data.notificationId);
    refreshPath("/notifications");

    return { ...EMPTY_FORM_STATE, success: "Marked as read." };
  }, "marking that as read");
}

/**
 * No parameters, because it needs none: there is nothing to validate and
 * nothing to carry. A function of fewer arguments is still a valid action for
 * `useActionState`, which simply passes two it does not read.
 */
export async function markAllNotificationsRead(): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const count = await notify(actor).markAllRead();
    refreshPath("/notifications");

    return {
      ...EMPTY_FORM_STATE,
      success:
        count === 0
          ? "Nothing was unread."
          : `${count} ${count === 1 ? "notification" : "notifications"} marked as read.`,
    };
  }, "marking those as read");
}

export async function saveNotificationPreference(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const parsed = setPreferenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await notify(actor).setPreference(parsed.data);
    refreshPath("/notifications/preferences");

    return { ...EMPTY_FORM_STATE, success: "Saved." };
  }, "saving that preference");
}
