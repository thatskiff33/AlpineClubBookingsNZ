// Pure idempotency-key builders for payment recovery operations, split from
// payment-recovery.ts so dependency-injected consumers (the booking-vs-Xero
// repair loader, #1491) can build keys without importing the Prisma client
// that module initializes at load time.

// THE PREFIXES BELOW ARE THE ONE SPELLING OF EACH RECOVERY KEY'S SHAPE (#4076).
// The Diagnostics finance pack classifies a `PaymentRecoveryOperation` by these
// and its test fails when an export here is neither mapped to a scenario nor
// declared not-a-recovery-key, so a new recovery key cannot land unlabelled.
import { exactPrefix } from "@/lib/prisma-exact-prefix";
export const BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX = "booking_cancel_refund_recovery_";
export const CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX = "capacity_claim_failed_refund_recovery_";
export const DUPLICATE_CAPTURE_REFUND_RECOVERY_PREFIX = "duplicate_capture_";
export const EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX =
  "edit_financial_review_refund_recovery_";
export const ADDITIONAL_INTENT_RECOVERY_PREFIX = "payment_recovery_additional_intent_";
export const EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX =
  "edit_financial_review_additional_intent_recovery_";
export { CREDIT_RELEASE_ASK_RECOVERY_PREFIX } from "@/lib/credit-release-ask-keys"; // #4253
/** An approved refund appeal's card refund (`enqueueRefundRequestRefundRecovery`). */
export const REFUND_REQUEST_REFUND_RECOVERY_PREFIX = "refund_request_refund_";
/** Cancelling a card payment request that was replaced or withdrawn. */
export const PAYMENT_INTENT_CANCEL_RECOVERY_PREFIX = "payment_recovery_cancel_";
/**
 * Refunding a card payment taken on a REPLACED payment request that was paid
 * anyway (`REFUND_SUPERSEDED_PAYMENT`). Not a booking edit's refund, whatever the
 * similar spelling suggests.
 */
export const SUPERSEDED_PAYMENT_REFUND_RECOVERY_PREFIX = "payment_recovery_refund_";
/** A booking edit's card refund (`enqueueBookingModificationRefundRecovery`). */
export const BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX =
  "payment_recovery_modification_refund_";
/**
 * #4104 (`INV-PAY-128`): a card refund Stripe accepted (`pending`) and failed
 * later, owed again. One row per failed Stripe refund; the key doubles as the
 * Stripe key prefix, so its retry is a request Stripe has never seen.
 */
export const CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX = "card_refund_failed_later_";
export function buildCardRefundFailedLaterRecoveryKey(stripeRefundId: string) {
  return `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}${stripeRefundId}`;
}
/** The failed Stripe refund a failed-later row owes; null for any other key. */
export function cardRefundFailedLaterRefundId(key: string): string | null {
  return key.startsWith(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX) && key.length > CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX.length
    ? key.slice(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX.length)
    : null;
}
/** The Stripe `reason` metadata of that retry; a failed refund carrying it was itself a retry. */
export const CARD_REFUND_FAILED_LATER_REASON = "card_refund_failed_later";

export function buildBookingCancellationRefundIdempotencyKey(bookingId: string) {
  return `${BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX}${bookingId}`;
}

export function buildPaymentIntentCancelRecoveryIdempotencyKey(
  paymentTransactionId: string,
  paymentIntentId: string,
) {
  return `${PAYMENT_INTENT_CANCEL_RECOVERY_PREFIX}${paymentTransactionId}_${paymentIntentId}`;
}

export function buildSupersededPaymentRefundRecoveryIdempotencyKey(
  paymentTransactionId: string,
  paymentIntentId: string,
) {
  return `${SUPERSEDED_PAYMENT_REFUND_RECOVERY_PREFIX}${paymentTransactionId}_${paymentIntentId}`;
}

export function buildBookingModificationRefundRecoveryIdempotencyKey(
  bookingModificationId: string,
) {
  return `${BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX}${bookingModificationId}`;
}

export function buildRefundRequestRefundRecoveryIdempotencyKey(refundRequestId: string) {
  return `${REFUND_REQUEST_REFUND_RECOVERY_PREFIX}${refundRequestId}`;
}

/** #4120: is this an approved refund appeal's card refund (`buildRefundRequestRefundRecoveryIdempotencyKey`)? */
export function isRefundRequestRefundRecoveryKey(key: string) {
  return key.startsWith(REFUND_REQUEST_REFUND_RECOVERY_PREFIX);
}

