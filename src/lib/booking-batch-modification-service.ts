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
  OtherLodgeRateAmountUnderReviewError,
  requestCarriesOtherLodgeElection,
  requestIsOtherLodgeRateElectionOnly,
} from "@/lib/booking-other-lodge-rate";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  assertNoPendingEditFinancialReview,
  raiseParkedEditFinancialReviewTasks,
} from "@/lib/edit-financial-review";
import { bookingHasOpenFinancialReview } from "@/lib/booking-financial-review-visibility";
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
import type { HostingCoverageLinkedMoveInput } from "@/lib/adult-member-hosting-linked-move";
import logger from "@/lib/logger";
import { createBookingModificationCredit } from "@/lib/member-credit";
import {
  CreditElectionNotAllowedError,
  resolveCreditElectionUpdate,
} from "@/lib/booking-credit-election";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";
import {
  describePromoChangeNotApplied,
  type PromoChangeNotAppliedNotice,
} from "@/lib/promo-change-not-applied";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { prisma } from "@/lib/prisma";
import {
  withOptionalTransaction,
  type PrismaTransactionClient,
} from "@/lib/db-transaction";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  assertProposedCheckInClearsXeroLockDate,
  assertDateEditClearsXeroLockDateFromFacts,
  checkInNeedingLockDateCheck,
  readXeroLockGuardDateEditBooking,
  resolveXeroLockDateFacts,
  type XeroLockDateFacts,
} from "@/lib/xero-period-lock-guard";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  type MemberGuestAddNotificationRow,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";
import {
  lockRosterDateRangesAndDates,
  rosterOperationalDayRange,
} from "@/lib/roster-lock";
import { formatDateOnly } from "@/lib/date-only";

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

/**
 * WHY a change fee on this booking was waived, as it is stored (#3232 D2).
 *
 * ONE HOME, because it is written twice — onto the `BookingModification` row and
 * onto the audit row — and read by a treasurer reconciling change-fee income
 * against the club's setting. Two string literals that must agree is exactly the
 * shape `INV-SSOT-001` is about: the pair that drifted would be the pair a query
 * for waived fees silently under-counts.
 *
 * There is only ever one reason today, and the constant is named for the value
 * rather than for "the reason" so a second one can be added beside it rather than
 * by changing what this one means.
 */
export const LINKED_MOVE_CHANGE_FEE_WAIVED_REASON =
  "LINKED_MOVE_SUPERVISION_RULE" as const;

type BatchModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    /** #3232: the deferred hosting reconciliation, when the caller asked for it. */
    pendingHostingReconcile?: () => Promise<void>;
    priceDiffCents: number;
    changeFeeCents: number;
    /**
     * #3232 D2: this booking's change fee was WAIVED, not absent.
     *
     * Without it a waived fee is an unmarked zero, and "no fee was due" and "we
     * waived it because our own supervision rule compelled this move" are the
     * same 0 in the modification row, the audit trail and the Xero leg. A
     * treasurer reconciling change-fee income against the club setting has
     * nothing to reconcile against, and the dependent's history reads as an
     * ordinary member-initiated edit to a booking the member never asked to
     * move.
     */
    changeFeeWaived: boolean;
    /**
     * #3232 (fix round): this edit's settlement genuinely needs a card-or-credit
     * choice, whichever way it was priced.
     *
     * `calculateModificationSettlementOptions` answers this as
     * `cardRefundAmountCents > 0 || creditRefundAmountCents > 0` — an OR over BOTH
     * options — and the two are computed from separate policy tiers, so one can
     * resolve to zero while the other does not. A caller that inferred the need
     * from the RESOLVED amounts of a quote priced one way therefore disagreed with
     * the write's own refusal, and the disagreement deadlocked the member: see
     * `combineLinkedMoveQuote`.
     */
    requiresSettlementMethod: boolean;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    promoRemoved: boolean;
    promoChanged: boolean;
    // #2390: set only when a usage cap stopped the promotion reaching somebody
    // on the repriced booking; null means everyone it applies to is covered.
    promoCoverage: PromoCoverageNotice | null;
    // #3179: set only when this edit carried a promo-code change it could not
    // honour and dropped. Null means nothing the member asked for was left
    // undone — never "there was no promo code".
    promoChangeNotApplied: PromoChangeNotAppliedNotice | null;
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
  /**
   * Whether this edit's settlement needs a card-or-credit choice at all (#3232).
   *
   * SURFACED BECAUSE A CALLER CANNOT DERIVE IT FROM THE MONEY. The refusal this
   * service raises without a method is an OR over both options, computed from two
   * separate policy tiers; `refundAmountCents` and `accountCreditAmountCents` are
   * the amounts of the option that was actually priced. A club whose tier carries
   * a card processing fee can therefore return 0 on the card while the credit
   * option returns real money — so the quote said "nothing to come back", asked
   * for no choice, and the write then refused for want of one, identically, on
   * every retry. The fact has to travel rather than be re-derived
   * (`INV-SSOT-001`).
   */
  requiresSettlementMethod: boolean;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoChanged: boolean;
  promoCoverage: PromoCoverageNotice | null;
  // #3179: the promo-code change this edit dropped, in the member's own words.
  // The panel holds itself open on it rather than closing on a silent partial.
  promoChangeNotApplied: PromoChangeNotAppliedNotice | null;
  choreWarnings: string[];
  // #2266: the stored credit election (#2265) after this edit, so the panel
  // can confirm what was remembered without a second fetch.
  creditElectionCents: number | null;
  /**
   * How much of a reduction the cancellation policy KEPT rather than returning
   * (#3232).
   *
   * Already computed inside the transaction and already written to the
   * modification row and the audit trail; it was simply not surfaced here, while
   * the date sibling's `DateModificationResponse` has always surfaced it. That
   * asymmetry meant the live member save path could return less money than the
   * member expected without saying which rule kept the difference. The linked
   * move made it load-bearing — `/modify-dates` answers with this contract on
   * every arm, so an arm that dropped the field would have to invent a figure.
   */
  policyRetainedAmountCents: number;
  /**
   * True when an over-capacity target was explicitly confirmed by an admin.
   *
   * Always false on every member path, including the linked move: confirming an
   * overbooking needs `adminOverride`, and the linked move answers a full lodge
   * with its own `NO_CAPACITY` arm rather than by overbooking. Surfaced for the
   * same reason as `policyRetainedAmountCents` above.
   */
  capacityOverridden: boolean;
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
  /**
   * Present ONLY when the caller asked for `hostingReconcile: "CALLER"` (#3232):
   * the adult-member hosting reconciliation this service deferred.
   *
   * A RETURNED OBLIGATION RATHER THAN A DOCUMENTED ONE. A caller composing several
   * booking writes into one transaction has to run the supervision check once, over
   * the state that will really commit, and it has to run it BEFORE that commit. A
   * boolean flag plus a paragraph asking nicely would be a supervision rule that a
   * future caller can turn off by accident; handing the work back means the thing
   * the caller must do is a value it is holding.
   *
   * It still is not unforgeable — nothing stops a caller dropping the thunk — which
   * is why `adult-member-hosting-call-sites.test.ts` pins the single file allowed to
   * ask for the deferral at all.
   */
  pendingHostingReconcile?: () => Promise<void>;
};

