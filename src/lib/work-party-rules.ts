/**
 * The work-party facts more than one module needs (INV-SSOT), with no
 * database or server dependency so the calendar's shared modules can import
 * them too.
 *
 * - **Open:** a work party members can still select is active, and its
 *   internal promo is active and not archived. `OPEN_WORK_PARTY_EVENT_WHERE` is
 *   that rule as a query; `isOpenWorkPartyEvent` is the same rule on a row
 *   already read. The booking picker, the booking-create and promo-validate
 *   checks, the member page and dashboard card (#5148) and the calendar's
 *   visibility filter all use one of the two. Any other work-party rule that
 *   asks "is it open?" (for example #5149's correction refusal) calls
 *   `isOpenWorkPartyEvent` rather than writing the test inline.
 * - **The window:** `startDate`/`endDate` are date-only columns holding the
 *   first and the LAST discounted night, both inclusive. A stay covering the
 *   whole window checks out the day after the last night (booking stays are
 *   half-open), which is `workPartyCheckOutDay`.
 */
import type { Prisma } from "@prisma/client";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  countClubNights,
  type CalendarDate,
} from "@/lib/club-time";

export const OPEN_WORK_PARTY_EVENT_WHERE = {
  active: true,
  promoCode: { active: true, archivedAt: null },
} satisfies Prisma.WorkPartyEventWhereInput;

export function isOpenWorkPartyEvent(event: {
  active: boolean;
  promoCode: { active: boolean; archivedAt: Date | null };
}): boolean {
  return (
    event.active && event.promoCode.active && !event.promoCode.archivedAt
  );
}

/** The first discounted night, as a club calendar day. */
export function workPartyFirstNight(event: { startDate: Date }): CalendarDate {
  return calendarDateOfDateOnlyInstant(event.startDate);
}

/** The morning after the last discounted night: the window's exclusive end. */
export function workPartyCheckOutDay(event: { endDate: Date }): CalendarDate {
  return addCalendarDays(calendarDateOfDateOnlyInstant(event.endDate), 1);
}

/** How many nights the window holds, first and last both counted. */
export function workPartyNightCount(event: {
  startDate: Date;
  endDate: Date;
}): number {
  return countClubNights(workPartyFirstNight(event), workPartyCheckOutDay(event));
}

/**
 * The member work party page (#5148). It sits under `/dashboard`, a root the
 * app already owns, so the app reserves no `/work-parties` word and a club can
 * still publish a website page at that address (owner decision, 15 Nov 2026).
 * The dashboard card and the calendar's "Open the work party" link both build
 * it here.
 */
export function memberWorkPartyHref(workPartyEventId: string): string {
  return `/dashboard/work-parties/${encodeURIComponent(workPartyEventId)}`;
}
