import {
  AdminReviewStatus,
  BookingStatus,
  type AgeTier,
  type Prisma,
} from "@prisma/client";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  deletePromoRedemptionAndAdjustCount,
  lockAndRefreshPromoCodeUsage,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import {
  selectedIndexesForStoredGuestTargets,
  targetBookingGuestIdsForSelectedIndexes,
} from "@/lib/promo-stored-guest-targets";
import {
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import {
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  rateSnapshotUpdateForRepricedGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import type { SupersededPrimaryPaymentIntent } from "@/lib/booking-payment-cleanup";
import {
  assertNoPendingEditFinancialReview,
  raiseParkedEditFinancialReviewTasks,
} from "@/lib/edit-financial-review";
import {
  counterpartStrandReviewOccurrence,
  editFinancialReviewOccurrence,
  storedSoldPriceEvidenceForGuest,
} from "@/lib/stored-sold-price-evidence";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { lockRosterDates } from "@/lib/roster-lock";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  evaluateNonMemberPricingRequirements,
  PaidUpAdultMemberRequiredError,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { formatDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  calendarDateOfDateOnlyInstant,
  type CalendarDate,
} from "@/lib/club-time";
// #2250 — the status half of the self-removal rule now lives in one module so
// the booking page's affordance and the night-conflict card cannot drift from
// this authoritative gate. The gate itself is unchanged.
import { SELF_REMOVABLE_GUEST_BOOKING_STATUSES } from "@/lib/booking-guest-self-removal";

export class BookingGuestRemovalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export type RemoveBookingGuestResult = {
  booking: Prisma.BookingGetPayload<{ include: { guests: true; payment: true } }>;
  removedGuest: Prisma.BookingGuestGetPayload<Record<string, never>>;
  priceDiffCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  pendingRefundAmountCents: number;
  additionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  paymentStatus: string | null;
  paymentId: string | null;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  memberId: string;
  promoRemoved: boolean;
  // #2390: set only when a usage cap stopped the promotion reaching somebody
  // this edit added; null means everybody the code applies to is covered.
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  oldGuestCount: number;
  bookingModificationId: string;
  /**
   * #3032 (epic #2797): this removal's money was PARKED rather than settled -
   * the guest came off the booking and an OPEN `EDIT_FINANCIAL_REVIEW` task now
   * holds the amount for a person to price.
   *
   * ON THE RESULT RATHER THAN LEFT FOR THE ROUTE TO RE-DERIVE, because the route
   * has to tell the member about it and the only honest source of "is this
   * booking's adjustment under review" is the transaction that decided it. A
   * route reading the tasks back afterwards would be answering a different
   * question - one another lane's edit could have changed in between.
   */
  financialReviewPending: boolean;
  /**
   * The tasks this removal raised or found already on file, in occurrence order.
   * Empty on every priced removal. One entry per unpriceable strand - see the
   * raise itself for why that is one task per strand and not one per removal.
   */
  financialReviewTaskIds: string[];
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
  // #1372: this removal newly dropped a paid (capacity-holding) booking into the
  // blocked minors-only review state, so the route should alert admins.
  minorsOnlyReviewNewlyFlagged: boolean;
};

type RemovalReviewUpdate = {
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  memberReviewJustification: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  adminReviewNotes: string | null;
  adminReviewedById: string | null;
  adminReviewedAt: Date | null;
  parkForReview: boolean;
  releaseFromReview: boolean;
};

/**
 * Review fields to write after a guest removal (#1100). Mirrors the batch
 * path's resolveModifyReviewUpdate scenarios, with one deliberate difference:
 * a member (or self-removing linked guest) who trips the no-adult rule is
 * never blocked for a written justification — the removal proceeds and the
 * booking is flagged with an automatic note so it lands in the admin review
 * queue, even when the booking is already paid.
 */
function resolveRemovalReviewUpdate({
  booking,
  actorRole,
  actorMemberId,
  nowFlagged,
  removedGuestName,
}: {
  booking: {
    status: string;
    requiresAdminReview: boolean;
    adminReviewStatus: AdminReviewStatus | null;
    memberReviewJustification: string | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
  };
  actorRole: string;
  actorMemberId: string;
  nowFlagged: boolean;
  removedGuestName: string;
}): RemovalReviewUpdate {
  if (!nowFlagged) {
    // Rule cleared (or never tripped): wipe review state so the booking
    // returns to the normal lifecycle; release a parked booking.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === BookingStatus.AWAITING_REVIEW,
    };
  }

  // Still (or already) flagged with a recorded review: preserve it — admins
  // are not re-prompted just because the guest list shuffled.
  if (booking.requiresAdminReview && booking.adminReviewStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: booking.memberReviewJustification,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: booking.adminReviewStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First trip. An admin performing the removal is the approval (batch
  // parity); anyone else flags the booking for admin review.
  if (actorRole === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at guest removal by admin.",
      adminReviewedById: actorMemberId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: `Automatic: removing ${removedGuestName} left no adult on this booking.`,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function removeBookingGuestInTransaction({
  tx,
  bookingId,
  guestId,
  actorMemberId,
  actorRole,
  settlementMethod,
  consentAuthority,
  subscriptionLockoutMode,
  hostingCoverageOverride,
  today,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  actorRole: string;
  settlementMethod?: BookingModificationSettlementMethod;
  /**
   * #2576 §7: the officer's explicit confirmation and mandatory reason for
   * overriding a same-owner coverage refusal. Ignored for a non-officer actor —
   * including a self-removing member guest, whose change is never blocked and never
   * discloses the owner's other bookings (see `resolveDependentDisposition`).
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  /**
   * The club's subscription-lockout mode (#2543), resolved by the caller BEFORE it
   * opened this transaction — `resolveSubscriptionLockoutMode` can refresh the
   * financial-year cache from Xero, which must never happen under the locks this
   * transaction holds. Omitted, the paid-up-adult re-evaluation below falls back to
   * a peek; a consent-authority removal never reaches it at all.
   */
  subscriptionLockoutMode?: SubscriptionLockoutMode;
  /**
   * The club's today (#3123), resolved by the caller BEFORE it opened this
   * transaction, exactly like `subscriptionLockoutMode` above and for the same
   * reason: reading the club's persisted timezone is a
   * `clubTimeSettings.findUnique`, and this transaction holds the per-lodge
   * capacity key (`INV-LOCK-004`). It is the UTC-midnight `@db.Date` encoding
   * (`INV-DATE-026`), and it is REQUIRED rather than defaulted — the default
   * is what let the self-removal window be judged against the container's
   * timezone instead of the club's (`INV-CONFIG-002`).
   */
  today: Date;
  /**
   * Member-guest consent (#2307, epic #2305): the narrow authority that lets a
   * DECLINE or an EXPIRY reach this function at all.
   *
   * Without it, two of the three consent removals are simply unauthorized here.
   * The gate below admits the booking owner, an `ADMIN`, or the guest
   * themselves — and a **delegate** answering for a target who cannot log in
   * (owner decisions D-5/D-10) is none of the three, while the **expiry cron**
   * has no actor at all.
   *
   * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It authorizes the
   * removal of exactly the one guest id it names, and only once that row already
   * carries the terminal consent status the caller claims — i.e. only after the
   * status-guarded claim in `member-guest-consent-service.ts` has already
   * succeeded **inside this same transaction**. From there the removal runs the
   * *self-removal* gate set, not the owner gate set, so owner decision D-14 is
   * honoured to the letter: a consent removal is refused in exactly the cases a
   * member's own self-removal would be refused, and those refusals are what land
   * a row on the admin exception list (D-15). It grants no new powers on any
   * existing path and cannot remove any other guest — a test asserts that.
   *
   * `actorMemberId` stays the truthful actor. For a delegate decline it is the
   * delegate, so the audit trail names who actually refused rather than writing
   * the target's id into an act the target did not perform. For the cron there
   * is no person, so the caller passes the **booking owner** — the party whose
   * booking is being repriced and who receives the account credit — and the real
   * actor is recorded separately as `cron:member-guest-consent-expiry` in the
   * audit log. Neither case impersonates the target.
   */
  consentAuthority?: {
    kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY";
    /** The only `BookingGuest` id this authority may remove. */
    guestId: string;
    /** Must equal that row's `memberId`, or the authority does not apply. */
    targetMemberId: string;
  };
}): Promise<RemoveBookingGuestResult> {
  // Two-tier lock protocol (#1881). A single-guest removal computes a reduction
  // refund (money) AND re-checks capacity, so it takes BOTH locks: the global
  // lock(1) FIRST so it mutually excludes cancel / settlement / hold-release,
  // then the per-lodge lock. The caller runs this inside prisma.$transaction, so
  // lock(1) here is the transaction's first lock (global-before-per-lodge order).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying the
  // per-lodge lock from this read is safe; the guest set, pricing and refund
  // below consume ONLY the post-lock re-read.
  const lockTarget = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { lodgeId: true },
  });

  if (!lockTarget) {
    throw new BookingGuestRemovalError("Booking not found", 404);
  }

  const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
  await acquireLodgeCapacityLock(tx, bookingLodgeId);

  // Re-read the full booking under the lock; every field consumed below comes
  // from this post-lock snapshot.
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: {
        include: {
          nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
        },
      },
      payment: true,
      member: true,
        promoRedemption: {
          include: {
            guestTargets: { select: { bookingGuestId: true } },
            promoCode: {
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
            },
          },
        },
    },
  });

  if (!booking) {
    throw new BookingGuestRemovalError("Booking not found", 404);
  }

  const guestToRemove = booking.guests.find((guest) => guest.id === guestId);

  // The consent authority (#2307) is checked against the POST-LOCK re-read, not
  // against anything the caller told us: the guest id must be the one the
  // authority names, the row must belong to the target it names, and the row
  // must ALREADY carry the terminal consent status. That last conjunct is what
  // binds this to the status-guarded claim earlier in the same transaction — an
  // authority cannot be used to remove a live PENDING (or CONFIRMED) row.
  const consentAuthorityApplies =
    consentAuthority !== undefined &&
    consentAuthority.guestId === guestId &&
    guestToRemove !== undefined &&
    guestToRemove.memberId !== null &&
    guestToRemove.memberId === consentAuthority.targetMemberId &&
    guestToRemove.consentStatus ===
      (consentAuthority.kind === "CONSENT_DECLINE" ? "DECLINED" : "EXPIRED");

  const isOwnerOrAdmin =
    !consentAuthorityApplies &&
    (booking.memberId === actorMemberId || actorRole === "ADMIN");
  // A consent removal runs the SELF-REMOVAL gate set on purpose (D-14): the
  // cases in which a never-consented member is trapped on a booking must be
  // exactly the cases in which they could not have taken themselves off, and
  // those refusals are what D-15 routes to the admin exception list.
  const isSelfRemoval =
    consentAuthorityApplies ||
    (!isOwnerOrAdmin && guestToRemove?.memberId === actorMemberId);
  const isLinkedGuestViewer = booking.guests.some(
    (guest) => guest.memberId === actorMemberId,
  );

  if (!isOwnerOrAdmin && !isSelfRemoval && !isLinkedGuestViewer) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  if (!guestToRemove) {
    throw new BookingGuestRemovalError(
      isOwnerOrAdmin ? "Guest not found on this booking" : "Forbidden",
      isOwnerOrAdmin ? 404 : 403,
    );
  }

  if (!isOwnerOrAdmin && !isSelfRemoval) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  /**
   * #3032 (epic #2797): refuse a second money-affecting edit while this booking's
   * last one is still under financial review. Taken under both locks, on the
   * post-lock re-read, and before any write, so a refused removal leaves the
   * booking exactly as it was.
   *
   * THE CONSENT-AUTHORITY EXEMPTION IS NOT A CLAIM THAT THE REMOVAL MOVES NO
   * MONEY. It does - it gives nights back like any other removal. It is owner
   * decision D-14: a member who never consented must always be able to come off
   * a booking, and holding that behind a pricing question nobody has answered
   * would trap them for as long as the review stayed open. So the structural
   * removal proceeds even while the earlier review is unresolved.
   *
   * WHAT THIS BRANCH DOES ABOUT THE MONEY THAT REMOVAL OWES. It parks it, like
   * any other unpriceable removal - the strand check below no longer exempts a
   * consent removal, because it no longer refuses one. So an exempted removal can
   * raise a SECOND review task beside the one already open, and that is the
   * intended shape: two occurrences, two keys, two amounts, each settled on its
   * own evidence. This exemption's only remaining effect is that such a removal
   * is not turned away by the fence while an earlier review is unresolved.
   *
   * DELIBERATELY BELOW THE AUTHORISATION CHECKS. A caller with no business
   * touching this booking must get the same 403 they got before this issue -
   * telling a stranger that the club is reviewing a booking's money is a leak,
   * and a 409 where a 403 belongs is also a wrong answer.
   */
  await assertNoPendingEditFinancialReview({
    bookingId,
    moneyAffecting: !consentAuthorityApplies,
    store: tx,
  });

  if (
    !isSelfRemoval &&
    !["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      400
    );
  }
  if (
    isSelfRemoval &&
    !SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "You cannot remove yourself from this booking in its current status",
      400,
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // #3123 — the SAME club day the self-removal test below uses, and the same
    // one the caller resolved before opening this transaction. The policy used
    // to read the environment's day for itself, so the two sides of this
    // function's date reasoning could disagree.
    today,
  });
  // #3123 — BOTH operands moved together, deliberately. `booking.checkIn` is a
  // `@db.Date` and therefore a CALENDAR DAY that takes no timezone at all, so
  // it is decoded zone-free (`storedDateOnly`, `INV-DATE-026`); the right-hand
  // side is a real question about the club's clock and arrives already resolved
  // from outside this transaction. Moving one side alone is the #3107 shape,
  // where two projections cancelled and fixing one of them broke a path that
  // had been working.
  const selfRemovalIsFuture =
    isSelfRemoval && storedDateOnly(booking.checkIn) > today;
  if (!isSelfRemoval && !editPolicy.canModify) {
    throw new BookingGuestRemovalError(
      editPolicy.reason ?? "This booking cannot be modified",
      400
    );
  }
  if (isSelfRemoval && !selfRemovalIsFuture) {
    throw new BookingGuestRemovalError(
      "Only future booking guests can remove themselves from another member's booking",
      400,
    );
  }
  if (!isSelfRemoval && editPolicy.mode !== "future") {
    throw new BookingGuestRemovalError(
      "Use the full booking edit flow for in-progress booking guest changes",
      400
    );
  }

  if (booking.guests.length <= 1) {
    throw new BookingGuestRemovalError(
      "Cannot remove the last guest. Cancel the booking instead.",
      400
    );
  }

  await assertBookingNotQuotePriced(tx, bookingId);

  // #3031 (epic #2797), INV-MOD-028: CAN THIS BOOKING'S HISTORY PRICE THE
  // REMOVAL EXACTLY?
  //
  // Removing a guest gives back every night that guest holds, so the credit is
  // historical money and must come from what was actually sold. This path never
  // computed it that way: it repriced the REMAINING guests and took the
  // difference against the booking's stored total. Where a remaining guest's
  // rows carry no usable price, that reprice values THEIR nights at today's
  // rate, and the whole of that movement lands inside what the member is told is
  // the departing guest's credit — a rate rise on somebody else's stay changing
  // the amount refunded for this one.
  //
  // Requiring every strand to reconcile is what makes the existing arithmetic
  // exact rather than replacing it: with every remaining night locked, the
  // reprice returns each remaining guest's stored total unchanged, so the
  // difference IS the departing guest's own stored price. That equality is
  // asserted below rather than assumed.
  //
  // Judged before any write, so the decision below is taken against the booking
  // exactly as it stands.
  //
  // #3032 (BFI 3): THIS NO LONGER REFUSES. The hand-off #3031 left here is
  // discharged — the structural removal commits, and the money it owes back is
  // PARKED as an OPEN `EDIT_FINANCIAL_REVIEW` task for a person to price, rather
  // than settled from a difference of repricings this booking's history cannot
  // support. `parkedFinancialReview` below is what carries that through the rest
  // of this function: no reprice, no promo recalculation, no settlement, no
  // credit, no Xero delta, and the booking's stored money untouched.
  //
  // JUDGED FOR EVERY REMOVAL, INCLUDING A CONSENT-AUTHORITY ONE, and dropping
  // that exemption is the point rather than a side effect. Owner decision D-14
  // says a DECLINE or an EXPIRY must ALWAYS be able to take its target off the
  // booking, and #3031 honoured it by exempting the strand check from a gate that
  // could only REFUSE. There is nothing left to exempt it from: parking removes
  // the guest and holds only the amount, which is exactly what D-14 asks for and
  // what a refusal could not give. Leaving the exemption would now be the harmful
  // branch — a consent removal from a booking whose rows do not reconcile would
  // settle an invented amount while every other removal parked.
  const strandEvidence = [guestToRemove, ...booking.guests]
    .filter(
      (guest, index, all) =>
        all.findIndex((other) => other.id === guest.id) === index,
    )
    .map((guest) => ({
      guest,
      evidence: storedSoldPriceEvidenceForGuest(guest, booking),
    }));
  /**
   * Is this removal's money unknowable from the booking's own history?
   *
   * ONE STRAND IS ENOUGH, and it does not have to be the departing one. The
   * credit this path settles is a DIFFERENCE OF REPRICINGS — the booking's
   * stored total less a reprice of whoever is left — so a REMAINING guest whose
   * rows carry no usable price has their nights revalued at today's rate, and the
   * whole of that movement lands inside what the member is told is the departing
   * guest's credit. That is the defect #3031 named, and it is not confined to the
   * guest who is leaving, which is why the check above judges every strand.
   */
  const parkedFinancialReview = strandEvidence.some(
    (strand) => strand.evidence.kind !== "exact",
  );
  /**
   * The strands this removal parks, and why the DEPARTING one is always among
   * them.
   *
   * A REMAINING strand is recorded when its own rows cannot be read - that is a
   * separate question for the admin, and it carries no surrendered nights
   * because nothing of that guest's is being given back.
   *
   * THE DEPARTING STRAND IS RECORDED WHENEVER THIS REMOVAL PARKS, READABLE OR
   * NOT, and that is a defect fix rather than symmetry. Filtering it out when its
   * own rows happened to be exact lost real money: nothing settles on a parked
   * removal (`priceDiffCents` is 0, and the booking's stored total does not
   * move), `tx.bookingGuest.delete` below destroys the guest row and every night
   * row behind it, and `BookingModification.previousData` keeps only name, age
   * tier and membership. So on a booking where the LEAVING guest reconciles and a
   * REMAINING one does not, the only task raised named the remaining guest, said
   * "gave back no nights", and read - correctly, for what it described - as
   * "reviewed, nothing to adjust". An admin dismissing it cleared the banner, and
   * the departing member's refund was a figure no longer present anywhere in the
   * database.
   *
   * Its evidence is exact, so the number IS knowable and is preserved on the
   * task: the real per-night prices, the stored guest total, and the nights this
   * removal surrenders. `COUNTERPART_STRAND_UNREADABLE` says which of the two
   * situations an admin is looking at, and `counterpartStrandReviewOccurrence`
   * carries the rest of the reasoning - including why no AMOUNT is written even
   * though the rows add up.
   */
  const unpriceableStrands = !parkedFinancialReview
    ? []
    : strandEvidence.flatMap(({ guest, evidence }) => {
        // A removal surrenders every night the departing guest holds and adds
        // none; a remaining guest surrenders nothing. Recorded from the rows
        // this service can still see, because the delete below destroys them.
        const surrenderedNightDates =
          guest.id === guestId
            ? evidence.nightPrices.map((night) => night.date)
            : [];
        if (evidence.kind === "unusable") {
          return [
            editFinancialReviewOccurrence({
              bookingId,
              bookingGuestId: guest.id,
              evidence,
              guestTotalCents: guest.priceCents,
              surrenderedNightDates,
              addedNightDates: [],
            }),
          ];
        }
        if (guest.id !== guestId) return [];
        return [
          counterpartStrandReviewOccurrence({
            bookingId,
            bookingGuestId: guest.id,
            evidence,
            guestTotalCents: guest.priceCents,
            surrenderedNightDates,
            addedNightDates: [],
          }),
        ];
      });

  const choreWarnings = await removeGuestChoreAssignments(tx, guestId);

  await tx.bookingGuest.delete({ where: { id: guestId } });

  const remainingGuests = booking.guests.filter((guest) => guest.id !== guestId);
  const seasonRateData = await loadSeasonRateData(tx, bookingLodgeId);

  const guestsForPricing = remainingGuests.map((guest) => ({
    bookingGuestId: guest.id,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    // Price remaining guests over exactly the nights they hold (#1093):
    // their stored night set (or stay envelope for pre-#713 guests without
    // rows), never the full booking range — removing one guest must not grow
    // phantom nights on a partial-stay guest who stays behind.
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights && guest.nights.length > 0 ? guest.nights : null,
    // Remaining guests keep their booked nightly prices (#1036): removing a
    // guest must return exactly that guest's own price, policy permitting.
    lockedNightPrices: lockedNightPricesForGuest(guest),
  }));
  const seasonYear = seasonYearOfStoredDate(booking.checkIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
    // Finding 2 (privacy re-review of MG3 #2308): a member removing a guest must
    // not be told the NAME and membership category of a beyond-family member
    // still on the booking; an admin doing the same is entitled to both.
    //
    // A CONSENT-AUTHORITY removal is exempt as well, and for a different reason
    // than the admin one. It is a decline, an expiry sweep or a delegate answer:
    // the acting party is the member being taken OFF the booking, or the cron,
    // and the refusal message is carried back as the operator-visible reason a
    // PENDING row could not be released (D-15's exception list). Collapsing it
    // would blank that reason for the person who has to act on it while
    // disclosing nothing to anybody new — the target can already see the whole
    // booking and its other guests, which is exactly what D-11 tells them before
    // they agree.
    skipAuthorization: actorRole === "ADMIN" || Boolean(consentAuthority),
  });

  // #2543 — the paid-up-adult requirement, re-evaluated over what is LEFT.
  //
  // The requirement used to be checked on additive writes only, so any party
  // could reach the forbidden state in two requests: book with a paid-up adult
  // member (allowed, the unpaid member repriced on the strength of their
  // presence), then remove that adult. Nothing re-evaluated, and no admin review
  // was raised.
  //
  // REFUSED ONLY FOR A VOLUNTARY REMOVAL. A consent DECLINE or EXPIRY must always
  // be able to take its target off the booking — that is owner decision D-14, and
  // refusing it would trap a member on a booking they have declined — and an ADMIN
  // is skipped here exactly as on every other #2543 gate, because the person who
  // would approve the override is the person doing the removal. What is left is
  // the case the finding is about: the booking owner, or a member removing
  // themselves, choosing to take the party's last paid-up adult member off it.
  if (actorRole !== "ADMIN" && !consentAuthority) {
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(tx, {
      mode: subscriptionLockoutMode,
      lodgeId: bookingLodgeId,
      seasonYear: seasonYearOfStoredDate(booking.checkIn),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      // Owner decision, 3 Aug 2026. It matters most on this path: an unfinancial
      // owner who removes their OWN guest row would otherwise walk out from under
      // the requirement entirely, leaving a party they still own and still pay for
      // with nobody paid-up on it.
      bookingOwnerMemberId: booking.memberId,
      participants: toSubscriptionLockoutParticipants(remainingGuests),
    });
    if (nonMemberPricing?.violation) {
      // AUDIENCE, not authorisation. This is the ONE #2543 gate whose refusal can
      // be delivered to somebody other than the unfinancial member: a member may
      // take their OWN guest row off a booking they do not own, and the owner arm
      // above can then fire alone. `repricedUnpaidMemberCount: 0` would tell that
      // member — often from another family — that the booking owner's subscription
      // is unpaid, which they can learn nowhere else in the app. The refusal, the
      // wording, the HOLD and the override door are unchanged; only that one count
      // is withheld. See `PaidUpAdultRefusalAudience`.
      throw new PaidUpAdultMemberRequiredError(
        nonMemberPricing.violation,
        booking.memberId === actorMemberId ? "BOOKER" : "OTHER_PARTY_MEMBER",
      );
    }
  }

  // #3123 — the SAME club day the caller resolved before it opened this
  // transaction, re-expressed as the calendar day the promo window and the
  // refund tier are written in. `today` arrives as the UTC-midnight `@db.Date`
  // encoding of that day (`INV-DATE-026`) because the self-removal comparison
  // above is written in `Date`s; `calendarDateOfDateOnlyInstant` is its exact
  // inverse, so this is one day in two encodings and NOT a second reading of
  // the club's clock.
  const todayAtClub = calendarDateOfDateOnlyInstant(today);

  /**
   * #3032 (epic #2797): THE MONEY BLOCK, AND THE ONE BRANCH THAT SKIPS IT.
   *
   * A parked removal performs no reprice, no promotion recalculation and no
   * settlement, and every value below therefore starts at what the booking
   * already stores. That is not a shortcut around the arithmetic — it IS the
   * decision. The credit this path would otherwise compute is a difference of
   * repricings, and on a booking whose stored rows cannot be read that
   * difference is a valuation taken by arithmetic, which epic #2797 prohibits.
   *
   * NOTHING HERE IS ZERO-AS-A-DECISION either, and the distinction is the one
   * the epic makes by name. `priceDiffCents` falls out as 0 because the
   * booking's total genuinely does not move, not because 0 was chosen as the
   * adjustment: the adjustment is UNKNOWN and is recorded as an OPEN task with
   * a null amount, which is what "not yet known" looks like in this schema. A
   * `$0` credit, a `$0` refund and a `$0` raised amount are all real financial
   * statements and none of them is written here.
   *
   * WHY THE BOOKING'S STORED TOTAL IS LEFT ALONE. Reducing it would require
   * knowing by how much, which is the very question under review; the epic's
   * *"finance state must distinguish pending financial review from a final
   * reconciled booking"* is carried by the OPEN task rather than by a total
   * this function guessed. The guest is off the booking either way — that is
   * the structural half, and it commits.
   */
  let priceBreakdown: Awaited<
    ReturnType<typeof priceBookingGuestsWithMembershipTypePolicy>
  > | null = null;
  let newTotalPriceCents = booking.totalPriceCents;
  let promoResult: Awaited<ReturnType<typeof recalculateBookingPromo>> = {
    newDiscountCents: booking.discountCents,
    newPromoAdjustmentCents: booking.promoAdjustmentCents,
    promoRemoved: false,
    promoCoverage: null,
  };

  if (!parkedFinancialReview) {
    const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
      where: { id: "default" },
    });
    priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: booking.memberId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: guestsForPricing,
      seasons: seasonRateData,
      // Group discount applies to any newly priced nights (#1095); remaining
      // guests' locked nights keep their booked (discount-inclusive) prices, so
      // a party dropping below the minimum never loses a discount it bought.
      //
      // Edit-time mapper (#2770, INV-MOD-026). A removal buys nothing, so on a
      // healthy booking every remaining night is locked and the switch cannot
      // move a cent either way. It is still gated here rather than left on the
      // creation mapper, because ONE value per edit is the invariant: a club with
      // the switch off must not have its add priced one way and its removal
      // another. Where it can be observed is the documented degradation both
      // INV-MOD-005 and INV-MOD-025 already name — a legacy guest with no stored
      // night rows, whose nights price at current rates; with the switch off
      // those rates are undiscounted, which is the club's stated intent for the
      // edit rather than a reprice of history (no stored price is overwritten).
      groupDiscount: toEditTimeGroupDiscountConfig(groupDiscountSetting),
      seasonYear,
      skipAuthorization: actorRole === "ADMIN",
    });
    const repriced = priceBreakdown;
    const guestNightRates = guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: repriced.guests[index].perNightCents,
      nightDates: repriced.guests[index].nightDates,
      // nightDates carry each guest's actual priced nights (partial stays
      // included); firstNight remains the booking's check-in so internal
      // work-party promos date their window from the stay start.
      firstNight: booking.checkIn,
    }));

    newTotalPriceCents = repriced.totalPriceCents;
    // #3031: THE CREDIT IS THE DEPARTING GUEST'S OWN STORED PRICE, and the gate
    // above is what makes it so rather than an assertion here.
    //
    // `newTotalPriceCents` is a reprice of the REMAINING guests, and the credit is
    // the difference against the booking's stored total. That was the defect: a
    // remaining guest whose rows carried no usable price had their nights valued
    // at today's rate, and the whole of that movement landed inside what the
    // member was told was the departing guest's credit.
    //
    // Every remaining night is now locked at what it was sold for before this
    // point is reached, and a locked night short-circuits the season lookup, so
    // the reprice returns each remaining guest's stored total unchanged and the
    // difference is exactly `guestToRemove.priceCents`. It is structural, not
    // policed - there is no state left in which the reprice could move - and it is
    // proved against the REAL pricing engine in
    // `booking-guest-removal-exact-credit.test.ts` rather than re-checked here
    // against a number this function has just derived.
    promoResult = await recalculateBookingPromo({
      tx,
      bookingId,
      booking,
      newTotalPriceCents,
      guestNightRates,
      todayAtClub,
    });
  }

  // Written from the STORED total on the parked branch rather than recomposed
  // from the parked promotion figures. The two agree by construction today, and
  // deriving it would make this line quietly depend on that agreement holding -
  // `priceDiffCents` below is the number every settlement decision reads, and it
  // must be zero on this branch because the booking did not move, not because
  // two expressions happened to cancel.
  const newFinalPriceCents = parkedFinancialReview
    ? booking.finalPriceCents
    : newTotalPriceCents + promoResult.newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  // Owner rule (#1100): a booking left with only non-adults must go through
  // admin approval, even if it was previously paid and approved for a
  // different composition. The self-removing guest is never blocked — the
  // removal proceeds and the booking is flagged with an automatic
  // justification (no written reason can be demanded of someone leaving).
  const reviewUpdate = resolveRemovalReviewUpdate({
    booking,
    actorRole,
    actorMemberId,
    nowFlagged: requiresAdultSupervisionReview(remainingGuests),
    removedGuestName: `${guestToRemove.firstName} ${guestToRemove.lastName}`,
  });

  // Settle the reduction through the same policy-based machinery the batch
  // modify path uses (#1014): a captured payment is refunded/credited only up
  // to the cancellation-policy tier for the days until check-in, and the
  // member must choose card vs credit. Previously this path refunded the full
  // guest cost with no policy tier, bypassing the cancellation window that the
  // batch endpoint enforces for the identical economic change.
  //
  // NULL ON A PARKED REMOVAL, and that is what keeps `applyPaymentAdjustments`
  // inert below rather than a second zero literal beside it: with no options and
  // a `priceDiffCents` of 0 its net amount is 0, so it takes no refund branch, no
  // credit branch and no additional-charge branch, updates no payment row, and
  // returns zeros for both Xero legs. The existing machinery is what proves
  // nothing moved, rather than a parallel hand-built result that could drift from
  // it.
  const settlementOptions = parkedFinancialReview
    ? null
    : await calculateModificationSettlementOptions({
        booking: booking as unknown as LoadedBookingForModify,
        netChargeCents: priceDiffCents,
        db: tx, // locked transaction; see `CancellationPolicyDb`
        // #3123 — the refund tier for this reduction, on the club's day.
        todayAtClub,
      });
  if (settlementOptions?.requiresSettlementMethod && !settlementMethod) {
    // A settled booking needs an explicit card/credit election. The only
    // body-less caller is a linked guest self-removing to resolve a night
    // conflict; for an already-paid target the owner's funds must not be
    // settled without their choice, so block and defer to the owner/admin
    // (who edit through the batch flow's chooser).
    throw new BookingGuestRemovalError(
      "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
      400,
    );
  }
  const paymentImpact = await applyPaymentAdjustments(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    priceDiffCents,
    changeFeeCents: 0,
    settlementOptions,
    settlementMethod,
  });

  // Run the same lifecycle transitions the batch path applies (#1041):
  // non-member-hold recalculation (an all-member booking clears its hold),
  // PENDING -> PAYMENT_PENDING inside the hold window, zero-dollar auto-pay
  // with superseded-PaymentIntent cancellation, and review parking (#1100).
  // Parking only ever moves pre-payment bookings to AWAITING_REVIEW; a
  // paid/confirmed booking is flagged for the admin queue without a status
  // change (applyLifecycleTransitions enforces that).
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules:
      actorRole === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status),
    reviewUpdate,
  });

  // NOT WRITTEN ON A PARKED REMOVAL. Every remaining strand keeps the price and
  // the rate snapshot it already carries: there was no reprice, so there is
  // nothing to write, and writing anything here would be the revaluation of a
  // stay nobody edited that the park exists to prevent.
  const repricedGuests = priceBreakdown;
  if (repricedGuests) {
    await Promise.all(
      remainingGuests.map((guest, index) =>
        tx.bookingGuest.update({
          where: { id: guest.id },
          // Overwrite the rate-type snapshot alongside the repriced total
          // (#1930, E4) — unless this guest kept a locked night, in which case
          // the stored snapshot stays, because one item code per guest cannot
          // describe a stay that mixes locked member-rate nights with newly
          // priced ones (#2543). See `rateSnapshotUpdateForRepricedGuest`.
          data: {
            priceCents: repricedGuests.guests[index].priceCents,
            rateMembershipTypeId: rateSnapshotUpdateForRepricedGuest(
              repricedGuests.guests[index],
              guestsForPricing[index]?.lockedNightPrices,
            ),
          },
        })
      )
    );
  }

  const updatedBooking = await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalPriceCents: newTotalPriceCents,
      discountCents: promoResult.newDiscountCents,
      promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
      finalPriceCents: newFinalPriceCents,
      hasNonMembers: lifecycle.hasNonMembers,
      nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
      status: lifecycle.newStatus,
      requiresAdminReview: reviewUpdate.requiresAdminReview,
      adminReviewReason: reviewUpdate.adminReviewReason,
      memberReviewJustification: reviewUpdate.memberReviewJustification,
      adminReviewStatus: reviewUpdate.adminReviewStatus,
      adminReviewNotes: reviewUpdate.adminReviewNotes,
      adminReviewedById: reviewUpdate.adminReviewedById,
      adminReviewedAt: reviewUpdate.adminReviewedAt,
    },
    include: { guests: true, payment: true },
  });

  // #1372: did this removal newly block a paid booking on the minors-only rule?
  // Computed from the pre-removal review state and the freshly written booking.
  const minorsOnlyReviewNewlyFlagged = minorsReviewAlertShouldFire({
    previous: booking,
    updated: updatedBooking,
  });

  await reconcileBedAllocationsForBookingWithLodgeLockHeld({
    bookingId,
    db: tx,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });

  const bookingModification = await tx.bookingModification.create({
    data: {
      bookingId,
      memberId: actorMemberId,
      modificationType: "GUEST_REMOVE",
      previousData: {
        guestCount: booking.guests.length,
        removedGuest: {
          firstName: guestToRemove.firstName,
          lastName: guestToRemove.lastName,
          ageTier: guestToRemove.ageTier,
          isMember: guestToRemove.isMember,
        },
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
      },
      newData: {
        guestCount: updatedBooking.guests.length,
        totalPriceCents: newTotalPriceCents,
        discountCents: promoResult.newDiscountCents,
        promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        settlementMethod: paymentImpact.settlementMethod,
        accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
        policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
        // #2390: the same sentence the member saw when they made the edit,
        // kept on the booking's own history so "why was I charged that?" has
        // an answer months later. Absent unless a cap left somebody out.
        ...(promoResult.promoCoverage
          ? { promoCoverageNote: promoResult.promoCoverage.message }
          : {}),
      },
      priceDiffCents,
      changeFeeCents: 0,
    },
  });

  /**
   * #3032 (epic #2797), REQUIREMENT 1: park the money, atomically with the
   * structural removal that is already written above.
   *
   * INSIDE THIS TRANSACTION AND UNDER THE LOCKS THIS FUNCTION ALREADY HOLDS.
   * `tx` is the caller's interactive transaction, so the guest delete, the
   * booking row, the `BookingModification` anchor and these tasks either all
   * commit or none of them do - which is the first of the two failure modes the
   * issue names ("saving the booking change but losing the fact that money still
   * needs review"). `raiseParkedEditFinancialReviewTasks` re-takes
   * `pg_advisory_xact_lock(1)`, which this function took as its FIRST lock at the
   * top; a transaction-scoped advisory lock is re-entrant, so that costs nothing
   * and adds no ordering edge (`INV-LOCK-002` still reads global -> lodge here).
   *
   * IT CANNOT ROLL THE REMOVAL BACK. The raise is a find-then-create under that
   * lock with a P2002 catch on the occurrence-key index, so a replay returns the
   * task already on file rather than throwing a unique violation out of this
   * transaction callback - which, with no global P2002 mapping in this
   * repository, would surface as a 500 AND undo the structural removal. That is
   * the headline requirement, and it is the reason the raise is shaped that way
   * rather than as a bare `create`.
   *
   * ONE TASK PER PARKED STRAND, not one per removal, and the difference is
   * deliberate. The occurrence key is minted per strand, so per-strand is what
   * "exactly one" can mean idempotently: a replay of this removal re-derives the
   * same keys and creates nothing.
   *
   * THE DEPARTING STRAND IS ALWAYS ONE OF THEM when this removal parks - see
   * `unpriceableStrands` above, where dropping it because its own rows read
   * cleanly is what silently destroyed the departing member's refund. So the task
   * carrying the surrendered nights, and therefore the money, is raised on every
   * parked removal.
   *
   * Where a REMAINING strand is unreadable it gets its own task beside it,
   * because it is a separate question for the admin: that one carries no
   * surrendered nights, and its honest resolution is often DISMISSED ("reviewed,
   * nothing to adjust"), which is a state this feature already has and does not
   * pretend is a payment. Dismissing it no longer discards anything, because the
   * departing guest's money is on its own task.
   *
   * The raise ITSELF - the settlement payment id, the strand's member, the null
   * amount - is `raiseParkedEditFinancialReviewTasks`, and is stated once there
   * rather than four times across the four parked doors (#3166, `INV-SSOT`).
   */
  const financialReviewTaskIds = await raiseParkedEditFinancialReviewTasks({
    booking,
    // The DEPARTING strand is raised for too, and its row is not in the
    // booking's remaining guest list - so it is named here explicitly.
    guests: [guestToRemove, ...booking.guests],
    // A removal adds nobody.
    addedGuests: [],
    // Already empty when this removal did not park (see its own comment).
    occurrences: unpriceableStrands,
    bookingModificationId: bookingModification.id,
    store: tx,
  });

  if (paymentImpact.accountCreditAmountCents > 0) {
    await createBookingModificationCredit(
      booking.memberId,
      paymentImpact.accountCreditAmountCents,
      bookingId,
      bookingModification.id,
      undefined,
      tx,
      booking.payment?.id,
    );
  }

  // #2364. Removing a guest cuts both ways: taking out the only adult member
  // opens a hosting review, and taking out the last non-member guest closes one.
  // Both are derived from the rows this transaction just wrote, using its own
  // client because it holds the global booking lock and the per-lodge lock.
  //
  // #2576 §6: removing the qualifying adult member is the change class the owner
  // names first, and it can strand ANOTHER booking on this account. The
  // disposition travels with the actor — a member is refused and rolled back, an
  // officer is allowed and escalated.
  await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
    ...hostingCoverageActorOptions({
      // #3232: removing a guest moves no dates, so there is no vacated window.
      vacatedRange: null,
      actorRole,
      actorMemberId,
      ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
    }),
  });

  return {
    booking: updatedBooking,
    removedGuest: guestToRemove,
    priceDiffCents,
    refundAmountCents: paymentImpact.refundAmountCents,
    accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
    pendingRefundAmountCents: paymentImpact.pendingRefundAmountCents,
    additionalAmountCents: paymentImpact.additionalAmountCents,
    settlementMethod: paymentImpact.settlementMethod,
    policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    paymentStatus: booking.payment?.status ?? null,
    paymentId: booking.payment?.id ?? null,
    paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
    memberEmail: booking.member.email,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.memberId,
    promoRemoved: promoResult.promoRemoved,
    promoCoverage: promoResult.promoCoverage,
    choreWarnings,
    oldGuestCount: booking.guests.length,
    bookingModificationId: bookingModification.id,
    financialReviewPending: parkedFinancialReview,
    financialReviewTaskIds,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
    minorsOnlyReviewNewlyFlagged,
  };
}

