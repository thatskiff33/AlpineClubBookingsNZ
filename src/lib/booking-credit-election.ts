import { BookingStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import {
  applyCreditToBooking,
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
  lockMemberCreditLedger,
} from "@/lib/member-credit";
import { calculateBookingCreditApplication } from "@/lib/policies/booking-route-decisions";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";

/**
 * The stored credit election (#2265, epic #2245 E1).
 *
 * A member can tick "use my credit" in the booking wizard and then save the
 * booking as a draft. Applying the credit there would tie their balance up
 * against a booking that may never be confirmed, so the owner's decision was to
 * REMEMBER the election on the draft (`Booking.creditElectionCents`) and apply
 * it the moment the booking reaches `PAYMENT_PENDING` — the same point at which
 * a directly-confirmed booking applies credit.
 *
 * Because time passes between the election and the confirmation, the amount the
 * member asked for is not necessarily still available or still owed: they may
 * have spent the balance on another booking, an admin may have adjusted it, or
 * the draft may have been edited to a lower price. This module resolves that
 * gap, and the rule it follows is CLAMP, NOT REFUSE.
 *
 * Why clamp. `calculateBookingCreditApplication` throws when the request
 * exceeds the balance or the price, and that is right where it is used — at
 * booking-create, the wizard validated the balance seconds earlier in the same
 * request, so an over-request there is a bug worth failing loudly. At
 * confirmation the same over-request is ordinary life, and throwing would leave
 * the member unable to pay their own draft at all: the pay step would 500 and
 * the only escape would be deleting the booking. The house already settled this
 * question the same way for the neighbouring case — `clampAppliedCreditToBookingPrice`
 * (#1887) clamps already-applied credit down when a modification reprices a
 * booking below it, precisely so the booking stays payable. This follows that
 * precedent.
 *
 * What is never allowed is applying less than the member asked for WITHOUT
 * saying so, so the outcome returned here carries the requested amount, the
 * applied amount, the shortfall and its reason, and the pay route returns them
 * to the client.
 *
 * The election is single-consumption, and that is enforced by a guarded CLAIM,
 * not by a read-then-write: the column is moved from the exact amount that was
 * read to NULL with `updateMany`, inside the same transaction that writes the
 * credit ledger row. A concurrent consumer, a retry, a double-submit or a
 * second pay attempt therefore either wins the claim and applies the credit
 * exactly once, or loses it and does nothing at all.
 */
export type StoredCreditElectionOutcome = {
  /** What the member asked to apply, in integer cents, as stored on the draft. */
  requestedCents: number;
  /** What was actually applied to the booking, in integer cents. */
  appliedCents: number;
  /** `requestedCents - appliedCents`; greater than zero means reality moved. */
  shortfallCents: number;
  /**
   * Which bound actually decided the applied amount. `"none"` when the full
   * election was applied. `"balance"` when the member's live balance is what
   * capped it, `"price"` when the booking's uncovered price is what capped it,
   * and `"balance_and_price"` only when the two are EQUAL and both below the
   * request — the one case where naming a single culprit would be arbitrary. A
   * bound that sits under the request but above the other bound did not decide
   * anything and is not reported, so the member is never told their balance was
   * short when the price was the real cap.
   */
  shortfallReason: "none" | "balance" | "price" | "balance_and_price";
  /** The member's credit balance at the moment of application, integer cents. */
  availableBalanceCents: number;
  /**
   * True when the booking is now fully covered by account credit and owes no
   * card payment at all. The caller must settle it at $0 rather than mint a
   * Stripe intent (Stripe rejects zero-amount intents).
   */
  fullyCovered: boolean;
};

/**
 * Consume the booking's stored credit election, if it has one.
 *
 * Must run inside the caller's transaction, and only once the booking is in
 * `PAYMENT_PENDING` — a booking still in `DRAFT` or `AWAITING_REVIEW` must not
 * have its credit consumed, which is the whole point of storing the election
 * rather than applying it. Returns `null` when there is nothing to do (no
 * election stored, the booking is not in a state that may consume one, or a
 * concurrent consumer won the claim first), in which case not a single row is
 * written.
 *
 * Lock order. The per-member credit-ledger lock is taken FIRST, before any
 * Booking row is written, because that is the order every other credit writer
 * in the house uses (`member-credit.ts` documents the lock; the modification
 * clamp, the Internet Banking switch and the cancellation restores all take it
 * before touching the booking). The caller is expected to already hold the
 * global booking lock(1) and, where it claims capacity, the per-lodge lock, so
 * the composed order stays global -> lodge -> member.
 *
 * Concurrency. Everything the decision depends on is read AFTER the lock, and
 * the election is then taken with a guarded claim — `updateMany` matching the
 * booking id, `PAYMENT_PENDING`, and the exact amount that was read. Two
 * requests racing on the same booking cannot both see a claim succeed, so the
 * credit can never be debited twice and the loser reports "nothing to do"
 * rather than a phantom outcome its caller would act on (a second confirmation
 * email, a second Xero invoice, a second MEMBER_PAID event).
 *
 * Credit is applied through the ordinary `applyCreditToBooking` path — the same
 * ledger row shape, the same validation, the same
 * `deriveBookingAppliedCreditCents` arithmetic — so the invariant
 * `amountCents + creditAppliedCents = finalPriceCents` on the Payment mirror
 * continues to hold and no bespoke money arithmetic exists here.
 */
export async function consumeStoredCreditElection(
  tx: Prisma.TransactionClient,
  { bookingId }: { bookingId: string },
): Promise<StoredCreditElectionOutcome | null> {
  // Pre-lock read: the lock key (memberId) plus the cheap "is there anything to
  // do at all" test, so a booking with no election costs one SELECT and takes
  // no lock. Every decision below consumes the POST-lock re-read instead.
  const lockTarget = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true, creditElectionCents: true },
  });

  if (!lockTarget || lockTarget.creditElectionCents == null) return null;

  await lockMemberCreditLedger(lockTarget.memberId, tx);

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      status: true,
      finalPriceCents: true,
      creditElectionCents: true,
    },
  });

  if (!booking || booking.creditElectionCents == null) return null;
  // Defence in depth. Credit belongs to the member until the booking is real;
  // a DRAFT or AWAITING_REVIEW booking keeps its election stored and untouched.
  if (booking.status !== BookingStatus.PAYMENT_PENDING) return null;

  const requestedCents = booking.creditElectionCents;

  // Guarded claim (#2265). Matching on the status AND the exact amount read
  // means the election is taken atomically: whoever's UPDATE lands first sets
  // the column to NULL and every other racer matches zero rows. A lost claim is
  // NOT an error — a concurrent pay attempt already applied the credit, or a
  // concurrent cancel moved the booking out of PAYMENT_PENDING — so return
  // "nothing to do" and let the caller carry on against the live ledger.
  const claimed = await tx.booking.updateMany({
    where: {
      id: bookingId,
      status: BookingStatus.PAYMENT_PENDING,
      creditElectionCents: requestedCents,
    },
    data: { creditElectionCents: null },
  });

  if (claimed.count === 0) return null;

  const availableBalanceCents = await getMemberCreditBalance(booking.memberId, tx);
  // Credit may already have been applied to this booking by another path (an
  // admin, or a legacy flow). The election can only claim the REMAINING price,
  // never re-cover a slice that is already covered.
  const alreadyAppliedCents = await deriveBookingAppliedCreditCents(bookingId, tx);
  const outstandingPriceCents = Math.max(
    0,
    booking.finalPriceCents - alreadyAppliedCents,
  );

  // Which bound ACTUALLY bound? A bound only counts when it is below the
  // request (so it bit at all) AND is no higher than the other bound (so it is
  // the one that decided the answer). Both flags are true only when the two
  // bounds are equal and both below the request — the honest reading of
  // "balance and price". Reporting `balance_and_price` merely because both
  // happened to sit under the request told a member whose price had dropped
  // that their balance was short when it was not.
  const limitedByBalance =
    availableBalanceCents < requestedCents &&
    availableBalanceCents <= outstandingPriceCents;
  const limitedByPrice =
    outstandingPriceCents < requestedCents &&
    outstandingPriceCents <= availableBalanceCents;
  const clampedRequestCents = Math.max(
    0,
    Math.min(requestedCents, availableBalanceCents, outstandingPriceCents),
  );

  // The clamp above is the ONLY new arithmetic; the application decision itself
  // stays in the shared policy function, which by construction can no longer
  // throw now that the request is inside both of its bounds.
  const { creditAppliedCents } = calculateBookingCreditApplication({
    requestedCreditCents: clampedRequestCents,
    creditBalanceCents: availableBalanceCents,
    finalPriceCents: outstandingPriceCents,
    status: BookingStatus.PAYMENT_PENDING,
  });

  if (creditAppliedCents > 0) {
    await applyCreditToBooking(
      booking.memberId,
      creditAppliedCents,
      bookingId,
      tx,
    );
  }

  const shortfallCents = requestedCents - creditAppliedCents;
  const shortfallReason: StoredCreditElectionOutcome["shortfallReason"] =
    shortfallCents <= 0
      ? "none"
      : limitedByBalance && limitedByPrice
        ? "balance_and_price"
        : limitedByBalance
          ? "balance"
          : "price";

  return {
    requestedCents,
    appliedCents: creditAppliedCents,
    shortfallCents: Math.max(0, shortfallCents),
    shortfallReason,
    availableBalanceCents,
    fullyCovered:
      booking.finalPriceCents > 0 &&
      alreadyAppliedCents + creditAppliedCents >= booking.finalPriceCents,
  };
}

