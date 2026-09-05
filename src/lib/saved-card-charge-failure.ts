/**
 * #3268 — when a saved-card auto-charge fails, decide whether retrying could
 * ever help, and retire the card when it cannot.
 *
 * `confirmPendingBookings` charges the saved card off-session once the hold
 * deadline passes. Until #3268 every thrown Stripe error was treated the same
 * way: release the capacity claim, alert admins, try again next run. In
 * production a payment method that Stripe would never accept again ("The
 * provided PaymentMethod was previously used with a PaymentIntent without
 * Customer attachment ... It may not be used again") was retried 24 times over
 * four days on the 3-hourly schedule — beds unheld throughout, admins alerted
 * every run, member never told.
 *
 * Two exports, one policy (INV-PAY-054):
 *
 *   - `classifySavedCardChargeFailure` reads the thrown error structurally
 *     through `readStripeErrorFields` (`stripe-errors.ts`) — the SDK puts the
 *     API type in `rawType`, not `type`, and the raw webhook /
 *     `last_payment_error` shape puts it in `type`; the reader accepts both —
 *     and returns `terminal` only when an automated retry cannot succeed. Everything it does not recognise is
 *     `retry`, which is exactly today's behaviour — the classifier can only
 *     narrow the retry loop, never widen it.
 *
 *   - `retireUnusableSavedCard` makes a terminal card unusable everywhere:
 *     detached at Stripe (best-effort, INV-INT-003: outside any transaction)
 *     and cleared from EVERY `Payment` row carrying that exact id — the row it
 *     was charged from AND the parent row a split child borrowed it from, which
 *     is what stops the next run re-borrowing it.
 *
 * `stripeSetupIntentId` and `stripeCustomerId` are deliberately left in place.
 * The setup-intent route's `seti_<bookingId>_<previousSetupIntentId>`
 * idempotency chain (#3266) depends on the previous id staying put, and the
 * customer is still the member's customer.
 */
import logger from "@/lib/logger";
import { prisma } from "./prisma";
import { detachPaymentMethod } from "./stripe";
import { readStripeErrorFields, stripeErrorApiType } from "./stripe-errors";
import {
  sendAdminPaymentFailureAlert,
  sendSavedCardChargeFailedEmail,
} from "./email";

export type SavedCardChargeFailureReason =
  /** Stripe rejected the payment method itself; no retry can change that. */
  | "payment_method_unusable"
  /** The issuer declined for a reason a later attempt cannot cure. */
  | "card_permanently_declined"
  /** A soft decline that has now persisted past the retry window. */
  | "soft_decline_exhausted";

/** The provider fields the decision was made on, for logs and the admin alert. */
export interface SavedCardChargeFailureEvidence {
  /** The API error type (`card_error`, `invalid_request_error`, ...), not the SDK class name. */
  stripeType: string | null;
  stripeCode: string | null;
  declineCode: string | null;
  /** Stripe's own retry advice on a decline; `do_not_try_again` is terminal. */
  adviceCode: string | null;
  message: string;
}

export type SavedCardChargeFailureClassification =
  | ({ outcome: "retry" } & SavedCardChargeFailureEvidence)
  | ({
      outcome: "terminal";
      reason: SavedCardChargeFailureReason;
    } & SavedCardChargeFailureEvidence);

/**
 * `invalid_request_error` codes that say the PaymentMethod itself cannot be
 * charged (as opposed to a malformed request about something else).
 */
const PAYMENT_METHOD_UNUSABLE_CODES: ReadonlySet<string> = new Set([
  "payment_method_unexpected_state",
  "payment_method_customer_mismatch",
  "payment_method_unactivated",
  "payment_method_invalid_parameter",
]);

/**
 * `card_error` codes an off-session retry can never satisfy. The card details
 * are wrong or expired, or the issuer demands the cardholder authenticate —
 * `authentication_required` is terminal FOR AUTOMATION: nobody is present to
 * complete the challenge, so only the member saving a fresh card can move it.
 */
const PERMANENT_CARD_ERROR_CODES: ReadonlySet<string> = new Set([
  "expired_card",
  "incorrect_number",
  "invalid_number",
  "incorrect_cvc",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "authentication_required",
]);

/**
 * Issuer decline codes Stripe documents as "do not retry": the card is gone,
 * blocked, or the account cannot take this kind of charge at all.
 */
