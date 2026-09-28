// Per-booking finding/action classification for the booking-vs-Xero repair
// tool. classifyBookingContext is a single sequential function that mutates
// its own local findings/actionMap accumulators and is kept whole (one
// function, one module), exceeding the ~700-LOC soft cap. Originally
// extracted verbatim from xero-booking-repair.ts under #1208 item 2's
// behavior-preserving-move rule; that one-off extraction constraint no
// longer binds — the body has since gained behavior deliberately (#1356
// supplementary-invoice arms, #1427 evidence-first credit-note sizing).
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import {
  isClearingAllocationShortfall,
  partialClearingNoteIsIncomplete,
} from "@/lib/xero-clearing-allocations";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  MutableFinding,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import {
  getCapturedRepairTransactions,
  getOutstandingCapturedRefundAmountCents,
  getOutstandingRepairTransactions,
  hasCapturedRepairPayment,
  planEditReviewChargeInvoicePayment,
} from "./xero-booking-repair-payments";
import {
  getBlockingOperation,
  toRetryableOperationMatch,
  isStuckOperation,
  paymentNoteAnswersInvoice,
  resolveObjectFromCandidates,
} from "./xero-booking-repair-object-resolution";
import {
  getCancellationCreditAmountCents,
  getCashCancellationRefundCandidateCents,
  getExpectedSupplementaryInvoiceAsk,
  getKnownModificationRefundTotalCents,
  getLatestDateChangingModification,
  getModificationNetAmountCents,
  getUnpaidCancellationClearingAmountCents,
  hasSuccessfulPrimaryInvoiceCreateAfter,
  hasSuccessfulPrimaryInvoiceUpdateAfter,
  modificationAddedGuestCount,
  resolvePrimaryInvoiceEditTiming,
} from "./xero-booking-repair-analysis";
import {
  addAction,
  addFinding,
  addXeroAmountMismatchFinding,
  buildBookingSummary,
  buildLinkRepairAction,
  buildManualReviewAction,
  addResolvedInXeroFinding,
  buildRetryAction,
  recoverStoredXeroAmountCents,
} from "./xero-booking-repair-findings";
import {
  getOperationQueueTypeHint,
  isSuccessfulXeroOperation,
  toIsoDate,
} from "./xero-booking-repair-utils";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { isCancellationRefundDecisionRecorded } from "@/lib/cancellation-settled-money";
import { isRecordedBookingInvoicePayment } from "@/lib/xero-inbound/object-links";
import { PART_PAYMENT_RECOGNISED_REASON } from "@/lib/part-payment-recognition-reason";
import {
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { formatDateOnly } from "@/lib/date-only";
import {
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
  bookingHasPrimaryXeroInvoice,
  keptLateCaptureRecordRoute,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * #3643: a booking's invoice-clearing credit note create that still stands -
 * not retired (CANCELLED) and not marked resolved in Xero by an officer (the
 * operations resolve route). The officer's mark is read through
 * `isResolvedInXero`, the one home of "resolved means done" (#3635,
 * `INV-INT-025`); the recognised part payment's rest asks this.
 */
function isOutstandingClearingNoteCreate(operation: XeroOperationRecord): boolean {
  return (
    operation.entityType === "CREDIT_NOTE" &&
    operation.operationType === "CREATE" &&
    operation.status !== "CANCELLED" &&
    !isResolvedInXero(operation)
  );
}

/** A live clearing allocation: reported, never retried here or queued beside. */
function addBlockedClearingAllocationFinding(
  findings: MutableFinding[],
  operation: XeroOperationRecord
) {
  addFinding(findings, {
    code: "BLOCKED_BY_XERO_OPERATION",
    severity: "warning",
    summary: ["FAILED", "PARTIAL"].includes(operation.status)
      ? "A Xero invoice-clearing allocation operation failed and is not retried here - resolve it by hand so the cancelled unpaid booking's invoice closes."
      : isStuckOperation(operation)
        ? "A pending or running Xero invoice-clearing allocation operation looks stuck."
        : "A Xero invoice-clearing allocation operation is already pending or running.",
    safeToAutoApply: false,
    details: { operationId: operation.id, operationStatus: operation.status },
    actionKeys: [],
  });
}

export function classifyBookingContext(
  context: BookingClassificationContext
): BookingXeroRepairBookingSummary {
  const { booking } = context;
  const findings: MutableFinding[] = [];
  const actionMap = new Map<string, BookingXeroRepairAction>();
  const payment = booking.payment;
  const capturedPaymentTransactions = getCapturedRepairTransactions(payment);
  const outstandingPaymentTransactions = getOutstandingRepairTransactions(payment);
  const outstandingCapturedRefundAmountCents =
    getOutstandingCapturedRefundAmountCents(payment);
  const paymentLinks = context.paymentLinks;
  const paymentOperations = context.paymentOperations;
  const bookingLinks = context.bookingLinks;
  const bookingOperations = context.bookingOperations;
  const primaryInvoice = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroInvoiceId,
        fieldObjectNumber: payment.xeroInvoiceNumber,
        fieldObjectUrl: payment.xeroInvoiceId
          ? buildXeroInvoiceUrl(payment.xeroInvoiceId)
          : null,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      })
    : null;

  if (payment && primaryInvoice?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Primary invoice references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Primary invoice references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        primaryInvoiceId: primaryInvoice.objectId,
        conflictingInvoiceIds: primaryInvoice.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && primaryInvoice && !payment.xeroInvoiceId) {
    const action = addAction(actionMap, {
      key: `payment-field:primary-invoice:${payment.id}:${primaryInvoice.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
      description: "Backfill payment.xeroInvoiceId from an existing Xero invoice link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        xeroInvoiceNumber: primaryInvoice.objectNumber,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "The primary Xero invoice exists, but the payment record is missing its invoice id.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        source: primaryInvoice.source,
      },
      actionKeys: [action.key],
    });
  }

  if (
    payment &&
    payment.xeroInvoiceId &&
    (!primaryInvoice?.link || primaryInvoice.objectId === payment.xeroInvoiceId)
  ) {
    const hasPrimaryInvoiceLink = paymentLinks.some(
      (link) =>
        link.xeroObjectType === "INVOICE" &&
        link.role === "PRIMARY_INVOICE" &&
        link.xeroObjectId === payment.xeroInvoiceId
    );
    if (!hasPrimaryInvoiceLink) {
      const action = addAction(actionMap, {
        key: `payment-link:primary-invoice:${payment.id}:${payment.xeroInvoiceId}`,
        bookingId: booking.id,
        type: "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
        description: "Backfill the missing PRIMARY_INVOICE Xero link from the payment record.",
        safeToAutoApply: true,
        payload: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
          xeroInvoiceNumber: payment.xeroInvoiceNumber,
        },
      });
      addFinding(findings, {
        code: "XERO_LINK_MISMATCH",
        severity: "warning",
        summary: "The payment record points at a Xero invoice, but the PRIMARY_INVOICE link is missing.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
        },
        actionKeys: [action.key],
      });
    }
  }

  if (booking.status === "PAID") {
    if (payment && !primaryInvoice && payment.manuallyMarkedPaidAt) {
      // B5 (#2262) carve-out. This booking was settled in cash / by an off-Xero
      // bank transfer, so NO Xero objects are expected for it and there is
      // nothing to repair. Without this arm it would classify as the
      // MISSING_PRIMARY_INVOICE critical finding carrying a safe-to-auto-apply
      // QUEUE_PRIMARY_INVOICE action — an auto-repair pass would then queue a
      // mint that raises, and emails the member, an awaiting-payment invoice for
      // money the club already holds. Informational and action-free on purpose.
      addFinding(findings, {
        code: "MANUALLY_SETTLED_NO_XERO_EXPECTED",
        severity: "info",
        summary:
          "The booking was manually marked paid (cash / off-Xero) — no Xero invoice is expected.",
        safeToAutoApply: false,
        details: {
          paymentId: payment.id,
          manuallyMarkedPaidAt: payment.manuallyMarkedPaidAt,
        },
        actionKeys: [],
      });
    } else if (payment && !primaryInvoice) {
      const blockingOperation = getBlockingOperation(
        paymentOperations,
        "INVOICE",
        "CREATE"
      );
      if (blockingOperation?.kind === "retryable") {
        const action = addAction(
          actionMap,
          buildRetryAction(booking.id, blockingOperation)
        );
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary: "A failed or partial Xero booking invoice operation is blocking the primary invoice.",
          safeToAutoApply: true,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
            lastErrorCode: blockingOperation.operation.lastErrorCode,
            lastErrorMessage: blockingOperation.operation.lastErrorMessage,
          },
          actionKeys: [action.key],
        });
      } else if (blockingOperation?.kind === "resolved") {
        // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
        // queued beside, but reported (decision 2), so a wrong resolve can be seen.
        addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "invoice");
      } else if (blockingOperation) {
        const summary = isStuckOperation(blockingOperation.operation)
          ? "A pending or running Xero booking invoice operation looks stuck."
          : "A Xero booking invoice operation is already pending or running.";
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary,
          safeToAutoApply: false,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
          },
          actionKeys: [],
        });
      } else {
        const action = addAction(actionMap, {
          key: `queue:primary-invoice:${booking.id}`,
          bookingId: booking.id,
          type: "QUEUE_PRIMARY_INVOICE",
          description: "Queue a missing primary Xero invoice for this confirmed or paid booking.",
          safeToAutoApply: true,
          payload: {
            bookingId: booking.id,
          },
        });
        addFinding(findings, {
          code: "MISSING_PRIMARY_INVOICE",
          severity: "critical",
          summary: "The booking is confirmed or paid locally, but no primary Xero invoice can be resolved.",
          safeToAutoApply: true,
          details: {
            paymentId: payment.id,
          },
          actionKeys: [action.key],
        });
      }
    }
  }

  const latestDateChangingModification = getLatestDateChangingModification(booking);
  /**
   * THIS ARM READS `operation.createdAt`; THE MONEY ARM BELOW MAY NOT (#3199
   * fix round). The two sit a few lines apart and answer questions that look
   * alike, so the difference is stated here rather than left to be inferred.
   *
   * `createdAt` is when the operation was ENQUEUED, which is a LOWER bound on
   * when Xero was written - a row enqueued before an edit can dispatch after
   * it. That is sound in the `>=` direction these two helpers ask: a row
   * enqueued at or after the date change is one whose dispatch is certainly
   * after it, so the invoice narration it wrote is current. The false negatives
   * run the other way - a row enqueued before the change but dispatched after
   * it is missed - and the cost is one redundant description-only invoice
   * update, no money.
   *
   * `resolvePrimaryInvoiceEditTiming` cannot borrow it. That question needs the
   * UPPER bound (`completedAt`), because the wrong answer there queues a
   * supplementary invoice for money the primary invoice already bills. Do not
   * copy this cheaper timestamp into a money arm.
   */
  if (
    payment &&
    primaryInvoice &&
    latestDateChangingModification &&
    !hasSuccessfulPrimaryInvoiceCreateAfter(
      paymentOperations,
      latestDateChangingModification.createdAt
    ) &&
    !hasSuccessfulPrimaryInvoiceUpdateAfter(
      paymentOperations,
      latestDateChangingModification.createdAt
    )
  ) {
    const updateOperationsAfterLatestDateChange = paymentOperations.filter(
      (operation) =>
        operation.entityType === "INVOICE" &&
        operation.operationType === "UPDATE" &&
        operation.createdAt >= latestDateChangingModification.createdAt
    );
    const blockingOperation = getBlockingOperation(
      updateOperationsAfterLatestDateChange,
      "INVOICE",
      "UPDATE"
    );

    if (blockingOperation?.kind === "retryable") {
      const action = addAction(
        actionMap,
        buildRetryAction(booking.id, blockingOperation)
      );
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary: "A failed or partial Xero primary invoice update is blocking current booking date narration.",
        safeToAutoApply: true,
        details: {
          modificationId: latestDateChangingModification.id,
          operationId: blockingOperation.operation.id,
          operationStatus: blockingOperation.operation.status,
        },
        actionKeys: [action.key],
      });
    } else if (blockingOperation?.kind === "resolved") {
      // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
      // queued beside, but reported (decision 2), so a wrong resolve can be seen.
      addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "invoice update", { modificationId: latestDateChangingModification.id });
    } else if (blockingOperation) {
      const summary = isStuckOperation(blockingOperation.operation)
        ? "A pending or running Xero primary invoice update looks stuck."
        : "A Xero primary invoice update is already pending or running.";
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary,
        safeToAutoApply: false,
        details: {
          modificationId: latestDateChangingModification.id,
          operationId: blockingOperation.operation.id,
          operationStatus: blockingOperation.operation.status,
        },
        actionKeys: [],
      });
    } else {
      const action = addAction(actionMap, {
        key: `queue:primary-invoice-update:${booking.id}:${latestDateChangingModification.id}`,
        bookingId: booking.id,
        type: "QUEUE_PRIMARY_INVOICE_UPDATE",
        description: "Queue an update to refresh the primary Xero invoice date fields and line narration.",
        safeToAutoApply: true,
        payload: {
          bookingId: booking.id,
          bookingModificationId: latestDateChangingModification.id,
          xeroInvoiceId: primaryInvoice.objectId,
        },
      });
      addFinding(findings, {
        code: "STALE_PRIMARY_INVOICE_DETAILS",
        severity: "warning",
        summary: "The booking dates changed after the primary Xero invoice was created, but no invoice update has succeeded.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          modificationId: latestDateChangingModification.id,
          xeroInvoiceId: primaryInvoice.objectId,
          currentCheckIn: formatDateOnly(booking.checkIn),
          currentCheckOut: formatDateOnly(booking.checkOut),
        },
        actionKeys: [action.key],
      });
    }
  }

  for (const modification of booking.modifications) {
    const modificationLinks = context.modificationLinksById.get(modification.id) ?? [];
    const modificationOperations =
      context.modificationOperationsById.get(modification.id) ?? [];
    /**
     * #3187: what this edit's supplementary invoice SHOULD bill, which is not
     * always what its `BookingModification` row says.
     *
     * A parked financial review writes 0 on both components and leaves them at
     * 0 - the money lives on the review tasks - so the arm below used to be
     * unreachable for exactly the bookings a review creates. Widening the gate
     * ALONE would have been worse than the silence: the action it builds is
     * queued from these same numbers, and an action carrying a net of 0 is
     * refused by the enqueue's own net guard. That is a CRITICAL finding,
     * marked safe to auto-apply, whose action does nothing - which teaches an
     * operator to ignore the tool. The gate and the payload therefore move
     * together, off one object.
     */
    const expectedAsk = getExpectedSupplementaryInvoiceAsk(
      modification,
      context.editReviewChargeCentsByModificationId.get(modification.id) ?? 0
    );
    const netAmountCents = expectedAsk.netAmountCents;
    const editReviewChargeCents = expectedAsk.editReviewChargeCents;
    /**
     * The REDUCTION arm below keeps reading the modification row alone, and
     * that is deliberate rather than an oversight. A settled CHARGE share is
     * money owed TO the club; letting it offset a reduction would net two
     * opposite settlements into one figure and suppress a credit note that is
     * genuinely due. The two cannot collide today - a parked edit's row carries
     * 0 on both components, so a review anchor is never also a reduction - and
     * this line is what keeps that a property of the code rather than a
     * coincidence anybody has to re-derive.
     */
    const modificationNetAmountCents = getModificationNetAmountCents(modification);

    if (netAmountCents > 0 && primaryInvoice) {
      const supplementaryInvoice = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      });

      if (!supplementaryInvoice) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "INVOICE",
          "CREATE"
        );
        /**
         * WAS THE PRIMARY INVOICE ALREADY RAISED WHEN THIS EDIT HAPPENED
         * (#3199, epic #2797)? The gate above cannot see that - it asks only
         * whether a primary invoice exists NOW - and a primary invoice minted
         * AFTER the edit already bills it, so a supplementary invoice on top
         * bills the money twice. `resolvePrimaryInvoiceEditTiming` carries the
         * reasoning: where the answer comes from, and why not from
         * `primaryInvoice.operation`, a link timestamp, or the recovery row's
         * frozen `hadIssuedXeroInvoice`.
         *
         * WHAT A LATER PRIMARY INVOICE CAN CARRY is what this engages on, and
         * it is NOT the same question as "what does this edit ask for". The
         * primary invoice bills `booking.guests[]` and their nights, so an edit
         * is at risk of being double-billed exactly when it moved one of those:
         *
         * - the modification row's own net is positive - a priced edit, whose
         *   increase moved the booking's stored totals AND its guest nights, so
         *   a primary invoice minted afterwards carries it; or
         * - the edit ADDED A GUEST (#3199 fix round). This one is not visible
         *   in any amount on the row. A parked edit writes 0 to both components
         *   - the money is on its review tasks - and still writes each added
         *   guest with a real `priceCents` and real priced nights, because the
         *   current rate for a guest who did not exist before is the one amount
         *   a parked edit can always work out. A primary invoice minted after
         *   such an edit bills that guest; the officer pricing the review is
         *   told the added guests' amount "has not been charged" and includes
         *   it; and the ordinary #3187 arm would then auto-apply a
         *   supplementary invoice for the same money. `modificationNetAmountCents`
         *   alone read that case as "nothing at risk" and it was the live
         *   double-bill this arm exists to stop.
         *
         * NOT the expected ask, and that boundary is load-bearing. Widening to
         * `netAmountCents` would engage on every review-priced finding - a
         * review whose money is genuinely NOT on the primary invoice, because
         * the invoice bills guest-night lines and a promo adjustment and
         * nothing else - and would undo #3187 by sweeping those bookings into
         * manual review. A parked edit that added no guest is exactly that
         * case, and it keeps its one-click repair.
         *
         * A STATED LIMIT, not an oversight: a change fee is not a line on the
         * primary invoice either, so an edit whose positive net is part price
         * increase and part change fee is only PARTLY double-billed. That case
         * reports for manual review rather than queueing a part-invoice,
         * because sizing what is left owed is exactly the judgement the
         * decision on #3199 put in a person's hands.
         */
        const editAddedGuestCount = modificationAddedGuestCount(modification);
        const primaryInvoiceEditTiming =
          modificationNetAmountCents > 0 || editAddedGuestCount > 0
            ? resolvePrimaryInvoiceEditTiming({
                operations: paymentOperations,
                primaryInvoiceObjectId: primaryInvoice.objectId,
                editedAt: modification.createdAt,
              })
            : null;
        const primaryInvoiceEditTimingRefusal =
          primaryInvoiceEditTiming &&
          primaryInvoiceEditTiming.outcome !== "invoice-preceded-edit"
            ? primaryInvoiceEditTiming
            : null;
        if (blockingOperation?.kind === "retryable") {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero supplementary invoice operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation && primaryInvoiceEditTimingRefusal) {
          /**
           * REPORTED, NEVER APPLIED, AND NEVER SILENTLY SKIPPED (#3199).
           *
           * The same finding code the ordinary arm raises, at `manual_review`
           * severity with no queue action - the shape this file already uses
           * for every other case it will not size itself. An officer still sees
           * the booking; what they no longer get is a button that bills money
           * the club may not be owed.
           */
          const summary =
            primaryInvoiceEditTimingRefusal.outcome === "invoice-followed-edit"
              ? "This booking edit happened before the primary Xero invoice was raised, so that invoice already bills the change - raising a supplementary invoice would bill the same money twice. Check the invoice in Xero and bill only what is genuinely still owed."
              : primaryInvoiceEditTimingRefusal.reason ===
                  "only-re-asserted-completion"
                ? "The only Xero record of this booking's primary invoice is a later re-run that found the invoice already there, so the history no longer says when it was first raised and whether it already bills this edit cannot be established. Check the invoice in Xero before raising a supplementary invoice for it."
                : "No Xero operation history says when this booking's primary invoice was raised, so whether it already bills this edit cannot be established. Check the invoice in Xero before raising a supplementary invoice for it.";
          const manualAction = addAction(
            actionMap,
            buildManualReviewAction(booking.id, summary)
          );
          addFinding(findings, {
            code: "MISSING_SUPPLEMENTARY_INVOICE",
            severity: "manual_review",
            summary,
            safeToAutoApply: false,
            details: {
              modificationId: modification.id,
              netAmountCents,
              priceDiffCents: expectedAsk.priceDiffCents,
              changeFeeCents: expectedAsk.changeFeeCents,
              ...(editReviewChargeCents > 0 ? { editReviewChargeCents } : {}),
              // #3199 fix round: why this engaged at all on an edit whose own
              // row nets 0 - the added guests a later primary invoice bills.
              ...(editAddedGuestCount > 0
                ? { addedGuestCount: editAddedGuestCount }
                : {}),
              xeroInvoiceId: primaryInvoice.objectId,
              primaryInvoiceTiming: primaryInvoiceEditTimingRefusal.outcome,
              ...(primaryInvoiceEditTimingRefusal.outcome === "unknown"
                ? {
                    primaryInvoiceTimingReason:
                      primaryInvoiceEditTimingRefusal.reason,
                  }
                : {
                    primaryInvoiceRaisedAt: toIsoDate(
                      primaryInvoiceEditTimingRefusal.raisedAt
                    ),
                    primaryInvoiceOperationId:
                      primaryInvoiceEditTimingRefusal.operationId,
                  }),
            },
            actionKeys: [manualAction.key],
          });
        } else if (!blockingOperation) {
          // #3187: a review-priced ask must not be queued as if the member had
          // already paid it. `planEditReviewChargeInvoicePayment` states why in
          // full; the short version is that the enqueue's `recordPayment`
          // default is TRUE, and on the internet-banking route that would record
          // a Stripe payment for money nobody has sent. The ordinary
          // price-increase arm keeps the behaviour it has always had, because a
          // modification with no review contributes no plan.
          const editReviewPaymentPlan =
            editReviewChargeCents > 0
              ? planEditReviewChargeInvoicePayment({
                  payment,
                  bookingModificationId: modification.id,
                  expectedNetAmountCents: netAmountCents,
                  hasOpenIntentMintRecovery:
                    context.openEditReviewChargeIntentRecoveryModificationIds.has(
                      modification.id
                    ),
                })
              : null;
          if (editReviewPaymentPlan?.outcome === "withdrawn") {
            // #3528 (`INV-ADDPAY-040`): an officer withdrew this edit's request
            // while it was unpaid, so the money is no longer asked for and no
            // invoice is missing. Nothing is queued and nothing is flagged -
            // the withdrawal audit row is the record - because the only other
            // reading, "a request exists with an intent, park an invoice on
            // it", would hold a fresh supplementary invoice against an intent
            // the withdrawal cancelled, until the reaper retired it.
          } else if (editReviewPaymentPlan?.outcome === "manual-review") {
            // The invoice IS missing, but the tool must not raise it: doing so
            // would either assert money the club does not hold, or claim the
            // anchor the intent-mint recovery is about to use. Same finding
            // code, no queue action, and NOT safe to auto-apply - the arm a
            // person sizes, exactly as the credit-note arm does above.
            const summary =
              editReviewPaymentPlan.reason === "capture-short-of-ask"
                ? "A completed financial review priced this booking edit above what the member's card actually took, and no supplementary Xero invoice exists - the difference is owed outside any invoice, so raise it by hand."
                : "A completed financial review priced this booking edit as money owed, but its card request has not been raised yet and its recovery is still owed - no supplementary Xero invoice can be raised until that replay runs.";
            /**
             * TWO PARKED EDITS ON ONE BOOKING, hitting the same reason, COLLAPSE
             * to one action, and that is a deliberate choice rather than an
             * oversight (#3187 fix round, nit).
             *
             * `buildManualReviewAction` keys on the booking and the reason text,
             * and these two summaries carry no modification id - so a booking
             * with two parked edits both short of their ask produces one action
             * for both. Nothing is LOST: each edit still raises its own finding
             * carrying its own `modificationId`, and `MARK_MANUAL_REVIEW` does
             * nothing when applied, so the only cost is that the action COUNT
             * under-reports while the finding count does not. Left as it is
             * because it is the convention every other manual-review arm in this
             * file already follows, including the amount-mismatch arm below;
             * making this one arm's key unique would be a second convention for
             * a counter, which is a worse trade than the counter.
             */
            const manualAction = addAction(
              actionMap,
              buildManualReviewAction(booking.id, summary)
            );
            addFinding(findings, {
              code: "MISSING_SUPPLEMENTARY_INVOICE",
              severity: "manual_review",
              summary,
              safeToAutoApply: false,
              details: {
                modificationId: modification.id,
                netAmountCents,
                priceDiffCents: expectedAsk.priceDiffCents,
                changeFeeCents: expectedAsk.changeFeeCents,
                editReviewChargeCents,
                editReviewPaymentReason: editReviewPaymentPlan.reason,
                ...(editReviewPaymentPlan.capturedAmountCents === null
                  ? {}
                  : {
                      capturedAmountCents:
                        editReviewPaymentPlan.capturedAmountCents,
                    }),
              },
              actionKeys: [manualAction.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:supplementary-invoice:${modification.id}`,
              bookingId: booking.id,
              type: "QUEUE_SUPPLEMENTARY_INVOICE",
              description:
                editReviewChargeCents > 0
                  ? "Queue the missing Xero supplementary invoice for a booking edit priced by a completed financial review."
                  : "Queue the missing Xero supplementary invoice for a price-increase booking modification.",
              safeToAutoApply: true,
              payload: {
                bookingId: booking.id,
                bookingModificationId: modification.id,
                // Signed (#1356): the queued invoice must carry the mixed-sign
                // components so its total matches the expectedAmountCents (net)
                // this same pass verifies against. Since #3187 they come from the
                // expected ask rather than straight off the modification row, so
                // a review-priced edit queues the amount the finding reports.
                priceDiffCents: expectedAsk.priceDiffCents,
                changeFeeCents: expectedAsk.changeFeeCents,
                // Named one by one rather than spread, so the plan's own
                // discriminant never rides along into the queued payload.
                ...(editReviewPaymentPlan
                  ? {
                      recordPayment: editReviewPaymentPlan.recordPayment,
                      waitForConfirmedAdditionalPayment:
                        editReviewPaymentPlan.waitForConfirmedAdditionalPayment,
                      paymentIntentId: editReviewPaymentPlan.paymentIntentId,
                    }
                  : {}),
              },
            });
            addFinding(findings, {
              code: "MISSING_SUPPLEMENTARY_INVOICE",
              severity: "critical",
              summary:
                editReviewChargeCents > 0
                  ? "A completed financial review priced this booking edit as money owed, but no supplementary Xero invoice exists."
                  : "A booking modification increased the amount owing, but no supplementary Xero invoice exists.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                netAmountCents,
                priceDiffCents: expectedAsk.priceDiffCents,
                changeFeeCents: expectedAsk.changeFeeCents,
                ...(editReviewChargeCents > 0 ? { editReviewChargeCents } : {}),
              },
              actionKeys: [action.key],
            });
          }
        } else if (blockingOperation.kind === "resolved") {
          // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
          // queued beside, but reported (decision 2), so a wrong resolve can be seen.
          addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "supplementary invoice", { modificationId: modification.id });
        } else {
          // #1356: a live-but-not-retryable operation (WAITING_PAYMENT parked
          // on its additional Stripe payment, or pending/running/unsupported)
          // must surface as blocked — silently emitting nothing here used to
          // let the modification look healthy, and classifying it as missing
          // would queue a duplicate that records payment before any capture.
          const summary =
            blockingOperation.operation.status === "WAITING_PAYMENT"
              ? "A Xero supplementary invoice operation is already queued and waiting for its additional Stripe payment."
              : isStuckOperation(blockingOperation.operation)
                ? "A pending or running Xero supplementary invoice operation looks stuck."
                : "A Xero supplementary invoice operation is already pending or running.";
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary,
            safeToAutoApply: false,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [],
          });
        }
      } else {
        addXeroAmountMismatchFinding({
          findings,
          actionMap,
          bookingId: booking.id,
          expectedAmountCents: netAmountCents,
          resolved: supplementaryInvoice,
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          entityType: "INVOICE",
          operationType: "CREATE",
          summary:
            editReviewChargeCents > 0
              ? "The supplementary invoice amount evidence does not match the total this booking edit's financial reviews settled to."
              : "The supplementary invoice amount evidence does not match the local booking modification amount.",
          details: {
            modificationId: modification.id,
            netAmountCents,
            priceDiffCents: expectedAsk.priceDiffCents,
            changeFeeCents: expectedAsk.changeFeeCents,
            ...(editReviewChargeCents > 0 ? { editReviewChargeCents } : {}),
          },
        });

        if (!supplementaryInvoice.link && supplementaryInvoice.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "INVOICE",
              xeroObjectId: supplementaryInvoice.objectId,
              xeroObjectNumber: supplementaryInvoice.objectNumber,
              xeroObjectUrl: supplementaryInvoice.objectUrl,
              role: "SUPPLEMENTARY_INVOICE",
              description:
                "Backfill the SUPPLEMENTARY_INVOICE link from a completed Xero operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary: "A supplementary invoice exists in operation history, but its booking-modification link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              xeroInvoiceId: supplementaryInvoice.objectId,
            },
            actionKeys: [action.key],
          });
        }
      }
    }

    if (modificationNetAmountCents < 0 && primaryInvoice) {
      const refundDueCents = Math.abs(modificationNetAmountCents);
      // Captured money via the payment status OR the transaction ledger —
      // ledger-first states (a SUCCEEDED capture row under a still-PENDING
      // aggregate status) must count as captured for the policy split below.
      // Deliberately Stripe-only in its ledger half, unlike
      // `hasCapturedRepairPayment` (#3639): this split routes card refunds.
      const paymentHasCapturedMoney =
        hasCapturedPayment(payment) || capturedPaymentTransactions.length > 0;
      const modificationCreditNote = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        // Same discrimination as the evidence read below: a SUCCEEDED
        // ACCOUNT-credit-note op for this modification must not resolve as
        // the invoice-applied note (allocating a cash-refund note against
        // the primary invoice would double-count the credit).
        payloadQueueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      });

      // #1427 (review finding): a net<0 modification legitimately settled
      // by an ACCOUNT credit note (the member keeps the value as account
      // credit; the paid primary invoice stays untouched) has NO
      // invoice-applied note to repair — classifying it as "missing" would
      // nag manual review forever. Positive identification only: a link
      // with the account role, or an executed op whose queue-type hint
      // names the account variant (hint-less rows never count).
      const settledByAccountCredit =
        modificationLinks.some(
          (link) =>
            link.xeroObjectType === "CREDIT_NOTE" &&
            link.role === "MODIFICATION_ACCOUNT_CREDIT_NOTE"
        ) ||
        modificationOperations.some(
          (operation) =>
            operation.entityType === "CREDIT_NOTE" &&
            operation.operationType === "CREATE" &&
            isSuccessfulXeroOperation(operation) &&
            getOperationQueueTypeHint(operation) ===
              XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
        );
      if (!modificationCreditNote && settledByAccountCredit) {
        continue;
      }

      // #1427: abs(net) is only an upper bound on the credit note — the
      // primary path caps the credit at the policy-limited settlement
      // (classifyXeroBookingEditSettlement), which the modification row
      // cannot reconstruct. Stored evidence is the record of record:
      // the enqueue-time operation payload (the #1354 queued-payload-first
      // rule — requeueing that amount also rebuilds the identical
      // amount-embedding correlation key, so a note that already hit Xero
      // dedups instead of duplicating), then link metadata, then executed
      // note totals. A stored amount outside (0, abs(net)] is inconsistent
      // and is ignored.
      const storedEvidence = recoverStoredXeroAmountCents({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        objectId: modificationCreditNote?.objectId ?? null,
        // A modification can also hold an ACCOUNT-credit-note op with the
        // same entityType/operationType and a different amount — only
        // payloads that name themselves invoice-applied count as evidence.
        payloadQueueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      });
      const storedSettlement =
        storedEvidence &&
        storedEvidence.amountCents > 0 &&
        storedEvidence.amountCents <= refundDueCents
          ? storedEvidence
          : null;
      const expectedCreditNoteCents =
        storedSettlement?.amountCents ?? refundDueCents;
      const expectedAmountSource = storedSettlement?.source ?? "net-amount";

      if (!modificationCreditNote) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "CREDIT_NOTE",
          "CREATE",
          // A pending ACCOUNT-credit-note op must not mask the genuinely
          // missing invoice-applied note behind a blocked finding.
          { payloadQueueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE }
        );
        if (blockingOperation?.kind === "retryable") {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero modification credit note operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          if (storedSettlement !== null || !paymentHasCapturedMoney) {
            // Sizing is safe: either the stored ledger records the
            // settlement this note was enqueued with, or no money was ever
            // captured, so no cancellation-policy tier can have applied and
            // the full delta is the correct bookkeeping correction (#1015).
            const action = addAction(actionMap, {
              key: `queue:mod-credit-note:${modification.id}`,
              bookingId: booking.id,
              type: "QUEUE_MODIFICATION_CREDIT_NOTE",
              description:
                "Queue the missing Xero modification credit note for a price-decrease booking modification.",
              safeToAutoApply: true,
              payload: {
                bookingId: booking.id,
                bookingModificationId: modification.id,
                refundAmountCents: expectedCreditNoteCents,
              },
            });
            addFinding(findings, {
              code: "MISSING_MODIFICATION_CREDIT_NOTE",
              severity: "critical",
              summary: "A booking modification reduced the amount owing, but no modification Xero credit note exists.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                refundAmountCents: expectedCreditNoteCents,
                refundAmountSource: expectedAmountSource,
                refundDueCents,
                priceDiffCents: modification.priceDiffCents,
                changeFeeCents: modification.changeFeeCents,
              },
              actionKeys: [action.key],
            });
          } else {
            // Captured money and NO stored evidence: a cancellation-policy
            // tier may have limited the settlement below abs(net), and
            // auto-queueing abs(net) would over-credit Xero income by the
            // policy-retained share (#1427). A human sizes this one.
            const action = addAction(
              actionMap,
              buildManualReviewAction(
                booking.id,
                "A modification credit note is missing, the payment has captured money, and no stored evidence records the policy-limited settlement - size the credit note manually."
              )
            );
            addFinding(findings, {
              code: "MISSING_MODIFICATION_CREDIT_NOTE",
              severity: "manual_review",
              summary:
                "A booking modification reduced the amount owing and no modification Xero credit note exists, but the settlement amount cannot be reconstructed safely (captured payment, no stored evidence).",
              safeToAutoApply: false,
              details: {
                modificationId: modification.id,
                refundDueCents,
                priceDiffCents: modification.priceDiffCents,
                changeFeeCents: modification.changeFeeCents,
              },
              actionKeys: [action.key],
            });
          }
        } else if (blockingOperation.kind === "resolved") {
          // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
          // queued beside, but reported (decision 2), so a wrong resolve can be seen.
          addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "modification credit note", { modificationId: modification.id });
        } else {
          // #1427 (the #1356 third-arm rule): a live-but-not-retryable
          // credit-note operation must surface as blocked — silence here
          // let the modification look healthy while nothing progressed.
          const summary = ["FAILED", "PARTIAL"].includes(
            blockingOperation.operation.status
          )
            ? "A Xero modification credit note operation failed and cannot be auto-retried - resolve the operation manually."
            : isStuckOperation(blockingOperation.operation)
              ? "A pending or running Xero modification credit note operation looks stuck."
              : "A Xero modification credit note operation is already pending or running.";
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary,
            safeToAutoApply: false,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [],
          });
        }
      } else {
        addXeroAmountMismatchFinding({
          findings,
          actionMap,
          bookingId: booking.id,
          expectedAmountCents: expectedCreditNoteCents,
          resolved: modificationCreditNote,
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_CREDIT_NOTE",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          payloadQueueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
          summary:
            "The modification credit-note amount evidence does not match the local booking modification refund amount.",
          details: {
            modificationId: modification.id,
            refundAmountCents: expectedCreditNoteCents,
            refundAmountSource: expectedAmountSource,
            priceDiffCents: modification.priceDiffCents,
            changeFeeCents: modification.changeFeeCents,
          },
        });

        if (!modificationCreditNote.link && modificationCreditNote.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: modificationCreditNote.objectId,
              xeroObjectNumber: modificationCreditNote.objectNumber,
              xeroObjectUrl: modificationCreditNote.objectUrl,
              role: "MODIFICATION_CREDIT_NOTE",
              description:
                "Backfill the MODIFICATION_CREDIT_NOTE link from a completed Xero operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary:
              "A modification credit note exists in operation history, but its booking-modification link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              xeroCreditNoteId: modificationCreditNote.objectId,
            },
            actionKeys: [action.key],
          });
        }

        const allocation = resolveObjectFromCandidates({
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });

        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            modificationOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation?.kind === "retryable") {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking a modification credit note allocation.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else if (!blockingOperation) {
            if (storedSettlement !== null || !paymentHasCapturedMoney) {
              // The allocation must match the NOTE's evidenced amount, not
              // abs(net): allocating more than a policy-limited note's total
              // both over-repairs the books and fails Xero-side (#1427).
              const action = addAction(actionMap, {
                key: `queue:allocation:${modification.id}:${modificationCreditNote.objectId}`,
                bookingId: booking.id,
                type: "QUEUE_CREDIT_NOTE_ALLOCATION",
                description:
                  "Queue the missing Xero allocation linking the modification credit note back to the primary invoice.",
                safeToAutoApply: true,
                payload: {
                  localModel: "BookingModification",
                  localId: modification.id,
                  creditNoteId: modificationCreditNote.objectId,
                  invoiceId: primaryInvoice.objectId,
                  amountCents: expectedCreditNoteCents,
                  role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
                },
              });
              addFinding(findings, {
                code: "MISSING_CREDIT_NOTE_ALLOCATION",
                severity: "critical",
                summary: "A modification credit note exists, but it is not allocated back to the original invoice.",
                safeToAutoApply: true,
                details: {
                  modificationId: modification.id,
                  creditNoteId: modificationCreditNote.objectId,
                  invoiceId: primaryInvoice.objectId,
                  amountCents: expectedCreditNoteCents,
                  amountSource: expectedAmountSource,
                },
                actionKeys: [action.key],
              });
            } else {
              // #1427: the note exists but nothing records its settlement
              // and the payment captured money — allocating abs(net) against
              // a possibly policy-limited note over-repairs the books (or
              // fails Xero-side). A human confirms the note's total first.
              const action = addAction(
                actionMap,
                buildManualReviewAction(
                  booking.id,
                  "A modification credit note exists without an allocation, but no stored evidence records its settlement amount - confirm the note's total in Xero and allocate manually."
                )
              );
              addFinding(findings, {
                code: "MISSING_CREDIT_NOTE_ALLOCATION",
                severity: "manual_review",
                summary:
                  "A modification credit note exists without an allocation, but its settlement amount cannot be reconstructed safely (captured payment, no stored evidence).",
                safeToAutoApply: false,
                details: {
                  modificationId: modification.id,
                  creditNoteId: modificationCreditNote.objectId,
                  invoiceId: primaryInvoice.objectId,
                  refundDueCents,
                },
                actionKeys: [action.key],
              });
            }
          } else if (blockingOperation.kind === "resolved") {
            // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
            // queued beside, but reported (decision 2), so a wrong resolve can be seen.
            addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "credit-note allocation", { modificationId: modification.id });
          } else {
            // #1427 third arm: a live-but-not-retryable allocation operation
            // must block, not be re-queued beside it — evidence-sized
            // amounts can differ from the pending op's, so the
            // amount-embedding correlation key no longer dedups a re-queue
            // the way identical abs(net) amounts once did.
            const summary = ["FAILED", "PARTIAL"].includes(
              blockingOperation.operation.status
            )
              ? "A Xero credit-note allocation operation failed and cannot be auto-retried - resolve the operation manually."
              : isStuckOperation(blockingOperation.operation)
                ? "A pending or running Xero credit-note allocation operation looks stuck."
                : "A Xero credit-note allocation operation is already pending or running.";
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary,
              safeToAutoApply: false,
              details: {
                modificationId: modification.id,
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [],
            });
          }
        } else {
          addXeroAmountMismatchFinding({
            findings,
            actionMap,
            bookingId: booking.id,
            expectedAmountCents: expectedCreditNoteCents,
            resolved: allocation,
            links: modificationLinks,
            operations: modificationOperations,
            xeroObjectType: "ALLOCATION",
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            entityType: "ALLOCATION",
            operationType: "ALLOCATE",
            summary:
              "The modification credit-note allocation amount evidence does not match the local booking modification refund amount.",
            details: {
              modificationId: modification.id,
              creditNoteId: modificationCreditNote.objectId,
              invoiceId: primaryInvoice.objectId,
              amountCents: expectedCreditNoteCents,
              amountSource: expectedAmountSource,
            },
          });

          if (!allocation.link && allocation.operation) {
            const action = addAction(
              actionMap,
              buildLinkRepairAction({
                bookingId: booking.id,
                localModel: "BookingModification",
                localId: modification.id,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: allocation.objectId,
                xeroObjectNumber: allocation.objectNumber,
                xeroObjectUrl: allocation.objectUrl,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
                description:
                  "Backfill the missing MODIFICATION_CREDIT_NOTE_ALLOCATION link from a completed Xero allocation operation.",
              })
            );
            addFinding(findings, {
              code: "XERO_LINK_MISMATCH",
              severity: "warning",
              summary: "A modification credit-note allocation exists in operation history, but its link is missing.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                allocationId: allocation.objectId,
              },
              actionKeys: [action.key],
            });
          }
        }
      }
    }
  }

  const refundCreditNote = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroRefundCreditNoteId,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      })
    : null;

  if (payment && refundCreditNote?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Refund credit note references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Refund credit note references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
        conflictingCreditNoteIds: refundCreditNote.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && refundCreditNote && !payment.xeroRefundCreditNoteId) {
    const action = addAction(actionMap, {
      key: `payment-field:refund-credit-note:${payment.id}:${refundCreditNote.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
      description:
        "Backfill payment.xeroRefundCreditNoteId from an existing refund credit note link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroRefundCreditNoteId: refundCreditNote.objectId,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "A refund credit note exists, but the payment record is missing its xeroRefundCreditNoteId.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && refundCreditNote) {
    const refundAmountCents = getCashCancellationRefundCandidateCents(booking);
    if (refundAmountCents !== null && refundAmountCents > 0) {
      addXeroAmountMismatchFinding({
        findings,
        actionMap,
        bookingId: booking.id,
        expectedAmountCents: refundAmountCents,
        resolved: refundCreditNote,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        summary:
          "The refund credit-note amount evidence does not match the local cash refund amount.",
        details: {
          paymentId: payment.id,
          refundAmountCents,
          paymentRefundedAmountCents: payment.refundedAmountCents,
        },
      });
    }
  }

  // #3639 review F6 (the #3535 composition): cash that arrived after an IB hold
  // was released retires the pending clearing note (`retirePendingClearingNote`
  // cancels its queued MODIFICATION_CREDIT_NOTE create), so the arm below skips
  // the booking - but the operator is still told why no note exists. The ONE
  // home of this finding (#3535's copy inside the arm was removed at the sync,
  // delta D2). The evidence that cash arrived is either arm's own write: the
  // member arm settles the payment and records its account-credit note; the
  // organisation arm settles nothing and raises a hand-back task instead
  // (#3643 F2, the population #3535's in-arm copy used to catch). The row is
  // the one `retirePendingClearingNote` writes: a CANCELLED create stamped with
  // the clearing note's queue type.
  const cashRetiredClearingNote = Boolean(
    booking.status === "CANCELLED" &&
    payment &&
    primaryInvoice &&
    (hasCapturedRepairPayment(payment) ||
      paymentNoteAnswersInvoice(refundCreditNote, paymentLinks, paymentOperations) ||
      context.cancelledBookingHandBackPaymentIds.has(payment.id)) &&
    bookingOperations.some(
      (operation) =>
        operation.entityType === "CREDIT_NOTE" &&
        operation.operationType === "CREATE" &&
        operation.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE &&
        operation.status === "CANCELLED"
    )
  );
  if (cashRetiredClearingNote && payment && primaryInvoice) {
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "info",
      summary:
        "Cash arrived for this booking after its hold was released, so its invoice-clearing credit note was retired and none is owed - no action.",
      safeToAutoApply: false,
      details: { paymentId: payment.id, invoiceId: primaryInvoice.objectId },
      actionKeys: [],
    });
  }

  // #3643 delta D2: the cancel path recorded Xero's part payment as the
  // payment's receipt (a SUCCEEDED internet banking row) and, in the same
  // transaction, queued a clearing note for the unpaid rest - only when Xero
  // showed a rest owed. While that note is outstanding the booking enters the
  // arm below, where it is only ever manual review, never a full-size queue or
  // retry (`INV-PAY-107`). F1: no rest note (paid in full at the cancel), or
  // one an officer marked resolved in Xero (the rest cleared by hand), means
  // nothing is owed, and the ordinary skips apply.
  const partPaymentRecognised = (payment?.transactions ?? []).some(
    (transaction) => transaction.reason === PART_PAYMENT_RECOGNISED_REASON
  );
  const recognisedRestOwed =
    partPaymentRecognised && bookingOperations.some(isOutstandingClearingNoteCreate);

  // #3639: this arm clears an invoice nobody paid; `hasCapturedRepairPayment`
  // and `paymentNoteAnswersInvoice` are the two things it asks first - except
  // for #3643's recognised part payment whose rest is still owed, above.
  if (
    booking.status === "CANCELLED" &&
    payment &&
    !cashRetiredClearingNote &&
    (recognisedRestOwed ||
      (!hasCapturedRepairPayment(payment) &&
        !paymentNoteAnswersInvoice(refundCreditNote, paymentLinks, paymentOperations))) &&
    primaryInvoice
  ) {
    const clearingAmountCents = getUnpaidCancellationClearingAmountCents(
      booking,
      context.xeroAllocatedAppliedCreditCents
    );
    if (clearingAmountCents > 0) {
      const cancellationCreditNote = resolveObjectFromCandidates({
        links: bookingLinks,
        operations: bookingOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!cancellationCreditNote) {
        const blockingOperation = getBlockingOperation(
          bookingOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        // The officer's "resolved in Xero" mark on the refused or failed note
        // (#3643, #3635 `INV-INT-025`): the clearing was done by hand, so
        // nothing is reported, retried or re-queued - the same rule as
        // `recognisedRestOwed` above.
        const blockingNoteResolvedInXero = blockingOperation?.kind === "resolved";
        // #3643: a payment the inbound sync recorded against the primary or
        // any supplementary invoice (the only local trace of a part payment).
        const recordedInvoicePayments = [
          ...paymentLinks,
          ...[...context.modificationLinksById.values()].flat(),
        ].filter(isRecordedBookingInvoicePayment);
        // #3643 (`INV-PAY-108`, task-queue review F2): an OPEN part-payment review is the
        // cancel's own durable proof that money was recorded against the
        // invoice, even with no local PAYMENT link.
        const openPartPaymentReview = Boolean(
          payment && context.openPartPaymentReviewPaymentIds.has(payment.id)
        );
        const invoicePaymentRecorded =
          recordedInvoicePayments.length > 0 ||
          partPaymentRecognised ||
          openPartPaymentReview;
        // #3643 (owner decision 28 Sep 2026, `INV-PAY-107`): a DECISION 2
        // cancel raised a hand-back task for the payment, and a treasurer has
        // dismissed it (the only way a review closes) - settled in Xero by hand.
        const partPaymentReviewClosed = Boolean(
          payment && context.closedPartPaymentReviewPaymentIds.has(payment.id)
        );
        if (blockingNoteResolvedInXero || partPaymentReviewClosed) {
          // Nothing owed: an officer cleared the invoice by hand.
          if (blockingOperation?.kind === "resolved") {
            // #3635 decision 2: reported, never re-run.
            addResolvedInXeroFinding(
              findings,
              blockingOperation.resolvedOperation,
              "invoice-clearing credit note"
            );
          }
        } else if (
          blockingOperation &&
          isClearingAllocationShortfall(blockingOperation.operation.lastErrorMessage)
        ) {
          // #3535: the invoices owe less than the note - retrying changes
          // nothing until a person looks, so it is never a safe auto-retry.
          const action = addAction(
            actionMap,
            buildManualReviewAction(
              booking.id,
              "The invoice-clearing credit note was refused because the booking's invoices owe less than it (part of the booking may have been paid) - review it by hand."
            )
          );
          addFinding(findings, {
            code: "MANUAL_REVIEW_REQUIRED",
            severity: "manual_review",
            summary:
              "An invoice-clearing credit note was refused because the booking's invoices owe less than it - review by hand; it is not retried automatically.",
            safeToAutoApply: false,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (
          invoicePaymentRecorded &&
          (!blockingOperation || blockingOperation.kind === "retryable")
        ) {
          // #3643 (`INV-PAY-107`): Xero recorded a payment against this
          // booking's invoices, so they owe less than a full-size clearing
          // note. Queueing or retrying one would be refused as a shortfall at
          // best; the part payment is money only a person can place (refund,
          // credit, or keep), so it is manual review, never an auto-apply.
          const action = addAction(
            actionMap,
            buildManualReviewAction(
              booking.id,
              "Xero records a payment against this cancelled booking's invoice, so a full invoice-clearing credit note would over-clear it - decide the part payment (refund, credit, or keep) and clear the rest by hand."
            )
          );
          addFinding(findings, {
            code: "MANUAL_REVIEW_REQUIRED",
            severity: "manual_review",
            summary:
              "A cancelled booking's invoice has a payment recorded against it, so its clearing credit note is not queued or retried automatically - review by hand.",
            safeToAutoApply: false,
            details: {
              paymentId: payment?.id ?? null,
              invoiceId: primaryInvoice.objectId,
              clearingAmountCents,
              operationId: blockingOperation?.operation.id ?? null,
              // DECISION 2 on #3643: name the payment a person has to place.
              recordedPayments: recordedInvoicePayments.map((link) => ({
                xeroPaymentId: link.xeroObjectId,
                metadata: link.metadata,
              })),
            },
            actionKeys: [action.key],
          });
        } else if (blockingOperation?.kind === "retryable") {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero cancellation credit note operation is blocking an unpaid cancelled booking from clearing its invoice.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:cancelled-open-invoice:${booking.id}`,
            bookingId: booking.id,
            type: "QUEUE_MODIFICATION_CREDIT_NOTE",
            description:
              "Queue the missing Xero credit note needed to clear the original invoice for a cancelled unpaid booking.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              refundAmountCents: clearingAmountCents,
              // #3535 (`INV-PAY-017`): the note clears an unpaid invoice.
              clearsUnpaidInvoice: true,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The booking was cancelled before payment succeeded, but the original Xero invoice still needs a clearing credit note.",
            safeToAutoApply: true,
            details: {
              paymentId: payment?.id ?? null,
              invoiceId: primaryInvoice.objectId,
              clearingAmountCents,
            },
            actionKeys: [action.key],
          });
        } else {
          // #3535: a live or failed clearing operation the retry helper cannot
          // replay must still be SEEN - silence here left an unpaid invoice open
          // with nothing in the report (the #1356 third-arm rule).
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: ["FAILED", "PARTIAL"].includes(blockingOperation.operation.status)
              ? "A Xero invoice-clearing credit note operation failed and cannot be auto-retried - resolve it by hand so the cancelled unpaid booking's invoice closes."
              : isStuckOperation(blockingOperation.operation)
                ? "A pending or running Xero invoice-clearing credit note operation looks stuck."
                : "A Xero invoice-clearing credit note operation is already pending or running.",
            safeToAutoApply: false,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
              retryUnsupportedReason: blockingOperation.retryMeta.reason,
            },
            actionKeys: [],
          });
        }
      } else {
        // #3535: a note whose own operation went PARTIAL did not finish its
        // allocations. Its row records the plan (one invoice, or the primary
        // and supplementary invoices a clearing note is spread across), so the
        // retry replays exactly that - a fresh allocation sized here would be
        // the note's whole amount against the primary invoice alone.
        const partialNoteOperation = bookingOperations.find(
          (operation) =>
            operation.entityType === "CREDIT_NOTE" &&
            operation.operationType === "CREATE" &&
            operation.status === "PARTIAL" &&
            operation.xeroObjectId === cancellationCreditNote.objectId
        );
        // #3635 (`INV-INT-025`): an officer who resolved the PARTIAL note in
        // Xero finished its allocations by hand. That is done: no retry, and no
        // fresh allocation queued below, which would be a second one beside
        // the officer's.
        const partialNoteResolvedInXero = Boolean(
          partialNoteOperation && isResolvedInXero(partialNoteOperation)
        );
        // Only while a planned invoice still has no allocation link from this
        // note: a repaired PARTIAL row stays PARTIAL, so its status alone
        // would report a whole note as broken forever.
        const partialNoteRetry =
          partialNoteOperation &&
          partialClearingNoteIsIncomplete(
            partialNoteOperation.requestPayload,
            cancellationCreditNote.objectId,
            bookingLinks.filter(
              (link) =>
                link.xeroObjectType === "ALLOCATION" &&
                link.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION"
            )
          )
            ? toRetryableOperationMatch(partialNoteOperation)
            : null;
        // The note's own amount, as its create recorded it (#3643): the cancel
        // wrote a recognised booking's rest - Xero's amount due at the read -
        // as the note's `refundAmountCents`, so the allocation reads back that
        // same figure rather than the full clearing amount. A stored figure
        // outside (0, clearingAmountCents] is ignored, as the modification arm
        // does; without one only an unrecognised (full-size) note falls back.
        const storedNoteAmount = recoverStoredXeroAmountCents({
          links: bookingLinks,
          operations: bookingOperations,
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_CREDIT_NOTE",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          objectId: cancellationCreditNote.objectId,
          payloadQueueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
        });
        const allocationAmountCents =
          storedNoteAmount &&
          storedNoteAmount.amountCents > 0 &&
          storedNoteAmount.amountCents <= clearingAmountCents
            ? storedNoteAmount.amountCents
            : partPaymentRecognised
              ? null
              : clearingAmountCents;
        const allocation = resolveObjectFromCandidates({
          links: bookingLinks,
          operations: bookingOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });
        if (partialNoteResolvedInXero) {
          // Done by hand in Xero: nothing retried or queued. The note itself
          // exists, so there is no missing document to report - but a separate
          // live allocation row is still seen (Xero review F8): a resolved row
          // never outranks a live one. Report-only, because the officer
          // allocated by hand and a retry could allocate twice.
          const liveAllocation = getBlockingOperation(
            bookingOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (liveAllocation && liveAllocation.kind !== "resolved") {
            addBlockedClearingAllocationFinding(findings, liveAllocation.operation);
          }
        } else if (partialNoteOperation && partialNoteRetry) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, partialNoteRetry)
          );
          addFinding(findings, {
            code: "MISSING_CREDIT_NOTE_ALLOCATION",
            severity: "critical",
            summary:
              "The invoice-clearing credit note exists, but its allocations did not all complete; retrying replays the recorded plan.",
            safeToAutoApply: true,
            details: {
              bookingId: booking.id,
              creditNoteId: cancellationCreditNote.objectId,
              operationId: partialNoteOperation.id,
            },
            actionKeys: [action.key],
          });
        } else if (!allocation) {
          const blockingOperation = getBlockingOperation(
            bookingOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation?.kind === "retryable") {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking an unpaid cancelled booking from clearing its invoice.",
              safeToAutoApply: true,
              details: {
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else if (blockingOperation?.kind === "resolved") {
            // #3635 (`INV-INT-025`): done by hand in Xero - never retried or
            // queued beside, but reported (decision 2), so a wrong resolve can be seen.
            addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "invoice-clearing allocation");
          } else if (blockingOperation?.kind === "blocked") {
            // #3635: a live allocation (pending, running, or failed and not
            // retryable) is reported, never queued beside - the #1356/#1427
            // third-arm rule the modification allocation arm follows.
            addBlockedClearingAllocationFinding(findings, blockingOperation.operation);
          } else if (allocationAmountCents === null) {
            // #3643: a recognised booking's note covers only the rest, and no
            // stored figure says how much - a full-size allocation would
            // over-clear, so a person allocates it.
            const action = addAction(
              actionMap,
              buildManualReviewAction(
                booking.id,
                "The unpaid-rest clearing credit note exists but is not allocated, and its amount is not recorded - allocate it to the invoice by hand."
              )
            );
            addFinding(findings, {
              code: "MANUAL_REVIEW_REQUIRED",
              severity: "manual_review",
              summary:
                "A part-paid cancelled booking's clearing credit note is not allocated and its amount is not recorded - allocate it by hand.",
              safeToAutoApply: false,
              details: { bookingId: booking.id, creditNoteId: cancellationCreditNote.objectId },
              actionKeys: [action.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:cancelled-allocation:${booking.id}:${cancellationCreditNote.objectId}`,
              bookingId: booking.id,
              type: "QUEUE_CREDIT_NOTE_ALLOCATION",
              description:
                "Queue the missing Xero allocation that clears the original invoice for a cancelled unpaid booking.",
              safeToAutoApply: true,
              payload: {
                localModel: "Booking",
                localId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: allocationAmountCents,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            });
            addFinding(findings, {
              code: "MISSING_CREDIT_NOTE_ALLOCATION",
              severity: "critical",
              summary:
                "The cancellation credit note exists, but it is not allocated back to the cancelled booking invoice.",
              safeToAutoApply: true,
              details: {
                bookingId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: allocationAmountCents,
              },
              actionKeys: [action.key],
            });
          }
        }
      }
    }
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    outstandingPaymentTransactions.length > 0
  ) {
    const outstandingPaymentIntentIds = [
      ...new Set(
        outstandingPaymentTransactions.map(
          (transaction) => transaction.stripePaymentIntentId
        )
      ),
    ];
    const action = addAction(actionMap, {
      key: `cancel-inflight-payment:${booking.id}:${payment.id}`,
      bookingId: booking.id,
      type: "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
      description:
        "Verify and cancel any in-flight Stripe payment intents, then mark only those uncaptured local transactions as failed.",
      safeToAutoApply: true,
      payload: {
        bookingId: booking.id,
        paymentId: payment.id,
        paymentIntentIds: outstandingPaymentIntentIds,
      },
    });
    addFinding(findings, {
      code: "CANCELLED_IN_FLIGHT_PAYMENT",
      severity: "critical",
      summary:
        "The booking is cancelled, but one or more Stripe payment intents are still pending or processing.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        paymentIntentIds: outstandingPaymentIntentIds,
        outstandingTransactions: outstandingPaymentTransactions.map((transaction) => ({
          kind: transaction.kind,
          paymentIntentId: transaction.stripePaymentIntentId,
          status: transaction.status,
          amountCents: transaction.amountCents,
          refundedAmountCents: transaction.refundedAmountCents,
        })),
      },
      actionKeys: [action.key],
    });
  }

  // #3635 (owner decision 29 Sep 2026, `INV-PAY-110`): a late capture a
  // treasurer KEPT is recorded by its own kept-capture invoice for the GROSS
  // capture, paid from Stripe on the capture day, anchored on its approval task
  // and queued by the dismissal: the booking's own payment, and a change
  // payment on a booking Xero never invoiced (`keptLateCaptureRecordRoute`).
  // Where none was asked for (the keep predates #3635, or a reopen withdrew
  // it), this queues it automatically - the pass re-reads the task under its
  // row lock before queueing. A failed one is retried. The same decision as the
  // dismissal (`decideLateCapture`, `late-capture-kept-xero-rules.ts`).
  if (booking.status === "CANCELLED" && payment) {
    for (const transaction of capturedPaymentTransactions) {
      if (!transaction.stripePaymentIntentId) continue;
      const kept = context.keptLateCaptures.get(transaction.stripePaymentIntentId);
      if (!kept) continue;
      if (
        keptLateCaptureRecordRoute({
          captureKind: transaction.kind,
          bookingHasPrimaryInvoice: bookingHasPrimaryXeroInvoice({
            paymentXeroInvoiceId: payment.xeroInvoiceId,
            paymentLinks,
          }),
        }) !== "kept-invoice"
      ) {
        continue;
      }
      const { recordCents } = decideLateCapture({
        taskStatus: "DISMISSED",
        bookingStatus: booking.status,
        superseded: false,
        capture: transaction,
      });
      if (recordCents === 0) continue;
      if (keptLateCaptureInvoiceAsked(kept.operations)) {
        const blockingOperation = getBlockingOperation(kept.operations, "INVOICE", "CREATE");
        if (blockingOperation?.kind === "resolved") {
          // `INV-INT-025`: an officer recorded it by hand in Xero; reported,
          // never re-run, and never queued again (a resolved row is "asked").
          addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "kept-payment invoice", {
            paymentIntentId: transaction.stripePaymentIntentId,
          });
        } else if (blockingOperation?.kind === "retryable") {
          const action = addAction(actionMap, buildRetryAction(booking.id, blockingOperation));
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero invoice for a late payment a treasurer kept needs retrying.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
              paymentIntentId: transaction.stripePaymentIntentId,
            },
            actionKeys: [action.key],
          });
        }
        continue;
      }
      const action = addAction(actionMap, {
        key: `queue:kept-late-capture-invoice:${kept.taskId}`,
        bookingId: booking.id,
        type: "QUEUE_KEPT_LATE_CAPTURE_INVOICE",
        description:
          "Queue the Xero invoice, paid from the Stripe account on the capture day, that records a late card payment a treasurer kept.",
        safeToAutoApply: true,
        payload: {
          manualRefundTaskId: kept.taskId,
          bookingId: booking.id,
          paymentIntentId: transaction.stripePaymentIntentId,
          capturedCents: recordCents,
          capturedAt: kept.raisedAt.toISOString(),
        },
      });
      addFinding(findings, {
        code: "KEPT_LATE_CAPTURE_WITHOUT_XERO_INVOICE",
        severity: "critical",
        summary:
          "A treasurer kept a late card payment on this cancelled booking, and Xero has no invoice for it.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          manualRefundTaskId: kept.taskId,
          paymentIntentId: transaction.stripePaymentIntentId,
          captureKind: transaction.kind,
          capturedCents: recordCents,
        },
        actionKeys: [action.key],
      });
    }
  }

  // #3635 round-3 N1/R5: every approval task, whatever its status now.
  //  - A kept invoice raised in Xero whose Stripe payment was never recorded
  //    (PARTIAL) is retried even after a reopen and approval: the cash was
  //    really taken, and the retry records only the payment.
  //  - A kept invoice an officer recorded by hand and resolved in Xero gets no
  //    refund note from the app; once its capture is refunded, an officer is
  //    told to record that refund by hand as well. Report-only.
  if (booking.status === "CANCELLED" && payment) {
    for (const transaction of capturedPaymentTransactions) {
      if (!transaction.stripePaymentIntentId) continue;
      const lateTask = context.lateCaptureTasks.get(transaction.stripePaymentIntentId);
      if (!lateTask) continue;
      const keptInvoice = getBlockingOperation(lateTask.operations, "INVOICE", "CREATE", {
        payloadQueueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
      });
      if (keptInvoice?.kind === "resolved") {
        if (transaction.refundedAmountCents > 0) {
          addFinding(findings, {
            code: "KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND",
            severity: "warning",
            summary:
              "A late card payment an officer recorded by hand in Xero was refunded. The app raises no refund credit note for it: record the refund by hand in Xero too.",
            safeToAutoApply: false,
            details: {
              paymentId: payment.id,
              manualRefundTaskId: lateTask.taskId,
              paymentIntentId: transaction.stripePaymentIntentId,
              refundedCents: transaction.refundedAmountCents,
              operationId: keptInvoice.resolvedOperation.id,
            },
            actionKeys: [],
          });
        }
        continue;
      }
      if (
        lateTask.status !== "DISMISSED" &&
        keptInvoice?.kind === "retryable" &&
        keptInvoice.operation.status === "PARTIAL"
      ) {
        const action = addAction(actionMap, buildRetryAction(booking.id, keptInvoice));
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary:
            "A Xero invoice for a late card payment was raised but its Stripe payment was never recorded.",
          safeToAutoApply: true,
          details: {
            operationId: keptInvoice.operation.id,
            operationStatus: keptInvoice.operation.status,
            paymentIntentId: transaction.stripePaymentIntentId,
          },
          actionKeys: [action.key],
        });
      }
    }
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    outstandingCapturedRefundAmountCents > 0
  ) {
    // #1491 (owner decision): a cancel that RECORDED a refund decision
    // deliberately retained the remainder as the cancellation-policy penalty,
    // so correct books get no finding (the #1427 precedent). Which artefacts
    // count is `isCancellationRefundDecisionRecorded`, shared with the Stripe
    // webhook since #3639. Without one, a late capture and a retention look
    // alike, so the finding stays but is NEVER auto-applied. Known residual: a
    // late capture on a booking that ALSO had a paid-path cancel is masked by
    // that cancel's artifact; the #1350 durable intent-cancellation recovery
    // and the webhook superseded-intent hook own that population.
    // #3638's second-instrument conflict marker is excluded with #2262's two
    // by `isManualSettlementMarkerEvent`, inside the shared rule.
    const cancellationRefundDecisionRecorded = isCancellationRefundDecisionRecorded({
      bookingId: booking.id,
      cancelledEvents: booking.events ?? [],
      creditsFromCancellation: booking.creditsFromCancellation,
      cancellationRefundRecoveryOperations: context.cancellationRefundRecoveryOperations,
    });
    // #3639 review F3: a capture a treasurer-approval task owns (held or kept)
    // is decided, so it is left out; nothing is offered for refund behind it.
    const heldOutstanding = capturedPaymentTransactions.filter(
      (transaction) =>
        transaction.stripePaymentIntentId !== null &&
        context.lateCaptureApprovalIntentIds.has(transaction.stripePaymentIntentId)
    );
    const unheldOutstandingCents =
      outstandingCapturedRefundAmountCents -
      heldOutstanding.reduce(
        (sum, t) => sum + Math.max(t.amountCents - t.refundedAmountCents, 0),
        0
      );
    const lateCaptureTransactions = capturedPaymentTransactions.filter(
      (transaction) =>
        transaction.amountCents > transaction.refundedAmountCents &&
        !heldOutstanding.includes(transaction)
    );
    // #3639 delta D1: the refund is PINNED to the unheld captures, slice by
    // slice, so no newest-first allocation can ever reach a held capture's money.
    // A legacy payment (no ledger rows, so no ids) cannot have a held capture —
    // approval tasks are raised on ledger rows — and keeps the derived refund.
    const pinnable = lateCaptureTransactions.every((transaction) => transaction.id !== null);
    const lateCaptureAllocation: { paymentTransactionId: string; amountCents: number }[] = [];
    let unallocatedCents = Math.max(unheldOutstandingCents, 0);
    for (const transaction of [...lateCaptureTransactions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )) {
      if (!pinnable || transaction.id === null || unallocatedCents <= 0) break;
      const sliceCents = Math.min(
        transaction.amountCents - transaction.refundedAmountCents,
        unallocatedCents
      );
      lateCaptureAllocation.push({ paymentTransactionId: transaction.id, amountCents: sliceCents });
      unallocatedCents -= sliceCents;
    }
    const refundAmountCents = pinnable
      ? lateCaptureAllocation.reduce((sum, slice) => sum + slice.amountCents, 0)
      : heldOutstanding.length === 0
        ? Math.max(unheldOutstandingCents, 0)
        : 0;
    if (!cancellationRefundDecisionRecorded && refundAmountCents > 0) {
      const action = addAction(actionMap, {
        key: `late-capture-refund:${booking.id}:${payment.id}:${refundAmountCents}`,
        bookingId: booking.id,
        type: "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
        description:
          "Refund the remaining captured Stripe amount on a cancelled booking with no recorded cancellation-refund decision. Verify first whether this is a genuine late capture (refund it) or a deliberate 0%-tier policy retention (leave it) — never auto-applied (#1491).",
        safeToAutoApply: false,
        payload: {
          bookingId: booking.id,
          paymentId: payment.id,
          refundAmountCents,
          allocation: pinnable ? lateCaptureAllocation : null,
          invoiceId: primaryInvoice?.objectId ?? null,
        },
      });
      addFinding(findings, {
        code: "LATE_CAPTURE_AFTER_CANCELLATION",
        severity: "critical",
        summary:
          "Captured value remains on a cancelled booking with no recorded cancellation-refund decision (late capture or 0%-tier retention).",
        safeToAutoApply: false,
        details: {
          paymentId: payment.id,
          paymentIntentIds: lateCaptureTransactions.map(
            (transaction) => transaction.stripePaymentIntentId
          ),
          refundAmountCents,
          invoiceId: primaryInvoice?.objectId ?? null,
        },
        actionKeys: [action.key],
      });
    }
  }

  if (booking.status === "CANCELLED" && payment) {
    const cancellationCreditAmountCents = getCancellationCreditAmountCents(booking);
    if (cancellationCreditAmountCents > 0) {
      const accountCreditNote = resolveObjectFromCandidates({
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "ACCOUNT_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!accountCreditNote) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE",
          // #3635: an operation on the payment's REFUND note must not answer
          // for the account-credit note - least of all a resolved one.
          { payloadQueueType: XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE }
        );
        if (blockingOperation?.kind === "retryable") {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero account-credit note operation is blocking a cancelled booking credit refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (blockingOperation?.kind === "resolved") {
          // #3635 decision 2: done by hand in Xero; reported, never re-run.
          addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "account-credit note");
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:account-credit-note:${payment.id}:${cancellationCreditAmountCents}`,
            bookingId: booking.id,
            type: "QUEUE_ACCOUNT_CREDIT_NOTE",
            description:
              "Queue the missing unapplied Xero account-credit note for a cancelled booking credit refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
          });
          addFinding(findings, {
            code: "MISSING_ACCOUNT_CREDIT_NOTE",
            severity: "critical",
            summary:
              "The cancelled booking created local account credit, but no corresponding unapplied Xero credit note exists.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }

    if (primaryInvoice && !refundCreditNote) {
      const cashCancellationRefundCents = getCashCancellationRefundCandidateCents(booking);
      if (cashCancellationRefundCents === null) {
        const action = addAction(
          actionMap,
          buildManualReviewAction(
            booking.id,
            "Cancelled booking has refunded cash locally, but the missing Xero cancellation credit note amount is ambiguous."
          )
        );
        addFinding(findings, {
          code: "MANUAL_REVIEW_REQUIRED",
          severity: "manual_review",
          summary:
            "The booking appears to have a cash cancellation refund, but the missing Xero refund note amount cannot be derived safely from local history.",
          safeToAutoApply: false,
          details: {
            paymentId: payment.id,
            refundedAmountCents: payment.refundedAmountCents,
            knownModificationRefundCents: getKnownModificationRefundTotalCents(booking),
          },
          actionKeys: [action.key],
        });
      } else if (cashCancellationRefundCents > 0) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE",
          // #3635: the account-credit note's operation must not answer for it.
          { payloadQueueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }
        );
        if (blockingOperation?.kind === "retryable") {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero refund credit note operation is blocking a cancelled booking cash refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (blockingOperation?.kind === "resolved") {
          // #3635 decision 2: done by hand in Xero; reported, never re-run.
          addResolvedInXeroFinding(findings, blockingOperation.resolvedOperation, "refund credit note");
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:refund-credit-note:${payment.id}:${cashCancellationRefundCents}`,
            bookingId: booking.id,
            type: "QUEUE_REFUND_CREDIT_NOTE",
            description:
              "Queue the missing Xero refund credit note for a cancelled booking cash refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The cancelled booking refunded cash locally, but no Xero refund credit note can be resolved for that cancellation.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }
  }

  return buildBookingSummary(context, findings, actionMap);
}
