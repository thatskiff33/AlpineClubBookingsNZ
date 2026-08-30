// Pure idempotency-key builders for payment recovery operations, split from
// payment-recovery.ts so dependency-injected consumers (the booking-vs-Xero
// repair loader, #1491) can build keys without importing the Prisma client
// that module initializes at load time.

export function buildBookingCancellationRefundIdempotencyKey(bookingId: string) {
  return `booking_cancel_refund_recovery_${bookingId}`;
}

// Capacity-race auto-refund durability: the recovery-operation dedup key for a
// payment that succeeded AFTER the final capacity claim failed (the booking was
// cancelled inside the reconciliation transaction and the full charge must be
// handed back). One row per (booking, intent): a Stripe event redelivery for
// the same intent upserts the same row, never a second refund debt.
export function buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
  bookingId: string,
  paymentIntentId: string,
) {
  return `capacity_claim_failed_refund_recovery_${bookingId}_${paymentIntentId}`;
}

// The Stripe idempotency-key prefix the INLINE capacity-race auto-refund has
// always used (payment-reconciliation.ts). The recovery cron replays the frozen
// plan under this stored prefix, so per-slice keys
// `capacity_claim_failed_<bookingId>_<pi>_<txn>_<amount>` are identical between
// the inline attempt and any replay — Stripe answers a repeat with the original
// refund and the ledger dedupes on refund id, never a double refund.
export function buildCapacityClaimFailedRefundStripeKeyPrefix(
  bookingId: string,
  paymentIntentId: string,
) {
  return `capacity_claim_failed_${bookingId}_${paymentIntentId}`;
}

// Duplicate-capture auto-refund (#1992): the recovery-operation dedup key for a
// SECOND, distinct Stripe capture arriving on an already-PAID booking (the
// residual #1967 window — an in-flight /pay link intent confirmed after the
// auto-charge cron settled the split child, or vice versa). One row per
// (booking, duplicate intent): a Stripe event redelivery for the same duplicate
// upserts the same row, never a second refund debt. The key shape doubles as
// the per-booking adjudication marker: markBookingPaymentSucceeded refuses to
// open a second duplicate-capture refund for the SAME booking against a
// DIFFERENT intent (that arriving intent is the settlement side of the pair the
// first operation already adjudicated), which is what makes the refund
// direction stable under webhook replays of both captures.
export function buildDuplicateCaptureRefundRecoveryIdempotencyKey(
  bookingId: string,
  paymentIntentId: string,
) {
  return `${buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId)}${paymentIntentId}`;
}

// The per-booking prefix of the duplicate-capture recovery key, used to ask
// "has ANY duplicate-capture refund already been adjudicated for this booking?"
// without knowing the other intent's id.
export function buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(
  bookingId: string,
) {
  return `duplicate_capture_${bookingId}_`;
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
  return `edit_financial_review_refund_recovery_${taskId}`;
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
export function buildEditFinancialReviewRefundStripeKeyPrefix(taskId: string) {
  return `edit_financial_review_refund_${taskId}`;
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
  return `payment_recovery_additional_intent_${bookingModificationId}`;
}

// #3170: the recovery-operation dedup key for the additional PaymentIntent a
// completed EDIT_FINANCIAL_REVIEW task contributes to when the officer decides
// the MEMBER owes the club.
//
// SCOPED TO THE EDIT (`BookingModification`), NOT TO THE TASK, and that INVERTS
// what the first #3170 round shipped. The reasoning that produced the task-scoped
// key was right about the mechanism and wrong about the goal: one edit can raise
// TWO review tasks over one `BookingModification` row, and under a shared key
// Stripe answers the second review's mint with the FIRST review's intent. That is
// now the DESIRED behaviour, because the owner's 30 Aug 2026 decision on #3170 is
// that both reviews contribute to ONE request for the total. Two separate
// requests is the arrangement that lost the money:
// `queueSupersededAdditionalIntentCancellations` cancels every OTHER outstanding
// additional on the payment when a new one is minted, and
// `reconcilePaymentAggregates` carries a single `additionalAmountCents`, so a
// $200 request followed by a $30 request collected $30 of $230 with both tasks
// reading COMPLETED.
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
  return `edit_financial_review_additional_intent_recovery_${bookingModificationId}`;
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
      "edit_financial_review_additional_intent_recovery_",
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
  "edit_financial_review_additional_intent_recovery_",
  "payment_recovery_additional_intent_",
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
// pre-deploy sliver. Nothing downstream reads this off the Stripe refund; it is
// dashboard-only.
export function buildRefundRequestRefundMetadata(
  bookingId: string,
  refundRequestId: string,
): Record<string, string> {
  return { bookingId, reason: "refund_appeal_approved", refundRequestId };
}

// #1507: the Stripe refund `metadata` for a booking-modification card refund
// (date change / batch edit / guest removal). The inline settlement helper
// (executeBookingModificationRefund) stamps a per-path `reason`; the recovery
// cron replays under the modification's stored Stripe key prefix (#1152) and
// must send the SAME body so Stripe replays the original refund instead of
// rejecting the reused key with `idempotency_error` (the #1494 failure mode).
// The shape is shared through this builder; the recovery reconstructs the
// per-path `reason` from the persisted key prefix via
// bookingModificationRefundReasonForKeyPrefix, so the inline shape is UNCHANGED
// for stored-prefix rows (no pre-deploy sliver). Nothing downstream reads this
// off the Stripe refund; it is dashboard-only.
export function buildBookingModificationRefundMetadata(
  bookingId: string,
  reason: string,
): Record<string, string> {
  return { bookingId, reason };
}

// #1507: map a modification refund's persisted Stripe idempotency-key prefix
// (`stripeKeyPrefix`, #1152) back to the `reason` the inline settlement helper
// stamped, so a recovery replay reconstructs the inline Stripe body
// byte-for-byte. The three prefixes mirror the `idempotencyKeyPrefix` each
// modification caller passes to executeBookingModificationRefund
// (booking-date/-batch modification services and the guest-removal route). A NEW
// modification refund path MUST add its prefix here, or its recovery replay
// diverges (safe-fails to idempotency_error, never double-refunds). Legacy rows
// enqueued before #1152 carry no stored prefix; they keep the historical
// recovery reason and their operation-scoped key (they were never shared-key
// with the inline refund, so convergence does not apply to them).
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
  return "booking_modification_refund_recovery";
}
