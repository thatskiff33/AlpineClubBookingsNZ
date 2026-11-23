/**
 * When a waitlist entry's stay has ended: its check-out date has come at the
 * club (F32, #1888). The past-date waitlist cron cancels such an entry, and the
 * lapse's owed notices (#5433) treat it as moved on. One rule for both
 * (`INV-SSOT-001`, #5433 review J). `checkOut` is the stored date-only lodge
 * night, so "today" is the club's calendar day in the same encoding
 * (`dateOnlyInstantOf`), never the host's clock face.
 */
import type { Prisma } from "@prisma/client";

import { clubToday, dateOnlyInstantOf, type ClubTimeZone } from "@/lib/club-time";

/** Today at the club, as the stored date-only instant a `checkOut` is compared with. */
export function clubTodayAsStoredDate(zone: ClubTimeZone): Date {
  return dateOnlyInstantOf(clubToday(zone));
}

/** True when a stay checking out on `checkOut` has ended by `today` (`clubTodayAsStoredDate`). */
export function waitlistStayHasEnded(checkOut: Date, today: Date): boolean {
  return checkOut.getTime() <= today.getTime();
}

/** The same rule as a query filter. */
export function waitlistStayEndedWhere(today: Date) {
  return { checkOut: { lte: today } } satisfies Prisma.BookingWhereInput;
}
