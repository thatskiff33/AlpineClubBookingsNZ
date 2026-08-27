/**
 * The one boundary a tokenised payment link dies at (#707/#740, CT-4 #2870).
 *
 * A `/pay` link stays valid to the END OF THE CHECK-IN DAY, inclusive, and four
 * separate decisions are bound to that single moment:
 *
 * 1. what `PaymentLink.expiresAt` is minted as — `payment-link.ts`,
 *    `booking-request.ts` and `group-booking.ts`;
 * 2. whether a fresh mint would be born expired and must therefore not happen;
 * 3. the request-hold TERMINAL CANCEL in `cron-confirm-pending.ts` (#2012),
 *    which releases real capacity;
 * 4. the split-child terminal cancel beside it (#1993 Part A).
 *
 * Those four used to say "the same boundary" IN A COMMENT while each wrote the
 * expression out again, and the comment is what CT-4 found had stopped being
 * true: every copy resolved the day's end in `APP_TIME_ZONE` — the deployment's
 * `TZ` seed — while the pay page and the email that carries the link had already
 * moved onto the club's PERSISTED zone (#3068). One function, taking the zone,
 * is what makes "they can never disagree" a property of the code rather than a
 * promise in prose.
 *
 * THE ZONE IS A PARAMETER ON PURPOSE. Resolving it is a database read, and three
 * of the call sites run inside a `prisma.$transaction` already holding
 * `acquireLodgeCapacityLock` (and one the global `lock(1)` as well), where a
 * settings query buys nothing and lengthens a lock nobody else can take. Every
 * caller resolves the zone with `readClubTimeZoneOutsideRequest()` BEFORE its
 * transaction and threads the value in — the ordering rule
 * `docs/CONCURRENCY_AND_LOCKING.md` states and `booking-create.ts` already
 * follows. `INV-CONFIG-002` supplies the zone; this module never reads it.
 *
 * `checkIn` is a `@db.Date` calendar day, decoded in UTC because that is what
 * the column encodes — `INV-DATE-019`'s first exact boundary plus
 * `INV-DATE-026`. Do not cite `INV-DATE-010` for that decode; it forbids the
 * opposite.
 *
 * ONE FAILURE MODE MOVED, for a day no booking can hold. The retired
 * `endOfDateOnlyForTimeZone` adapter answered `new Date(NaN)` for `9999-12-31`,
 * whose exclusive end has no `CalendarDate`; the kernel throws a `RangeError`
 * instead, which is the right answer for a value about to be written to
 * `expiresAt` — an Invalid Date reaches Prisma and fails three modules later,
 * while `NaN <= now` is `false` and would quietly keep extending a hold forever.
 */

import {
  calendarDateOfDateOnlyInstant,
  endOfClubDayInclusive,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";

/** Re-exported so a caller threading the zone needs one import, not two. */
export type { ClubTimeZone };

export function paymentLinkExpiryForCheckIn(
  checkIn: Instant,
  zone: ClubTimeZone,
): Instant {
  return endOfClubDayInclusive(calendarDateOfDateOnlyInstant(checkIn), zone);
}