/**
 * Statuses a stored credit election may be WRITTEN onto (#2266, the edit-path
 * counterpart of #2265's create-path election). The set is exactly the set of
 * statuses whose election a consumer will later honour:
 *
 *  - `DRAFT` / `AWAITING_REVIEW` — the same statuses booking-create stores an
 *    election on; consumed when the booking pays at `PAYMENT_PENDING`.
 *  - `PAYMENT_PENDING` — the pay step's consumption door explicitly handles a
 *    `PAYMENT_PENDING` booking carrying an election (create-payment-intent's
 *    released-from-review arm, and the Internet Banking switch), so an election
 *    stored here is consumed on the very next pay attempt.
 *
 * `PENDING` is deliberately ABSENT even though members can edit PENDING
 * bookings: `charge-saved-method` requires `PENDING` and does not consume
 * elections — `booking-credit-election.ts`'s settle-door notes (#2319) rely on
 * "no election-bearing booking is ever in PENDING", and the create flow
 * likewise never stores an election for a hold-rail booking. Keeping PENDING
 * out preserves that invariant; the hold release lands the booking in
 * `PAYMENT_PENDING`, where the member can elect their credit.
 *
 * Known accepted noise (#2266, LOW-8): because `PAYMENT_PENDING` is writable,
 * a member whose election was already CONSUMED by a pay attempt (intent
 * minted, credit applied, booking still `PAYMENT_PENDING` until capture) can
 * edit and RE-ARM a fresh election. If the earlier intent then captures, the
 * settle doors (#2319) clear the re-armed election and fire the "unapplied
 * election" operator alert even though the earlier sibling consumption
 * already applied credit — a redundant alert for that case. This is accepted
 * rather than suppressed: money conservation always holds (the clear debits
 * nothing — pinned in issue-2265-credit-election-service.test.ts), and a
 * ledger-based suppression ("credit was already applied to this booking")
 * would also silence the genuinely informative case where the member
 * re-elected MORE credit that the already-minted intent amount cannot honour
 * — the member then paid full freight on the intent while holding an
 * unhonoured request, which is exactly what the alert exists to surface. A
 * sometimes-redundant alert is honest; a sometimes-wrongly-silent one is not.
 */
