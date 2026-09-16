import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface ProvisionalChildSummary {
  guestCount: number;
  holdUntil: Date;
  // The provisional non-member child's own priced total in integer cents
  // (#1976). This is the guest portion that is deferred — charged closer to the
  // stay, NOT today — while the parent's member portion is charged up front. It
  // is the child's server-side `finalPriceCents`, never a client re-computation.
  //
  // This is the pay-step half of the single deferred "guest portion" figure
  // (#2003): booking-create prices the NON-MEMBER SUBSET on its own (no promo)
  // and stores that total as the child's `finalPriceCents`. The pre-booking
  // review banner shows the SAME figure because the booking quote prices the
  // same subset through the same helper (`priceDeferredNonMemberPortion`,
  // src/lib/policies/booking-route-decisions.ts) — the shared subset-pricing
  // path, NOT a whole-party non-member sum. That matters under a group discount,
  // where the subset can be priced differently than the whole party (the subset
  // may fall under minGroupSize while the full party meets it), so a whole-party
  // sum would under-quote this deferred charge.
  deferredAmountCents: number;
}

/**
 * Describe the provisional non-member child of a split parent booking (#738),
 * for member-facing email copy only.
 *
 * A split (member + non-member party, outside the hold window) creates a
 * PAYMENT_PENDING parent (member places, charged up front) plus a PENDING child
 * that holds the non-member places provisionally (`parentBookingId` = parent,
 * `nonMemberHoldUntil` set, same member). This returns that child's guest count
 * and hold deadline so the parent's confirmation email can explain the split.
 *
 * Returns null when the booking is not a split parent (no such child), or when
 * the lookup fails — the caller then sends the ordinary confirmation with no
 * provisional section. This is a read-only describe helper: it never mutates
 * booking state and must not change any hold/settlement decision.
 */
export async function getProvisionalNonMemberChildSummary(parent: {
  id: string;
  // #3369: null when the parent booking is owned by an Organisation.
  memberId: string | null;
}): Promise<ProvisionalChildSummary | null> {
  // #3369: a provisional non-member child is a SPLIT of a member's own party —
  // the member pays their share now and the non-member guests pay theirs later.
  // A school booking has no member to split from and has never had one of
  // these, so there is nothing to describe.
  if (parent.memberId === null) return null;
  const parentMemberId = parent.memberId;
  try {
    const child = await prisma.booking.findFirst({
      where: {
        parentBookingId: parent.id,
        memberId: parentMemberId,
        status: BookingStatus.PENDING,
        nonMemberHoldUntil: { not: null },
      },
      select: {
        nonMemberHoldUntil: true,
        finalPriceCents: true,
        _count: { select: { guests: true } },
      },
    });

    if (!child || !child.nonMemberHoldUntil) {
      return null;
    }

    return {
      guestCount: child._count.guests,
      holdUntil: child.nonMemberHoldUntil,
      deferredAmountCents: child.finalPriceCents,
    };
  } catch {
    return null;
  }
}