const PERMANENT_DECLINE_CODES: ReadonlySet<string> = new Set([
  "expired_card",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "card_not_supported",
  "currency_not_supported",
  "invalid_account",
  "new_account_information_available",
  "revocation_of_all_authorizations",
  "revocation_of_authorization",
  "security_violation",
  "service_not_allowed",
  "stop_payment_order",
  "transaction_not_allowed",
  "fraudulent",
  "merchant_blacklist",
  "authentication_required",
  "do_not_try_again",
]);

/**
 * Stripe's documented do-not-retry signal, sent alongside a decline as
 * `advice_code` (SDK `Error.d.ts`). Terminal whatever the decline code says.
 */
const DO_NOT_TRY_AGAIN_ADVICE = "do_not_try_again";

/**
 * A soft decline (insufficient funds, try again later, issuer unavailable, a
 * generic "do not honor") is retried while `holdOverdueWindows` is below this.
 * The window is the cron's existing ~2-day hold-extension unit, counted from
 * when the charge first became due, so in plain English: a card still being
 * declined two days after the charge first became due is treated as unusable.
 */
export const SOFT_DECLINE_TERMINAL_WINDOW = 2;

/**
 * Decide whether a thrown saved-card charge failure is worth retrying.
 *
 * `holdOverdueWindows` is the 1-based ~2-day window `now` falls in, measured
 * from when the charge first became due (`splitSettlementExtensionNumber` in
 * the cron) — a pure function of time, so a rerun in the same window reaches
 * the same answer (INV-INT-001).
 */
export function classifySavedCardChargeFailure(
  err: unknown,
  ctx: { holdOverdueWindows: number }
): SavedCardChargeFailureClassification {
  const fields = readStripeErrorFields(err);
  const evidence: SavedCardChargeFailureEvidence = {
    stripeType: fields.apiType,
    stripeCode: fields.code,
    declineCode: fields.declineCode,
    adviceCode: fields.adviceCode,
    message: fields.message,
  };
  const param = fields.param;
  const message = fields.message;

  if (evidence.stripeType === "invalid_request_error") {
    const codeNamesPaymentMethod =
      (evidence.stripeCode !== null &&
        PAYMENT_METHOD_UNUSABLE_CODES.has(evidence.stripeCode)) ||
      (evidence.stripeCode === "resource_missing" &&
        param !== null &&
        param.startsWith("payment_method"));
    // LAST RESORT, on the message text. Stripe does not always attach a code
    // or a param to a payment-method rejection: the production incident that
    // opened #3268 arrived as a bare invalid_request_error reading
    //   "The provided PaymentMethod was previously used with a PaymentIntent
    //    without Customer attachment or was detached from a Customer. It may
    //    not be used again."
    // The codes above are preferred and this match exists only for that shape.
    const messageNamesUnusablePaymentMethod =
      /PaymentMethod/.test(message) &&
      /(may not be used again|detached from a Customer|No such PaymentMethod|does not belong to)/i.test(
        message
      );
    if (
      param === "payment_method" ||
      codeNamesPaymentMethod ||
      messageNamesUnusablePaymentMethod
    ) {
      return { outcome: "terminal", reason: "payment_method_unusable", ...evidence };
    }
    return { outcome: "retry", ...evidence };
  }

  if (evidence.stripeType === "card_error") {
    if (
      (evidence.stripeCode !== null &&
        PERMANENT_CARD_ERROR_CODES.has(evidence.stripeCode)) ||
      (evidence.declineCode !== null &&
        PERMANENT_DECLINE_CODES.has(evidence.declineCode)) ||
      evidence.adviceCode === DO_NOT_TRY_AGAIN_ADVICE
    ) {
      return { outcome: "terminal", reason: "card_permanently_declined", ...evidence };
    }
    // Soft decline: insufficient_funds, try_again_later, processing_error,
    // issuer_not_available, generic_decline, do_not_honor, anything unknown.
    if (ctx.holdOverdueWindows >= SOFT_DECLINE_TERMINAL_WINDOW) {
      return { outcome: "terminal", reason: "soft_decline_exhausted", ...evidence };
    }
    return { outcome: "retry", ...evidence };
  }

  // api_error, rate_limit_error, authentication_error, idempotency_error,
  // connection errors, plain Errors, anything unrecognised: today's behaviour.
  return { outcome: "retry", ...evidence };
}