/**
 * Pricing echo for identity-only modifications (#1099): stored totals,
 * per-guest prices, and night rows exactly as persisted, in booking-guest
 * order (matching proposedRemainingGuests when nothing is added or removed).
 * Guests without night rows (quoted or pre-#713 bookings) echo empty night
 * arrays, which the guest-sync step treats as "leave the rows alone".
 */
function buildIdentityOnlyPricing(booking: LoadedBookingForModify): PricingResult {
  // #3031: NO `?? 0`, ANYWHERE IN THIS ECHO. These amounts are written straight
  // back onto `BookingGuestNight.priceCents` by `syncGuestNights`, so a default
  // would replace a night's real sold price with a magic zero on an edit whose
  // entire promise is that it preserves it (INV-MOD-028). A night loaded without
  // its price is a SELECT that did not ask for it — the census in
  // `in-progress-edit-sold-price-census.test.ts` exists to stop exactly that —
  // and the honest response is to refuse rather than to invent. A stored value
  // that is negative IS echoed, unchanged: the promise is byte-for-byte
  // preservation, and repairing damaged rows is #2745's audited decision, not
  // this echo's.
  //
  // ONE READ OF THE ROWS, feeding both the breakdown and the per-night rates
  // (`INV-SSOT`). They were read twice, and the second read defaulted — dead
  // only because object-literal properties evaluate in source order and the
  // refusal happened to precede it. A prohibited construct on a money value must
  // not depend on evaluation order for its harmlessness.
  //
  // #3170: AND A ROW THAT SAYS "NOT KNOWN" IS ECHOED AS THAT. Byte-for-byte
  // preservation is the promise, and a `NULL` is a value this column now holds:
  // it is what a parked edit writes for a night this booking's history cannot
  // price. Refusing it here would refuse a member a spelling correction on a
  // booking whose amount an officer has yet to confirm, and writing a number
  // instead would invent the very figure the review exists to establish.
  //
  // The two absences stay apart, exactly as they do at the write. `null` is the
  // row's own statement and is preserved; `undefined` is still a SELECT that
  // did not ask for the price — a caller wiring defect — and still throws.
  const echoedNights = booking.guests.map((guest) =>
    (guest.nights ?? []).map((night) => {
      if (night.priceCents === undefined) {
        throw new Error(
          `Booking guest ${guest.id} night ${night.stayDate.toISOString()} was loaded without its stored sold price (#3031)`,
        );
      }
      if (night.priceSource === undefined) {
        throw new Error(
          `Booking guest ${guest.id} night ${night.stayDate.toISOString()} was loaded without price provenance (#3275)`,
        );
      }
      return {
        stayDate: night.stayDate,
        priceCents: night.priceCents,
        priceSource: night.priceSource,
      };
    }),
  );
  return {
    kind: "priced",
    inProgressPlan: null,
    capacityOverridden: false,
    newTotalPriceCents: booking.totalPriceCents,
    priceBreakdown: {
      totalPriceCents: booking.totalPriceCents,
      guests: booking.guests.map((guest, index) => ({
        priceCents: guest.priceCents,
        perNightCents: echoedNights[index].map((night) => night.priceCents),
        nightDates: echoedNights[index].map((night) => night.stayDate),
        perNightPriceSources: echoedNights[index].map((night) => night.priceSource),
      })),
    },
    // #3170: RATES ONLY, and the pair stays aligned. A night whose stored price
    // is not known has no rate to state, so it is dropped from BOTH lists
    // together rather than carried as a null one list would read as zero. This
    // echo's rates are unused in practice — a price-preserving modification
    // re-runs no promotion cap, which is the only reader — so dropping is safe
    // as well as honest; what would not be safe is a rate vector whose
    // positions no longer matched its dates.
    guestNightRates: booking.guests.map((guest, index) => {
      const rated = echoedNights[index].filter(
        (night): night is typeof night & { priceCents: number } =>
          night.priceCents !== null,
      );
      return {
        bookingGuestId: guest.id,
        memberId: guest.memberId ?? null,
        isMember: guest.isMember,
        perNightRates: rated.map((night) => night.priceCents),
        nightDates: rated.map((night) => night.stayDate),
      };
    }),
    // Nothing was rated here — this echo does not run the rate resolver at all.
    // A request carrying an other-lodge election is therefore kept OFF this path
    // (see `pricePreservingModification` below): storing the flag from an echo
    // would stamp a re-rate the money never made.
    otherLodgeRatedGuestIds: new Set<string>(),
  };
}

/**
 * Everything a batch modification must resolve BEFORE its transaction opens
 * (#3232, `INV-LOCK-004`).
 *
 * Three reads, and each of them is here for a reason already written down
 * somewhere else in the tree:
 *
 *  - the member-guest add policy, whose own module header says it must be read
 *    before the caller opens its transaction;
 *  - the club's subscription-lockout mode, which `INV-LOCK-004` names explicitly
 *    as a reader to resolve first and pass in as a value, because it can refresh
 *    the financial-year configuration from Xero;
 *  - the Xero lock dates, which on a cold cache is a live HTTPS request with a
 *    possible OAuth refresh.
 *
 * `modifyBookingBatch` does this itself when it owns its transaction, which is
 * every route and on-behalf caller and is byte-identical to before. A caller that
 * supplies `tx` MUST call this first: see the `preTransaction` field.
 */
interface BatchModificationPreparation {
  readonly memberGuestPolicy: Awaited<ReturnType<typeof loadMemberGuestAddPolicy>>;
  readonly subscriptionLockoutMode: SubscriptionLockoutMode;
  readonly xeroLockDates: XeroLockDateFacts;
}

/**
 * The brand that makes "these lock-date facts cover EVERY booking" a property of
 * the VALUE rather than a rule in a comment (#3232 fix round, `INV-LOCK-004`).
 *
 * Module-private and mintable in exactly one place — `prepareBatchModification
 * ForCallerTransaction`, which passes `"unknown"` and cannot be asked for
 * anything else. Nothing outside this file can construct the shape, so a caller
 * that supplies a transaction cannot hand in facts resolved from an enumerated
 * candidate set.
 *
 * WHY THAT MATTERS, AND IT IS NOT THEORETICAL. `resolveXeroLockDateFacts` returns
 * `not-applicable` when no candidate check-in is retroactive, and the decision
 * then returns before looking at the booking at all. A caller-transaction caller
 * discovers bookings UNDER the locks — the linked move reads who was stranded
 * after the first move is written, and the policy-exception approval's drift gate
 * can apply a stored past check-in while the frozen proposal's is in the future.
 * Enumerating there would hand the guard a set that does not contain the booking
 * it is about to judge, and the answer would be a retroactive invoice re-dated
 * into a closed accounting period with no refusal at all. Making it
 * unrepresentable beats a comment asking nobody to do it (`INV-SSOT-001`).
 */
