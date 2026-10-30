import { z } from "zod";
import { uuidField } from "@/lib/forms";
import { NOTIFICATION_CATEGORIES } from "@/modules/notify/shared";

/** What the notification screens post (PRD 12.2). */

export const markReadSchema = z.object({
  notificationId: uuidField,
});

/**
 * A preference, as two checkboxes post it.
 *
 * An unticked checkbox posts NOTHING, so the property is absent rather than
 * present-and-false, and a schema that merely allowed the value `undefined`
 * would still require the key. That exact mistake made the closure gate
 * unsubmittable earlier in this build: `.optional()` is what makes the key
 * itself optional, and it is the difference between a working form and one
 * that refuses every submission with nothing highlighted.
 */
const checkbox = z
  .union([z.literal("on"), z.literal("true")])
  .optional()
  .transform((value) => value !== undefined);

export const setPreferenceSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  inApp: checkbox,
  email: checkbox,
});
