import {
  type Booking,
  type BookingGuest,
  type Payment,
  PaymentSource,
  type PaymentStatus,
  type Role,
} from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api-error";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";
import {
  applyChoreCleanup,
  applyGuestChanges,
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  applyPromoCodeChanges,
  assertBookingModifiable,
  calculateModificationSettlementOptions,
  BookingModificationSettlementMethodRequiredError,
  calculateModificationChangeFee,
  calculateModifiedPricing,
  loadActiveSeasonRates,
  prepareGuestPlan,
  resolveGuestNameUpdates,
  resolveTargetDates,
  type BatchModifyInput,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
  type ResolvedGuestNameUpdate,
  type PricingResult,
  isBookingFullyPaidForGuestNameEdits,
  isMemberWholeLodgeBooking,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
} from "@/lib/booking-modify";
import {
  requestCarriesOtherLodgeElection,
  requestIsOtherLodgeRateElectionOnly,
} from "@/lib/booking-other-lodge-rate";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";
import { getDefaultLodgeId } from "@/lib/lodges";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import {
  sendAdminMinorsOnlyReviewAlert,
  sendBookingModifiedEmail,
} from "@/lib/email";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
} from "@/lib/booking-review";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import logger from "@/lib/logger";
import { createBookingModificationCredit } from "@/lib/member-credit";
import {
  CreditElectionNotAllowedError,
  resolveCreditElectionUpdate,
} from "@/lib/booking-credit-election";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { prisma } from "@/lib/prisma";
import {
  withOptionalTransaction,
  type PrismaTransactionClient,
} from "@/lib/db-transaction";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate,
} from "@/lib/xero-period-lock-guard";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  type MemberGuestAddNotificationRow,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import {
  lockRosterDateRangesAndDates,
  rosterOperationalDayRange,
} from "@/lib/roster-lock";
import { formatDateOnly } from "@/lib/date-only";

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type BatchModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    promoRemoved: boolean;
    promoChanged: boolean;
    // #2390: set only when a usage cap stopped the promotion reaching somebody
    // on the repriced booking; null means everyone it applies to is covered.
    promoCoverage: PromoCoverageNotice | null;
    choreWarnings: string[];
    datesChanged: boolean;
    adminOverride: boolean;
    notifyMember: boolean;
    capacityOverridden: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    oldGuestCount: number;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    zeroDollarAutoPaid: boolean;
    supersededPrimaryPaymentIntents: { length: number };
    xeroAdditionalAmountCents: number;
    xeroRefundAmountCents: number;
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    guestNameUpdates: ResolvedGuestNameUpdate[];
    guestIdentityChanged: boolean;
    identityOnlyModification: boolean;
    // #2266: this edit changed ONLY the stored credit election (#2265) — no
    // member email, exactly like an identity-only edit.
    creditElectionOnlyModification: boolean;
    // #2266: the election as stored after this edit, and whether it moved.
    creditElectionCents: number | null;
    creditElectionChanged: boolean;
    // #1372: this edit newly dropped a paid (capacity-holding) booking into the
    // blocked minors-only review state, so the post-tx step alerts admins.
    minorsOnlyReviewNewlyFlagged: boolean;
    // MG2 #2307: cross-family member guests added by this edit, to be told after
    // the commit. Empty on every family-scope modification.
    memberGuestNotificationRows: MemberGuestAddNotificationRow[];
    // MG4 #2309: cross-family member guests this edit took OFF the booking, to
    // be told after the commit. Empty on every family-scope modification.
    withdrawnMemberGuests: Array<{
      targetMemberId: string;
      context: "REQUEST_CANCELLED" | "TAKEN_OFF";
    }>;
  };

export type BatchModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  additionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoChanged: boolean;
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  // #2266: the stored credit election (#2265) after this edit, so the panel
  // can confirm what was remembered without a second fetch.
  creditElectionCents: number | null;
  /**
   * Present ONLY in tx-mode (#2525): the post-commit provider work (Stripe
   * refund, additional PaymentIntent, member/notification emails, Xero
   * settlement, superseded-intent drain, change-request linkage, audit) the
   * service deferred because the caller owns the commit. The atomic
   * approve-and-execute path MUST run it after committing. Absent in standalone
   * mode, where the service already ran those effects and the provider-derived
   * fields (`stripeRefundId`, `additionalPaymentClientSecret`) are populated.
   */
  deferredPostCommit?: () => Promise<void>;
};

/**
 * Pricing echo for identity-only modifications (#1099): stored totals,
 * per-guest prices, and night rows exactly as persisted, in booking-guest
 * order (matching proposedRemainingGuests when nothing is added or removed).
 * Guests without night rows (quoted or pre-#713 bookings) echo empty night
 * arrays, which the guest-sync step treats as "leave the rows alone".
 */
function buildIdentityOnlyPricing(booking: LoadedBookingForModify): PricingResult {
  return {
    inProgressPlan: null,
    capacityOverridden: false,
    newTotalPriceCents: booking.totalPriceCents,
    priceBreakdown: {
      totalPriceCents: booking.totalPriceCents,
      guests: booking.guests.map((guest) => ({
        priceCents: guest.priceCents,
        perNightCents: (guest.nights ?? []).map((night) => night.priceCents ?? 0),
        nightDates: (guest.nights ?? []).map((night) => night.stayDate),
      })),
    },
    guestNightRates: booking.guests.map((guest) => ({
      bookingGuestId: guest.id,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: (guest.nights ?? []).map((night) => night.priceCents ?? 0),
      nightDates: (guest.nights ?? []).map((night) => night.stayDate),
    })),
    // Nothing was rated here — this echo does not run the rate resolver at all.
    // A request carrying an other-lodge election is therefore kept OFF this path
    // (see `pricePreservingModification` below): storing the flag from an echo
    // would stamp a re-rate the money never made.
    otherLodgeRatedGuestIds: new Set<string>(),
  };
}

