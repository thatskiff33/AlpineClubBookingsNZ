/**
 * The `errorMessage` the email core writes on a fail-closed withhold's `FAILED`
 * row: the booking's "No emails" switch could not be read, so nothing was sent,
 * and the core alerts officers itself (`alertAdminsOfFailClosedWithhold` in
 * `core.ts`). One spelling, so an owed notice reading that row can tell a
 * failure officers were already told about and not alert them a second time
 * (#5433 PR 3, round 1). A leaf, so a reader does not load the email core.
 */
export const BOOKING_NO_EMAILS_UNREADABLE_MESSAGE =
  'Withheld: the booking\'s "No emails" switch could not be read, so the send failed closed';