const EVERY_BOOKING_LOCK_FACTS: unique symbol = Symbol(
  "batchModificationPreTransaction",
);

export interface BatchModificationPreTransaction
  extends BatchModificationPreparation {
  readonly [EVERY_BOOKING_LOCK_FACTS]: true;
}

/**
 * Resolve the pre-transaction work for one or more batch modifications.
 *
 * ONE VALUE COVERS EVERY BOOKING THE CALLER WILL WRITE, which is what makes it
 * usable by a caller whose second booking is only discovered under the locks — the
 * linked move (#3232) reads who was stranded after the first booking has already
 * moved, so it cannot name its bookings out here. `candidateCheckIns: "unknown"`
 * says exactly that and costs one settings read, one token read and at most one
 * TTL-cached Xero organisation read. A caller that CAN name its check-ins passes
 * them and usually pays nothing at all, because only a retroactive check-in is
 * guarded.
 */
async function prepareBookingBatchModification(options: {
  /** The check-ins the caller can enumerate, or `"unknown"` when it cannot. */
  candidateCheckIns: Date[] | "unknown";
  audience: "admin" | "member";
  /**
   * The CONSERVATIVE lock-date guard for an admin date override (#1697,
   * re-affirmed #1718): every recalculate override is checked, even where the
   * settlement would only write today-dated documents. It throws rather than
   * returning a value, and it lives here so that this function is the ONE place in
   * this module that reads the club's settings or reaches a provider — which is
   * what `lock-bound-club-zone-outside-transaction.test.ts` can then hold.
   */
  adminOverride?: { bookingId: string; requestedCheckIn: string | undefined };
}): Promise<BatchModificationPreparation> {
  if (options.adminOverride) {
    await assertProposedCheckInClearsXeroLockDate(
      prisma,
      options.adminOverride.bookingId,
      options.adminOverride.requestedCheckIn,
    );
  }
  const [memberGuestPolicy, subscriptionLockoutMode, xeroLockDates] =
    await Promise.all([
      loadMemberGuestAddPolicy(),
      resolveSubscriptionLockoutMode(),
      resolveXeroLockDateFacts(options.candidateCheckIns, {
        audience: options.audience,
      }),
    ]);
  return { memberGuestPolicy, subscriptionLockoutMode, xeroLockDates };
}

/**
 * The pre-transaction value for a caller that owns the commit (#3232,
 * `INV-LOCK-004`).
 *
 * THE ONLY WAY TO MAKE ONE, and it takes no candidate check-ins: such a caller
 * cannot name the bookings it will write, because it discovers them under the
 * locks. It therefore pays one settings read, one token read and at most one
 * TTL-cached Xero organisation read, and gets facts that cover EVERY booking. See
 * `EVERY_BOOKING_LOCK_FACTS` for what a narrower set would have cost.
 */
export async function prepareBatchModificationForCallerTransaction(options: {
  audience: "admin" | "member";
}): Promise<BatchModificationPreTransaction> {
  return {
    ...(await prepareBookingBatchModification({
      candidateCheckIns: "unknown",
      audience: options.audience,
    })),
    [EVERY_BOOKING_LOCK_FACTS]: true,
  };
}

/**
 * The check-ins THIS edit's lock-date decision could turn on, for a caller that
 * owns its own transaction and can therefore name them (#3232).
 *
 * IT COSTS EXACTLY WHAT THE GUARD IT REPLACES COST, and it IS that guard: the
 * same one light indexed read, the same non-owner skip, and the same single
 * predicate (`checkInNeedingLockDateCheck`) deciding both whether the facts are
 * worth resolving and, once they are, what the answer is. An identity-only fix,
 * a settled payment, a booking with no issued Xero invoice or a future-dated move
 * therefore reads no settings, no token store and no Xero — which is what #1729
 * narrowed this guard to, and what its own suite pins.
 *
 * IT STAYS BEFORE THE TRANSACTION on this path, deliberately. Deciding it under
 * the locks would be safe but wasteful: a refusal would have taken the global
 * money key and the lodge capacity key to write nothing. A caller that supplies
 * the transaction gets the decision inside it instead, because it has no position
 * outside one — see `preTransaction`.
 */
/**
 * A NAMED return type rather than an inline one, so the shape of this function's
 * SIGNATURE cannot hide its body from a source-scanning census. `functionSpan` in
 * `lock-bound-club-zone-outside-transaction.test.ts` takes the first `{` after the
 * parameter list as the start of the body, and `Promise<{ … }>` puts a different
 * brace there — which made this function's one pre-transaction booking read read as
 * an unguarded call from the module's top level.
 */
type OrdinaryXeroLockDateGuard = {
  candidateCheckIns: Date[];
  decide: (facts: XeroLockDateFacts) => void;
};

async function resolveOrdinaryXeroLockDateGuard(
  bookingId: string,
  input: { checkIn?: string; checkOut?: string },
  actor: { id: string; role: Role },
): Promise<OrdinaryXeroLockDateGuard> {
  const audience = actor.role === "ADMIN" ? "admin" : "member";
  const booking = await readXeroLockGuardDateEditBooking(
    prisma,
    bookingId,
    input,
    { audience, actorMemberId: actor.id },
  );
  // Nothing to decide: no date fields, a missing booking, or a member-audience
  // actor on a booking that is not theirs. No settings read, no token read and no
  // Xero call, exactly as before.
  if (!booking) return { candidateCheckIns: [], decide: () => undefined };
  const candidate = checkInNeedingLockDateCheck(booking, input);
  return {
    candidateCheckIns: candidate ? [candidate] : [],
    // The audience travels ON the facts (#3232 fix round), so the wording of the
    // locked-period refusal and the wording of the read-failure refusal cannot
    // disagree about who is reading them.
    decide: (facts) =>
      assertDateEditClearsXeroLockDateFromFacts(booking, input, facts),
  };
}