/**
 * Retire a card the classifier called terminal: detach it at Stripe and clear
 * it from every row that carries it. Returns the number of rows cleared.
 *
 * Provider call first and OUTSIDE any transaction (INV-INT-003). A detach that
 * fails with `invalid_request_error` — the pm is already detached, was never
 * attached, or no longer exists — is swallowed and logged: the card is
 * unusable either way, and the local clear is what stops the retry loop. Any
 * OTHER detach failure (an `api_error`, a rate limit, a connection error) is
 * RETHROWN before a single row is written, so the cron's outer catch falls back
 * to the ordinary retry alert and the card stays on the rows. Clearing on a
 * transient failure would leave the card attached at Stripe while telling the
 * member to re-save; the setup-intent route (#3266) would then find it still
 * attached and re-adopt it, the next run would fail terminally again, and the
 * member would be emailed again. "A cleared card is a detached card" is the
 * invariant this ordering buys (INV-PAY-054).
 *
 * TWO tables, not one — as hygiene, not as a charge-loop guard.
 * `reconcilePaymentAggregates` (`payment-transactions.ts`) re-derives
 * `Payment.stripePaymentMethodId` from the latest PRIMARY `PaymentTransaction`'s
 * `paymentMethodId` on every ledger upsert — including webhook-driven ones — for
 * a `Payment` row that carries NO `stripeSetupIntentId`. A split child's row is
 * exactly such a row (its pm was borrowed, not saved), so without this clear a
 * stale PROCESSING / `legacy_primary_backfill` ledger row could copy the retired
 * pm straight back onto it. On the composed code that copy could not be
 * charged: `reusableSavedPaymentMethodOnRow` refuses a card on a row without a
 * SetupIntent (INV-PAY-053), and the parent row a child borrows from always
 * carries a SetupIntent, so the derivation never touches the parent's card
 * column and no later parent reconcile can restore the card for the child to
 * re-borrow. The ledger rows are nulled anyway so that no row anywhere names a
 * retired card: a `paymentMethodId` on a captured row is informational only —
 * the reconcile derivation is its only production READER,
 * `xero-booking-repair-types.ts` SELECTS it into the repair snapshot where
 * nothing reads it, and refunds and recovery key on the intent id, never on the
 * pm — and a retired pm left on a ledger row would read as a card the system
 * still knows about. The cost is provenance: nulling it on a captured
 * historical row loses "which card paid" for that row. Accepted (INV-PAY-054).
 *
 * No lock is taken for these field writes. The setup-intent route writes
 * `Payment.stripePaymentMethodId` unlocked today, and nothing writes
 * `PaymentTransaction.paymentMethodId` after the row is created. The race that
 * matters is harmless: a charge that read this pm a moment before the clear
 * hands it to Stripe, Stripe refuses it for the same reason, and that run lands
 * in this same terminal branch — the second clear matches zero rows and the
 * second detach fails with `invalid_request_error`, which is swallowed.
 * Idempotent by construction (INV-PAY-027).
 */
export async function retireUnusableSavedCard(params: {
  paymentMethodId: string;
  bookingId: string;
}): Promise<{ clearedPaymentRows: number; clearedLedgerRows: number }> {
  try {
    await detachPaymentMethod(params.paymentMethodId);
  } catch (detachErr) {
    if (stripeErrorApiType(detachErr) !== "invalid_request_error") {
      // Transient or unknown: the card may still be attached. Do NOT clear.
      throw detachErr;
    }
    logger.warn(
      {
        err: detachErr,
        bookingId: params.bookingId,
        job: "confirmPendingBookings",
      },
      "Stripe reports the unusable saved card is already detached or gone; clearing it locally (#3268)"
    );
  }

  const clearedPayments = await prisma.payment.updateMany({
    where: { stripePaymentMethodId: params.paymentMethodId },
    data: { stripePaymentMethodId: null },
  });
  const clearedLedger = await prisma.paymentTransaction.updateMany({
    where: { paymentMethodId: params.paymentMethodId },
    data: { paymentMethodId: null },
  });

  return {
    clearedPaymentRows: clearedPayments.count,
    clearedLedgerRows: clearedLedger.count,
  };
}

/**
 * Plain-English admin alert body for a terminal failure. Says what happened,
 * what the system did about it, what the member has been asked to do, and
 * quotes Stripe's own words so the operator can look it up.
 *
 * `claimReleased` is whether `releaseChargeClaim` succeeded. It normally does,
 * and the booking is back to PENDING with its beds unheld; when it did not, the
 * booking is stuck CONFIRMED and unpaid with no card, and the alert must say
 * that rather than assert a pending state the row is not in.
 */
