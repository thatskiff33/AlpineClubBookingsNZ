/**
 * The finished-stay correction (#3750): an officer-approved LOCKED_PERIOD change
 * request executed on a stay that has already finished.
 *
 * ONE HOME for what makes this edit different from every other batch edit, so
 * the executor that asks for it and the service that honours it read the same
 * rule (`INV-SSOT-001`):
 *
 *  - {@link FinishedStayCorrection} — the service argument itself. It is never a
 *    request-body field; `modifyBookingBatch` takes it beside `tx`, and
 *    `finished-stay-correction-call-sites.test.ts` pins the executor in
 *    `booking-change-request-execution.ts` as its only caller.
 *  - {@link classifyFinishedStayChangeFeeRule} — the owner's change-fee rule
 *    (decision record on #3750, 6 Oct 2026): adding guests incurs NO change fee;
 *    any removal or swap is charged "as if it normally would have been for a same
 *    day (0 day) notice change".
 *  - {@link finishedStayNoticeDay} — how "a 0-day notice" is expressed to the
 *    ordinary fee machinery: the day the late-notice change fee, the reduction's
 *    refund tier and the applied-credit give-back tier are measured FROM is the
 *    stay's own check-in, so `daysUntilCheckIn` is 0 for every one of them. A
 *    finished stay measured from the real today would be a NEGATIVE notice
 *    period, which `getRefundTier` answers with no tier at all (0%) — harsher
 *    than the club's own same-day tier, and not what the owner decided.
 */

import { calendarDateOfDateOnlyInstant, type CalendarDate } from "@/lib/club-time";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";

/**
 * The service argument that turns a batch edit into a finished-stay correction.
 * `changeRequestId` is the approved request it executes, recorded on the
 * modification row and the audit trail so the two are joined both ways (the
 * request also carries `linkedModificationId`).
 */
export interface FinishedStayCorrection {
  readonly changeRequestId: string;
}

/**
 * Which half of the owner's fee rule an executed correction fell under. Stored
 * on the modification row and the audit row, so a treasurer reconciling change
 * fees can tell "no fee because the officer only added guests" from "a same-day
 * tier that happened to come to nothing".
 */
export type FinishedStayChangeFeeRule = "ADD_ONLY_NO_FEE" | "SAME_DAY_NOTICE";

/** A guest the correction keeps, before and after. */
export interface FinishedStayRemainingGuest {
  readonly stored: {
    readonly stayStart: Date;
    readonly stayEnd: Date;
    readonly nights?: ReadonlyArray<{ readonly stayDate: Date }>;
  };
  readonly proposed: {
    readonly stayStart: Date;
    readonly stayEnd: Date;
    readonly nights?: ReadonlyArray<Date>;
  };
}

function nightKeys(
  stayStart: Date,
  stayEnd: Date,
  nights: ReadonlyArray<Date> | undefined,
): string[] {
  if (nights && nights.length > 0) {
    return nights.map((night) => formatDateOnly(storedDateOnly(night))).sort();
  }
  const keys: string[] = [];
  const end = storedDateOnly(stayEnd);
  for (
    let night = storedDateOnly(stayStart);
    night < end;
    night = addDaysDateOnly(night, 1)
  ) {
    keys.push(formatDateOnly(night));
  }
  return keys;
}

/**
 * The owner's rule, decided from what the correction WILL WRITE rather than from
 * which fields the request happened to carry.
 *
 * That distinction is not pedantry: the member's change-request form sends the
 * same payload as the edit panel, and the edit panel sends `guestStayRanges` for
 * every guest in grid and range modes whether or not their nights moved. A rule
 * keyed on "the request mentions stay ranges" would charge a same-day fee on a
 * request that only added a guest. So: add-only means at least one guest is
 * added, nobody is removed, and every guest already on the booking keeps exactly
 * the nights they had.
 *
 * Anything else — a removal, a swap (a removal with an add), a stay-range or
 * date change — is `SAME_DAY_NOTICE`, and the ordinary fee machinery prices it at
 * {@link finishedStayNoticeDay}.
 */
export function classifyFinishedStayChangeFeeRule(plan: {
  readonly addedGuestCount: number;
  readonly removedGuestCount: number;
  readonly remainingGuests: ReadonlyArray<FinishedStayRemainingGuest>;
}): FinishedStayChangeFeeRule {
  if (plan.addedGuestCount === 0 || plan.removedGuestCount > 0) {
    return "SAME_DAY_NOTICE";
  }
  const everyKeptGuestUnchanged = plan.remainingGuests.every(({ stored, proposed }) => {
    const before = nightKeys(
      stored.stayStart,
      stored.stayEnd,
      stored.nights?.map((night) => night.stayDate),
    );
    const after = nightKeys(proposed.stayStart, proposed.stayEnd, proposed.nights);
    return before.length === after.length && before.every((key, i) => key === after[i]);
  });
  return everyKeptGuestUnchanged ? "ADD_ONLY_NO_FEE" : "SAME_DAY_NOTICE";
}

/**
 * The day a finished-stay correction's fees and refund tiers are measured from:
 * the stay's own check-in, so the notice period is exactly 0 days. Passed where
 * the ordinary edit passes the club's today, and only to the three money tiers —
 * the edit policy, the promotion window and every date gate still read the real
 * today.
 */
export function finishedStayNoticeDay(booking: { readonly checkIn: Date }): CalendarDate {
  return calendarDateOfDateOnlyInstant(storedDateOnly(booking.checkIn));
}