export async function loadSeasonRateData(
  tx: Prisma.TransactionClient,
  lodgeId?: string,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true, ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}) },
    include: { membershipTypeRates: true },
  });

  // #2756: through the shared mapper, which carries the season's `type`. Mapped
  // by hand without it, `summerOnly` — the schema DEFAULT — could never be
  // satisfied, so the guest-removal reprice and the waitlist confirm that shares
  // this loader both priced at the full rate whatever the club had configured.
  return toSeasonRateData(seasons);
}

async function removeGuestChoreAssignments(
  tx: Prisma.TransactionClient,
  guestId: string
) {
  const choreWarnings: string[] = [];
  const lockCandidates = await tx.choreAssignment.findMany({
    where: { bookingGuestId: guestId },
    select: { date: true },
  });

  await lockRosterDates(tx, lockCandidates.map((assignment) => assignment.date));

  const guestAssignments = await tx.choreAssignment.findMany({
    where: { bookingGuestId: guestId },
    include: { choreTemplate: true },
  });

  for (const assignment of guestAssignments) {
    if (
      assignment.status === "CONFIRMED" ||
      assignment.status === "COMPLETED"
    ) {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${formatDateOnly(assignment.date)} was ${assignment.status}`
      );
    }
  }

  await tx.choreAssignment.deleteMany({
    where: { bookingGuestId: guestId },
  });

  return choreWarnings;
}

export async function recalculateBookingPromo({
  tx,
  bookingId,
  booking,
  newTotalPriceCents,
  guestNightRates,
  todayAtClub,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  booking: Prisma.BookingGetPayload<{
    include: {
          promoRedemption: {
            include: {
              guestTargets: { select: { bookingGuestId: true } };
              promoCode: {
                include: {
                  assignments: { select: { memberId: true } };
                  lodges: { select: { lodgeId: true } };
                };
              };
            };
          };
    };
  }>;
  newTotalPriceCents: number;
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    firstNight?: Date | null;
  }>;
  /**
   * The club's own calendar day (#3123, `INV-CONFIG-002`), resolved by whichever
   * caller opened the transaction `tx` belongs to, BEFORE it opened it.
   *
   * REQUIRED. `INV-LOCK-004` names the club timezone as one of only two reads
   * that cannot take a transaction client, and both callers hold the per-lodge
   * capacity key and the promo row lock here. It decides the promotion's
   * validity window inside `validateAndCalculatePromoDiscount`.
   */
  todayAtClub: CalendarDate;
}) {
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoCoverage: PromoCoverageNotice | null = null;

  if (booking.promoRedemption?.promoCode) {
    // Row-lock the promo code and re-read its usage counter before the caps are
    // checked (#2299). Removing guests can drop the booking's benefit to
    // nothing and RELEASE a total-redemptions slot, so this transaction is a
    // promo-counter writer and must serialise with the others. The per-lodge
    // capacity lock is already held, so the order stays lodge -> promo row.
    const promo = await lockAndRefreshPromoCodeUsage(
      tx,
      booking.promoRedemption.promoCode
    );
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: booking.checkIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes,
        lodgeId: bookingLodgeId,
        // #2390: never refuse the edit over somebody else's cap consumption —
        // keep whoever is already benefiting and leave out only new people.
        capOverflow: "coverExisting",
        // #3123 — resolved outside this transaction by the caller.
        todayAtClub,
      },
    );

    if (application.error || !application.discount) {
      promoRemoved = true;
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    } else {
      const discount = application.discount;
      newDiscountCents = discount.discountCents;
      newPromoAdjustmentCents = discount.priceAdjustmentCents;
      promoCoverage = await describePromoCapCoverage(tx, {
        promoCode: promo.code,
        capCoverage: application.capCoverage,
      });

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        discount.freeNightsUsed,
        discount.eligibleGuestCount,
        discount.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved, promoCoverage };
}
