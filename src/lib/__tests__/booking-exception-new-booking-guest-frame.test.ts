import { describe, expect, it, vi } from "vitest";

/**
 * CT-4 (#2870): THE NEW-BOOKING PROPOSAL FRAME, now whole. Group F2 closed two
 * of the three shapes; group F4b closed the third, and this file pins all three
 * as positive assertions.
 *
 * ## KEPT DELIBERATELY, INCLUDING ITS HISTORY
 *
 * Between F2 and F4b this file pinned today's WRONG answer on purpose, with a
 * header saying a red here was the rest of the fix arriving rather than a
 * regression. F4b turned that pin into the assertion below rather than deleting
 * it: a warning that existed precisely to notice this moment is worth more as
 * the test that now proves the moment happened. The mechanism is recorded in
 * full because it is the shape this epic keeps finding, and the shape a later
 * edit is most likely to reintroduce.
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
 * ## The mechanism that was wrong, exactly
 *
 * `buildProposalPartyFromGuests` (`src/lib/booking-exception-request-service.ts`)
 * was a MIXED FRAME, and the union of the two frames is what over-expanded:
 *
 *  - `bookingNights` expands the submitted envelope with `getStayNights`, which
 *    F2 corrected, so those were already the stored calendar days;
 *  - each guest's range goes through `normalizeGuestStayRange`
 *    (`src/lib/booking-guest-stay-range-input.ts`), which projected
 *    `booking.checkIn`/`checkOut` through `APP_TIME_ZONE` with
 *    `normalizeDateOnlyForTimeZone` at the top of the function, BEFORE it
 *    defaulted a guest who supplied no dates of their own.
 *
 * Every guest-supplied field on this input type is a `yyyy-MM-dd` STRING, so an
 * explicit range and an explicit night set both reach `parseDateOnly` and always
 * came back as the stored days. Only the DEFAULT was projected — and the default
 * is what the member form sends for every guest unless they open multi-range
 * mode. So for a club behind Greenwich that guest was frozen a night early, the
 * officer reviewed that, and the expand-only party envelope widened to cover
 * both frames at once.
 *
 * F4b read those two calls as the stored calendar days they are, which converges
 * the frame: every shape below now reaches `STORED_NIGHTS`. The zone-divergence
 * premise case stays, because without it the three assertions would agree for
 * the wrong reason on a `Pacific/Auckland` default, where the projection is the
 * identity.
 *
 * ## The cutover, stated rather than left to be discovered
 *
 * A NEW_BOOKING proposal frozen before this change and approved after it is
 * UNAFFECTED — measured, not assumed. The approval engine's tamper gate hashes
 * the stored snapshot against its own stored hash, `verifyLiveProposalIntegrity`
 * returns `{ intact: true }` for a new-booking snapshot because there is no live
 * base to drift, and both the policy-drift re-evaluation and the capacity
 * recheck read the frozen `YYYY-MM-DD` strings. Nothing in that path calls this
 * helper again, so such a request still executes exactly as it was frozen —
 * including a night early, if it was frozen before this fix.
 *
 * A MODIFICATION request carrying a range-less ADDED guest is the case that does
 * change: its approval REPLAYS the stored delta through
 * `buildModificationProposalParties`, which reaches this helper, so it now
 * replays to a different hash and is refused with `PROPOSAL_DRIFT_MESSAGE`. That
 * is the correct outcome on #3056's recorded ACCEPT precedent — the proposal
 * describes a stay a night early, so refusing it once and having the member
 * resubmit is better than executing it.
 *
 * The MESSAGE was not true of this cause, and #3089 fixed that: it used to say
 * "the live booking has changed since this request was made", which sent an
 * officer looking for an edit that never happened. The engine still cannot tell
 * this cause from real base drift — that needs a signal it does not carry — so
 * the message now names NEITHER cause and states only what was established
 * (`INV-EXCEPT-035`).
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { buildProposalPartyFromGuests } from "@/lib/booking-exception-request-service";

/**
 * The zone the `@/config/operational` factory above pins, named rather than left
 * to the helper's `APP_TIME_ZONE` default, which #3123 deletes. The premise case
 * asserts the two are still the same zone, so this constant cannot drift out of
 * step with the factory and leave the cases below passing for the wrong reason.
 */
const CLUB_ZONE_BEHIND_UTC = "America/Denver";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const CHECK_IN = "2026-07-04";
const CHECK_OUT = "2026-07-07";

/** What the member asked for, read as the days they are stored as. */
const STORED_NIGHTS = ["2026-07-04", "2026-07-05", "2026-07-06"];

/**
 * A night EARLY: what a range-less guest used to get, kept as a NAMED value so
 * a regression fails against the specific wrong answer rather than against
 * "something else". The `not.toEqual` below is the mutation-shaped assertion —
 * reinstating `normalizeDateOnlyForTimeZone` reaches exactly this list.
 */
const PROJECTED_A_NIGHT_EARLY = ["2026-07-03", "2026-07-04", "2026-07-05"];

const ada = {
  firstName: "Ada",
  lastName: "Lovelace",
  ageTier: "ADULT",
  isMember: true,
};

describe("the new-booking proposal's guest frame (CT-4, #2870, groups F2 + F4b)", () => {
  it("PREMISE: the mocked club zone really does move a stored day", () => {
    // Measured, not assumed. If `America/Denver` ever stopped shifting a
    // UTC-midnight day, every assertion below would hold for the wrong reason.
    // The zone the removed call read is `APP_TIME_ZONE`, so the constant has to
    // keep naming it.
    expect(APP_TIME_ZONE).toBe(CLUB_ZONE_BEHIND_UTC);
    expect(formatDateOnlyForTimeZone(day(CHECK_IN), CLUB_ZONE_BEHIND_UTC)).toBe(
      "2026-07-03",
    );
  });

  it("a guest who supplied no dates is defaulted from the STORED envelope (this WAS the F2 pin)", () => {
    const party = buildProposalPartyFromGuests(day(CHECK_IN), day(CHECK_OUT), [
      ada,
    ]);

    // This assertion IS the flipped pin. It read `PROJECTED_A_NIGHT_EARLY` and a
    // `checkIn` of "2026-07-03" until F4b read those two calls as stored days.
    expect(party.guests[0].nights).toEqual(STORED_NIGHTS);
    expect(party.guests[0].nights).not.toEqual(PROJECTED_A_NIGHT_EARLY);
    // The envelope no longer widens to cover two frames at once: a guest who
    // asked for nothing cannot expand the booking they were added to.
    expect(party.checkIn).toBe(CHECK_IN);
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