const CREDIT_ELECTION_WRITABLE_STATUSES = new Set<string>([
  BookingStatus.DRAFT,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.PAYMENT_PENDING,
]);

export class CreditElectionNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditElectionNotAllowedError";
  }
}

/**
 * Decide what a modification writes to `Booking.creditElectionCents` (#2266).
 *
 * Pure policy, so the rules are unit-testable away from the modify machinery:
 *
 *  - request absent          -> `undefined` (leave the stored election alone)
 *  - request 0               -> `null` (clear; always safe — clearing takes
 *                               nothing from anybody)
 *  - edit settled at $0      -> `null` (the election is moot: nothing is left
 *                               for credit to pay, the same silence as
 *                               confirm-draft's $0 arm; #2319's lifecycle arm
 *                               already cleared the old value)
 *  - request > 0             -> the requested cents, stored RAW exactly as the
 *                               draft-create branch stores it — the pay step
 *                               clamps to the live balance and outstanding
 *                               price and reports any shortfall (#2265) —
 *                               provided the booking can still consume it:
 *                               a writable status, no captured payment, and
 *                               not organiser-settled (the member owes nothing
 *                               on an organiser-settled booking). Anything
 *                               else throws rather than storing a request no
 *                               consumer would ever honour.
 *
 * `status` must be the POST-lifecycle status of this edit, so an edit that
 * parks the booking for review stores the election on `AWAITING_REVIEW` (the
 * create flow's exact behaviour) and an edit of a settled booking refuses.
 */