export function describeTerminalSavedCardChargeFailure(
  classification: Extract<SavedCardChargeFailureClassification, { outcome: "terminal" }>,
  { claimReleased }: { claimReleased: boolean }
): string {
  const why =
    classification.reason === "payment_method_unusable"
      ? "Stripe reported the saved card can no longer be charged"
      : classification.reason === "card_permanently_declined"
        ? "the card issuer declined it for a reason a retry cannot fix"
        : "the card has kept declining for two days after the charge first became due";
  const stripeDetail = [
    classification.stripeCode ? `code ${classification.stripeCode}` : null,
    classification.declineCode ? `decline ${classification.declineCode}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    `The saved card for this booking was found unusable: ${why}. ` +
    "It has been removed from the booking, and the member has been emailed asking them to save a new card. " +
    (claimReleased
      ? "The booking stays pending; no further automatic charge will be attempted until a card is saved. "
      : "The booking could NOT be returned to pending after the failed charge and is still marked confirmed but unpaid, with no card on file — it needs an administrator to correct it. ") +
    `Stripe said: "${classification.message}"${stripeDetail ? ` (${stripeDetail})` : ""}.`
  );
}

/** The booking fields the terminal escalation reads — ids and dates, no more. */
export interface TerminalSavedCardChargeBooking {
  id: string;
  memberId: string;
  lodgeId: string | null;
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  member: { email: string; firstName: string; lastName: string };
}

/**
 * The cron's terminal branch, run AFTER the capacity claim has been released:
 * retire the card, tell the member once, tell admins once, log the decision.
 *
 * "Once" needs no counter. After this run the pm is gone from every row that
 * carried it, so the next run never reaches the charge arm for this card: a
 * split child takes the #1967 payment-link path (its own capped admin
 * cadence), a plain booking takes `missing_payment_method`, which only logs.
 * Rerunning THIS run — a crash between the clear and the emails — re-classifies
 * the same error and re-sends, which is the ordinary at-least-once shape every
 * cron notice here accepts (INV-INT-001).
 *
 * `retireUnusableSavedCard` may THROW (a detach failure Stripe did not call
 * `invalid_request_error`): nothing has been cleared and no notice has gone,
 * and the caller's catch falls back to the ordinary retry alert.
 *
 * The member email is best-effort: a send failure is logged and never thrown,
 * and it cannot undo the clear, which has already committed. The admin alert
 * carries the plain-English account and Stripe's own words. Log fields are
 * ids and provider codes only (INV-INT-005).
 */
export async function retireAndEscalateUnusableSavedCard(params: {
  booking: TerminalSavedCardChargeBooking;
  paymentMethodId: string;
  paymentIntentId: string;
  failure: Extract<SavedCardChargeFailureClassification, { outcome: "terminal" }>;
  /** Whether `releaseChargeClaim` succeeded; false changes the alert's wording. */
  claimReleased: boolean;
}): Promise<void> {
  const { booking, failure } = params;
  const { clearedPaymentRows, clearedLedgerRows } = await retireUnusableSavedCard({
    paymentMethodId: params.paymentMethodId,
    bookingId: booking.id,
  });

  logger.error(
    {
      bookingId: booking.id,
      reason: failure.reason,
      stripeType: failure.stripeType,
      stripeCode: failure.stripeCode,
      declineCode: failure.declineCode,
      adviceCode: failure.adviceCode,
      claimReleased: params.claimReleased,
      clearedPaymentRows,
      clearedLedgerRows,
      job: "confirmPendingBookings",
    },
    "Saved card is permanently unusable; retired it and stopped retrying (#3268)"
  );

  try {
    await sendSavedCardChargeFailedEmail({
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
      email: booking.member.email,
      firstName: booking.member.firstName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
    });
  } catch (emailErr) {
    logger.error(
      { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send the saved-card-charge-failed email to the member (#3268)"
    );
  }

  try {
    await sendAdminPaymentFailureAlert({
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: booking.finalPriceCents,
      errorMessage: describeTerminalSavedCardChargeFailure(failure, {
        claimReleased: params.claimReleased,
      }),
      paymentIntentId: params.paymentIntentId,
    });
  } catch (alertErr) {
    logger.error(
      { err: alertErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send admin payment failure alert"
    );
  }
}
