import { describe, expect, it, vi } from "vitest";

/**
 * CT-4 (#2870), group F2: THE HALF OF THE NEW-BOOKING PROPOSAL FRAME THAT IS
 * STILL WRONG. This file pins today's WRONG answer on purpose.
 *
 * READ THIS BEFORE "FIXING" THE ASSERTION IT PINS. A red there is the REST of
 * the fix arriving, not a regression — the last section says what to do then.
 *
 * ## Why this file exists at all
 *
 * Group B left a loudly-labelled pin of exactly this shape on the MODIFICATION
 * path, in `src/app/api/bookings/[id]/exception-requests/__tests__/freeze-and-approval-share-one-frame.test.ts`.
 * F2 turned that pin green and removed it, correctly: the modification path
 * resolves guest ranges through `resolveModificationStayRanges`, which never
 * reaches `normalizeGuestStayRange`, so it really is closed. The NEW-BOOKING
 * path does reach it, and F2 did NOT close that. Deleting the tree's only
 * durable warning while half the defect remained would have left the remaining
 * half neither documented nor guarded, so the warning moves here.
 *
 * ## The mechanism, exactly
 *
 * `buildProposalPartyFromGuests` (`src/lib/booking-exception-request-service.ts`)
 * is now a MIXED FRAME, and the union of the two frames is what over-expands:
 *
 *  - `bookingNights` expands the submitted envelope with `getStayNights`, which
 *    F2 corrected, so those are the stored calendar days;
 *  - each guest's range goes through `normalizeGuestStayRange`
 *    (`src/lib/booking-guest-stay-range-input.ts`), which projects
 *    `booking.checkIn`/`checkOut` through `APP_TIME_ZONE` with
 *    `normalizeDateOnlyForTimeZone` at the top of the function, BEFORE it
 *    defaults a guest who supplied no dates of their own.
 *
 * Every guest-supplied field on this input type is a `yyyy-MM-dd` STRING, so an
 * explicit range and an explicit night set both reach `parseDateOnly` and come
 * back as the stored days. Only the DEFAULT is projected — and the default is
 * what the member form sends for every guest unless they open multi-range mode.
 * So for a club behind Greenwich that guest is still frozen a night early, the
 * officer still reviews it, and the expand-only party envelope widens to cover
 * both frames at once.
 *
 * F2 halves the error and closes two of the three shapes; it does not close this
 * one. `normalizeGuestStayRange` is #2870 item 6 and belongs to another lane.
 *
 * ## WHEN THAT LANE LANDS
 *
 * `RANGE_LESS_TODAY` becomes `STORED_NIGHTS`, and the projected envelope becomes
 * the stored one. Point the pinned test at the stored values, retitle it, and
 * delete this section. Nothing else in this file changes.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { buildProposalPartyFromGuests } from "@/lib/booking-exception-request-service";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const CHECK_IN = "2026-07-04";
const CHECK_OUT = "2026-07-07";

/** What the member asked for, read as the days they are stored as. */
const STORED_NIGHTS = ["2026-07-04", "2026-07-05", "2026-07-06"];

/** A night EARLY. Today's answer for a guest who supplied no dates. */
const RANGE_LESS_TODAY = ["2026-07-03", "2026-07-04", "2026-07-05"];

const ada = {
  firstName: "Ada",
  lastName: "Lovelace",
  ageTier: "ADULT",
  isMember: true,
};

describe("the new-booking proposal's guest frame (CT-4, #2870, group F2)", () => {
  it("PREMISE: the mocked club zone really does move a stored day", () => {
    // Measured, not assumed. If `America/Denver` ever stopped shifting a
    // UTC-midnight day, every assertion below would hold for the wrong reason.
    expect(formatDateOnlyForTimeZone(day(CHECK_IN))).toBe("2026-07-03");
  });

  it("PINS A DEFECT F2 DID NOT FIX: a guest who supplied no dates is defaulted from the PROJECTED envelope", () => {
    const party = buildProposalPartyFromGuests(day(CHECK_IN), day(CHECK_OUT), [
      ada,
    ]);

    // A night early, and the party envelope has widened to cover both frames.
    // See "WHEN THAT LANE LANDS" in this file's header before changing these.
    expect(party.guests[0].nights).toEqual(RANGE_LESS_TODAY);
    expect(party.checkIn).toBe("2026-07-03");
    expect(party.checkOut).toBe(CHECK_OUT);
  });

  it("a guest with an explicit stay range gets the stored days", () => {
    const party = buildProposalPartyFromGuests(day(CHECK_IN), day(CHECK_OUT), [
      { ...ada, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
    ]);

    expect(party.guests[0].nights).toEqual(STORED_NIGHTS);
    expect(party.checkIn).toBe(CHECK_IN);
    expect(party.checkOut).toBe(CHECK_OUT);
  });

  it("a guest with an explicit night set gets the stored days", () => {
    const party = buildProposalPartyFromGuests(day(CHECK_IN), day(CHECK_OUT), [
      { ...ada, nights: STORED_NIGHTS },
    ]);

    expect(party.guests[0].nights).toEqual(STORED_NIGHTS);
    expect(party.checkIn).toBe(CHECK_IN);
    expect(party.checkOut).toBe(CHECK_OUT);
  });
});