export function resolveCreditElectionUpdate({
  requestedCents,
  status,
  organiserSettled,
  hasCapturedPayment,
  settledAtZeroDollars,
}: {
  requestedCents: number | undefined;
  status: string;
  organiserSettled: boolean;
  hasCapturedPayment: boolean;
  settledAtZeroDollars: boolean;
}): number | null | undefined {
  if (requestedCents === undefined) return undefined;
  if (!Number.isInteger(requestedCents) || requestedCents < 0) {
    throw new CreditElectionNotAllowedError(
      "Credit amount must be a whole number of cents",
    );
  }
  if (settledAtZeroDollars || requestedCents === 0) return null;

  if (organiserSettled) {
    throw new CreditElectionNotAllowedError(
      "Account credit cannot be applied to a booking your organiser settles",
    );
  }
  if (hasCapturedPayment || !CREDIT_ELECTION_WRITABLE_STATUSES.has(status)) {
    throw new CreditElectionNotAllowedError(
      "Account credit can only be applied to a booking that has not been paid yet",
    );
  }

  return requestedCents;
}

/**
 * Who the booking page's saved-election notice may address (#2266 MED-2).
 *
 * The stored election is the OWNER's money: the amount and the second-person
 * promise ("your credit choice…") belong to the booking owner alone, and the
 * admin viewer gets the established third-person phrasing. A linked-guest
 * viewer (a member listed on somebody else's booking) gets NOTHING — not even
 * a neutral third-person line — matching how every other money surface on the
 * booking page is gated (`showCreditApplied` on canManageBooking, the payment
 * cards owner-positive per #1303/#1289): linked guests keep second-person
 * framing for stay copy, but the owner's financial affairs are never
 * disclosed to them, and a notice without the amount would still disclose
 * that the owner elected credit while offering the guest nothing actionable.
 *
 * Pure so the three viewer classes are unit-testable away from the page.
 */
export function resolveCreditElectionNoticeAudience({
  isBookingOwner,
  isNonOwnerAdminViewer,
}: {
  isBookingOwner: boolean;
  isNonOwnerAdminViewer: boolean;
}): "owner" | "admin" | null {
  if (isBookingOwner) return "owner";
  if (isNonOwnerAdminViewer) return "admin";
  return null;
}

