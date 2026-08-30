// Per-booking finding/action classification for the booking-vs-Xero repair
// tool. classifyBookingContext is a single sequential function that mutates
// its own local findings/actionMap accumulators and is kept whole (one
// function, one module), exceeding the ~700-LOC soft cap. Originally
// extracted verbatim from xero-booking-repair.ts under #1208 item 2's
// behavior-preserving-move rule; that one-off extraction constraint no
// longer binds — the body has since gained behavior deliberately (#1356
// supplementary-invoice arms, #1427 evidence-first credit-note sizing).
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  MutableFinding,
} from "./xero-booking-repair-types";
import {
  getCapturedRepairTransactions,
  getOutstandingCapturedRefundAmountCents,
  getOutstandingRepairTransactions,
  planEditReviewChargeInvoicePayment,
} from "./xero-booking-repair-payments";
import {
  getBlockingOperation,
  isStuckOperation,
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
} from "./xero-booking-repair-analysis";
import {
  addAction,
  addFinding,
  addXeroAmountMismatchFinding,
  buildBookingSummary,
  buildLinkRepairAction,
  buildManualReviewAction,
  buildRetryAction,
  recoverStoredXeroAmountCents,
} from "./xero-booking-repair-findings";
import {
  getOperationQueueTypeHint,
} from "./xero-booking-repair-utils";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { formatDateOnly } from "@/lib/date-only";

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
      if (blockingOperation && blockingOperation.retryMeta.supported) {
        const action = addAction(
          actionMap,
          buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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

    if (blockingOperation && blockingOperation.retryMeta.supported) {
      const action = addAction(
        actionMap,
        buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
          if (editReviewPaymentPlan?.outcome === "manual-review") {
            // The invoice IS missing, but the tool must not raise it: doing so
            // would either assert money the club does not hold, or claim the
            // anchor the intent-mint recovery is about to use. Same finding
            // code, no queue action, and NOT safe to auto-apply - the arm a
            // person sizes, exactly as the credit-note arm does above.
            const summary =
              editReviewPaymentPlan.reason === "capture-short-of-ask"
                ? "A completed financial review priced this booking edit above what the member's card actually took, and no supplementary Xero invoice exists - the difference is owed outside any invoice, so raise it by hand."
                : "A completed financial review priced this booking edit as money owed, but its card request has not been raised yet and its recovery is still owed - no supplementary Xero invoice can be raised until that replay runs.";
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
            ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
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
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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

  if (
    booking.status === "CANCELLED" &&
    payment &&
    capturedPaymentTransactions.length === 0 &&
    primaryInvoice
  ) {
    const clearingAmountCents = getUnpaidCancellationClearingAmountCents(booking);
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
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
        }
      } else {
        const allocation = resolveObjectFromCandidates({
          links: bookingLinks,
          operations: bookingOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });
        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            bookingOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
                amountCents: clearingAmountCents,
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
                amountCents: clearingAmountCents,
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

  if (
    booking.status === "CANCELLED" &&
    payment &&
    outstandingCapturedRefundAmountCents > 0
  ) {
    // #1491 (owner decision): a cancel that RECORDED a refund decision
    // deliberately retained the remainder as the cancellation-policy
    // penalty. Correct books ⇒ no finding (the #1427 account-credit-settled
    // precedent: never nag forever on correct books). The decision artifacts,
    // any of: the CANCELLED event's policy snapshot (written by every
    // paid-path cancel, including 0%-tier retentions; unpaid-branch cancels
    // carry no snapshot), a cancellation credit (credit path), or a LIVE
    // booking-cancel refund recovery operation (card path, frozen inside the
    // claim transaction — a terminally FAILED op is a decision whose money
    // never moved, so it does NOT suppress the finding; the recovery
    // exhaustion alert and this finding both stay loud). Without such a
    // record the state cannot be distinguished from a genuine late capture,
    // so the finding stays but is NEVER auto-applied — an operator confirms
    // which it is before any refund moves. Known residual: a genuine late
    // capture on a booking that ALSO had a paid-path cancel is masked by
    // that cancel's artifact; the #1350 durable intent-cancellation recovery
    // and the webhook superseded-intent hook own that population.
    const cancellationRefundDecisionRecorded =
      (booking.events ?? []).some((event) => event.snapshot !== null) ||
      getCancellationCreditAmountCents(booking) > 0 ||
      context.cancellationRefundRecoveryOperations.some(
        (operation) => operation.status !== "FAILED"
      );
    if (!cancellationRefundDecisionRecorded) {
      const lateCaptureTransactions = capturedPaymentTransactions.filter(
        (transaction) => transaction.amountCents > transaction.refundedAmountCents
      );
      const refundAmountCents = outstandingCapturedRefundAmountCents;
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
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
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