// Capacity-race auto-refund durability: the recovery-operation dedup key for a payment that
// succeeded AFTER the final capacity claim failed (the booking was cancelled inside the reconciliation
// transaction and the full charge must be handed back). One row per (booking, intent): a Stripe
// event redelivery for the same intent upserts the same row, never a second refund debt.
export function buildCapacityClaimFailedRefundRecoveryIdempotencyKey(bookingId: string, paymentIntentId: string) {
  return `${buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId)}${paymentIntentId}`;
}

// #4125: every capacity-race refund row of one booking starts with this; the trailing `_` ends its id.
export function buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId: string) {
  return `${CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX}${bookingId}_`;
}

// #4147 (`INV-SSOT`): THIS booking's cancel's card refund (member cancel's row; capacity race's per intent); exact (#4146).
export const bookingCancelCardRefundRecoveryWhere = (bookingId: string) => ({
  bookingId,
  OR: [{ idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) }, { idempotencyKey: exactPrefix(buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId)) }],
});
export const isBookingCancelCardRefundRecoveryKey = (bookingId: string, key: string): boolean =>
  key === buildBookingCancellationRefundIdempotencyKey(bookingId) || key.startsWith(buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId));

// The Stripe idempotency-key prefix the INLINE capacity-race auto-refund has
// always used (payment-reconciliation.ts). The recovery cron replays the frozen
// plan under this stored prefix, so per-slice keys
// `capacity_claim_failed_<bookingId>_<pi>_<txn>_<amount>` are identical between
// the inline attempt and any replay — Stripe answers a repeat with the original
// refund and the ledger dedupes on refund id, never a double refund.
export function buildCapacityClaimFailedRefundStripeKeyPrefix(bookingId: string, paymentIntentId: string) {
  return `capacity_claim_failed_${bookingId}_${paymentIntentId}`;
}

// Duplicate-capture auto-refund (#1992): the recovery-operation dedup key for a
// SECOND, distinct Stripe capture arriving on an already-PAID booking (the
// residual #1967 window — an in-flight /pay link intent confirmed after the
// auto-charge cron settled the split child, or vice versa). One row per
// (booking, duplicate intent): a Stripe event redelivery for the same duplicate
// upserts the same row, never a second refund debt. A capture a key names is going
// back to the member, so it is never the settlement another capture duplicates
// (#4211): replays keep the refund direction stable, and a third capture is refunded.
export function buildDuplicateCaptureRefundRecoveryIdempotencyKey(
  bookingId: string,
  paymentIntentId: string,
) {
  return `${buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId)}${paymentIntentId}`;
}

// The per-booking prefix of the duplicate-capture recovery key: which of this
// booking's captures a duplicate-capture refund owns, without knowing their intents.
export function buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(
  bookingId: string,
) {
  return `${DUPLICATE_CAPTURE_REFUND_RECOVERY_PREFIX}${bookingId}_`;
}

// #4211: the duplicate intent a booking's duplicate-capture key names, or null. A booking id
// plus `_` can begin a longer id, so a caller reads only that booking's rows.
export function duplicateCaptureIntentIdForRecoveryKey(bookingId: string, idempotencyKey: string): string | null {
  const prefix = buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId);
  return idempotencyKey.startsWith(prefix) && idempotencyKey.length > prefix.length ? idempotencyKey.slice(prefix.length) : null;
}

// The Stripe idempotency-key prefix for the duplicate-capture auto-refund
// (#1992). Inline execution (payment-reconciliation.ts) and the recovery cron's
// replay of the frozen plan share this prefix, so per-slice keys
// `duplicate_capture_refund_<bookingId>_<pi>_<txn>_<amount>` are identical
// between the inline attempt and any replay — Stripe answers a repeat with the
// original refund and the ledger dedupes on refund id, never a double refund.
export function buildDuplicateCaptureRefundStripeKeyPrefix(
  bookingId: string,
  paymentIntentId: string,
) {
  return `duplicate_capture_refund_${bookingId}_${paymentIntentId}`;
}

// #3032 (epic #2797): the recovery-operation dedup key for the Stripe refund a
// completed EDIT_FINANCIAL_REVIEW task sends back. Keyed on the TASK, never on
// the `BookingModification` anchor the amount settles against (owner decision
// D-3032-1), because one edit can raise TWO review tasks - two unpriceable
// strands share one modification row. Under the modification-scoped key those
// two reviews would upsert the SAME recovery row, and that upsert overwrites
// `amountCents` and `stripeKeyPrefix`: a partially-processed $50 refund would be
// silently rewritten to $30 under a different prefix and replayed as fresh
// refunds for slices already sent. One task, one refund debt.
export function buildEditFinancialReviewRefundRecoveryIdempotencyKey(
  taskId: string,
) {
  return `${EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX}${taskId}`;
}

