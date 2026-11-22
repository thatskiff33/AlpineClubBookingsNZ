/**
 * A member's own email preferences: which ones there are, their defaults, and
 * the request body that changes them. Shared by
 * `/api/notifications/preferences` and the AI app action catalogue (ALP-718),
 * so the two cannot describe a different set (`INV-SSOT`).
 */
import { z } from "zod";

export const MEMBER_NOTIFICATION_PREFERENCE_KEYS = [
  "bookingConfirmation",
  "bookingReminder",
  "bookingBumped",
  "bookingCancelled",
  // #2284 (S2): the family-scope "you were added to a booking" FYI opt-out.
  "bookingAddedByFamily",
  "choreRoster",
  // #4987: club-business bulk email, opt-out (INV-PRIV-026).
  "clubNotices",
  "marketingEmails",
] as const;

export type MemberNotificationPreferenceKey =
  (typeof MEMBER_NOTIFICATION_PREFERENCE_KEYS)[number];

export type MemberNotificationPreferences = Record<
  MemberNotificationPreferenceKey,
  boolean
>;

/** Every preference optional: the ones sent change, the rest stay as they are. */
export const memberNotificationPreferencesUpdateSchema = z.object(
  Object.fromEntries(
    MEMBER_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, z.boolean().optional()]),
  ) as Record<MemberNotificationPreferenceKey, z.ZodOptional<z.ZodBoolean>>,
);

/**
 * The same body as an AI app connection may send it (ALP-718): marketing
 * email is an opt-in consent (`INV-PRIV-026`), which the member gives on the
 * website, so a connection may turn it off but never on.
 */
export const memberNotificationPreferencesConnectionUpdateSchema =
  memberNotificationPreferencesUpdateSchema.extend({ marketingEmails: z.literal(false).optional() });

export function resolveMemberNotificationPreferences(
  preferences?: Partial<MemberNotificationPreferences> | null
): MemberNotificationPreferences {
  return {
    bookingConfirmation: preferences?.bookingConfirmation ?? true,
    bookingReminder: preferences?.bookingReminder ?? true,
    bookingBumped: preferences?.bookingBumped ?? true,
    bookingCancelled: preferences?.bookingCancelled ?? true,
    bookingAddedByFamily: preferences?.bookingAddedByFamily ?? true,
    choreRoster: preferences?.choreRoster ?? true,
    clubNotices: preferences?.clubNotices ?? true,
    marketingEmails: preferences?.marketingEmails ?? false,
  };
}