/**
 * The audit action a settlement writes when it CLEARS a stored credit election
 * it could not honour (#2265, #2319 doors 1 and 2).
 *
 * One constant rather than a literal per call site, because two things read it
 * back: the member's own booking history (`booking-history.ts` renders it as
 * "Saved account credit was not applied", keyed on this exact string and on a
 * `creditElectionCents` key in the audit `details` JSON) and the booking page's
 * audit allowlist. A typo'd action string would silently render nothing, which
 * is precisely the silence this audit exists to prevent.
 */
export const UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION =
  "booking.credit_election.unapplied";

/**
 * Clear a stored credit election off a booking whose settlement cannot honour
 * it, returning the cents cleared (or `null` when there was nothing to clear).
 *
 * When clearing is the honest answer. The election records that the member ASKED
 * to put account credit towards this booking; it is consumed at
 * `PAYMENT_PENDING` by the card pay step and the switch-to-Internet-Banking
 * route, both of which recompute what is owed from the ledger AFTERWARDS so the
 * charge or invoice is raised for the post-election remainder. A settlement that
 * arrives with the full price already captured — cash against a full-price Xero
 * invoice, or a Stripe intent that already succeeded — is at the other end of
 * that pipe. "Applying" the election there would debit the member's balance for
 * money they have already handed over, inventing a charge rather than honouring
 * a choice. The payment stands, the balance stays whole, and the election simply
 * cannot be honoured on this booking any more — so it must be cleared, because
 * a settled booking carrying a non-NULL election advertises an outstanding
 * request that nothing will ever act on.
 *
 * What clearing is NOT for: a settlement that has not yet taken the money. There
 * the election is still honourable and the caller must refuse or defer, never
 * clear — throwing away a member's request to make a charge simpler would be the
 * original #2265 bug wearing a different hat. `payment-link.ts` shows both
 * halves of that distinction in one function.
 *
 * Guarded claim, the same discipline `consumeStoredCreditElection` uses: the row
 * moves from the EXACT amount that was read to NULL, so a consumer racing this
 * writer either already applied the credit (this claim matches nothing and
 * reports "nothing stale") or has not run yet and is untouched. Callers that
 * hold `pg_advisory_xact_lock(1)` already exclude both real consumers; the guard
 * means the property does not depend on that.
 *
 * Callers MUST report a non-null return: an audit row under
 * `UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION` (the member's booking history renders
 * it) and an operator alert, so a member who chose to spend credit and then paid
 * full price is told their balance is intact rather than left guessing.
 */
export async function clearStaleCreditElection(
  tx: Prisma.TransactionClient,
  booking: { id: string; creditElectionCents: number | null },
): Promise<number | null> {
  const requestedCents = booking.creditElectionCents;
  if (requestedCents == null) return null;

  const claimed = await tx.booking.updateMany({
    where: { id: booking.id, creditElectionCents: requestedCents },
    data: { creditElectionCents: null },
  });

  return claimed.count === 1 ? requestedCents : null;
}

/**
 * Thrown when the $0 settlement's status-guarded claim matches no row: the
 * booking left `PAYMENT_PENDING` (a concurrent cancel, most likely) while this
 * transaction was assembling its settlement. Loud on purpose — the caller's
 * transaction must roll back, taking the credit application with it, rather
 * than resurrect a cancelled booking as PAID.
 */
export class CreditCoveredSettlementConflictError extends Error {
  constructor(bookingId: string) {
    super(
      `Booking ${bookingId} left PAYMENT_PENDING during the credit-covered settlement`,
    );
    this.name = "CreditCoveredSettlementConflictError";
  }
}