// #3032: the Stripe idempotency-key prefix for that same refund, task-scoped for
// the same reason and with a sharper consequence. The per-slice key is
// `${prefix}_${transactionId}_${amount}`, so two reviews of ONE edit that confirm
// the SAME amount would mint identical keys under a modification-scoped prefix -
// Stripe answers the second with the FIRST refund, the ledger dedupes on refund
// id, and the caller takes the replayed id as success and writes a member-facing
// REFUNDED event. The member is told their money came back when only half of it
// did. The inline refund and the recovery replay share this prefix, which is what
// makes a genuine replay of ONE task's refund converge instead of double-refund.
// A booking-edit refund recovery row written before its stored Stripe prefix
// existed replays under this operation-scoped Stripe key. It is FROZEN: it only
// happens to share its text with `BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX`,
// and renaming the recovery prefix must never move an in-flight legacy replay's
// Stripe key (that would refund twice).
export function buildLegacyModificationRefundStripeKeyPrefix(operationId: string) {
  return `payment_recovery_modification_refund_${operationId}`;
}

// #4083 (`INV-PAY-128`): THE STRIPE KEY OF ONE REFUND SLICE, and the generation
// a refused slice moves to. Stripe answers a repeated key with its ORIGINAL
// response for 24 hours, so a slice Stripe refused (`failed` or `canceled`)
// replayed under its own key only reads the refusal back. The recovery runner
// moves a slice it READ refused to the next generation (`refused1`,
// `refused2`, ...), a key never sent before. A slice it did not read refused
// keeps its key, so a refund made but not recorded is still answered with the
// original and never made twice. One spelling for the sender and the runner.
const REFUSED_REFUND_KEY_SUFFIX = /^refused([1-9][0-9]{0,5})$/;

export function isRefusedRefundKeySuffix(value: unknown): value is string {
  return typeof value === "string" && REFUSED_REFUND_KEY_SUFFIX.test(value);
}

export function nextRefusedRefundKeySuffix(current: string | undefined): string {
  const generation = current ? REFUSED_REFUND_KEY_SUFFIX.exec(current)?.[1] : undefined;
  return `refused${generation ? Number(generation) + 1 : 1}`;
}

export function refundSliceStripeIdempotencyKey(
  prefix: string,
  slice: { paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string },
): string {
  const key = `${prefix}_${slice.paymentTransactionId}_${slice.amountCents}`;
  return slice.stripeKeySuffix ? `${key}_${slice.stripeKeySuffix}` : key;
}

export function buildEditFinancialReviewRefundStripeKeyPrefix(taskId: string) {
  return `edit_financial_review_refund_${taskId}`;
}

// #1350 / #3639: the Stripe idempotency-key prefix, and the metadata, of the
// refund of a genuine late capture on a cancelled booking. ONE builder for the
// webhook's automatic refund and the treasurer-approved one, because they are the
// same refund of the same capture: whichever runs first, a repeat under this
// prefix is answered by Stripe with the original refund (INV-PAY-106).
const LATE_CAPTURE_REFUND_KEY_PREFIX = "late_cancel_refund_";
// Independent of `CANCELLED_BOOKING_LATE_CAPTURE_REASON` (the frozen
// PaymentTransaction.reason marker) despite the same spelling: this is Stripe
// refund metadata, replayed byte for byte, and neither may be derived from the other.
export const LATE_CAPTURE_REFUND_METADATA_REASON = "cancelled_booking_late_capture";
export function buildLateCaptureRefundStripeKeyPrefix(bookingId: string, paymentIntentId: string) {
  return `${LATE_CAPTURE_REFUND_KEY_PREFIX}${bookingId}_${paymentIntentId}`;
}
/** #1491: the `reason` the repair tool's late-capture refund carries (`xero-booking-repair-passes.ts`). */
export const LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON = "cancelled_booking_late_capture_repair";
export function buildLateCaptureRefundMetadata(bookingId: string): Record<string, string> {
  return { bookingId, reason: LATE_CAPTURE_REFUND_METADATA_REASON };
}
// #3639: the recovery row of a treasurer-approved late-capture refund. One per
// capture: the approval task is one per payment intent (its `occurrenceKey`).
export const LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX = "late_capture_approval_refund_recovery_";
export function buildLateCaptureApprovalRefundRecoveryIdempotencyKey(
  paymentIntentId: string,
) {
  return `${LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX}${paymentIntentId}`;
}
/** The late capture a treasurer-approved late-capture refund's recovery row refunds; null for any other row. */
export function lateCaptureIntentOfApprovalRefundRecoveryKey(key: string): string | null {
  if (!key.startsWith(LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX)) return null;
  const intent = key.slice(LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX.length);
  return intent.length > 0 ? intent : null;
}
// The inverse of `buildLateCaptureRefundStripeKeyPrefix`, for the recovery
// replay: the operation's own `paymentIntentId` is the payment's representative
// intent, not necessarily the late capture's.
export function lateCaptureRefundPaymentIntentId(
  keyPrefix: string,
  bookingId: string,
): string {
  return keyPrefix.slice(`${LATE_CAPTURE_REFUND_KEY_PREFIX}${bookingId}_`.length);
}
export function isLateCaptureRefundStripeKeyPrefix(
  keyPrefix: string | null | undefined,
): boolean {
  return keyPrefix?.startsWith(LATE_CAPTURE_REFUND_KEY_PREFIX) ?? false;
}