export async function modifyBookingBatch({
  bookingId,
  actor,
  approvedExceptionAdultMemberHostingDecision,
  hostingCoverageOverride,
  input,
  ipAddress,
  todayAtClub,
  tx: callerTx,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  /**
   * The attributable decision already made by an approved hosting-policy
   * exception. It bypasses ENFORCED refusal for this booking only; the service
   * still records/reopens the authoritative review before the approval executor
   * performs its guarded PENDING -> APPROVED claim.
   */
  approvedExceptionAdultMemberHostingDecision?: {
    reason: string;
    byMemberId: string;
  } | null;
  /**
   * #2576 §7: the officer's explicit confirmation and mandatory reason for
   * overriding a same-owner coverage refusal. Ignored for a non-officer actor, so a
   * member cannot self-authorise past §6's block by inventing a reason.
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  input: BatchModifyInput;
  ipAddress: string;
  /**
   * The CLUB's calendar day (`INV-CONFIG-002`), resolved by the caller before it
   * opened ANY transaction. REQUIRED, with no default.
   *
   * WHY THE CALLER RESOLVES IT AND NOT THIS FUNCTION (`INV-LOCK-004`, #3123
   * review). This service is transaction-AWARE: `withOptionalTransaction` below
   * runs its callback inside `tx` when the caller supplies one, and opens its
   * own `prisma.$transaction` only when the caller does not. So the ordinary
   * reading of "the read sits above the `withOptionalTransaction` call,
   * therefore it is outside the transaction" is FALSE on the caller-supplied
   * path: by the time control reaches this function
   * `approveAndExecutePolicyExceptionRequest` already holds
   * `pg_advisory_xact_lock(1)` and the per-lodge capacity key, and a
   * `clubTimeSettings` read on the module client would take a SECOND pooled
   * connection under both. There is no position inside this function that is
   * outside the transaction on every path, which is precisely why the day has
   * to arrive as a value.
   *
   * FIVE decisions inside the transaction read this one day and they must all
   * agree: the edit policy's gate, the promotion's validity window
   * (`applyPromoCodeChanges`), the late-notice change fee's tier
   * (`calculateModificationChangeFee`), the reduction refund's settlement tier
   * (`calculateModificationSettlementOptions`), and the person-night guard's
   * self-removal window inside `prepareGuestPlan`. Three of them move money, so
   * two todays here would be a batch edit priced against itself.
   */
  todayAtClub: CalendarDate;
  /**
   * Caller-supplied transaction (#2525). When present, the modification runs
   * inside it — so an atomic approve-and-execute can release a policy-exception
   * reservation, claim the request status, and apply the modification in ONE
   * transaction with no mark-approved-then-call gap — and the provider work is
   * returned as `deferredPostCommit` instead of firing inline. Absent for every
   * existing caller (route + on-behalf), which keeps behaviour byte-identical.
   * The supplier has ALREADY taken global lock(1) and the per-lodge lock; the
   * two `pg_advisory_xact_lock(1)` / `acquireLodgeCapacityLock` acquisitions
   * below re-enter those same keys (no-ops), preserving the global→lodge order.
   */
  tx?: PrismaTransactionClient;
}): Promise<BatchModificationResponse> {
  // Issue #1668: admin-only date override. The route also rejects non-admins,
  // but keep the service guard so the invariant holds however it is called.
  if (input.adminOverride && actor.role !== "ADMIN") {
    throw new ApiError("Admin override is not available for this account", 403);
  }
  const adminOverride = Boolean(input.adminOverride) && actor.role === "ADMIN";
  // #1746: partner-shared admission is admin-initiated by owner decision —
  // the reserved slots (#1745) must be unreachable from member self-service
  // however the service is called.
  if (input.partnerSharedGuests?.length && actor.role !== "ADMIN") {
    throw new ApiError(
      "Partner-shared placement is not available for this account",
      403,
    );
  }
  // Owner decision (#1668/#1696): an admin chooses per edit whether the member is
  // emailed — on override AND plain edits — with absent meaning notify. A
  // non-admin actor can never suppress (the route 403s any notify flag), so they
  // always notify (unchanged).
  const notifyMember =
    actor.role !== "ADMIN" ? true : input.notifyMember !== false;
  if (adminOverride) {
    // Date-only contract: an override edit may change ONLY the dates. Any guest
    // or promo input is rejected so preview/apply mirroring stays tractable.
    if (
      input.addGuests?.length ||
      input.removeGuestIds?.length ||
      input.guestStayRanges?.length ||
      input.guestUpdates?.length ||
      // #2337: a placeholder→member link is a guest change, never a date override.
      input.linkGuestToMember?.length ||
      input.promoCode ||
      input.promoGuestIds?.length ||
      input.promoAddedGuestIndexes?.length ||
      input.removePromoCode ||
      // #2266: an explicit undefined-check — a 0-cent election is falsy.
      input.applyCreditCents !== undefined
    ) {
      throw new ApiError("Admin override edits change dates only", 400);
    }
    if (!input.pricingMode) {
      throw new ApiError("Choose a pricing mode for the admin override", 400);
    }
    // "shift" is dispatched to adminShiftBookingDates at the route and must
    // never reach the recalculate machinery here.
    if (input.pricingMode === "shift") {
      throw new ApiError(
        "Shift-mode admin overrides are applied through the date-shift path",
        400,
      );
    }
    // Xero lock-date guard (#1697): a recalculate override can queue a
    // check-in-dated primary-invoice write (date/narration update on unpaid
    // bookings; create on zero-dollar ones), so the proposed check-in must
    // clear the effective lock date — same semantics as the retroactive
    // create (#1695). Deliberately conservative: it fires on every recalculate
    // override even when the settlement would only write today-dated documents
    // (decision on #1697, re-affirmed on #1718). Shift mode writes no Xero
    // documents and is never guarded. Runs before the transaction: the Xero
    // call must stay outside it, and the pre-read is only advisory (the outbox
    // still fails safely if the lock dates change mid-flight).
    await assertProposedCheckInClearsXeroLockDate(
      prisma,
      bookingId,
      input.checkIn,
    );
  } else {
    // Ordinary edits (#1729) get the NARROW guard instead, also before the
    // transaction: it consults the lock dates only when this edit would
    // actually queue the check-in-dated invoice update (issued Xero invoice +
    // dates changing + payment not settled — the settlement classifier's own
    // predicate), with member-appropriate error text for non-admin actors.
    // Identity-only edits (guest name fixes, no date fields) never trigger
    // it — the outbox backstop covers that rare strand instead of blocking a
    // typo fix.
    await assertProposedDateEditClearsXeroLockDate(
      prisma,
      bookingId,
      { checkIn: input.checkIn, checkOut: input.checkOut },
      {
        audience: actor.role === "ADMIN" ? "admin" : "member",
        actorMemberId: actor.id,
      },
    );
  }

  // "+ Add Member Guest" (epic #2305, MG2 #2307). Read the module flag and the
  // policy singleton HERE, before the transaction below takes the global money
  // lock and the per-lodge capacity lock — see the ordering rule in
  // `member-guest-add-policy.ts`. `prepareGuestPlan` takes the answer as a value,
  // so there is no way for it to reach for the database itself.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  // #2543 — the club's subscription-lockout mode, resolved here for exactly the
  // same reason and passed the same way: as a value the in-transaction planner
  // cannot reach for the database to obtain. `resolveSubscriptionLockoutMode` may
  // refresh the financial-year cache from Xero, which must never happen inside the
  // transaction below.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();
  // #3123 — the caller's club day, encoded at UTC midnight so it shares a frame
  // with the stored `@db.Date` columns the edit policy compares against
  // (`INV-DATE-026`). The day itself is a REQUIRED parameter; its docblock says
  // why this function may not resolve one for itself.
  const clubTodayDateOnly = dateOnlyInstantOf(todayAtClub);
  // MG4-D-a, brought forward: an ADMIN actor is the one that passes
  // `skipAuthorization`, so its cross-family adds are consent-free and
  // always-notify, stamped with the acting admin.
  // #2526: a policy-exception approval passes `reviewedMemberProposal`, so
  // its cross-family adds are NOT consent-free — the notification/consent actor
  // must agree with the guest plan's own decision (see the flag's docblock).
  const memberGuestActor: MemberGuestAddActor =
    actor.role === "ADMIN" && input.reviewedMemberProposal !== true
      ? { kind: "ADMIN", adminMemberId: actor.id }
      : { kind: "MEMBER" };

  const result = await withOptionalTransaction(callerTx, async (tx) => {
    // Two-tier lock protocol (#1881). A batch modification moves money (reduction
    // refunds / additional charges, credit allocation) AND re-checks/claims
    // capacity, so it takes BOTH locks: the global lock(1) FIRST so it mutually
    // excludes cancel / settlement / hold-release (which serialise on lock(1)),
    // then the per-lodge lock for the capacity check. Before #1881 this took only
    // the per-lodge lock, so a concurrent cancel of the same booking (on lock(1))
    // could interleave and both paths compute a refund against the same captured
    // payment, or the modify's status commit could clobber a just-cancelled
    // booking.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying the
    // per-lodge lock from this read is safe; the eligibility checks, pricing,
    // capacity check and claim below all run against the post-lock re-read.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; everything below consumes ONLY
    // this post-lock snapshot.
    const booking = (await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        // Per-night sets (issue #713): preserve unedited guests' gaps and
        // re-sync edited guests' nights. Deterministic order (#2266 MED-4):
        // pricing, promo targeting and the client's guest list must all agree
        // on guest order, so never rely on the planner's unordered scan.
        guests: {
          include: { nights: { select: { stayDate: true, priceCents: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
        payment: true,
        member: true,
        promoRedemption: {
          include: {
            promoCode: {
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
            },
            guestTargets: { select: { bookingGuestId: true } },
          },
        },
      },
    })) as LoadedBookingForModify | null;

    assertBookingModifiable(booking, {
      role: actor.role,
      actorId: actor.id,
    });
    // Identity-only requests (guest name fixes, nothing structural) never
    // reprice (#1099), so they are allowed on quote-priced bookings: the
    // negotiated basis cannot be disturbed by an edit that skips the pricing
    // engine entirely.
    const requestedStructuralChange = Boolean(
      input.checkIn ||
        input.checkOut ||
        input.addGuests?.length ||
        input.removeGuestIds?.length ||
        input.guestStayRanges?.length ||
        // #2337: a link re-rates a guest, so it is structural — it must never take
        // the identity-only price-preserving echo (that would skip the re-rate).
        input.linkGuestToMember?.length ||
        input.promoCode ||
        input.removePromoCode,
    );
    const requestIsIdentityOnly =
      !requestedStructuralChange && Boolean(input.guestUpdates?.length);
    // #2266: a credit election with nothing structural is price-preserving by
    // construction — it only writes Booking.creditElectionCents (#2265) — so
    // it must not run the pricing engine (a season-rate change would silently
    // reprice an untouched booking) and is safe on quote-priced bookings.
    const requestIsCreditElectionOnly =
      !requestedStructuralChange &&
      !input.guestUpdates?.length &&
      input.applyCreditCents !== undefined;
    // #2337: the placeholder→member link. The synchronous gate (admin,
    // whole-lodge, placeholder-only) runs inside `prepareGuestPlan`; the
    // member-ORIGIN fence runs here, where the DB is in hand. A SCHOOL whole-lodge
    // booking also carries `wholeLodgeHold`, so without this a student row could
    // be re-rated at a member rate — corrupting the school's negotiated price.
    const hasLinks = Boolean(input.linkGuestToMember?.length);
    const memberWholeLodgeForLink = hasLinks
      ? await isMemberWholeLodgeBooking(tx, bookingId)
      : false;
    if (hasLinks && !memberWholeLodgeForLink) {
      throw new ApiError(
        "Linking a placeholder to a member is only available on member whole-lodge bookings.",
        400,
      );
    }
    // A member whole-lodge booking is quote-priced (its placeholders were
    // flat-split at approval), but a link-only request is EXACTLY the sanctioned
    // re-rate of those placeholders, so it is exempt from the quote-priced block
    // the same way an identity-only edit is. The exemption is link-ONLY: a link
    // combined with a date/add/remove/promo change on a quote-priced booking is
    // still refused, because those DO disturb the negotiated basis.
    const requestIsMemberLinkExempt =
      hasLinks &&
      memberWholeLodgeForLink &&
      !(
        input.checkIn ||
        input.checkOut ||
        input.addGuests?.length ||
        input.removeGuestIds?.length ||
        input.guestStayRanges?.length ||
        input.promoCode ||
        input.removePromoCode
      );
    /**
     * The other-lodge election, exempt on exactly the link's terms (owner
     * decision, 21 Aug 2026).
     *
     * THIS EXEMPTION WAS MISSING, and its absence broke the feature's headline
     * case. `modify-quote` has carried one since the Other Lodges epic, so an
     * election-only edit on a quote-priced booking PREVIEWED 200 and then SAVED
     * 400 — on precisely the bookings these guests arrive through, since the
     * public request form is what asks "are you a member of another lodge?".
     * #2978 did not cause that, but it widened who may be ticked, so it made it
     * far more reachable.
     *
     * The owner's reasoning for allowing it: the tick renegotiates nothing. It
     * records that somebody belongs to a partner lodge and applies the rate the
     * club has already agreed to give such people — the same character as the
     * #2337 placeholder link exempted above.
     *
     * The rule is `requestIsOtherLodgeRateElectionOnly`, the SAME function the
     * preview calls, so the two can no longer drift: pair the tick with a date,
     * add/remove-guest, stay-range or promo change and the block applies again
     * in full. Officer-only, matching `resolveOtherLodgeRateElection`'s own
     * `role !== "ADMIN"` refusal — that resolver would throw 403 later anyway,
     * but an exemption that reads as if a member could use it is a trap for the
     * next reader.
     */
    const requestIsOtherLodgeRateExempt =
      actor.role === "ADMIN" && requestIsOtherLodgeRateElectionOnly(input);
    const quotePriced = await isQuotePricedBooking(tx, bookingId);
    if (
      !requestIsIdentityOnly &&
      !requestIsCreditElectionOnly &&
      !requestIsMemberLinkExempt &&
      !requestIsOtherLodgeRateExempt &&
      quotePriced
    ) {
      throw new ApiError(QUOTE_PRICED_EDIT_BLOCK_MESSAGE, 400);
    }

    const dates = resolveTargetDates({
      booking,
      role: actor.role,
      input,
      today: clubTodayDateOnly,
    });

    // Lock the complete old and proposed booking envelopes before any
    // Booking/BookingGuest tuple write. This includes empty roster partitions,
    // so a concurrent whole-roster Save cannot validate the old stay and then
    // insert after this modification moves or removes the guest. Both envelopes
    // run through `rosterOperationalDayRange`, which extends them to the
    // check-out day: since #2622 a roster row can legitimately sit there, so
    // the OLD and NEW check-out dates are both inside the sorted set.
    const existingAssignmentDates = await tx.choreAssignment.findMany({
      where: { bookingId },
      select: { date: true },
    });
    await lockRosterDateRangesAndDates(
      tx,
      [
        rosterOperationalDayRange(booking.checkIn, booking.checkOut),
        rosterOperationalDayRange(dates.newCheckIn, dates.newCheckOut),
      ],
      existingAssignmentDates.map((assignment) => assignment.date),
    );

    // #2363: this is the live member/admin edit surface, so the minimum-stay
    // policy is enforced on the SAVE and not only advised on the preview. It
    // mirrors the protected sibling `modifyBookingDates` exactly: a non-admin
    // actor is hard-blocked with the full frozen review snapshot
    // (policy id/version/name, resolved scope, affected NZ nights, typed
    // requirements, eligibility and capacity mode), and the check runs BEFORE
    // the guest plan, pricing and the capacity check so nothing is priced or
    // claimed for a stay the policy refuses. The server is authoritative here:
    // the edit panel's banner is advisory only and never gates Save.
    //
    // THE EXEMPTION IS "THE NIGHTS DID NOT MOVE", not "the request was one of
    // two shapes". `resolveTargetDates` has already resolved the effective
    // envelope — including the widening a `guestStayRanges` payload can cause —
    // so `dates.datesChanged` IS the predicate the rationale always described:
    // an edit that leaves the stay's nights exactly as they were cannot admit a
    // NEW violation, so enforcing on it could only hard-block an unrelated fix
    // to a booking that was already grandfathered outside the policy, with no
    // remedy available to the member. That is not hypothetical: the member panel
    // sends `guestStayRanges` unconditionally in grid and range modes, so the
    // narrower identity-only/credit-only test blocked ordinary guest adds and
    // name fixes. `modify-quote` gates its own check on the identical
    // `targetDatesChanged`, computed the same way from the same envelope logic,
    // so preview and apply agree on EVERY request shape — keep the two in step.
    if (actor.role !== "ADMIN" && dates.datesChanged) {
      const { validateMinimumStay, formatViolationsDetail } = await import(
        "@/lib/booking-policies"
      );
      // `tx`, never the module client: this runs under BOTH the global money
      // lock and the per-lodge capacity lock, so a read on a second pool
      // connection here is the pool-starvation shape `member-guest-add-policy.ts`
      // forbids. See docs/CONCURRENCY_AND_LOCKING.md → minimum-stay composition.
      const stayResult = await validateMinimumStay(
        dates.newCheckIn,
        dates.newCheckOut,
        bookingLodgeId,
        tx,
      );
      if (!stayResult.valid) {
        throw new MinimumStayPolicyViolationError(
          formatViolationsDetail(stayResult.violations),
          stayResult.violations,
        );
      }
    }

    const guestPlan = await prepareGuestPlan(tx, {
      booking,
      role: actor.role,
      actorId: actor.id,
      input,
      isInProgressEdit: dates.isInProgressEdit,
      editableFrom: dates.editableFrom,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      memberGuestPolicy,
      // #3123 — the caller's club day, threaded on rather than read under the
      // locks this transaction holds (`INV-LOCK-004`). The planner hands it to
      // the person-night guard, whose self-removal window is member-facing.
      today: clubTodayDateOnly,
      // #2543 — read before the transaction opened (like `memberGuestPolicy`), so
      // the planner's refusals and the paid-up-adult requirement branch on the
      // same mode `modify-quote` previewed, and no settings read happens under
      // the global + per-lodge locks this transaction holds.
      subscriptionLockoutMode,
    });
    const guestNameUpdates = resolveGuestNameUpdates({
      booking,
      input,
      // Quoted bookings rename placeholder students even after payment.
      allowWhenFullyPaid: quotePriced,
      // Identity-only edits on a fully-paid booking may fix a spelling typo on a
      // free-text non-member guest (#1386); a swap to a different person is
      // still rejected. Never loosen structural edits — hence identity-only.
      allowTypoFixWhenFullyPaid: requestIsIdentityOnly,
    });
    // #2337: the resolved links (with previous placeholder names for the audit)
    // and the per-row write map (member identity + any consent columns).
    const guestMemberLinks = guestPlan.guestMemberLinks;
    const linkWriteByGuestId = new Map(
      guestMemberLinks.map((link) => {
        const name = guestPlan.guestMemberLinkNames.get(link.guestId);
        return [
          link.guestId,
          {
            memberId: link.memberId,
            firstName: name?.firstName ?? null,
            lastName: name?.lastName ?? null,
            consentColumns: guestPlan.guestMemberLinkColumns.get(link.guestId),
          },
        ];
      }),
    );
    const identityOnlyModification =
      guestNameUpdates.length > 0 && !requestedStructuralChange;
    // A fully-paid, non-quoted booking whose name edit cleared the typo guard
    // (#1386): flag it so the audit row is queryable and the price-preserving
    // path is provably taken (it never reprices or rechecks capacity).
    const paidNameTypoFix =
      identityOnlyModification &&
      !quotePriced &&
      isBookingFullyPaidForGuestNameEdits(booking);

    // Identity-only modifications are price-preserving by construction
    // (#1099): the stored totals, per-guest prices, and night rows are echoed
    // back instead of running the pricing engine, so a name fix can never
    // move money — not on quoted bookings (no per-tier basis to reprice
    // from), not on legacy bookings without night rows, not across a season
    // rate change. The promo is equally untouched: nothing promo-relevant
    // changes when a name does. #2266: a credit-election-only modification is
    // price-preserving for the same reason and takes the same echo.
    //
    // #2978 review: an other-lodge election is NEVER price-preserving, whatever
    // else the request carries. A name edit plus a tick used to take this echo,
    // which writes the per-guest flag from the election while leaving every
    // locked night exactly as it was — the officer sees the tick land and the
    // total never moves, and the row then reads "(Other Club Member)" beside a
    // fee that says otherwise. Same reasoning as `linkGuestToMember` in
    // `requestedStructuralChange` above: a re-rate has to reach the rate
    // resolver. Kept out HERE rather than added to `requestedStructuralChange`
    // deliberately, so the quote-priced exemptions above keep the meaning
    // `modify-quote` gives them and the preview and the save still agree about
    // what is allowed.
    const pricePreservingModification =
      (identityOnlyModification || requestIsCreditElectionOnly) &&
      !requestCarriesOtherLodgeElection(input);
    const pricing = pricePreservingModification
      ? buildIdentityOnlyPricing(booking)
      : await calculateModifiedPricing(tx, {
          booking,
          bookingId,
          isInProgressEdit: dates.isInProgressEdit,
          editableFrom: dates.editableFrom,
          newCheckIn: dates.newCheckIn,
          newCheckOut: dates.newCheckOut,
          normalizedAddGuests: guestPlan.normalizedAddGuests,
          removeGuestIds: input.removeGuestIds,
          guestsForPricing: guestPlan.guestsForPricing,
          // #2543 — see the `prepareGuestPlan` call above.
          subscriptionLockoutMode,
          // Finding 2 (privacy re-review of MG3 #2308). #2526: read the SAME
          // answer the guest plan used, so a policy-exception approval (which
          // borrows ADMIN only for the reviewed minimum-stay override) prices
          // the party under the family boundary it was actually planned under.
          skipAuthorization: guestPlan.guestAuthorizationIsAdmin,
          skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
          // Multi-lodge: season rates are resolved for the booking's lodge.
          seasonRateData: await loadActiveSeasonRates(tx, bookingLodgeId),
          // Issue #1668: over-capacity warns-and-confirms under admin override.
          adminOverride,
          confirmOverCapacity: input.confirmOverCapacity,
          // #1746: admin-flagged partner-sharers route capacity through the
          // #1745 reserved-slot check (gated to ADMIN actors above).
          partnerSharedGuests: input.partnerSharedGuests,
        });

    const promo = pricePreservingModification
      ? {
          newDiscountCents: booking.discountCents,
          newPromoAdjustmentCents: booking.promoAdjustmentCents,
          promoRemoved: false,
          promoChanged: false,
          // A price-preserving modification re-runs no cap, so it cannot change
          // who the promotion covers.
          promoCoverage: null,
        }
      : await applyPromoCodeChanges(tx, {
          booking,
          bookingId,
          input,
          inProgressPlan: pricing.inProgressPlan,
          newCheckIn: dates.newCheckIn,
          newTotalPriceCents: pricing.newTotalPriceCents,
          guestNightRates: pricing.guestNightRates,
          todayAtClub,
        });

    const newFinalPriceCents = pricing.newTotalPriceCents + promo.newPromoAdjustmentCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    const changeFeeCents = await calculateModificationChangeFee({
      booking,
      newCheckIn: dates.newCheckIn,
      checkInChanged: dates.checkInChanged,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      db: tx, // locked transaction; see `CancellationPolicyDb`
      todayAtClub,
    });

    const settlementOptions = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: priceDiffCents + changeFeeCents,
      db: tx,
      todayAtClub,
    });
    if (settlementOptions?.requiresSettlementMethod && !input.settlementMethod) {
      throw new BookingModificationSettlementMethodRequiredError();
    }

    const { createdGuests } = await applyGuestChanges(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      removedGuests: guestPlan.removedGuests,
      remainingGuests: guestPlan.remainingGuests,
      proposedRemainingGuests: guestPlan.proposedRemainingGuests,
      normalizedAddGuests: guestPlan.normalizedAddGuests,
      guestNameUpdates,
      // #2337: stamp the member identity + consent columns onto the linked rows.
      guestMemberLinks: linkWriteByGuestId,
      priceBreakdown: pricing.priceBreakdown,
      inProgressPlan: pricing.inProgressPlan,
      // Other Lodges epic: the election these rows were priced against, so the
      // per-guest flag is written from the same decision that cleared their
      // locked nights.
      otherLodgeElection: guestPlan.otherLodgeElection,
      // #2978 review: and who pricing actually rated at that rate, so a tick the
      // rate resolver declined is never stored as though it had been honoured.
      otherLodgeRatedGuestIds: pricing.otherLodgeRatedGuestIds,
    });

    const choreWarnings = await applyChoreCleanup(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      datesChanged: dates.datesChanged,
      rosterDatesAlreadyLocked: true,
    });

    const payments = await applyPaymentAdjustments(tx, {
      booking,
      priceDiffCents,
      changeFeeCents,
      settlementOptions,
      settlementMethod: input.settlementMethod,
    });

    const lifecycle = await applyLifecycleTransitions(tx, {
      booking,
      bookingId,
      newCheckIn: dates.newCheckIn,
      newFinalPriceCents,
      guestsForPricing: guestPlan.guestsForPricing,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      reviewUpdate: guestPlan.reviewUpdate,
    });

    // #2266: resolve what this edit writes to the stored credit election
    // (#2265). Evaluated against the POST-lifecycle status, so an edit that
    // parked the booking for review still stores the election (create-flow
    // parity) and an edit that settled it at $0 drops the now-moot request.
    // The write itself rides the booking update below, inside this
    // lock(1)-holding transaction — every consumer of the column serialises
    // on the same lock, so no guarded claim is needed here.
    let creditElectionCentsUpdate: number | null | undefined;
    try {
      creditElectionCentsUpdate = resolveCreditElectionUpdate({
        requestedCents: input.applyCreditCents,
        status: lifecycle.newStatus,
        organiserSettled: booking.organiserSettled,
        hasCapturedPayment: hasCapturedPayment(booking.payment),
        settledAtZeroDollars: lifecycle.zeroDollarAutoPaid,
      });
    } catch (err) {
      if (err instanceof CreditElectionNotAllowedError) {
        throw new ApiError(err.message, 400);
      }
      throw err;
    }
    const creditElectionChanged =
      creditElectionCentsUpdate !== undefined &&
      creditElectionCentsUpdate !== booking.creditElectionCents;

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: dates.newCheckIn,
        checkOut: dates.newCheckOut,
        totalPriceCents: pricing.newTotalPriceCents,
        discountCents: promo.newDiscountCents,
        promoAdjustmentCents: promo.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        hasNonMembers: lifecycle.hasNonMembers,
        nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
        status: lifecycle.newStatus,
        // #2266: a DRAFT parked to AWAITING_REVIEW must not be swept by the
        // 72-hour draft expiry while an admin is deciding — create parity
        // (booking-create nulls draftExpiresAt for review-parked drafts).
        ...(lifecycle.clearDraftExpiresAt ? { draftExpiresAt: null } : {}),
        requiresAdminReview: guestPlan.reviewUpdate.requiresAdminReview,
        adminReviewReason: guestPlan.reviewUpdate.adminReviewReason,
        memberReviewJustification: guestPlan.reviewUpdate.memberReviewJustification,
        adminReviewStatus: guestPlan.reviewUpdate.adminReviewStatus,
        adminReviewNotes: guestPlan.reviewUpdate.adminReviewNotes,
        adminReviewedById: guestPlan.reviewUpdate.adminReviewedById,
        adminReviewedAt: guestPlan.reviewUpdate.adminReviewedAt,
        // Persisted capacity override (#1771): this batch modification
        // re-evaluates capacity against the new nights/guests
        // (pricing.capacityOverridden from calculateModifiedPricing), so
        // RECONCILE the marker — stamp when admitted over capacity behind a
        // confirm, and CLEAR any prior stamp when the change moved the booking
        // back within capacity, so a stale flag can't suppress a legitimate
        // cancel on the new nights later.
        capacityOverriddenAt: pricing.capacityOverridden ? new Date() : null,
        capacityOverriddenByMemberId: pricing.capacityOverridden
          ? actor.id
          : null,
        // #2266: the stored credit election (#2265). A conditional spread so
        // an edit that carried no credit input leaves the column untouched.
        ...(creditElectionCentsUpdate !== undefined
          ? { creditElectionCents: creditElectionCentsUpdate }
          : {}),
        // Other Lodges epic: the partner lodge this booking now claims. A
        // conditional spread on the same terms — an edit that said nothing about
        // the other-lodge rate leaves the column exactly as it was.
        ...(guestPlan.otherLodgeElection.requested &&
        guestPlan.otherLodgeElection.otherLodgeIdChanged
          ? { otherLodgeId: guestPlan.otherLodgeElection.otherLodgeId }
          : {}),
      },
      include: { guests: true, payment: true },
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
        memberId: actor.id,
        // GUEST_TYPO_FIX discriminates a post-payment spelling correction
        // (#1386) from an ordinary pre-payment name update, so the abuse-
        // sensitive path is queryable. (modificationType is a free-text String,
        // not a Prisma enum — no schema change.)
        // #2337: a placeholder→member link is the notable, money-moving event, so
        // it takes precedence in the queryable discriminator. The linked-guest
        // detail lives in previousData/newData so the identity change is never
        // silent (modificationType is free text, not a Prisma enum — no schema
        // change).
        modificationType: guestMemberLinks.length > 0
          ? "GUEST_MEMBER_LINK"
          : paidNameTypoFix
            ? "GUEST_TYPO_FIX"
            : identityOnlyModification
              ? "GUEST_UPDATE"
              : // #2266: a credit-election-only edit is queryably distinct from a
                // structural modification (modificationType is free text).
                requestIsCreditElectionOnly
                ? "CREDIT_ELECTION"
                : "BATCH_MODIFY",
        previousData: {
          checkIn: formatDateOnly(new Date(booking.checkIn)),
          checkOut: formatDateOnly(new Date(booking.checkOut)),
          guestCount: booking.guests.length,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
          removedGuests: guestPlan.removedGuests.map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
          updatedGuests: guestNameUpdates.map((update) => ({
            guestId: update.guestId,
            firstName: update.previousFirstName,
            lastName: update.previousLastName,
          })),
          // #2337: the placeholder identity BEFORE the link, so the audit records
          // exactly what each linked row was.
          ...(guestMemberLinks.length > 0
            ? {
                linkedGuests: guestMemberLinks.map((link) => ({
                  guestId: link.guestId,
                  firstName: link.previousFirstName,
                  lastName: link.previousLastName,
                })),
              }
            : {}),
        },
        newData: {
          checkIn: formatDateOnly(dates.newCheckIn),
          checkOut: formatDateOnly(dates.newCheckOut),
          guestCount: updatedBooking.guests.length,
          addedGuests: (guestPlan.normalizedAddGuests ?? []).map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
          updatedGuests: guestNameUpdates.map((update) => ({
            guestId: update.guestId,
            firstName: update.firstName,
            lastName: update.lastName,
          })),
          // #2337: which member each placeholder is now linked to.
          ...(guestMemberLinks.length > 0
            ? {
                linkedGuests: guestMemberLinks.map((link) => ({
                  guestId: link.guestId,
                  memberId: link.memberId,
                })),
              }
            : {}),
          totalPriceCents: pricing.newTotalPriceCents,
          discountCents: promo.newDiscountCents,
          promoAdjustmentCents: promo.newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          promoRemoved: promo.promoRemoved,
          promoChanged: promo.promoChanged,
          // #2390: the same sentence the member was shown at the edit, kept on
          // the booking's own history so the split has an answer later.
          ...(promo.promoCoverage
            ? { promoCoverageNote: promo.promoCoverage.message }
            : {}),
          settlementMethod: payments.settlementMethod,
          accountCreditAmountCents: payments.accountCreditAmountCents,
          policyRetainedAmountCents: payments.policyRetainedAmountCents,
          // #2266: what this edit did to the stored credit election (#2265),
          // recorded whenever the request carried a credit input — the
          // member's booking history reads it back.
          ...(creditElectionCentsUpdate !== undefined
            ? {
                creditElectionCents: creditElectionCentsUpdate,
                previousCreditElectionCents: booking.creditElectionCents,
              }
            : {}),
          // Post-payment identity-preserving spelling correction (#1386).
          ...(paidNameTypoFix ? { paidNameTypoFix: true } : {}),
          // Admin override recalculate (#1668).
          ...(adminOverride
            ? {
                adminOverride: true,
                pricingMode: "recalculate",
                capacityOverridden: pricing.capacityOverridden,
              }
            : {}),
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    if (payments.accountCreditAmountCents > 0) {
      await createBookingModificationCredit(
        booking.memberId,
        payments.accountCreditAmountCents,
        bookingId,
        bookingModification.id,
        undefined,
        tx,
        booking.payment?.id,
      );
    }

    // Fire the deferred envelope constraint triggers here so a violation is
    // attributed to this service instead of the transaction's COMMIT.
    await assertBookingEnvelopeInvariants(tx);

    // #2364. Re-derive the hosting hazard from the rows this edit just wrote:
    // guests added or removed, nights moved, and a lodge change all land here,
    // and so does the case that matters most — the member fixing the problem by
    // adding an adult member, which clears the pending review with no admin
    // action. Passed `tx` because this transaction holds the global booking lock
    // and the per-lodge capacity lock; reaching for the module client under
    // those is the second-connection shape the ordering rule forbids. No
    // `decision` is offered here even for an admin edit: accepting a hosting
    // exception is a deliberate act with a reason attached, not a side effect of
    // an unrelated change, so a newly-appeared hazard opens PENDING for
    // everybody and an already-decided one is left exactly as it was.
    //
    // #2576 §6/§7: participant-night, lodge and date changes can all take
    // exact-night cover away from another booking on this account. The disposition
    // travels with the actor — an ordinary member is refused and rolled back, an
    // officer is allowed and the consequence is escalated to an urgent incident.
    await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
      ...(approvedExceptionAdultMemberHostingDecision
        ? { decision: approvedExceptionAdultMemberHostingDecision }
        : {}),
      ...hostingCoverageActorOptions({
        actorRole: actor.role,
        actorMemberId: actor.id,
        ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
      }),
    });

    return {
      booking: updatedBooking,
      priceDiffCents,
      changeFeeCents,
      refundAmountCents: payments.refundAmountCents,
      accountCreditAmountCents: payments.accountCreditAmountCents,
      additionalAmountCents: payments.additionalAmountCents,
      pendingRefundAmountCents: payments.pendingRefundAmountCents,
      promoRemoved: promo.promoRemoved,
      promoChanged: promo.promoChanged,
      promoCoverage: promo.promoCoverage,
      choreWarnings,
      datesChanged: dates.datesChanged,
      adminOverride,
      notifyMember,
      capacityOverridden: pricing.capacityOverridden,
      oldCheckIn: booking.checkIn,
      oldCheckOut: booking.checkOut,
      oldGuestCount: booking.guests.length,
      hasSucceededPayment: payments.hasSucceededPayment,
      hasIssuedXeroInvoice: payments.hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      paymentSource: booking.payment?.source ?? null,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
      supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
      xeroAdditionalAmountCents: payments.xeroAdditionalAmountCents,
      xeroRefundAmountCents: payments.xeroRefundAmountCents,
      settlementMethod: payments.settlementMethod,
      policyRetainedAmountCents: payments.policyRetainedAmountCents,
      guestNameUpdates,
      // #2337: a link changes who a guest row is FOR (placeholder → member), so
      // it is an identity change for the Xero name-sync the same as a rename.
      guestIdentityChanged:
        guestNameUpdates.length > 0 || guestMemberLinks.length > 0,
      identityOnlyModification,
      creditElectionOnlyModification: requestIsCreditElectionOnly,
      // Read back from the row this transaction just wrote, so a lifecycle
      // clear (the $0 settle arm) is reflected even when this edit carried no
      // credit input of its own.
      creditElectionCents: updatedBooking.creditElectionCents,
      creditElectionChanged,
      // #1372: newly blocked a paid booking on the minors-only rule? Computed
      // from the pre-edit review state and the freshly written booking.
      minorsOnlyReviewNewlyFlagged: minorsReviewAlertShouldFire({
        previous: booking,
        updated: updatedBooking,
      }),
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
      // MG2 #2307: the cross-family guests this modification added, matched to
      // the rows it actually created, carried OUT of the transaction so the
      // sends happen after the commit.
      // #2337: the linked EXISTING rows carry the member identity now too, so a
      // beyond-family link owes the same consent notification an added
      // cross-family member guest does. They are matched by memberId alongside the
      // created rows.
      memberGuestNotificationRows: matchMemberGuestNotificationRows({
        createdGuests: [
          ...createdGuests,
          ...guestMemberLinks.map((link) => ({
            id: link.guestId,
            memberId: link.memberId,
          })),
        ],
        entriesByMemberId: guestPlan.memberGuestEntries,
      }),
      /**
       * MG4 (#2309): the cross-family member guests this modification took OFF
       * the booking, carried out for the same post-commit dispatch.
       *
       * A NON-NULL `consentStatus` IS THE WHOLE TEST, and it is the right one:
       * it means a consent record exists for this row, which means the member
       * was told something — either asked (PENDING) or told they were on it
       * (CONFIRMED) — and that is precisely the population for whom being
       * removed silently would leave a false belief standing. A family-scope
       * row (NULL) was never the subject of any message, so removing it owes
       * nobody an email, exactly as before MG4.
       *
       * The ACTOR is excluded: a member using #2250 self-removal does not need
       * an email telling them what they just did.
       */
      withdrawnMemberGuests: guestPlan.removedGuests
        .filter(
          (guest) =>
            guest.memberId != null &&
            guest.consentStatus != null &&
            guest.memberId !== actor.id,
        )
        .map((guest) => ({
          targetMemberId: guest.memberId as string,
          // A request nobody has answered yet is "called off"; a settled place
          // is "taken off". Two different things to the reader, so the composed
          // sentence tells them apart.
          context:
            guest.consentStatus === "PENDING"
              ? ("REQUEST_CANCELLED" as const)
              : ("TAKEN_OFF" as const),
        })),
    } satisfies BatchModificationTransactionResult;
  });

  // #2525: post-commit provider work (superseded-intent drain, Stripe refund,
  // additional PaymentIntent, member/notification emails, Xero settlement,
  // change-request linkage, audit) plus building the response. In standalone
  // mode it runs immediately below, exactly as before. In tx-mode the caller
  // owns the commit, so it is handed back as `deferredPostCommit` — no provider
  // call fires inside the still-open approval transaction.
  const runPostCommit = async (): Promise<BatchModificationResponse> => {
    // #2576 §7/§8, FIRST. The edit reconciled the account's other bookings inside
    // the transaction; where an officer's edit took cover away, the bounded
    // re-evaluation committed with it as a queue row. Draining it here is the
    // "immediate re-evaluation" the owner asked for, and it comes before the
    // settlement and email work because a confirmed booking the club's own rule
    // would refuse is the more urgent of the two. Best-effort: the edit is
    // committed, and the cron sweep is the authority on completion.
    await settleHostingCoverageAfterCommit({ bookingId });

    // AFTER the commit, and before the settlement work below, so a cross-family
    // guest is asked as promptly as the booking-modified email is sent. Awaited: an
    // unsent consent request leaves a bed held (D-4) for a member nobody asked.
    if (result.memberGuestNotificationRows.length > 0) {
      // Loaded lazily on purpose: the sender pulls in the whole email/template
      // graph, and only a booking that actually added a cross-family member guest
      // needs it. A club with the module off never loads the mailer through this
      // path at all.
      const { sendMemberGuestAddNotifications } = await import(
        "@/lib/member-guest-consent-notifications"
      );
      // Belt and braces around a function that is documented never to reject: the
      // booking is ALREADY COMMITTED at this point, so an unexpected throw here
      // would hand the member an error for a booking that exists and was paid for.
      // A notification problem is logged, never surfaced as a booking failure.
      try {
        await sendMemberGuestAddNotifications({
          bookingId,
          rows: result.memberGuestNotificationRows,
          actor: memberGuestActor,
        });
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to dispatch member-guest add notifications",
        );
      }
    }

    // MG4 (#2309): and the other direction, on the same rules — after the commit,
    // lazily imported, never allowed to fail an already-committed edit.
    if (result.withdrawnMemberGuests.length > 0) {
      const { sendMemberGuestWithdrawnNotifications } = await import(
        "@/lib/member-guest-consent-notifications"
      );
      try {
        // Grouped by context so each reader gets the sentence that matches what
        // actually happened to them, rather than one message covering both.
        for (const context of ["REQUEST_CANCELLED", "TAKEN_OFF"] as const) {
          const targetMemberIds = result.withdrawnMemberGuests
            .filter((entry) => entry.context === context)
            .map((entry) => entry.targetMemberId);
          if (targetMemberIds.length === 0) continue;
          await sendMemberGuestWithdrawnNotifications({
            bookingId,
            targetMemberIds,
            context,
          });
        }
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to dispatch member-guest withdrawal notifications",
        );
      }
    }

    await drainSupersededPrimaryIntents({
      bookingId,
      supersededPrimaryPaymentIntents: result.supersededPrimaryPaymentIntents,
    });

    const stripeRefundId = await executeBookingModificationRefund({
      bookingId,
      result,
      metadataReason: "batch_modification",
      idempotencyKeyPrefix: `mod_batch_refund_${bookingId}`,
      failureMessage: "Stripe refund failed after batch modification - enqueueing recovery",
      recoveryFailureMessage:
        "Failed to enqueue payment recovery for Stripe refund failure after batch modification",
    });

    const { additionalPaymentClientSecret, additionalPaymentIntentId } =
      await createModificationAdditionalPaymentIntent({
        bookingId,
        result,
        reason: "batch_modify_price_increase",
        idempotencyKey: `mod_batch_${bookingId}_${result.bookingModificationId}`,
        failureMessage: "Failed to create additional PaymentIntent for batch modification",
      });

    // Issue #1668: under an admin override, link this modification to the
    // booking's most recent approved-unlinked change request. Best-effort.
    const linkedChangeRequestId = result.adminOverride
      ? await linkModificationToOutstandingChangeRequest(prisma, {
          bookingId,
          modificationId: result.bookingModificationId,
          appliedCheckIn: result.booking.checkIn,
          appliedCheckOut: result.booking.checkOut,
        })
      : null;

    await dispatchBatchPostTransactionSideEffects({
      bookingId,
      actorMemberId: actor.id,
      ipAddress,
      result,
      additionalPaymentIntentId,
      linkedChangeRequestId,
    });

    return {
      booking: result.booking,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      additionalAmountCents: result.additionalAmountCents,
      settlementMethod: result.settlementMethod,
      additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
      stripeRefundId: stripeRefundId ?? null,
      promoRemoved: result.promoRemoved,
      promoChanged: result.promoChanged,
      promoCoverage: result.promoCoverage,
      choreWarnings: result.choreWarnings,
      creditElectionCents: result.creditElectionCents,
    };
  };

  if (callerTx) {
    // tx-mode (atomic approve-and-execute): the caller owns the commit. The
    // modification is already applied in the caller's transaction; provider
    // work runs after commit via deferredPostCommit. Provider-derived fields
    // (stripeRefundId / additionalPaymentClientSecret) are null here — they
    // become available only when the deferred work runs, and the approval does
    // not surface them.
    return {
      booking: result.booking,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      additionalAmountCents: result.additionalAmountCents,
      settlementMethod: result.settlementMethod,
      additionalPaymentClientSecret: null,
      stripeRefundId: null,
      promoRemoved: result.promoRemoved,
      promoChanged: result.promoChanged,
      promoCoverage: result.promoCoverage,
      choreWarnings: result.choreWarnings,
      creditElectionCents: result.creditElectionCents,
      deferredPostCommit: async () => {
        await runPostCommit();
      },
    };
  }

  return await runPostCommit();
}

