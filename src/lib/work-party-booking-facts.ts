/**
 * What "Add to work party" and "Remove from work party" (#5149) read about a
 * booking before they decide, in one place: the admin booking page's list
 * (`GET /api/admin/bookings/[id]/work-party`) and the service's re-check under
 * its locks (`work-party-booking-correction.ts`) read the same select and the
 * same facts, so the list and the save cannot disagree. The rules over these
 * facts are `workPartyBookingEligibility` and `workPartyRemovalEligibility`.
 *
 * The facts the maintainers asked for on #5149
 * (https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6951626920
 * and https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211):
 *  - the acting officer is the booking's owner, or for an organiser-paid
 *    joiner the organiser who paid, or in either's family groups (owner
 *    decision 3, 18 Nov 2026), whatever the money does;
 *  - the booking is PAID with no money taken, nothing or account credit alone
 *    (owner decisions of 18 and 20 Nov 2026), so a Remove would leave a paid,
 *    bed-holding booking owing what the work party took off.
 */
import { BookingStatus, type Prisma } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { getAllowedGuestMemberIds, type BookingGuestLookupDb } from "@/lib/booking-guests";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { isQuotePricedBooking } from "@/lib/booking-modify-quote-priced";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import type {
  WorkPartyEligibilityBooking,
  WorkPartyRemovalEligibilityBooking,
} from "@/lib/work-party-booking-correction";

/** The one booking read both doors take: the service's fields and the list's. */
export const WORK_PARTY_BOOKING_SELECT = {
  status: true,
  checkIn: true,
  checkOut: true,
  lodgeId: true,
  memberId: true,
  finalPriceCents: true,
  organiserSettled: true,
  parentBookingId: true,
  payment: true,
  promoRedemptions: {
    select: {
      id: true,
      applicationOrder: true,
      promoCode: {
        select: { code: true, workPartyEvent: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.BookingSelect;

export type WorkPartyBooking = Prisma.BookingGetPayload<{ select: typeof WORK_PARTY_BOOKING_SELECT }>;

/**
 * Whether the acting officer is this member or in their family. Family is the
 * one existing definition, the member-guest boundary's
 * (`getAllowedGuestMemberIds`: the member plus every co-member of all their
 * family groups). No member (an organisation) has no family.
 */
export async function actorIsMemberOrFamily(
  db: BookingGuestLookupDb,
  memberId: string | null,
  actorMemberId: string,
): Promise<boolean> {
  if (!memberId) return false;
  return (await getAllowedGuestMemberIds(db, memberId)).has(actorMemberId);
}

/**
 * Owner decision 3 (18 Nov 2026, maintainers' comment above): the booking is
 * the officer's own or their family's — its owner, or for a joiner of an
 * organiser-pays group the organiser, who pays for it, or anyone in either's
 * family groups. A guest on someone else's booking is neither.
 *
 * The organiser is this booking's payer from the moment it joins
 * (`organiserSettled`, set at create), not only once the group settlement
 * has succeeded (`paidByOrganiser`, which needs the settled mirror): before
 * that, a lower price on the joiner lowers the organiser's own combined bill
 * (#5149 review A1). Read fresh, so under the service's locks it sees a family
 * change that has committed.
 */
export async function workPartyActorIsOwnerOrFamily(
  db: BookingGuestLookupDb & Pick<Prisma.TransactionClient, "booking">,
  booking: Pick<WorkPartyBooking, "memberId" | "organiserSettled" | "parentBookingId">,
  actorMemberId: string,
): Promise<boolean> {
  if (await actorIsMemberOrFamily(db, bookingOwner(booking).memberId, actorMemberId)) return true;
  if (!booking.organiserSettled || !booking.parentBookingId) return false;
  const organiserBooking = await db.booking.findUnique({
    where: { id: booking.parentBookingId },
    select: { memberId: true },
  });
  return actorIsMemberOrFamily(db, organiserBooking ? bookingOwner(organiserBooking).memberId : null, actorMemberId);
}

/**
 * PAID with no money taken: no money on the payment (`amountCents` 0) and no
 * ledger row that captured any (`CAPTURED_TRANSACTION_STATUS_LIST`: a capture
 * later refunded was still taken), whatever account credit paid. Owner decision,
 * 18 Nov 2026 (maintainers' second comment): nothing at all, the shape the
 * ordinary $0 auto-pay writes when an Add brings an unpaid booking to nothing.
 * Owner decision, 20 Nov 2026
 * (https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-7035299228):
 * account credit alone too, the shape the auto-pay writes when an Add brings
 * the price down to the credit applied. A booking paid in full by credit
 * before any work party is caught as well; the owner accepted that. A joiner
 * whose share the organiser paid is not: the group settlement records that
 * share on the joiner's payment (`amountCents`). A joiner worth $0 when the
 * group settled has nothing recorded there, and is caught like any booking
 * paid with nothing.
 */
export async function workPartyPaidWithNoMoneyTaken(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  booking: Pick<WorkPartyBooking, "status" | "payment">,
): Promise<boolean> {
  const payment = booking.payment;
  if (booking.status !== BookingStatus.PAID || !payment) return false;
  if (payment.amountCents > 0) return false;
  const taken = await db.paymentTransaction.count({
    where: { paymentId: payment.id, amountCents: { gt: 0 }, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
  });
  return taken === 0;
}

export interface WorkPartyBookingFacts {
  add: WorkPartyEligibilityBooking;
  remove: WorkPartyRemovalEligibilityBooking;
  /** The work party the booking is on, or null. */
  current: { id: string; name: string } | null;
}

/** Everything the two eligibility rules read, for this booking and this officer. */
export async function readWorkPartyBookingFacts(
  db: Prisma.TransactionClient,
  bookingId: string,
  booking: WorkPartyBooking,
  actorMemberId: string,
): Promise<WorkPartyBookingFacts> {
  const redemptions = bookingPromoRedemptions(booking);
  const current = redemptions.find((row) => row.promoCode?.workPartyEvent)?.promoCode?.workPartyEvent ?? null;
  const shared = {
    status: booking.status,
    checkOut: booking.checkOut,
    quotePriced: await isQuotePricedBooking(db, bookingId),
    actorIsOwnerOrFamily: await workPartyActorIsOwnerOrFamily(db, booking, actorMemberId),
  };
  return {
    current,
    add: {
      ...shared,
      checkIn: booking.checkIn,
      hasWorkParty: current !== null,
      otherPromoCodes: redemptions.flatMap((row) => (row.promoCode && !row.promoCode.workPartyEvent ? [row.promoCode.code] : [])),
      memberOwned: Boolean(bookingOwner(booking).memberId),
    },
    remove: {
      ...shared,
      workPartyEventId: current?.id ?? null,
      paidWithNoMoneyTaken: current ? await workPartyPaidWithNoMoneyTaken(db, booking) : false,
    },
  };
}