// The recovery-operation dedup key for an ordinary booking edit's additional
// PaymentIntent (#1096), scoped to the `BookingModification` that recorded the
// price increase - one edit, one charge debt.
//
// #3170 MOVED IT HERE from `payment-recovery.ts`, where it was private. That
// module initialises the Prisma client at load time; this one is deliberately
// free of it so a caller can build a key without dragging the client into its
// graph, which is why every other builder already lives here. The move is what
// lets `createModificationAdditionalPaymentIntent` default the key without
// importing the enqueue module's whole surface.
export function buildAdditionalIntentRecoveryIdempotencyKey(
  bookingModificationId: string,
) {
  return `${ADDITIONAL_INTENT_RECOVERY_PREFIX}${bookingModificationId}`;
}

/**
 * #3954 review round 4: the Stripe key a price reduction's RE-ISSUED ask is
 * minted under - frozen on its recovery row inside the edit's transaction and
 * read back by both the door's after-commit mint and the recovery runner, so
 * the two converge on one intent whichever runs. Scoped to the reducing edit,
 * whatever door it came through.
 */
export function buildReissuedAskStripeIdempotencyKey(bookingModificationId: string) {
  return `mod_reissued_ask_${bookingModificationId}`;
}

/**
 * #3954 review round 6: the reason every re-issued ask's intent and
 * `PaymentTransaction` row carry, whichever minter wrote it
 * (`planReissuedAskMint`) - and how a reduction knows a ledger row as a
 * re-issue when it reads what Xero billed of it (`unpaidAskBillingEvidence`).
 */
export const REISSUED_ASK_REASON = "modification_reissued_ask";

// #3170: the recovery-operation dedup key for the additional PaymentIntent a
// completed EDIT_FINANCIAL_REVIEW task contributes to when the officer decides
// the MEMBER owes the club.
//
// SCOPED TO THE EDIT (`BookingModification`), NOT TO THE TASK (inverting the
// first #3170 round). One edit can raise two reviews over one row, and under
// a shared key Stripe answers the second review's mint with the FIRST review's
// intent - now the DESIRED behaviour: the owner's 30 Aug 2026 decision on #3170
// is that both reviews contribute to ONE request for the total. Two requests lost
// money: `queueSupersededAdditionalIntentCancellations` cancels every OTHER
// outstanding additional on the payment when one is minted, and
// `reconcilePaymentAggregates` carries one `additionalAmountCents`, so $200 then
// $30 collected $30 of $230, both tasks COMPLETED.
//
// WHICH OF THE TWO EACH KEY BELONGS TO, stated here because it is the subtlety
// most likely to be got wrong later:
//
//   * THE REQUEST is edit-scoped - one PaymentIntent, one `ADDITIONAL`
//     PaymentTransaction, one figure on the member's pay link. So the Stripe key
//     below and this recovery key, which both name the REQUEST, are scoped to the
//     `BookingModification`.
//   * THE SHARE is task-scoped - one officer's decision about one unreadable
//     guest strand, with its own amount and its own direction. It stays on the
//     `ManualRefundTask` row (`amountCents`, `settlementDirection`) and in that
//     task's audit entry, which is what keeps the combined figure explainable
//     back to the two decisions that produced it.
//   * The REFUND keys above stay TASK-scoped, and that is not an inconsistency:
//     a refund is not a request the member acts on, it is money already sent, so
//     two refunds of one edit are two separate movements and must never converge.
//
// The amount stored on the recovery row is ADVISORY, not the debt. The replay
// re-derives the total from the settled shares
// (`syncEditFinancialReviewChargeRequest`), so a row carrying a stale figure
// cannot mint for the wrong one - which is what makes a single edit-scoped row
// safe where the first round needed one row per task to protect the amount.
export function buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
  bookingModificationId: string,
) {
  return `${EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX}${bookingModificationId}`;
}

