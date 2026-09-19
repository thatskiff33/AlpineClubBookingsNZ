/*
  #3278 — WHO RECEIVES A BOOKING'S STORED-MONEY VERDICT, at the projection that
  decides it.

  The owner's decision (20 September 2026) is that the verdict is OFFICER-ONLY:
  a member sees their amounts exactly as they did before the feature existed.
  Two of the three surfaces this module feeds print ANOTHER MEMBER'S booking —
  the organiser group card renders a row per joiner, each joiner being a
  different member's booking, and the "Your non-member guests" section renders
  a linked child. So the failing case these tests exist for is not "a member
  sees a verdict"; it is "a member reads an integrity verdict about a DIFFERENT
  member's money", which is what shipped before the gate and what nothing
  exercised.

  The gate is asserted at the PROJECTION rather than at the components, because
  the components are client components: one that declines to render a verdict
  has still had it serialised into that browser's payload, reasons and all. A
  render assertion would have passed on the broken code.
*/
import { describe, expect, it } from "vitest";

import { BOOKING_MONEY_RECONCILIATION_WITHHELD } from "@/lib/booking-money-reconciliation-audience";
import { reconcileStoredBookingMoney } from "@/lib/booking-money-reconciliation-store";
import type { FeatureFlags } from "@/config/schema";
import { resolveBookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";

const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-11T00:00:00.000Z");

/**
 * A linked booking whose stored final price cannot be derived from its own
 * total and promotion adjustment — an UNRECONCILED row, so a leaked verdict
 * would be visible rather than an empty one that proves nothing.
 */
function linkedBooking(id: string) {
  return {
    id,
    status: "PENDING",
    hasNonMembers: true,
    groupBookingJoin: null,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    totalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    // 10_000 + 0 is not 9_999: FINAL_PRICE_RELATION_MISMATCH.
    finalPriceCents: 9_999,
    guests: [
      {
        id: `${id}-g1`,
        priceCents: 10_000,
        stayStart: null,
        stayEnd: null,
        nights: [
          { stayDate: CHECK_IN, priceCents: 10_000, priceSource: "SOLD" },
        ],
      },
    ],
    promoRedemption: null,
    nightAdjustments: [],
  };
}

function record(): BookingDetailRecord {
  const child = linkedBooking("child-1");
  const joinerBooking = linkedBooking("joiner-1");
  return {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PAID",
    parentBooking: null,
    parentBookingId: null,
    cancelIfGuestsBumped: false,
    hasNonMembers: true,
    linkedBookings: [child],
    groupBookingAsOrganiser: {
      joinCode: "ABC123",
      status: "OPEN",
      paymentMode: "EACH_PAYS_OWN",
      joinDeadline: null,
      maxJoiners: 4,
      settlement: null,
      joins: [
        {
          id: "join-1",
          isMember: true,
          contactFirstName: null,
          contactLastName: null,
          joinerMember: { firstName: "Jo", lastName: "Other" },
          booking: joinerBooking,
        },
        // A join that has not verified yet: no child booking, so it is not a
        // roster row at all and must produce no entry to carry a verdict on.
        {
          id: "join-2",
          isMember: false,
          contactFirstName: "Unverified",
          contactLastName: "Guest",
          joinerMember: null,
          booking: null,
        },
      ],
    },
  } as unknown as BookingDetailRecord;
}

function viewer(canSeeAdminTools: boolean): BookingDetailViewer {
  return {
    canManageBooking: true,
    isBookingOwner: true,
    canSeeAdminTools,
  } as unknown as BookingDetailViewer;
}

function party(canSeeAdminTools: boolean) {
  return resolveBookingDetailLinkedParty({
    booking: record(),
    modules: { groupBookings: true } as unknown as FeatureFlags,
    viewer: viewer(canSeeAdminTools),
    access: { isDeleted: false } as unknown as BookingDetailEditAccess,
  });
}

describe("the linked party's stored-money verdicts (#3278)", () => {
  it("withholds a linked child's verdict from a member who is not an officer", () => {
    const { nonMemberGuestChildren } = party(false);

    expect(nonMemberGuestChildren).toHaveLength(1);
    expect(nonMemberGuestChildren[0]!.moneyReconciliation).toEqual(
      BOOKING_MONEY_RECONCILIATION_WITHHELD,
    );
    // The amount itself is untouched by the decision — a member's figures read
    // exactly as they did before this feature existed.
    expect(nonMemberGuestChildren[0]!.finalPriceCents).toBe(9_999);
  });

  /*
    THE ONE THAT WOULD HAVE CAUGHT IT. A joiner row is a DIFFERENT member's
    booking, rendered to the organiser. Before the gate, the organiser received
    that member's verdict and its full reasons array in the page payload.
  */
  it("never gives a non-officer organiser a verdict about another member's booking", () => {
    const joiners = party(false).organiserGroupState!.joiners;

    expect(joiners).toHaveLength(1);
    expect(joiners[0]!.moneyReconciliation).toEqual(
      BOOKING_MONEY_RECONCILIATION_WITHHELD,
    );
    // Nothing anywhere in what reaches the browser names a reason.
    expect(JSON.stringify(joiners)).not.toContain("MISMATCH");
  });

  it("gives an officer the canonical verdict for both, unchanged", () => {
    const officerParty = party(true);
    const expectedChild = reconcileStoredBookingMoney(
      linkedBooking("child-1") as never,
    );
    const expectedJoiner = reconcileStoredBookingMoney(
      linkedBooking("joiner-1") as never,
    );

    expect(expectedChild.state).toBe("UNRECONCILED");
    expect(officerParty.nonMemberGuestChildren[0]!.moneyReconciliation).toEqual({
      visibility: "VISIBLE",
      reconciliation: expectedChild,
    });
    expect(
      officerParty.organiserGroupState!.joiners[0]!.moneyReconciliation,
    ).toEqual({ visibility: "VISIBLE", reconciliation: expectedJoiner });
  });

  /*
    The fail-open shape this replaced. `joiners` used to be built from
    `filter(join => join.booking).map(...)`, which does not NARROW, so every
    read of the joiner's booking went through `?.` and the verdict was typed
    nullable. Null then meant two things at once — "this join has no booking"
    and, once the gate existed, "withheld from you" — and the card rendered
    both as nothing. A join without a booking now produces no row at all, so
    every row that exists carries a real, required view.
  */
  it("drops an unverified join entirely rather than giving it an absent verdict", () => {
    for (const canSeeAdminTools of [true, false]) {
      const joiners = party(canSeeAdminTools).organiserGroupState!.joiners;
      expect(joiners.map((joiner) => joiner.id)).toEqual(["join-1"]);
      for (const joiner of joiners) {
        expect(joiner.moneyReconciliation).not.toBeNull();
        expect(joiner.moneyReconciliation.visibility).toBeDefined();
      }
    }
  });
});
