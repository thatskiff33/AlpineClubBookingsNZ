import { queueOrganiserExtraForChange } from "@/lib/organiser-extra-invoice-queue";
import { isUnpaidConfirmedWholeLodge } from "@/lib/booking-payment-flow";
import { postStoredBookingConfirmationLedgerLines } from "@/lib/booking-ledger-confirmation-sync";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import {
  AdminReviewStatus,
  type AgeTier,
  type MemberGuestConsentStatus,
  type Prisma,
} from "@prisma/client";
import { raiseEditRefundHandBackIfOwed } from "@/lib/edit-refund-hand-back";
import { bookingPromoCodeLabel, bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { repriceBookingPromotions } from "@/lib/booking-promotions";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { recordBookingNightAdjustments } from "@/lib/night-adjustment-write";
import {
  d3CompatibleBookingMoneyBuildUpCents,
  readBookingMoneyBuildUp,
  selectLoadedBookingMoneyBuildUp,
} from "@/lib/booking-money-build-up";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";
import {
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { bookingOwner } from "@/lib/booking-owner";
import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import { queueReductionAskFollowUps } from "@/lib/unpaid-ask-billed-offset-note";
import {
  readReductionAgainstUnpaidAsk,
  type RetiredAdditionalAsk,
} from "@/lib/additional-ask-reduction";
import { unpaidAskOffsetHistory } from "@/lib/unpaid-ask-offset-marker";
import { primaryInvoiceSettlementHistory } from "@/lib/booking-primary-invoice-claim";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import {
  activeLifecycleEditRefusal,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  rateSnapshotUpdateForRepricedGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForLifecycle,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { creditGiveBackHistory } from "@/lib/booking-credit-give-back-marker";
import type { SupersededPrimaryPaymentIntent } from "@/lib/booking-payment-cleanup";
import {
  assertNoPendingEditFinancialReview,
  findOpenEditFinancialReviewTask,
} from "@/lib/edit-financial-review";
import {
  editedBookingTotalCents,
  refuseNegativeStoredGuestTotals,
  valuedNightLocksForGuest,
  withUnattachedStrandMoney,
} from "@/lib/edit-night-valuation";
import {
  createBookingModificationCredit,
  requireMemberCreditRecipient,
} from "@/lib/member-credit";
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
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { postModificationLedgerLines } from "@/lib/booking-ledger-modification-sync";
import { computeModificationPricing } from "@/lib/booking-modification-pricing";
import { reserveOrganiserChildModificationRefund } from "@/lib/organiser-child-refund";
import logger from "@/lib/logger";
import {
  pricingSideFromPriceBreakdown,
  pricingSideFromStoredGuests,
  type ModificationLine,
} from "@/lib/booking-modification-lines";
import type { ClubFormat } from "@/lib/club-format";

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
  /**
   * #3371: the minter's own value, carrying what minting it would absorb. The
   * plain figure above is what the emails and the response body read; the two
   * are not interchangeable and only this one may reach
   * `createModificationAdditionalPaymentIntent`.
   */
  additionalAsk: AdditionalAsk;
  /** #3954: the unpaid asks this removal's reduction retired, for the minter to cancel. */
  retiredAdditionalAsks: readonly RetiredAdditionalAsk[];
  /** #3954: the reduction cancelled the unpaid ask outright, for the member's email. */
  unpaidAskCancelled: boolean;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  xeroRefundAmountCents: number;
  appliedCreditGivenBackCents: number;
  /** #3653: see `BookingModificationPaymentContext`. */
  organiserChildRefund: { amountCents: number } | null;
  xeroAdditionalAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  paymentStatus: string | null;
  paymentId: string | null;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  /** The owner's first name, as `bookingOwner()` projects it (#3369). */
  memberFirstName: string;
  /** The booking OWNER, or null when it is owned by an Organisation (#3369). */
  memberId: string | null;
  promoRemoved: boolean;
  // #2390: set only when a usage cap stopped the promotion reaching somebody
  // this edit added; null means everybody the code applies to is covered.
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  oldGuestCount: number;
  bookingModificationId: string;
  /** #3530: the itemised lines the removal stored, or null when it stored none. */
  priceLines: ModificationLine[] | null;
  /**
   * #3032: whether an `EDIT_FINANCIAL_REVIEW` task raised before #4317 is
   * still open on this booking, read inside the transaction that removed the
   * guest, for the member's email. A removal raises none since #4317.
   */
  financialReviewPending: boolean;
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
    // returns to the normal lifecycle, in place — the status is untouched. A
    // self-removal CAN reach an AWAITING_REVIEW booking (it is in
    // `SELF_REMOVABLE_GUEST_BOOKING_STATUSES`), but it can never clear the
    // review there: a no-adult park is all-minor, so any surviving subset
    // stays flagged, and a request hold is refused first by
    // `assertBookingNotQuotePriced`. Only the officer review route releases
    // AWAITING_REVIEW (#3500, `INV-MOD-013`).
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
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
  format,
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
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
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
      payment: { include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } } },
      member: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
        promoRedemptions: {
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
    (bookingOwner(booking).memberId === actorMemberId || actorRole === "ADMIN");
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
   * WHAT THIS BRANCH DOES ABOUT THE MONEY THAT REMOVAL OWES. It prices it,
   * like every removal (#4317): the departing guest's stored total is credited
   * from the booking's own data (`INV-MOD-028`). The open review it passes is
   * left exactly as it was, for its own settle. This exemption's only effect is
   * that such a removal is not turned away by the fence.
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

  // #3245: derived, not restated. A self-removal answers a different question
  // and keeps its own named set (`SELF_REMOVABLE_GUEST_BOOKING_STATUSES`).
  const editRefusal = isSelfRemoval
    ? null
    : activeLifecycleEditRefusal(booking.status, actorRole);
  if (editRefusal) throw new BookingGuestRemovalError(editRefusal, 400);
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

  // #4317 (epic #4302, `INV-MOD-028`): EVERY REMOVAL IS PRICED.
  //
  // The credit is what the removal changes on the guests: every remaining
  // night is locked at its valued figure (`valuedNightLocksForGuest`), so the
  // reprice returns each remaining guest's stored total unchanged and the
  // difference is the departing guest's own `BookingGuest.priceCents` (T2). The
  // headline moves by exactly that, so a total a parked edit froze keeps its gap
  // (`editedBookingTotalCents`, review H1). No remaining guest's night is valued
  // at today's rate, so a rate rise on somebody else's stay cannot move this
  // guest's credit. A consent-authority removal is priced the same way.
  //
  // D11 (review M2): a negative stored guest total, which the database forbids,
  // refuses the removal before anything is read or written.
  refuseNegativeStoredGuestTotals(logger, { bookingId, site: "guest-removal" }, booking.guests);

  // #3277: capture the build-up under the existing global -> lodge locks and
  // before the chore/guest deletes below can cascade any of its target rows.
  // Selection waits until today's existing calculation is available; the input
  // itself is the pre-removal record.
  const recordedMoneyBuildUp = await readBookingMoneyBuildUp(tx, {
    bookingId,
    purpose: "GUEST_REMOVAL",
    bookingGuestId: guestId,
  });

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
    // Remaining guests keep their valued nightly prices (#1036, #4317):
    // removing a guest must return exactly that guest's own price, policy
    // permitting.
    ...valuedNightLocksForGuest(guest, booking),
  }));
  const seasonYear = seasonYearOfStoredDate(booking.checkIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: bookingOwner(booking).memberId,
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
      bookingOwnerMemberId: bookingOwner(booking).memberId,
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
        bookingOwner(booking).memberId === actorMemberId ? "BOOKER" : "OTHER_PARTY_MEMBER",
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

  // THE MONEY BLOCK. Every removal reprices whoever is left, re-runs the
  // promotion over them, and settles the difference (#4317).
  const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  // #4317: a remaining strand holding no night keeps its stored total on itself.
  const priceBreakdown = withUnattachedStrandMoney(
    await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: bookingOwner(booking).memberId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: guestsForPricing,
      seasons: seasonRateData,
      // Group discount applies to any newly priced nights (#1095); remaining
      // guests' locked nights keep their booked (discount-inclusive) prices, so
      // a party dropping below the minimum never loses a discount it bought.
      //
      // Edit-time mapper (#2770, INV-MOD-026). A removal buys nothing, so every
      // remaining night is locked at its valued figure and the switch cannot
      // move a cent either way. It is still gated here rather than left on the
      // creation mapper, because ONE value per edit is the invariant: a club
      // with the switch off must not have its add priced one way and its
      // removal another.
      groupDiscount: toEditTimeGroupDiscountConfig(groupDiscountSetting),
      seasonYear,
      skipAuthorization: actorRole === "ADMIN",
    }),
    guestsForPricing,
  );
  const repriced = priceBreakdown;
  // Each guest's own priced row, read once. The breakdown was built from
  // `guestsForPricing`, so a guest with no row is a wiring defect and there
  // is no amount to promo-allocate against — refused, not guessed (#2800).
  const guestNightRates = guestsForPricing.map((guest, index) => {
    const priced = repriced.guests[index];
    if (priced === undefined) {
      throw new Error(
        `Guest removal reprice has no priced guest at breakdown position ${index} of ${repriced.guests.length} (#3031).`,
      );
    }
    return {
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priced.perNightCents,
      nightDates: priced.nightDates,
      // nightDates carry each guest's actual priced nights (partial stays
      // included); firstNight remains the booking's check-in so internal
      // work-party promos date their window from the stay start.
      firstNight: booking.checkIn,
      // #3827 (D-3813-4): a guest still awaiting acceptance takes no code.
      consentStatus: remainingGuests[index]!.consentStatus,
    };
  });

  // THE CREDIT IS THE DEPARTING GUEST'S OWN STORED PRICE, structurally:
  // every remaining night is locked at its valued figure, which short-circuits
  // the season lookup, so the reprice returns each remaining guest's stored
  // total unchanged, and the headline moves by exactly
  // `guestToRemove.priceCents` — whatever gap a parked edit left between the
  // headline and its guests stays where it was (review H1). Proved against the
  // REAL pricing engine in `booking-guest-removal-exact-credit.test.ts`.
  const newTotalPriceCents = editedBookingTotalCents(booking, repriced.totalPriceCents);
  const promoResult = await recalculateBookingPromo({
    tx,
    bookingId,
    booking,
    newTotalPriceCents,
    guestNightRates,
    todayAtClub,
  });
  // #3276: the remaining guests' nights are untouched by a removal, so only
  // the build-up is rewritten — from the engine's fresh decision over exactly
  // those guests.
  await recordBookingNightAdjustments(tx, {
    format,
    bookingId,
    guestIds: guestsForPricing.map((guest) => guest.bookingGuestId),
    targets: promoResult.adjustmentTargets,
    writer: "guest removal",
  });

  const newFinalPriceCents = bookingFinalPriceCents({
    totalPriceCents: newTotalPriceCents,
    promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
  });
  const derivedPriceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  const moneyBuildUpSelection = selectLoadedBookingMoneyBuildUp(recordedMoneyBuildUp, {
    derivedCents: derivedPriceDiffCents,
    // A valid old build-up can differ when the surviving promo is re-capped
    // or redistributed. D3 keeps today's existing result in that case.
    mismatchClassification: "LEGITIMATE_DIVERGENCE",
  });

  // The canonical decision is complete while the departing guest and all of
  // its targets still exist. Only now may the destructive half start.
  const choreWarnings = await removeGuestChoreAssignments(tx, guestId);
  await tx.bookingGuest.delete({ where: { id: guestId } });
  const priceDiffCents = d3CompatibleBookingMoneyBuildUpCents(moneyBuildUpSelection);
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
  // #3954: the unpaid ask, read ONCE for this removal and handed to both the
  // options and the save, so a capture between two reads cannot split them.
  const reduction = await readReductionAgainstUnpaidAsk(tx, booking, priceDiffCents);
  const settlementOptions = await calculateModificationSettlementOptions({
    booking: booking as unknown as LoadedBookingForModify,
    netChargeCents: priceDiffCents,
    reduction,
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
    reduction,
    settlementOptions,
    settlementMethod,
    todayAtClub,
    format,
  });

  // Run the same lifecycle transitions the batch path applies (#1041):
  // non-member-hold recalculation (an all-member booking clears its hold),
  // PENDING -> PAYMENT_PENDING inside the hold window, zero-dollar auto-pay
  // with superseded-PaymentIntent cancellation, and review parking (#1100).
  // Parking only ever moves pre-payment bookings to AWAITING_REVIEW; a
  // paid/confirmed booking is flagged for the admin queue without a status
  // change (applyLifecycleTransitions enforces that).
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: booking as unknown as LoadedBookingForLifecycle,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    // A removal records no change fee on an unpaid payment (`INV-PAY-119`).
    feeRecordedByThisEditCents: 0,
    format,
    guestsForPricing,
    skipBookingLifecycleRules:
      actorRole === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status),
    reviewUpdate,
  });

  // Every remaining strand's total is written from the reprice, which returns
  // its stored total (every held night is locked at its valued figure), and its
  // night rows are left as they are: a removal changes nobody else's nights.
  await Promise.all(
    remainingGuests.map((guest, index) => {
      // Same rule as the reprice above (#3031): this row's stored total is
      // written straight from the breakdown, so a guest the engine produced
      // no row for has no total and no safe substitute (#2800).
      const priced = priceBreakdown.guests[index];
      if (priced === undefined) {
        throw new Error(
          `Guest removal reprice has no priced guest at breakdown position ${index} for booking guest ${guest.id} (#3031).`,
        );
      }
      return tx.bookingGuest.update({
        where: { id: guest.id },
        // Overwrite the rate-type snapshot alongside the repriced total
        // (#1930, E4) — unless this guest kept a locked night, in which case
        // the stored snapshot stays, because one item code per guest cannot
        // describe a stay that mixes locked member-rate nights with newly
        // priced ones (#2543). See `rateSnapshotUpdateForRepricedGuest`.
        data: {
          priceCents: priced.priceCents,
          rateMembershipTypeId: rateSnapshotUpdateForRepricedGuest(
            priced,
            guestsForPricing[index]?.lockedNightPrices,
          ),
        },
      });
    })
  );

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

  /**
   * #3530: the lines behind `priceDiffCents`. BEFORE is every guest this
   * transaction loaded, the removed one included, from the in-memory rows (the
   * removed guest's night rows are gone by now); AFTER is the remaining guests
   * as the breakdown priced them, index-aligned with `guestsForPricing`.
   */
  const { priceLines, sides: pricingSides } =
    await computeModificationPricing(
          { bookingId, site: "guest-removal", promoCodes: { store: tx, before: booking } },
          () => {
            const promoCode = bookingPromoCodeLabel(booking);
            return {
              before: pricingSideFromStoredGuests(booking.guests, {
                promoAdjustmentCents: booking.promoAdjustmentCents,
                promoCode,
              }),
              after: pricingSideFromPriceBreakdown(
                remainingGuests.map((guest) => ({
                  guestKey: guest.id,
                  name: `${guest.firstName} ${guest.lastName}`.trim(),
                })),
                priceBreakdown.guests,
                {
                  promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
                  promoCode: promoResult.remainingPromoCodeLabel,
                },
              ),
            };
          },
          priceDiffCents,
          logger,
        );

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
        ...creditGiveBackHistory(paymentImpact.appliedCreditGiveBack),
        // #3954: what an unpaid ask took of this reduction, for the Xero repair pass.
        ...unpaidAskOffsetHistory(paymentImpact),
        ...primaryInvoiceSettlementHistory(paymentImpact), // #3980: the gap's anchor
        // #2390: the same sentence the member saw when they made the edit,
        // kept on the booking's own history so "why was I charged that?" has
        // an answer months later. Absent unless a cap left somebody out.
        ...(promoResult.promoCoverage
          ? { promoCoverageNote: promoResult.promoCoverage.message }
          : {}),
        ...moneyBuildUpSelection.historyMetadata,
      },
      priceDiffCents,
      changeFeeCents: 0,
      ...(priceLines ? { priceLines } : {}),
    },
  });

  // #3582: the same before and after, per night, on the booking ledger — under
  // the `lock(1)` this function took first.
  await queueOrganiserExtraForChange(tx, booking, bookingModification);
  await postModificationLedgerLines({
    store: tx,
    bookingId,
    lodgeId: booking.lodgeId,
    bookingModification,
    sides: pricingSides,
    site: "guest-removal",
  });
  // #4019: this new whole-lodge PAID path bypasses the ordinary settle.
  // Post after guest/night writes and the edit, at the final price only.
  if (lifecycle.zeroDollarAutoPaid && isUnpaidConfirmedWholeLodge(booking)) {
    await postStoredBookingConfirmationLedgerLines(tx, bookingId);
  }

  // D-3813-6 (`INV-PAY-117`): a reduction on a booking paid by internet
  // banking or by hand asks the treasurer to send it back.
  await raiseEditRefundHandBackIfOwed(tx, {
    bookingId,
    paymentId: booking.payment?.id ?? null,
    bookingModificationId: bookingModification.id,
    adjusted: paymentImpact,
    editLabel: "guest removal", booking, // #3949: booking names the payee (a group organiser who paid by bank transfer)
  });
  // #3954: a smaller re-issued ask, and the note for an offset Xero had
  // already billed, are durable from this commit, not from after it.
  await queueReductionAskFollowUps(tx, {
    bookingId,
    paymentId: booking.payment?.id ?? null,
    bookingModificationId: bookingModification.id,
    settled: paymentImpact,
  });

  /**
   * Whether this booking's money still sits under an earlier review as the
   * member's email is written: a review task raised before #4317 that is still
   * open (waves B and C retire them). This removal raises none — it priced.
   * Only a consent removal can get here with one open, because every other
   * removal is fenced on exactly that question above; it is asked under the
   * locks this transaction holds, so the answer is the one it committed beside.
   */
  const financialReviewPending = consentAuthorityApplies
    ? (await findOpenEditFinancialReviewTask(bookingId, tx)) !== null
    : false;

  if (paymentImpact.accountCreditAmountCents > 0) {
    await createBookingModificationCredit(
      requireMemberCreditRecipient(bookingOwner(booking).memberId),
      paymentImpact.accountCreditAmountCents,
      bookingId,
      bookingModification.id,
      undefined,
      tx,
      booking.payment?.id,
    );
  }
  // #3653: an organiser-settled child's refund debt, before this edit commits.
  await reserveOrganiserChildModificationRefund(tx, {
    plan: paymentImpact.organiserChildRefund,
    bookingId,
    payment: booking.payment,
    bookingModificationId: bookingModification.id,
  });

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
    additionalAsk: paymentImpact.additionalAsk,
    retiredAdditionalAsks: paymentImpact.retiredAdditionalAsks,
    unpaidAskCancelled: paymentImpact.unpaidAskCancelled,
    settlementMethod: paymentImpact.settlementMethod,
    policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    appliedCreditGivenBackCents: paymentImpact.appliedCreditGivenBackCents,
    organiserChildRefund: paymentImpact.organiserChildRefund,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    paymentStatus: booking.payment?.status ?? null,
    paymentId: booking.payment?.id ?? null,
    paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
    memberEmail: bookingOwner(booking).member.email,
    memberName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
    memberFirstName: bookingOwner(booking).member.firstName,
    memberId: bookingOwner(booking).memberId,
    promoRemoved: promoResult.promoRemoved,
    promoCoverage: promoResult.promoCoverage,
    choreWarnings,
    oldGuestCount: booking.guests.length,
    bookingModificationId: bookingModification.id,
    priceLines,
    financialReviewPending,
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
          promoRedemptions: {
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
    /** #3276: REQUIRED, so an adjustment row can be attributed to a night by date. */
    nightDates: Date[];
    firstNight?: Date | null;
    /** #3827 (D-3813-4): REQUIRED — only a guest actually staying can benefit. */
    consentStatus: MemberGuestConsentStatus | null;
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
  // #3827: every code the booking carries, in its stored order, through the
  // one re-price (`booking-promotions.ts`) — which row-locks every code in one
  // sorted call and re-reads each counter under it (INV-MONEY-023). The
  // per-lodge capacity lock is already held, so the order stays lodge -> promo
  // rows. A code that no longer applies is released on its own.
  const redemptions = bookingPromoRedemptions(booking).filter(
    (redemption) => redemption.promoCode,
  );
  return repriceBookingPromotions(tx, {
    bookingId,
    redemptions,
    memberId: bookingOwner(booking).memberId,
    bookingCheckIn: booking.checkIn,
    totalPriceCents: newTotalPriceCents,
    guests: guestNightRates,
    lodgeId:
      redemptions.length > 0 ? booking.lodgeId ?? (await getDefaultLodgeId(tx)) : booking.lodgeId,
    todayAtClub,
  });
}