// #3170: the Stripe idempotency key for that same additional PaymentIntent,
// edit-scoped for the reason set out above. It is what makes the FIRST mint for
// an edit the ONLY mint for that edit: a later share does not create a second
// intent, it raises this one's amount to the new total through
// `updatePaymentIntentAmount`, so nothing is ever superseded and nothing is ever
// cancelled between two shares of one edit. The inline sync and the recovery
// replay share the key, so a genuine replay converges on the one intent.
export function buildEditFinancialReviewAdditionalIntentStripeKey(
  bookingModificationId: string,
) {
  return `edit_financial_review_additional_${bookingModificationId}`;
}

/**
 * A STRIPE IDEMPOTENCY KEY THAT NAMES THE AMOUNT IT WAS MINTED FOR.
 *
 * Stripe REFUSES a key replayed with different parameters, answering
 * `idempotency_error`. So any key pinned to a request whose amount can be
 * RE-DERIVED between attempts has to move when that amount moves, or the first
 * re-derivation turns every remaining attempt into the same permanent failure
 * and the ask is never raised at all.
 *
 * Two paths need it and it is one rule, so it is spelled once (`INV-SSOT-001`).
 * The ordinary edit's recovery replay re-derives against the payment as it
 * stands now (#3340), and the edit-review charge re-derives its share sum
 * (#3170) and, since #3371, the carried balance with it - a member who pays the
 * earlier ask between a failed mint and its replay moves the second figure.
 *
 * A changed amount is a different request and gets a different key. The intent a
 * previous attempt may have minted at Stripe carries no `PaymentTransaction`
 * row - an attempt is only replayed because the last one died before writing
 * one - so it was never reachable by anybody and expires at Stripe.
 */
export function stripeIdempotencyKeyForAskAmount(
  baseKey: string,
  askCents: number,
) {
  return `${baseKey}_${askCents}`;
}

// #3170: the `reason` stamped on the combined request's `ADDITIONAL`
// PaymentTransaction, and the way a later share FINDS that request.
//
// It is a lookup key rather than prose, which is why it is built here beside the
// idempotency keys rather than spelled inline at the call site. The request has
// to be findable from the edit alone - a second share knows its
// `BookingModification` and nothing about the first share - and the ledger row
// carries no anchor column of its own. Matching is EXACT EQUALITY on this whole
// string; nothing slices an id back out of it, which is deliberate (see
// `bookingModificationIdForAdditionalIntentRecoveryKey` for why prefix-slicing is
// the thing that went wrong here once already).
export function buildEditFinancialReviewChargeReason(
  bookingModificationId: string,
) {
  return `edit_financial_review_charge_${bookingModificationId}`;
}

// Whether a CREATE_ADDITIONAL_PAYMENT_INTENT recovery operation belongs to a
// completed EDIT_FINANCIAL_REVIEW charge rather than to an ordinary booking edit.
// The two replay DIFFERENTLY - the review charge re-derives its total from the
// settled shares and may need to RAISE an existing intent rather than mint one -
// so the recovery worker has to tell them apart, and this is the one place that
// knows how.
export function isEditFinancialReviewAdditionalIntentRecoveryKey(
  idempotencyKey: string | null | undefined,
): boolean {
  return Boolean(
    idempotencyKey?.startsWith(
      EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX,
    ),
  );
}

// The `BookingModification` a CREATE_ADDITIONAL_PAYMENT_INTENT recovery operation
// belongs to, read back from its dedup key.
//
// #3170 REPLACED A BROKEN INLINE SLICE. `payment-recovery.ts` used to derive this
// by slicing `"payment_recovery_additional_intent_".length` characters off the
// key, which is correct for the ordinary edit key and silently wrong for every
// other shape: a review-charge key sliced to `"tent_recovery_<id>"`, and the
// caller then looked for waiting Xero operations under a modification id that
// cannot exist. The builder had been moved into this module and made a required
// argument; the parser was left behind, which is exactly the half-move
// `INV-SSOT` exists to stop.
//
// FAIL-CLOSED: an unrecognised key returns null and the caller does nothing,
// rather than a slice of a string that is not an id. Add a prefix here whenever a
// new caller builds one of these keys, or its recovery replay silently skips the
// Xero attach.
const ADDITIONAL_INTENT_RECOVERY_KEY_PREFIXES = [
  EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX,
  ADDITIONAL_INTENT_RECOVERY_PREFIX,
] as const;

