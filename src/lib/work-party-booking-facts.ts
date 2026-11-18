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
 *  - a Stripe dispute holds the member's card payment (`INV-PAY-154`), so an
 *    Add's reduction would be held for the treasurer;
 *  - the booking is PAID with nothing taken (owner decision, 18 Nov 2026), so a
 *    Remove would leave a paid, bed-holding booking owing its whole price.
 */
import { BookingStatus, type Prisma } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { getAllowedGuestMemberIds, type BookingGuestLookupDb } from "@/lib/booking-guests";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { isQuotePricedBooking } from "@/lib/booking-modify-quote-priced";
import { editReductionDisputeHold } from "@/lib/booking-modify-settlement-options";
import { recordedUnpaidAskOffsetCents } from "@/lib/unpaid-ask-offset-marker";
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
 * the officer's own or their family's — its owner, or for a joiner the group
 * organiser paid for (`paidByOrganiser`) that organiser, or anyone in either's
 * family groups. A guest on someone else's booking is neither. Read fresh, so
 * under the service's locks it sees a family change that has committed.
 */
export async function workPartyActorIsOwnerOrFamily(
  db: BookingGuestLookupDb & Pick<Prisma.TransactionClient, "booking">,
  booking: Pick<WorkPartyBooking, "memberId" | "organiserSettled" | "parentBookingId" | "payment">,
  actorMemberId: string,
): Promise<boolean> {
  if (await actorIsMemberOrFamily(db, bookingOwner(booking).memberId, actorMemberId)) return true;
  if (!paidByOrganiser(booking) || !booking.parentBookingId) return false;
  const organiserBooking = await db.booking.findUnique({
    where: { id: booking.parentBookingId },
    select: { memberId: true },
  });
  return actorIsMemberOrFamily(db, organiserBooking ? bookingOwner(organiserBooking).memberId : null, actorMemberId);
}

/**
 * Owner decision, 18 Nov 2026 (maintainers' second comment): PAID with nothing
 * taken — no money on the payment (`amountCents` 0), no account credit applied,
 * and no ledger row that took any. The ordinary $0 auto-pay writes exactly this
 * shape when an Add brings an unpaid booking to nothing.
 */
export async function workPartySettledAtZero(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  booking: Pick<WorkPartyBooking, "status" | "payment">,
): Promise<boolean> {
  const payment = booking.payment;
  if (booking.status !== BookingStatus.PAID || !payment) return false;
  if (payment.amountCents > 0 || payment.creditAppliedCents > 0) return false;
  const taken = await db.paymentTransaction.count({
    where: { paymentId: payment.id, amountCents: { gt: 0 }, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] } },
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
      hasOtherPromoCode: redemptions.some((row) => row.promoCode && !row.promoCode.workPartyEvent),
      memberOwned: Boolean(bookingOwner(booking).memberId),
      // The ordinary edit's own reader, as `applyPaymentAdjustments` asks it.
      cardPaymentDisputed: (await editReductionDisputeHold(db, booking)).cents > 0,
    },
    remove: {
      ...shared,
      workPartyEventId: current?.id ?? null,
      settledAtZero: current ? await workPartySettledAtZero(db, booking) : false,
    },
  };
}

/**
 * #5149 (B-L1 of the maintainers' second comment): how much of an Add's
 * reduction an unpaid additional ask took (#3954, `INV-PAY-120`), when it took
 * all of it and nothing comes back — after Add, Remove, Add the reduction
 * cancels the ask the Remove raised. Read from the edit's own history row
 * (`recordedUnpaidAskOffsetCents`), inside the transaction that wrote it; 0
 * otherwise.
 */
export async function reductionWhollyAbsorbedByUnpaidAskCents(
  db: Pick<Prisma.TransactionClient, "bookingModification">,
  edit: { bookingModificationId?: string | null; priceDiffCents: number },
  moneyBackCents: number,
): Promise<number> {
  if (!edit.bookingModificationId || edit.priceDiffCents >= 0 || moneyBackCents > 0) return 0;
  const row = await db.bookingModification.findUnique({
    where: { id: edit.bookingModificationId },
    select: { newData: true },
  });
  const offsetCents = recordedUnpaidAskOffsetCents(row?.newData);
  return offsetCents > 0 && offsetCents === -edit.priceDiffCents ? offsetCents : 0;
}