/**
 * Settle a booking whose account credit now covers its whole price, so it owes
 * no card payment.
 *
 * Same shape as the existing zero-dollar settlements (`createConfirmedBooking`'s
 * fully-credit-covered branch and `applyLifecycleTransitions`' repriced-to-zero
 * branch): status PAID, one $0 SUCCEEDED Payment mirroring the applied credit
 * so `amountCents + creditAppliedCents = finalPriceCents` holds, and every
 * stale primary Stripe intent queued for cancellation. Must run inside the
 * caller's transaction, which must already hold the global booking lock(1) and
 * the booking's per-lodge capacity lock; the caller performs the post-commit
 * side effects (member email, Xero invoice, booking event, provider intent
 * cancellations).
 *
 * The PAID write is a status-guarded claim, so a booking that a concurrent
 * cancel moved out of `PAYMENT_PENDING` can never be clobbered back to PAID.
 */
export async function settleFullyCreditCoveredBooking(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    appliedCreditCents,
  }: { bookingId: string; appliedCreditCents: number },
): Promise<{ supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] }> {
  // Status-guarded claim FIRST, so nothing else in this settlement is written
  // for a booking that is no longer payable.
  const claimed = await tx.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
    data: { status: BookingStatus.PAID },
  });

  if (claimed.count === 0) {
    throw new CreditCoveredSettlementConflictError(bookingId);
  }

  // #2576 §9. A fully credit-covered settlement is a confirmation
  // (PAYMENT_PENDING -> PAID) and §9 names payment completion, so the hosting facts
  // have to be re-read rather than trusted from the quote. Enqueued rather than
  // refused for the reason every payment path is: the member's credit has been
  // committed by the time this runs, so throwing would leave a debited balance
  // pointing at a booking the club had just refused. The row commits with the claim
  // and the caller drains it after the transaction.
  await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
    cause: "SYSTEM_CHANGE",
  });

  const payment = await tx.payment.upsert({
    where: { bookingId },
    create: {
      bookingId,
      amountCents: 0,
      creditAppliedCents: appliedCreditCents,
      status: PaymentStatus.SUCCEEDED,
    },
    update: {
      amountCents: 0,
      creditAppliedCents: appliedCreditCents,
      status: PaymentStatus.SUCCEEDED,
      // Nothing is owed by card, so no card pointer on this Payment can still
      // be live. Clearing them is the same shape the repriced-to-zero
      // settlement uses (booking-modify-settlement.ts). It is not hypothetical:
      // a booking reaches this settlement THROUGH `PAYMENT_PENDING`, and a
      // previous pay attempt on the same booking can already have minted a
      // primary intent (the member started paying by card, abandoned it, and
      // their balance then grew enough to cover the stay) — that intent must
      // stop being pointed at as well as being cancelled with the provider,
      // which the queue below does.
      //
      // Note on the two OTHER card doors, since an earlier draft of this comment
      // named them as producers here and was wrong (#2319). A public payment
      // link cannot reach a booking carrying an unconsumed election — it now
      // refuses one outright (payment-link.ts) — and `charge-saved-method`
      // requires `PENDING`, a status no election-bearing booking is ever in.
      //
      // `stripePaymentMethodId` is DELIBERATELY kept (unlike the
      // booking-modify-settlement sibling): a split parent's saved card is the
      // fallback the deferred non-member guest charge uses
      // (`savedPaymentMethodForBooking` in saved-payment-method.ts, which the
      // cron, the admin confirm route, the member page and payment-link.ts all
      // read — and which since #3269 counts the card only with its
      // `stripeSetupIntentId` beside it), so clearing it here would strip the
      // card the child booking is charged on later. Nothing about this
      // booking's own settlement needs it gone.
      stripePaymentIntentId: null,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
  });

  // A zero effective price supersedes every positive pending primary intent —
  // the same sweep the repriced-to-zero modification path performs.
  const supersededPrimaryPaymentIntents =
    await queueSupersededPrimaryIntentCancellations(tx, {
      bookingId,
      paymentId: payment.id,
      newFinalPriceCents: 0,
    });

  return { supersededPrimaryPaymentIntents };
}