export function bookingModificationIdForAdditionalIntentRecoveryKey(
  idempotencyKey: string | null | undefined,
): string | null {
  if (!idempotencyKey) return null;
  for (const prefix of ADDITIONAL_INTENT_RECOVERY_KEY_PREFIXES) {
    if (idempotencyKey.startsWith(prefix)) {
      const id = idempotencyKey.slice(prefix.length);
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

// #1494: the Stripe refund `metadata` for a booking-cancellation card refund.
// The inline cancel path (which creates the Stripe refund) and the recovery
// cron (which replays it under the shared `booking_cancel_refund_<bookingId>`
// idempotency key) both build the body from THIS one function, so the two send
// a byte-identical request body. Stripe rejects a reused idempotency key whose
// parameters differ (`idempotency_error`) instead of replaying, so the exact
// crash scenario the frozen plan exists for — inline Stripe refund succeeded
// but the local recording was lost — only converges if the replay's metadata
// matches the original's byte for byte. The shape is a pure function of
// `bookingId` plus constants: it deliberately carries NO per-cancellation value
// (the refund percentage used to ride here) because the cron cannot reconstruct
// such a value from the persisted operation, and recomputing it at replay time
// would drift (days-until-check-in and the policy can both change). Nothing
// downstream reads this metadata off the Stripe refund — it is dashboard-only.
export function buildBookingCancellationRefundMetadata(
  bookingId: string,
): Record<string, string> {
  return { bookingId, reason: "cancellation" };
}

// #1507: the Stripe refund `metadata` for an approved refund-request (appeal)
// card refund. The admin approve route creates the Stripe refund under the
// `refund_request_<id>` idempotency-key prefix; if that inline refund fails the
// recovery cron replays it under the SAME prefix (#1039). Both build the body
// from THIS one function, so the two send a byte-identical request body. As with
// the booking-cancellation convergence (#1494), Stripe rejects a reused
// idempotency key whose parameters differ (`idempotency_error`) instead of
// replaying, so the crash the durable recovery exists for — inline Stripe refund
// succeeded but the local recording was lost — only converges if the replay's
// metadata matches the original's byte for byte. Before #1507 the cron sent
// `reason: "refund_request_refund_recovery"` while the route sent
// `reason: "refund_appeal_approved"`. The inline shape is UNCHANGED by this
// convergence (only the recovery branch now matches), so every Stripe refund the
// route has ever created already carries this exact body — there is no
// pre-deploy sliver. Since #4312 the webhook reads its `reason` back (`cardRefundDoorOf`), to leave a request's refund to its approval.
export const buildRefundRequestRefundStripeKeyPrefix = (refundRequestId: string) => `refund_request_${refundRequestId}`; // the route's and its replay's (#1039, #1507)
export function buildRefundRequestRefundMetadata(
  bookingId: string,
  refundRequestId: string,
): Record<string, string> {
  return { bookingId, reason: "refund_appeal_approved", refundRequestId };
}

// #1507: the Stripe refund `metadata` for a booking-modification card refund
// (date change / batch edit / guest removal / guest-acceptance re-price). The
// recovery cron replays under the modification's stored Stripe key prefix
// (#1152) and must send the SAME body so Stripe replays the original refund
// instead of rejecting the reused key with `idempotency_error` (the #1494
// failure mode). Since #4101 both sides take the `reason` from that one prefix
// via bookingModificationRefundReasonForKeyPrefix (`INV-MOD-061`), so the
// inline refund and its replay cannot disagree. Nothing downstream reads this
// off the Stripe refund; it is dashboard-only.
export function buildBookingModificationRefundMetadata(
  bookingId: string,
  reason: string,
): Record<string, string> {
  return { bookingId, reason };
}

/** #3340: the `reason` a superseded payment's refund carries (`REFUND_SUPERSEDED_PAYMENT`). */
export const SUPERSEDED_PAYMENT_REFUND_METADATA_REASON = "zero_dollar_batch_modification_superseded";

/**
 * #4104 review (CM, `INV-SSOT`): THE STRIPE REFUND METADATA A CARD REFUND ROW'S
 * RUNNER SENDS - an approved refund request's, a cancellation's, a superseded
 * payment's, or any other's by its stored Stripe key prefix
 * (`bookingModificationRefundReasonForKeyPrefix`). The runner builds its body
 * here, and a refund Stripe failed later is matched to an open row's unmarked
 * slice only when it carries exactly this (`card-refund-failed-later.ts`), so a
 * refund some other door or the Stripe dashboard made is never taken for it.
 */
export function cardRefundOperationRefundMetadata(operation: {
  type: string;
  idempotencyKey: string;
  stripeKeyPrefix: string | null;
  bookingId: string;
}): Record<string, string> {
  if (operation.type === "REFUND_SUPERSEDED_PAYMENT") {
    return { bookingId: operation.bookingId, reason: SUPERSEDED_PAYMENT_REFUND_METADATA_REASON };
  }
  if (operation.idempotencyKey.startsWith(REFUND_REQUEST_REFUND_RECOVERY_PREFIX)) {
    return buildRefundRequestRefundMetadata(
      operation.bookingId,
      operation.idempotencyKey.slice(REFUND_REQUEST_REFUND_RECOVERY_PREFIX.length),
    );
  }
  if (operation.idempotencyKey.startsWith(BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX)) {
    return buildBookingCancellationRefundMetadata(operation.bookingId);
  }
  return buildBookingModificationRefundMetadata(
    operation.bookingId,
    bookingModificationRefundReasonForKeyPrefix(operation.stripeKeyPrefix),
  );
}

// #1507: map a modification refund's Stripe idempotency-key prefix to the
// Stripe metadata `reason`. THE ONE SPELLING (`INV-MOD-061`, #4101): the inline
// settlement helper (executeBookingModificationRefund) stamps the reason this
// returns for the prefix its caller passes, and the recovery replay rebuilds it
// from the same prefix stored on the row (`stripeKeyPrefix`, #1152), so the two
// send one request. The first four rows are the helper's callers
// (booking-date/-batch modification services, the guest-removal route and the
// guest-acceptance re-price); a new caller adds its prefix here or its refunds
// carry the generic recovery reason, which
// `modification-refund-replay-reason.test.ts` refuses. Legacy rows enqueued
// before #1152 carry no stored prefix; they keep the historical recovery reason
// and their operation-scoped key (they were never shared-key with the inline
// refund, so convergence does not apply to them).
export function bookingModificationRefundReasonForKeyPrefix(
  keyPrefix: string | null | undefined,
): string {
  if (keyPrefix?.startsWith("mod_dates_refund_")) {
    return "date_change_price_decrease";
  }
  if (keyPrefix?.startsWith("mod_batch_refund_")) {
    return "batch_modification";
  }
  if (keyPrefix?.startsWith("guest_remove_refund_")) {
    return "guest_removed_price_decrease";
  }
  // #4101: a guest's acceptance that re-prices a paid booking down
  // (`settleGuestAcceptanceRepriceAfterCommit`). Missing before #4101, its
  // replay sent the default reason below and Stripe refused the reused key.
  if (keyPrefix?.startsWith("guest_accept_refund_")) {
    return "guest_accepted_promo_reprice";
  }
  // Capacity-race auto-refund (payment succeeded after the final capacity
  // claim failed). The inline path builds its Stripe metadata from
  // buildBookingModificationRefundMetadata(bookingId, "capacity_claim_failed"),
  // so a recovery replay under the stored capacity_claim_failed_<...> prefix
  // reconstructs the identical body from the persisted operation alone.
  if (keyPrefix?.startsWith("capacity_claim_failed_")) {
    return "capacity_claim_failed";
  }
  // Duplicate-capture auto-refund (#1992, a second distinct capture on an
  // already-PAID booking). The inline path builds its Stripe metadata from
  // buildBookingModificationRefundMetadata(bookingId, "duplicate_capture"), so
  // a recovery replay under the stored duplicate_capture_refund_<...> prefix
  // reconstructs the identical body from the persisted operation alone.
  if (keyPrefix?.startsWith("duplicate_capture_refund_")) {
    return "duplicate_capture";
  }
  // #3032: the completed edit-financial-review refund. The inline path builds its
  // Stripe metadata from
  // buildBookingModificationRefundMetadata(bookingId, "edit_financial_review"),
  // so a recovery replay under the stored edit_financial_review_refund_<taskId>
  // prefix reconstructs the identical body from the persisted operation alone.
  // Without this row the replay would send the default reason below, Stripe would
  // reject the reused key with `idempotency_error`, and the refund would never
  // recover - safe, but permanently stuck.
  if (keyPrefix?.startsWith("edit_financial_review_refund_")) {
    return "edit_financial_review";
  }
  // #3639: a treasurer-approved late-capture refund, replayed under the webhook's
  // own prefix and body (`buildLateCaptureRefundMetadata`).
  if (isLateCaptureRefundStripeKeyPrefix(keyPrefix)) {
    return LATE_CAPTURE_REFUND_METADATA_REASON;
  }
  // #4104: a refund Stripe accepted and failed later, asked for again.
  if (keyPrefix?.startsWith(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX)) {
    return CARD_REFUND_FAILED_LATER_REASON;
  }
  return "booking_modification_refund_recovery";
}

// #3653: an organiser-settled child's refund out of the organiser's COMBINED
// card payment. One recovery row per refund, and the row's key doubles as the
// Stripe idempotency key, so a replay can only ever answer with the refund the
// first attempt made. An edit's refund is keyed by its `BookingModification`; a
// group cancellation's by its settlement and the child; an approved refund
// appeal's by its `RefundRequest` (#3956, `INV-PAY-123`).
//
// The appeal's prefix is deliberately NOT under `organiser_child_refund_`
// (#3956 review, blue/green): a worker older than #3956 routes only that
// prefix to the #3653 executor, which would refund the appeal under a reduction's
// Stripe metadata and write the booking event an appeal must not. Under its own
// prefix, such a worker takes it for an ordinary modification refund, meets the
// allocation that names no real transaction (`organiserChildRefundAllocationPlan`),
// and fails the row before any Stripe call; the retry lands on a current worker.
export const ORGANISER_CHILD_REFUND_KEY_PREFIX = "organiser_child_refund_";
export const ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX = "organiser_card_appeal_refund_";
export function buildOrganiserChildModificationRefundKey(bookingModificationId: string) {
  return `${ORGANISER_CHILD_REFUND_KEY_PREFIX}mod_${bookingModificationId}`;
}
export function buildOrganiserChildCancellationRefundKey(
  settlementId: string,
  childBookingId: string,
) {
  return `${ORGANISER_CHILD_REFUND_KEY_PREFIX}cancel_${settlementId}_${childBookingId}`;
}
export function buildOrganiserChildAppealRefundKey(refundRequestId: string) {
  return `${ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX}${refundRequestId}`;
}
/** Every child refund debt out of the combined payment: an edit's, a group cancel's or an appeal's. */
export function isOrganiserChildRefundKey(key: string) {
  return key.startsWith(ORGANISER_CHILD_REFUND_KEY_PREFIX) || isOrganiserChildAppealRefundKey(key);
}
/** #3956: an approved refund appeal's refund out of the combined payment - not the cancellation's money. */
export function isOrganiserChildAppealRefundKey(key: string) {
  return key.startsWith(ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX);
}
/** #4120 (`INV-SSOT`): an appeal's card refund - the request's own row, or its debt to the organiser's card (#3956). */
export function isAppealRefundRecoveryKey(key: string) {
  return isRefundRequestRefundRecoveryKey(key) || isOrganiserChildAppealRefundKey(key);
}
/**
 * `isOrganiserChildRefundKey` as a `PaymentRecoveryOperation` where fragment -
 * the one spelling a query uses, so no reader counts one prefix and misses the
 * other (`INV-SSOT`).
 */
export const ORGANISER_CHILD_REFUND_KEY_WHERE = {
  OR: [
    { idempotencyKey: { startsWith: ORGANISER_CHILD_REFUND_KEY_PREFIX } },
    { idempotencyKey: { startsWith: ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX } },
  ],
};
/** The Stripe `reason` metadata, rebuilt from the key alone so a replay sends the same body. */
export function organiserChildRefundReasonForKey(key: string) {
  if (key.startsWith(`${ORGANISER_CHILD_REFUND_KEY_PREFIX}cancel_`)) return "organiser_cancellation";
  if (isOrganiserChildAppealRefundKey(key)) return "organiser_child_appeal";
  return "organiser_child_reduction";
}

// Group organiser-cancel settlement refund (F3, #1351): the organiser cancel's
// durable retry of a pre-#3653 group settlement refund - ONE operation for the
// whole group's plan, keyed on the settlement. Its `paymentId` is only an anchor
// for the schema FK - the money belongs to the children in the settlement's
// frozen `{childId: cents}` plan - so a reader of the row's payment must
// recognise it by this key. Here, not in payment-recovery.ts, so a reader can
// recognise one without importing the Prisma client.
export const GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX = "group_settlement_refund_recovery_";
export function buildGroupSettlementRefundRecoveryIdempotencyKey(settlementId: string) {
  return `${GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX}${settlementId}`;
}
export function isGroupSettlementRefundRecoveryKey(key: string) {
  return key.startsWith(GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX);
}
/**
 * #3372 (owner, 8 Oct 2026: "Separate club-wide line"): every group settlement
 * refund row, as a `PaymentRecoveryOperation` where fragment, for the
 * club-wide part of "Refunds owed" (`readRefundsAndCreditsOwed`).
 */
export const GROUP_SETTLEMENT_REFUND_RECOVERY_WHERE = {
  idempotencyKey: { startsWith: GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX },
} as const;
/** The settlement a group settlement refund row replays. */
export function groupSettlementIdForRefundRecoveryKey(key: string) {
  return key.slice(GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX.length);
}