async function dispatchBatchPostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
  linkedChangeRequestId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: BatchModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
  linkedChangeRequestId: string | null;
}): Promise<void> {
  const auditDetails = {
    datesChanged: result.datesChanged,
    oldGuestCount: result.oldGuestCount,
    newGuestCount: result.booking.guests.length,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    promoRemoved: result.promoRemoved,
    promoChanged: result.promoChanged,
    promoCoverageNote: result.promoCoverage?.message ?? null,
    updatedGuestCount: result.guestNameUpdates.length,
    guestIdentityChanged: result.guestIdentityChanged,
    // #2266: the stored credit election (#2265) after this edit — audited
    // whenever it moved, so a member's "use my credit" choice on the edit
    // path is as traceable as the create path's.
    ...(result.creditElectionChanged
      ? { creditElectionCents: result.creditElectionCents }
      : {}),
    zeroDollarAutoPaid: result.zeroDollarAutoPaid,
    settlementMethod: result.settlementMethod,
    policyRetainedAmountCents: result.policyRetainedAmountCents,
    // Admin override recalculate (#1668): before/after dates, capacity decision
    // and the linked change request, so the override edit is fully auditable.
    // Issue #1696: a non-override admin edit that suppressed the member email
    // records notifyMember: false too (notifyMember is false only when an admin
    // opted out — members always notify), so every suppressed edit is auditable.
    ...(result.adminOverride
      ? {
          adminOverride: true,
          pricingMode: "recalculate" as const,
          confirmOverCapacity: result.capacityOverridden,
          notifyMember: result.notifyMember,
          capacityOverridden: result.capacityOverridden,
          oldCheckIn: formatDateOnly(new Date(result.oldCheckIn)),
          oldCheckOut: formatDateOnly(new Date(result.oldCheckOut)),
          newCheckIn: formatDateOnly(result.booking.checkIn),
          newCheckOut: formatDateOnly(result.booking.checkOut),
          linkedChangeRequestId,
        }
      : result.notifyMember
        ? {}
        : { notifyMember: false }),
  };

  logAudit({
    // Issue #1668: every override move audits under the one queryable action
    // name shared with the shift and modify-dates override paths.
    action: result.adminOverride
      ? "booking.modify.admin_override"
      : "booking.modify.batch",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: result.adminOverride
      ? "Admin override: booking dates recalculated"
      : "Booking modified",
    details: JSON.stringify(auditDetails),
    metadata: { bookingId, ...auditDetails },
    ipAddress,
  });

  void queueXeroBookingEditSettlement({
    bookingId,
    bookingModificationId: result.bookingModificationId,
    createdByMemberId: actorMemberId,
    hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    originalPaymentStatus: result.paymentStatus,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    datesChanged: result.datesChanged,
    guestIdentityChanged: result.guestIdentityChanged,
    settlementMethod: result.settlementMethod,
    settlementAmountCents: result.xeroRefundAmountCents,
    createPrimaryInvoiceWhenMissing:
      result.zeroDollarAutoPaid && !result.hasIssuedXeroInvoice,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to queue Xero settlement for batch modification",
    ),
  );

  // #1372: an edit that dropped the last adult from a paid booking blocks its
  // lodge check-in (the booking KEEPS its PAID status). Nudge admins to review
  // it, best-effort — an email failure must never affect the completed edit.
  if (result.minorsOnlyReviewNewlyFlagged) {
    sendAdminMinorsOnlyReviewAlert({
      memberName: result.memberName,
      checkIn: result.booking.checkIn,
      checkOut: result.booking.checkOut,
      guestCount: result.booking.guests.length,
      reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    }).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to send minors-only review admin alert",
      ),
    );
  }

  // #2266: a credit-election-only edit changes nothing about the stay, so no
  // change-notification email — same silence as an identity-only name fix.
  if (result.identityOnlyModification || result.creditElectionOnlyModification) {
    return;
  }

  // Owner decision (#1668 review): an override admin may choose not to email
  // the member; the choice is recorded in the audit fields above.
  if (!result.notifyMember) {
    return;
  }

  const member = await prisma.member.findUnique({
    where: { id: result.booking.memberId },
  });
  if (!member) return;

  sendBookingModifiedEmail({
    bookingId: result.booking.id,
    recipientMemberId: member.id,
    email: member.email,
    firstName: member.firstName,
    modificationType: "BATCH_MODIFY",
    oldCheckIn: result.oldCheckIn,
    oldCheckOut: result.oldCheckOut,
    newCheckIn: result.booking.checkIn,
    newCheckOut: result.booking.checkOut,
    oldGuestCount: result.oldGuestCount,
    newGuestCount: result.booking.guests.length,
    oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
    newFinalPriceCents: result.booking.finalPriceCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    additionalAmountCents: result.additionalAmountCents,
    additionalPaymentMethod:
      result.additionalAmountCents > 0 &&
      result.paymentSource === PaymentSource.INTERNET_BANKING
        ? "INTERNET_BANKING"
        : result.additionalAmountCents > 0 && result.hasSucceededPayment
          ? "STRIPE"
          : undefined,
    paymentReference: result.paymentReference,
    xeroInvoiceNumber: result.xeroInvoiceNumber,
    // #2390: if a usage cap stopped the promotion reaching somebody this edit
    // added, the email says so in the same words the member saw on screen.
    promoCoverageNote: result.promoCoverage?.message ?? null,
    lodgeId: result.booking.lodgeId,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to send batch modification email",
    ),
  );
}
