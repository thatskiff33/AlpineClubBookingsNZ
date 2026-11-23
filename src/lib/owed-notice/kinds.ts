/**
 * #5433: every kind of owed notice this release may write. A marker can be
 * written only with one of these (`OwedNoticeInput.kind`), and the registry
 * must deliver exactly these (`owed-notice-registry.test.ts`), so a typo or a
 * missed registration fails to compile or fails that test instead of leaving
 * a member's notice in a table no sweep reads.
 *
 * A leaf module, importing nothing, so any deliverer module can name its kind
 * without importing the registry or the drain.
 */
export const OWED_NOTICE_KINDS = [
  "booking-bump-member",
  "booking-bump-officers",
  "waitlist-offer-member",
  "waitlist-offer-officers",
  "waitlist-offer-expired",
  "waitlist-offer-lapsed-untold",
] as const;

export type OwedNoticeKind = (typeof OWED_NOTICE_KINDS)[number];