export async function modifyBookingBatch({
  bookingId,
  actor,
  approvedExceptionAdultMemberHostingDecision,
  hostingCoverageOverride,
  hostingCoverageLinkedMove,
  input,
  ipAddress,
  todayAtClub,
  tx: callerTx,
  hostingReconcile,
  waiveChangeFee,
  preTransaction,
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
  /**
   * #3232: the MEMBER's answer to the linked-move offer, when they gave one.
   *
   * Only `LEAVE_UNCOVERED` is meaningful here — it turns the stranded refusal into
   * an escalation, so the change proceeds, the member has already been warned in
   * plain words and the officer queue gets an incident. `MOVE_BOTH` never reaches
   * this service directly: accepting is a two-booking atomic move and belongs to
   * `booking-linked-date-move-service.ts`, which calls this service twice inside
   * one transaction.
   */
  hostingCoverageLinkedMove?: HostingCoverageLinkedMoveInput | null;
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
  /**
   * WHO reconciles the adult-member hosting rule for this edit (#3232).
   *
   * Absent, or `"INLINE"`, means this service does it at the end of its own write,
   * which is every existing caller and is the only correct answer for a single
   * booking. `"CALLER"` is for a caller composing SEVERAL booking writes into ONE
   * transaction, and it exists because such a caller has an intermediate state that
   * the rule would refuse and must not.
   *
   * THE INTERMEDIATE STATE IS THE WHOLE PROBLEM, and there is no ordering that
   * avoids it. Booking A carries the only qualifying adult and booking B depends on
   * it; the member is moving both. Move A first and A's seam sees B stranded and
   * refuses. Move B first and B's own seam sees B with no qualifying adult on its
   * new nights and refuses. Either order fails on a state that was never going to
   * be committed, so the reconciliation has to happen once, at the end, over the
   * state that really will be.
   *
   * WHAT THE CALLER OWES, and it is not optional: it MUST reconcile every booking
   * it wrote, with full enforcement, before its transaction commits. Deferral moves
   * the check; it never removes it. The obligation is handed back as
   * `pendingHostingReconcile` on the result rather than left to a docblock, and
   * `booking-linked-date-move-service.ts` is the ONLY caller that may pass
   * `"CALLER"` — pinned tree-wide by `adult-member-hosting-call-sites.test.ts`, so a
   * new caller cannot quietly opt out of the supervision rule by copying a flag.
   *
   * REQUIRES `tx`. Without a caller transaction there is no composition to defer
   * for, and deferring would just be a hosting check nobody runs; asking for it
   * without one throws rather than silently skipping.
   */
  hostingReconcile?: "INLINE" | "CALLER";
  /**
   * Charge NO late-notice change fee for this move (#3232 D2).
   *
   * WHAT IT IS FOR, and it is one thing only. A club may decide that when its own
   * adult-supervision rule is what COMPELLED a second booking to move, charging
   * that second booking's change fee is not fair — `BookingDefaults.
   * linkedMoveChargesBothChangeFees`, which defaults to charging. The waiver
   * applies to the booking that was dragged along, never to the one the member
   * chose to move.
   *
   * WHY A SERVICE ARGUMENT AND NOT A FIELD ON `BatchModifyInput`. `input` is the
   * parsed REQUEST BODY on both member-facing save routes, so a fee waiver living
   * there would be a fee waiver any authenticated member could ask for. This sits
   * beside `tx` and `hostingReconcile` — arguments a route cannot populate from
   * the body — and `adult-member-hosting-call-sites.test.ts` pins the single file
   * allowed to pass it, exactly as it pins `hostingReconcile: "CALLER"`.
   *
   * IT ZEROES THE FEE, it does not hide it. The zero flows through the settlement
   * options, the payment adjustment, the modification row, the audit trail and the
   * Xero settlement leg, the same way a parked edit's zero does — so what the
   * member is shown, what they are charged and what the club's books record are
   * one number. That is the whole point: before this existed the setting changed
   * the SENTENCE the member read and nothing else, so a club that had waived the
   * second fee told the member it was waived and charged it anyway.
   */
  waiveChangeFee?: boolean;
  /**
   * The work that has to happen BEFORE the transaction, done by the caller that
   * owns the transaction (#3232, `INV-LOCK-004`).
   *
   * REQUIRED WHENEVER `tx` IS SUPPLIED, and that is the whole point of it. Three
   * things above this line read the club's settings and module flags and — on a
   * cold cache — the Xero organisation over HTTPS. They sit before
   * `withOptionalTransaction`, which READS as "before the transaction" and is
   * FALSE on the caller-supplied path: that helper runs its callback inside `tx`
   * when a caller hands one in, so by the time control reaches this function the
   * caller already holds `pg_advisory_xact_lock(1)` and the per-lodge capacity
   * key. Each of those reads then takes a second pooled connection under both
   * keys, and a live provider request serialises the club's entire money and
   * lifecycle path behind an outbound HTTP call — the shape
   * `docs/CONCURRENCY_AND_LOCKING.md` forbids outright.
   *
   * There is no position inside this function that is outside the transaction on
   * every path, which is why the answers have to ARRIVE as values — exactly as
   * `todayAtClub` does, and for exactly the same reason. Asking for `tx` without
   * them throws rather than quietly doing provider work under two locks.
   *
   * Build it with `prepareBatchModificationForCallerTransaction`, which is the
   * only function that can mint one — see `EVERY_BOOKING_LOCK_FACTS`.
   */
  preTransaction?: BatchModificationPreTransaction;
}): Promise<BatchModificationResponse> {
  if (callerTx && !preTransaction) {
    throw new Error(
      "INV-LOCK-004: modifyBookingBatch in caller-transaction mode requires " +
        "`preTransaction` — the member-guest policy, the subscription-lockout " +
        "mode and the Xero lock dates must be resolved before the caller opens " +
        "its transaction, never from inside it. Call " +
        "prepareBatchModificationForCallerTransaction() first.",
    );
  }
  if (input.adminOverride && callerTx) {
    // The override path takes the CONSERVATIVE lock-date guard, which has no
    // pre-resolved form because nothing composes it into a caller transaction.
    // Refusing the combination is better than running that guard's Xero call
    // under two locks, and better than skipping a guard the owner re-affirmed
    // twice (#1697, #1718).
    throw new Error(
      "INV-LOCK-004: an admin date override cannot run inside a caller-supplied " +
        "transaction — its Xero lock-date guard has no pre-resolved form.",
    );
  }
  if (hostingReconcile === "CALLER" && !callerTx) {
    throw new Error(
      "hostingReconcile: \"CALLER\" is only meaningful inside a caller-supplied " +
        "transaction; without one the hosting rule would simply not be checked.",
    );
  }
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
    // documents and is never guarded. It runs inside
    // `prepareBookingBatchModification` below, which is where every read on this
    // path now lives (#3232) — outside the transaction, as it must be, and the
    // pre-read is only advisory (the outbox still fails safely if the lock dates
    // change mid-flight).
  }

  // EVERYTHING THAT MUST HAPPEN BEFORE THE TRANSACTION, IN ONE PLACE (#3232,
  // `INV-LOCK-004`). The member-guest policy (whose own module header demands
  // this position), the subscription-lockout mode (which `INV-LOCK-004` names,
  // and which can refresh the financial year from Xero) and the Xero lock dates
  // (a live HTTPS request on a cold cache).
  //
  // FROM THE CALLER WHEN THERE IS ONE, because on that path "here" is INSIDE the
  // caller's transaction — `withOptionalTransaction` runs its callback on `tx`,
  // so a read above it is not outside anything. See `preTransaction`, which is
  // required in that mode for exactly this reason.
  let preparation: BatchModificationPreparation;
  if (preTransaction) {
    preparation = preTransaction;
  } else {
    const ordinaryGuard = await resolveOrdinaryXeroLockDateGuard(
      bookingId,
      input,
      actor,
    );
    preparation = await prepareBookingBatchModification({
      audience: actor.role === "ADMIN" ? "admin" : "member",
      candidateCheckIns: ordinaryGuard.candidateCheckIns,
      ...(adminOverride
        ? { adminOverride: { bookingId, requestedCheckIn: input.checkIn } }
        : {}),
    });
    // #1729's narrow guard, still before the transaction on this path.
    ordinaryGuard.decide(preparation.xeroLockDates);
  }
  const memberGuestPolicy = preparation.memberGuestPolicy;
  const subscriptionLockoutMode = preparation.subscriptionLockoutMode;
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
          include: { nights: { select: { stayDate: true, priceCents: true, priceSource: true } } },
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
    // #3232: the ordinary lock-date decision (#1729's narrow guard) for a CALLER
    // that owns the transaction, and only for one. Such a caller has no position
    // outside the transaction — it opened it before calling — so the decision has
    // to be made in here, and it can be: NOTHING IS READ, because the facts
    // arrived as a value resolved before that caller opened anything. It is
    // arithmetic over the post-lock row, which is better evidence than a pre-read
    // one. The standalone path keeps its pre-transaction decision, where a refusal
    // takes no locks. The one skip mirrors that pre-read's exactly: a
    // MEMBER-audience actor on a booking that is not theirs is not told about the
    // club's Xero state (the eligibility check above has already refused them, so
    // this is defence in depth rather than the decision).
    if (
      preTransaction &&
      !(actor.role !== "ADMIN" && booking.memberId !== actor.id)
    ) {
      assertDateEditClearsXeroLockDateFromFacts(
        booking,
        { checkIn: input.checkIn, checkOut: input.checkOut },
        preparation.xeroLockDates,
      );
    }
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

    // #3032 (epic #2797): refuse a second money-affecting edit while this
    // booking's last one is still under financial review. Taken here - under both
    // locks, on the post-lock re-read, and BEFORE `calculateModifiedPricing`
    // below or any write - so a refused edit changes nothing at all.
    //
    // THE PREDICATE IS `pricePreservingModification` ITSELF, not a second
    // expression that agrees with it today. An earlier revision fenced on
    // `!identityOnly && !creditElectionOnly` and repriced on that pair MINUS the
    // other-lodge term, so one request carrying `guestUpdates` AND
    // `otherLodgeMemberGuestIds` - a shape the route's schema accepts - skipped
    // the fence and then re-rated its guests off stored money that was under
    // review. #2978 fixed the identical drift on the neighbouring predicate one
    // revision earlier; two expressions for one question is the defect, so there
    // is now exactly one (`INV-SSOT`).
    //
    // A name correction and a credit election pass through: neither reads the
    // booking's stored money, so neither can compound an unresolved amount. The
    // rule itself, and why it is this narrow, are in
    // `assertNoPendingEditFinancialReview`.
    await assertNoPendingEditFinancialReview({
      bookingId,
      moneyAffecting: !pricePreservingModification,
      store: tx,
    });

    const pricingResult = pricePreservingModification
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

    /**
     * #3031/#3170 (epic #2797): THE EXACT ADJUSTMENT CANNOT BE READ FROM THIS
     * BOOKING'S OWN STORED SOLD-PRICE HISTORY.
     *
     * #3031 REFUSED here. #3032 parked the guest-removal path and deliberately
     * left this one refusing, because a removal's structural change is a row
     * delete — expressible without valuing anything — while this branch's is a
     * rewrite of every strand's night rows, and that needed a per-night integer
     * for nights each strand KEEPS. There was no honest number for those, and
     * `BookingGuestNight.priceCents` was `NOT NULL`, so "leave it blank" was not
     * representable either.
     *
     * #3170 made it representable, on the owner's decision of 30 Aug 2026, and
     * this path now does what the epic promised: THE CHANGE COMMITS AND THE
     * MONEY PARKS. The booking becomes what the member asked for; every night
     * whose price this booking can still tell us keeps it byte for byte; every
     * night it cannot is written as `NULL` — not known; and one OPEN
     * `EDIT_FINANCIAL_REVIEW` task per unreadable strand is raised inside this
     * same transaction for a person to price.
     *
     * NOTHING MOVES ON THIS BRANCH, and every one of those is a decision rather
     * than an omission: no reprice, no promotion recalculation, no change fee,
     * no settlement options, no refund, no credit, no Xero delta, and the
     * booking's own stored totals untouched. `priceDiffCents` falls out as 0
     * because the booking's money genuinely did not move, NOT because 0 was
     * chosen as the adjustment — the adjustment is unknown, and unknown is an
     * OPEN task with a null amount. A `$0` credit, a `$0` refund and a `$0`
     * raised amount are all real financial statements and none is written here.
     *
     * WHY THE CHANGE FEE IS 0 AND NOT COMPUTED. A change fee is a policy amount
     * this service could work out, but charging it would mean money moving on an
     * edit whose whole adjustment a person has yet to price — and it would move
     * through the same settlement call this branch is skipping. The admin
     * settles the entire adjustment, fee included, when they resolve the task.
     * The removal path takes exactly this line (`changeFeeCents: 0`).
     */
    const parked =
      pricingResult.kind === "financial_review_required" ? pricingResult : null;

    /**
     * #3214 (epic #2797): AN OTHER-LODGE ELECTION IS REFUSED ON THE EDIT THAT
     * PARKS THE MONEY, and the whole request is refused with it. Why refusal
     * rather than disclosure, and what each direction used to do, are in
     * `OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE`, which
     * `OtherLodgeRateAmountUnderReviewError` carries together with the status
     * that docblock argues for (`INV-MOD-028`).
     *
     * HERE and not one line earlier because the pricing pass is the only thing
     * that knows this edit parks — and not one line later because everything
     * below either composes what will be written or writes it. Nothing above
     * this point in the transaction has written anything: the advisory locks,
     * the post-lock re-read, the roster row lock, `prepareGuestPlan` and
     * `calculateModifiedPricing` are all locks and reads. So a refused edit
     * changes nothing at all, INCLUDING the lodge — which is exactly what it
     * used to save while dropping the ticks that came with it.
     *
     * READ OFF THE RESOLVED ELECTION, not off a second predicate that agrees
     * with it: `guestPlan.otherLodgeElection` is the object `applyGuestChanges`
     * is handed below, so the guard fences precisely the value that would be
     * written, and `resolveOtherLodgeRateElection` sets `requested` from the
     * same `requestCarriesOtherLodgeElection` that `pricePreservingModification`
     * above uses (`INV-SSOT`). The modify-quote preview refuses on the identical
     * field, so preview and save cannot disagree.
     */
    if (parked && guestPlan.otherLodgeElection.requested) {
      throw new OtherLodgeRateAmountUnderReviewError();
    }
    // Whether an admin confirmed an overbooking to make this edit fit. Read off
    // the union rather than off one branch, because #3170 puts the PARKED plan
    // through the same capacity check as the priced one — parking withholds the
    // money, never the beds — so both members carry it.
    const capacityOverridden = pricingResult.capacityOverridden;

    /**
     * #3170 asked whether a parked edit should carry a promo-code change, and
     * the answer was that it should not carry it but MUST NOT SWALLOW IT.
     * #3179 is where that second half was built.
     *
     * A member who asks to apply or remove a promo code in the same request as
     * a parked edit has that part of their request dropped: the stub below
     * keeps the booking's stored promotion figures and reports
     * `promoRemoved: false`, `promoChanged: false` over an HTTP 200. Parking
     * did not introduce that - `applyPromoCodeChanges` returns the same shape
     * for EVERY in-progress plan, priced or parked, because an in-progress edit
     * reuses prices already agreed and re-runs no promotion cap.
     *
     * So the fix is the one both branches share: the promotion is still not
     * re-run on either, and the member is TOLD on both. `promoEngineRan` below
     * is what makes that one answer rather than two.
     *
     * THIS PREDICATE IS NOT THAT ANSWER, and naming it accurately is the point.
     * It decides only whether the promotion figures are stubbed HERE. The other
     * stub is inside `applyPromoCodeChanges` itself, on an in-progress plan,
     * where this expression is `false` and the engine still does not run - so
     * reading this to decide what the member is told would have covered one of
     * the two branches and left the other silent.
     */
    const promoFiguresStubbedHere =
      pricePreservingModification || pricingResult.kind !== "priced";
    const promo = promoFiguresStubbedHere
      ? {
          newDiscountCents: booking.discountCents,
          newPromoAdjustmentCents: booking.promoAdjustmentCents,
          promoRemoved: false,
          promoChanged: false,
          // A price-preserving modification re-runs no cap, so it cannot change
          // who the promotion covers.
          promoCoverage: null,
          // #3179: this branch runs no promotion at all. The type on
          // `PromoChangeResult` is what forces this literal to answer the same
          // question the function does, so the notice below cannot be built off
          // a predicate that knows about only one of the two stubs.
          promoEngineRan: false,
        }
      : await applyPromoCodeChanges(tx, {
          booking,
          bookingId,
          input,
          inProgressPlan: pricingResult.inProgressPlan,
          newCheckIn: dates.newCheckIn,
          newTotalPriceCents: pricingResult.newTotalPriceCents,
          guestNightRates: pricingResult.guestNightRates,
          todayAtClub,
        });

    /**
     * #3179 (epic #2797): THE PART OF THE REQUEST THIS EDIT DID NOT DO, said
     * out loud.
     *
     * The stub above keeps the booking's stored promotion figures. When the
     * request ALSO carried a promo-code change, that change is dropped - the
     * edit still returns 200 and the booking still changes, so without this the
     * member is handed a success for something that half happened. The owner's
     * decision on #3179 is to save what can be honoured and warn clearly about
     * what cannot; this is the warning, and every surface downstream reads this
     * one value (`INV-SSOT`).
     *
     * READ OFF `promo.promoEngineRan`, NOT off the pricing branch. There are
     * TWO stubs, not one: the literal above, and `applyPromoCodeChanges`' own
     * in-progress early return. An in-progress edit that PRICES normally takes
     * neither `pricePreservingModification` nor the parked branch, so a
     * predicate built here would call the engine, receive the stubbed figures
     * back, and build no notice - the one branch this warning most needs to
     * cover if the in-progress refusals are ever relaxed. The flag comes from
     * whichever code decided to skip, which is the only place that knows.
     *
     * Null in the ordinary case, and null on a price-preserving echo, where a
     * promo change cannot arrive at all: `promoCode`/`removePromoCode` make a
     * request STRUCTURAL, which is what `pricePreservingModification` excludes.
     * The call is still made unconditionally on the skipped branch rather than
     * fenced on that reasoning, so that if the exclusion ever moves the member
     * is told instead of silenced.
     *
     * WHICH REASON. `dates.isInProgressEdit` and not the pricing branch: on a
     * stay already under way both surfaces refuse a promo change outright
     * (`resolveTargetDates`, and the matching block in the modify-quote route),
     * so that arm is defence in depth and its wording must still be true if a
     * refusal is ever relaxed - which is exactly why it has to be WIRED and not
     * merely written. The reachable case is the other one - a pre-check-in edit
     * whose money parked for review (#3166, `INV-MOD-028`), where the member
     * edit panel does show the promo card.
     */
    const promoChangeNotApplied = promo.promoEngineRan
      ? null
      : describePromoChangeNotApplied({
          requestedPromoCode: input.promoCode,
          removePromoCodeRequested: Boolean(input.removePromoCode),
          currentPromoCode: booking.promoRedemption?.promoCode?.code,
          // The RESOLVED removals, not `input.removeGuestIds`: a resent code's
          // sentence claims who it covers has not changed, and a removed guest
          // takes their `PromoRedemptionGuestTarget` row with them (cascade)
          // while the stored discount is written back untouched. An id naming
          // nobody on the booking removes nothing and must suppress nothing.
          guestRemovalsRequested: guestPlan.removedGuests.length > 0,
          reason: dates.isInProgressEdit
            ? "STAY_IN_PROGRESS"
            : "AMOUNT_UNDER_REVIEW",
          phase: "saved",
        });

    // #3170: on a parked edit the booking's stored final price is written back
    // unchanged rather than recomposed from the parked promotion figures. The
    // two agree by construction today, and deriving it would make this line
    // quietly depend on that agreement holding — `priceDiffCents` below is the
    // number every settlement decision reads, and it must be zero because the
    // booking did not move, not because two expressions happened to cancel.
    // (The removal path states the same reasoning at the same place.)
    const newTotalPriceCents =
      pricingResult.kind === "priced"
        ? pricingResult.newTotalPriceCents
        : booking.totalPriceCents;
    const newFinalPriceCents =
      pricingResult.kind === "priced"
        ? pricingResult.newTotalPriceCents + promo.newPromoAdjustmentCents
        : booking.finalPriceCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    // #3232 D2: what this move WOULD attract, before the club's waiver is applied.
    // A parked edit is priced by nobody, so it is zero here for the reason it is
    // zero everywhere else on that path.
    const chargeableChangeFeeCents = parked
      ? 0
      : await calculateModificationChangeFee({
      booking,
      newCheckIn: dates.newCheckIn,
      checkInChanged: dates.checkInChanged,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      db: tx, // locked transaction; see `CancellationPolicyDb`
      todayAtClub,
    });
    // #3232 D2: `waiveChangeFee` takes the same zero branch a parked edit takes,
    // so the waived fee is genuinely absent from every downstream decision rather
    // than subtracted back out somewhere later.
    const changeFeeCents = waiveChangeFee ? 0 : chargeableChangeFeeCents;
    // #3232 D2 (fix round): AND A WAIVER IS RECORDED ONLY WHERE A FEE WAS REALLY
    // SUPPRESSED. The flag alone is not evidence of one: `calculateModification
    // ChangeFee` already returns 0 for an unchanged check-in, a DRAFT booking and
    // a move outside every fee band, and a parked edit never asks it at all. Marking
    // those as "waived because our own supervision rule compelled this move"
    // over-counts precisely the number the field exists for — the one a treasurer
    // reconciles against the club setting — and puts a waiver in a dragged-along
    // booking's history that nobody granted.
    const changeFeeWaived = waiveChangeFee === true && chargeableChangeFeeCents > 0;

    // NULL ON A PARKED EDIT, which is what keeps `applyPaymentAdjustments`
    // inert below rather than a second zero literal beside it: with no options
    // and a `priceDiffCents` of 0 its net amount is 0, so it takes no refund
    // branch, no credit branch and no additional-charge branch, updates no
    // payment row, and returns zeros for both Xero legs. The existing machinery
    // is what proves nothing moved, rather than a parallel hand-built result
    // that could drift from it.
    const settlementOptions = parked
      ? null
      : await calculateModificationSettlementOptions({
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
      // #3170: on a parked edit the breakdown is SPARSE — a night whose price
      // this booking cannot tell us carries `null`, and `syncGuestNights` writes
      // that through as `NULL` rather than inventing a number or dropping the
      // row. The structural half commits; the money waits for a person.
      priceBreakdown:
        pricingResult.kind === "priced"
          ? pricingResult.priceBreakdown
          : pricingResult.parkedGuestRows,
      // #3166: NULL on a pre-check-in park, which selects the ORDINARY writer
      // branch below — the one that knows about member links, consent columns,
      // other-club flags and guest removal. An in-progress park still carries
      // its plan and still takes the in-progress branch. One field decides which
      // writer runs; `parkedGuestRows` above is what that writer is handed
      // either way, so neither branch composes its own rows.
      inProgressPlan:
        pricingResult.kind === "priced"
          ? pricingResult.inProgressPlan
          : pricingResult.parkedPlan,
      // Other Lodges epic: the election these rows were priced against, so the
      // per-guest flag is written from the same decision that cleared their
      // locked nights.
      otherLodgeElection: guestPlan.otherLodgeElection,
      // #2978 review: and who pricing actually rated at that rate, so a tick the
      // rate resolver declined is never stored as though it had been honoured.
      // A parked edit runs no rate resolver at all, so it rated nobody at the
      // other-lodge rate and stores no such flag — the same answer the
      // price-preserving echo gives, and for the same reason.
      otherLodgeRatedGuestIds:
        pricingResult.kind === "priced"
          ? pricingResult.otherLodgeRatedGuestIds
          : new Set<string>(),
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
        totalPriceCents: newTotalPriceCents,
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
        // (capacityOverridden from calculateModifiedPricing), so
        // RECONCILE the marker — stamp when admitted over capacity behind a
        // confirm, and CLEAR any prior stamp when the change moved the booking
        // back within capacity, so a stale flag can't suppress a legitimate
        // cancel on the new nights later.
        capacityOverriddenAt: capacityOverridden ? new Date() : null,
        capacityOverriddenByMemberId: capacityOverridden
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
          totalPriceCents: newTotalPriceCents,
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
          // #3179: and the same for a promo-code change this edit could not
          // carry. The booking's own timeline replays it, so "why is the code
          // still on it?" has an answer months later.
          ...(promoChangeNotApplied
            ? { promoChangeNotAppliedNote: promoChangeNotApplied.message }
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
                capacityOverridden: capacityOverridden,
              }
            : {}),
          // #3232 D2: the zero beside this is a WAIVER, and which waiver. Only
          // where a fee really was suppressed — see `changeFeeWaived` above.
          ...(changeFeeWaived
            ? {
                changeFeeWaived: true,
                changeFeeWaivedReason: LINKED_MOVE_CHANGE_FEE_WAIVED_REASON,
              }
            : {}),
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    /**
     * #3170 (epic #2797), the money half of parking: ONE OPEN
     * `EDIT_FINANCIAL_REVIEW` TASK PER UNREADABLE STRAND, raised inside this
     * same transaction and under the locks it already holds, so the structural
     * change and the record that its money is unresolved either both land or
     * neither does. The guest-removal path is the worked example and this
     * follows it line for line.
     *
     * ANCHORED TO THIS EDIT'S OWN `BookingModification` ROW (owner decision
     * D-3032-1), written immediately above, so a credit or refund that
     * eventually moves is keyed to the change that caused it rather than to a
     * second history row minted at completion.
     *
     * The raise is a find-then-create with a P2002 catch on the occurrence-key
     * index, so a REPLAY returns the task already on file instead of throwing a
     * unique violation that would roll this edit's structural half back with it.
     * That is what makes "a replay raises nothing further" true rather than
     * hoped for.
     *
     * The raise ITSELF - the settlement payment id, the strand's member, the
     * null amount - is `raiseParkedEditFinancialReviewTasks`, and is stated once
     * there rather than four times across the four parked doors (#3166,
     * `INV-SSOT`).
     */
    await raiseParkedEditFinancialReviewTasks({
      booking,
      guests: booking.guests,
      // A batch edit can add guests in the same request. They are priced and
      // written normally while the booking's own total is frozen, so the money
      // is owed and only their rows record it.
      addedGuests: createdGuests,
      occurrences: parked?.occurrences ?? [],
      bookingModificationId: bookingModification.id,
      store: tx,
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
    //
    // NOT WHEN THE CALLER IS COMPOSING SEVERAL BOOKING WRITES (#3232), and this
    // one is not a nicety — it is a 500 the linked move hit on the real database.
    // `SET CONSTRAINTS ... IMMEDIATE` applies for the REST OF THE TRANSACTION, not
    // just to the queued checks, so flushing at the end of the FIRST booking's
    // write turns the envelope triggers immediate for the second booking's — and
    // the second booking legitimately writes its guest stay ranges before its own
    // `Booking` row, which is exactly the ordering these triggers are deferrable
    // in order to permit. Measured: the dependent's guest update was refused with
    // `BookingGuest stay range must be within parent Booking date range`, naming
    // the new stay range against the OLD booking window, and the member got the
    // internal-consistency 500.
    //
    // The caller that took `hostingReconcile: "CALLER"` is by definition the one
    // that owns the end of this transaction, so it owns this flush too and
    // performs it once, after every booking is written. Forgetting it costs
    // ATTRIBUTION and not safety: the triggers are `DEFERRABLE INITIALLY
    // DEFERRED`, so a genuine violation still fails the COMMIT — just as an
    // anonymous transaction error rather than one carrying this service's stack.
    if (hostingReconcile !== "CALLER") await assertBookingEnvelopeInvariants(tx);

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
    //
    // #3232: DEFERRED, not skipped, when the caller is composing several booking
    // writes into one transaction. See `hostingReconcile` — an intermediate state
    // where one of two linked bookings has moved would be refused by this very
    // rule, over a state that was never going to be committed. The obligation
    // travels back to the caller as `pendingHostingReconcile`.
    const reconcileHosting = async () => {
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
      ...(approvedExceptionAdultMemberHostingDecision
        ? { decision: approvedExceptionAdultMemberHostingDecision }
        : {}),
      ...hostingCoverageActorOptions({
        actorRole: actor.role,
        actorMemberId: actor.id,
        // #3232: a batch edit CAN move the stay, and this seam runs after the
        // write, so the dependent fan-out would otherwise be narrowed to the new
        // nights and would miss a booking that was relying on the old ones.
        // `booking` is the post-lock PRE-WRITE snapshot — the window the booking
        // really held, never the window the caller asked for.
        vacatedRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
        ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
        // #3232: a member who was offered the linked move and declined it is
        // escalated rather than refused — see `hostingCoverageActorOptions`. The
        // owner travels WITH the answer, from the same pre-write snapshot, because
        // the answer only means anything if the actor is the person whose two
        // bookings these are; an officer answering here would otherwise skip §7's
        // confirmation and its mandatory reason.
        ...(hostingCoverageLinkedMove
          ? {
              linkedMove: {
                answer: hostingCoverageLinkedMove,
                bookingOwnerMemberId: booking.memberId,
              },
            }
          : {}),
      }),
      });
    };
    if (hostingReconcile !== "CALLER") await reconcileHosting();

    return {
      booking: updatedBooking,
      pendingHostingReconcile:
        hostingReconcile === "CALLER" ? reconcileHosting : undefined,
      priceDiffCents,
      changeFeeCents,
      changeFeeWaived,
      // #3232 (fix round): the WRITE's own answer to "does this settlement need a
      // card-or-credit choice", so a caller quoting on one option cannot disagree
      // with the refusal it will hit. Null options (a parked edit) need nothing.
      requiresSettlementMethod:
        settlementOptions?.requiresSettlementMethod === true,
      refundAmountCents: payments.refundAmountCents,
      accountCreditAmountCents: payments.accountCreditAmountCents,
      additionalAmountCents: payments.additionalAmountCents,
      pendingRefundAmountCents: payments.pendingRefundAmountCents,
      promoRemoved: promo.promoRemoved,
      promoChanged: promo.promoChanged,
      promoCoverage: promo.promoCoverage,
      promoChangeNotApplied,
      choreWarnings,
      datesChanged: dates.datesChanged,
      adminOverride,
      notifyMember,
      capacityOverridden: capacityOverridden,
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
      requiresSettlementMethod: result.requiresSettlementMethod,
      additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
      stripeRefundId: stripeRefundId ?? null,
      promoRemoved: result.promoRemoved,
      promoChanged: result.promoChanged,
      promoCoverage: result.promoCoverage,
      promoChangeNotApplied: result.promoChangeNotApplied,
      choreWarnings: result.choreWarnings,
      creditElectionCents: result.creditElectionCents,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      capacityOverridden: result.capacityOverridden,
    };
  };

  if (callerTx) {
    // tx-mode: the caller owns the commit. The modification is already applied in
    // the caller's transaction; provider work runs after commit via
    // `deferredPostCommit`. Provider-derived fields (`stripeRefundId` /
    // `additionalPaymentClientSecret`) are null here — they do not exist yet, since
    // they are produced by work that has not run.
    //
    // THE OLD JUSTIFICATION FOR THE NULLS — "and the approval does not surface
    // them" — WAS TRUE OF ONE CALLER AND IS NOT TRUE OF THE OTHER (#3232 fix
    // round). An officer's policy-exception approval really does not show a member
    // a payment sheet; a member's own linked-move save does, and it is a live save
    // on a page with a Pay control. What makes the null safe there is not that
    // nobody wanted a secret, it is that each booking's increase is collectable
    // from that booking's own page through
    // `/api/bookings/[id]/additional-payment-secret`, per booking and never as a
    // combined charge — which is why the offer's own money sentence says the
    // amount is payable ACROSS the bookings and settles on each separately
    // (`formatLinkedMoveMoneySentence`), rather than implying one payment step.
    return {
      booking: result.booking,
      ...(result.pendingHostingReconcile
        ? { pendingHostingReconcile: result.pendingHostingReconcile }
        : {}),
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      additionalAmountCents: result.additionalAmountCents,
      settlementMethod: result.settlementMethod,
      requiresSettlementMethod: result.requiresSettlementMethod,
      additionalPaymentClientSecret: null,
      stripeRefundId: null,
      promoRemoved: result.promoRemoved,
      promoChanged: result.promoChanged,
      promoCoverage: result.promoCoverage,
      promoChangeNotApplied: result.promoChangeNotApplied,
      choreWarnings: result.choreWarnings,
      creditElectionCents: result.creditElectionCents,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      capacityOverridden: result.capacityOverridden,
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
    // #3232 D2: present only on a waiver, so a query for waived fees is a query
    // for this key rather than a guess at which zeroes meant something.
    ...(result.changeFeeWaived
      ? {
          changeFeeWaived: true,
          changeFeeWaivedReason: LINKED_MOVE_CHANGE_FEE_WAIVED_REASON,
        }
      : {}),
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    promoRemoved: result.promoRemoved,
    promoChanged: result.promoChanged,
    promoCoverageNote: result.promoCoverage?.message ?? null,
    // #3179: the audit trail carries the dropped promo-code change too, so an
    // officer answering "I asked for a discount and did not get it" can see
    // exactly what the member was told and when.
    promoChangeNotAppliedNote: result.promoChangeNotApplied?.message ?? null,
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

  /*
    #3032 (epic #2797): does this booking's money sit under review as this email
    is written?

    NOT "did this edit park money" - this path parks none. The batch park is
    #3170, held on an owner money decision, so a value derived from THIS edit
    would be a constant `false` dressed up as a computation, and would stay
    `false` on the day #3170 lands. The question the member is owed is the one
    every other member-facing surface answers: is the club still working out an
    amount on this booking. Read from `bookingHasOpenFinancialReview`, the same
    reader behind the booking-detail banner and the My Bookings row, so the
    email cannot say one thing while the page the member opens says another
    (`INV-SSOT`).

    Read after the transaction commits, deliberately: this edit decided nothing
    about the review, so the honest answer is the booking's state now, not a
    value captured earlier in a transaction that never touched it. That is the
    opposite of the removal path, where the transaction DID decide it and
    carries the answer out on its result.
  */
  const financialReviewPending = await bookingHasOpenFinancialReview(
    result.booking.id,
  );

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
    // #3179: and if the edit could not carry a promo-code change, the email
    // says THAT in the same words too. The email is the durable copy: a member
    // who closed the panel without reading the banner still has this.
    promoChangeNotAppliedNote: result.promoChangeNotApplied?.message ?? null,
    financialReviewPending,
    lodgeId: result.booking.lodgeId,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to send batch modification email",
    ),
  );
}
