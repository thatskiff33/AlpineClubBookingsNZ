/**
 * Xero credit note creation, allocation, and refund-credit-note settlement.
 *
 * Owns three closely-related accounting documents:
 *
 * - `createXeroCreditNote` (refund credit note settled by a Stripe-refund
 *   credit-note payment in the same flow)
 * - `createUnappliedXeroCreditNote` (account credit balance, used for
 *   member-credit refunds rather than money out)
 * - `allocateCreditNoteToInvoice` (apply an unapplied credit note against
 *   an invoice via Xero allocation)
 *
 * Also exposes the shared `backfillCancellationCreditXeroNote` helper
 * that keeps the local `MemberCredit` rows in step with the canonical
 * Xero credit-note IDs.
 */

import { CreditNote, LineAmountTypes, type LineItem } from "xero-node";
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
  sumCoveredRefundCreditNoteCents,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  getAccountMapping,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { formatDateOnly } from "@/lib/date-only";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { buildSyntheticAllocationId } from "./xero-invoice-helpers";
import {
  buildRefundCreditNotePayment,
  REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
} from "./xero-invoice-payments";

export interface CreateXeroRefundCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  /**
   * Cumulative refunded-cents watermark this note settles up to (#1162). When
   * set, the payment is refunded per-delta (Stripe): skip only when an active
   * refund credit note already covers this watermark, and key the note/payment
   * on the watermark so equal-amount deltas do not collide. Undefined keeps the
   * legacy single-note behaviour for non-per-delta callers.
   */
  watermarkCents?: number;
}

function readLinkWatermarkCents(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).watermarkCents;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface CreateXeroUnappliedCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  bookingModificationId?: string;
}

export async function createXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroRefundCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true, guests: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (!payment.xeroInvoiceId) {
    throw new Error(`No Xero invoice linked to payment: ${paymentId}`);
  }
  const originalInvoiceId = payment.xeroInvoiceId;
  const queuedOperationId = options?.syncOperationId ?? null;
  const watermarkCents = options?.watermarkCents;
  const isDeltaMode =
    typeof watermarkCents === "number" && Number.isFinite(watermarkCents);

  let existingCreditNoteId: string | null = null;
  let existingCreditNoteNumber: string | null = null;
  // F4 (#1354): in delta mode the amounts billed to Xero are derived from
  // EXECUTION-TIME state, not the enqueue-time request. The enqueue-time
  // watermark can be stale: two Stripe refunds inside one outbox interval
  // give the second operation a LOWER watermark than the first, and
  // oldest-first execution then treated the first note as covering — the
  // second delta was marked SUCCEEDED without creating anything.
  // #2902 (INV-PAY-050): the cumulative total a refund note may cover is the
  // provider-backed CASH refund evidence (`resolveStripeCashRefundEvidence`),
  // never the raw refundedAmountCents mirror — the mirror also counts
  // account-credit dispositions, so using it here is what minted fictitious
  // refund notes (each settled by a Stripe-bank payment) for cancellations
  // that returned no cash. Recomputing the evidence here also neutralises any
  // already-queued fictitious operation: it completes without billing Xero.
  // `cashRefundCents − sum(covered notes)` is the true uncovered amount at
  // the moment this runs, whatever order operations execute or replay in
  // (refundedAmountCents stays monotonic under inbound reconcile since #1353,
  // and succeeded PaymentRefund rows are never deleted).
  let effectiveRefundAmountCents = refundAmountCents;
  let effectiveWatermarkCents: number | null = null;

  if (isDeltaMode) {
    // Per-delta refunds (#1162): a payment refunded in steps has one active note
    // per delta. Skip only when an existing note already covers this watermark;
    // a lower-watermark note is an earlier, smaller delta and must not block this
    // one, so the canonical single-note lookup is deliberately bypassed here.
    const activeLinks = await prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        active: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        xeroObjectId: true,
        xeroObjectNumber: true,
        metadata: true,
      },
    });

    const coveredCents = await sumCoveredRefundCreditNoteCents(paymentId);
    const evidence = await resolveStripeCashRefundEvidence({
      id: payment.id,
      bookingId: payment.bookingId,
      refundedAmountCents: payment.refundedAmountCents,
    });
    const uncoveredCents = Math.max(
      0,
      evidence.cashRefundCents - coveredCents
    );

    if (uncoveredCents <= 0) {
      // Nothing uncovered at execution time: the enqueue-time delta was
      // already settled by other notes (or the request raced a competing
      // note). Close against the covering link — by watermark when one
      // matches, else the newest active note.
      const coveringLink =
        activeLinks.find((link) => {
          const linkWatermark = readLinkWatermarkCents(link.metadata);
          return linkWatermark !== null && linkWatermark >= watermarkCents;
        }) ??
        activeLinks[0] ??
        null;
      if (coveringLink) {
        existingCreditNoteId = coveringLink.xeroObjectId;
        existingCreditNoteNumber = coveringLink.xeroObjectNumber ?? null;
      } else {
        // Reached when no cash remains uncovered AND no active note exists —
        // notably a queued operation for an account-credit-only cancellation
        // (#2902): its cash evidence is zero, so the operation completes
        // WITHOUT billing Xero. Never bill Xero for a covered request.
        logger.warn(
          {
            paymentId,
            refundAmountCents,
            coveredCents,
            cashRefundCents: evidence.cashRefundCents,
            cashEvidenceSource: evidence.source,
          },
          "No uncovered provider-backed Stripe cash refund at execution time; completing without creating a Xero refund credit note"
        );
        if (queuedOperationId) {
          await completeXeroSyncOperation(queuedOperationId, {
            responsePayload: {
              skippedNothingUncovered: true,
              coveredCents,
              cashRefundCents: evidence.cashRefundCents,
              cashEvidenceSource: evidence.source,
            },
          });
        }
        return payment.xeroRefundCreditNoteId ?? "";
      }
    } else {
      // Bill exactly what the ledger still shows uncovered (never more than
      // requested), and key the note by the EXECUTION-TIME watermark so a
      // replay under unchanged state mints the identical Xero idempotency
      // key, while changed state produces a consistent new intent.
      effectiveRefundAmountCents = Math.min(refundAmountCents, uncoveredCents);
      effectiveWatermarkCents = coveredCents + effectiveRefundAmountCents;
    }
  } else {
    const canonicalRefundCreditNote =
      await findCanonicalPaymentRefundCreditNote(paymentId);
    existingCreditNoteId =
      payment.xeroRefundCreditNoteId ?? canonicalRefundCreditNote?.xeroObjectId ?? null;
    existingCreditNoteNumber =
      canonicalRefundCreditNote?.xeroObjectNumber ?? null;
  }

  // Idempotency guard: skip if a credit note already covers this payment/delta
  if (existingCreditNoteId) {
    if (payment.xeroRefundCreditNoteId !== existingCreditNoteId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: existingCreditNoteId,
        },
      });
    }

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: existingCreditNoteId,
      xeroObjectNumber: existingCreditNoteNumber,
      role: "REFUND_CREDIT_NOTE",
    });
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingCreditNoteId,
        xeroObjectNumber: existingCreditNoteNumber,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditNoteId,
            xeroObjectNumber: existingCreditNoteNumber,
            role: "REFUND_CREDIT_NOTE",
          },
        ],
      });
    }
    logger.info({ paymentId, creditNoteId: existingCreditNoteId }, "Xero credit note already exists, skipping");
    return existingCreditNoteId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const refundLineItem: LineItem = {
    description: `Refund for booking ${payment.booking.id.slice(0, 8)} (${formatDateOnly(new Date(payment.booking.checkIn))} - ${formatDateOnly(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: effectiveRefundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    refundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    refundLineItem.accountCode = accountCode;
  }

  // The credit note's own date decides which GST period and financial year the
  // refund lands in, so it is the club's calendar day (INV-DATE-019, #2834). The
  // stay dates above are `@db.Date` lodge nights, left on truncation —
  // INV-DATE-019's first boundary with INV-DATE-026, not INV-DATE-010 (#3080).
  // Read once, outside the closure: it runs per payload and per repair attempt.
  const creditNoteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: creditNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [refundLineItem],
    reference: `Refund - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const creditNoteIdempotencyKey = isDeltaMode
    ? buildXeroIdempotencyKey(
        "payment",
        paymentId,
        "refund-credit-note",
        effectiveWatermarkCents ?? watermarkCents,
        "v2"
      )
    : buildXeroIdempotencyKey(
        "payment",
        paymentId,
        "refund-credit-note",
        refundAmountCents,
        "v1"
      );
  let operationId = queuedOperationId;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    allocation: {
      invoiceId: originalInvoiceId,
      amount: effectiveRefundAmountCents / 100,
    },
  };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        allocation: {
          invoiceId: originalInvoiceId,
          amount: effectiveRefundAmountCents / 100,
        },
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNote",
            context: `createCreditNotes(refund ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create Xero credit note");
    }

    // Save credit note ID immediately so follow-up retries repair the existing note instead
    // of minting duplicates when downstream bookkeeping calls fail.
    await prisma.payment.update({
      where: { id: paymentId },
      data: { xeroRefundCreditNoteId: createdNote.creditNoteID },
    });

    let refundPaymentResponseBody:
      | { paymentID?: string; invoiceNumber?: string; creditNoteNumber?: string; amount?: number }
      | null = null;
    let refundPaymentErr: unknown = null;

    try {
      const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
      // Key on the freshly created note id (#1162): this runs only for a
      // brand-new note, so v1->v2 cannot replay historical payments, and equal
      // amount refunds no longer collide onto one refund-payment key.
      const refundPaymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        paymentId,
        "refund-payment",
        createdNote.creditNoteID,
        "v2"
      );
      const refundPayment = buildRefundCreditNotePayment({
        paymentId,
        creditNoteId: createdNote.creditNoteID,
        refundAmountCents: effectiveRefundAmountCents,
        bankCode,
        // The club's calendar day, from the persisted zone (CT-5, #2869).
        paymentDate: xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest()),
      });
      const refundPaymentResponse = await callXeroApi(
        () =>
          xero.accountingApi.createPayments(
            tenantId,
            {
              payments: [refundPayment],
            },
            undefined,
            refundPaymentIdempotencyKey
          ),
        {
          operation: "createPayments",
          resourceType: "PAYMENT",
          workflow: "createXeroCreditNote",
          context: `createPayments(refund credit note ${paymentId})`,
        }
      );
      refundPaymentResponseBody = refundPaymentResponse.body.payments?.[0] ?? null;
      logger.info(
        { paymentId, creditNoteId: createdNote.creditNoteID },
        "Xero refund payment created against Stripe bank account via credit note"
      );
    } catch (error) {
      refundPaymentErr = error;
      logger.error(
        { err: error, paymentId, creditNoteId: createdNote.creditNoteID },
        "Failed to create Xero refund payment against Stripe bank account via credit note"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        creditNote: response.body,
        allocation: null,
        allocationSkipped: true,
        allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
        refundPayment: refundPaymentResponseBody,
        refundPaymentError: refundPaymentErr,
      },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: "REFUND_CREDIT_NOTE",
          metadata: {
            amountCents: effectiveRefundAmountCents,
            watermarkCents:
              effectiveWatermarkCents ??
              options?.watermarkCents ??
              effectiveRefundAmountCents,
          },
        },
        ...(refundPaymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: paymentId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: refundPaymentResponseBody.paymentID,
                xeroObjectNumber:
                  refundPaymentResponseBody.creditNoteNumber
                  ?? refundPaymentResponseBody.invoiceNumber
                  ?? null,
                role: "REFUND_PAYMENT",
                metadata: {
                  creditNoteId: createdNote.creditNoteID,
                  invoiceId: originalInvoiceId,
                  amountCents: refundAmountCents,
                },
              },
            ]
          : []),
      ],
    });

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}


async function backfillCancellationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  const bookingLabel = params.bookingId.slice(0, 8);
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      amountCents: params.refundAmountCents,
      type: CreditType.CANCELLATION_REFUND,
      // Every credit this pipeline mints must link back to its Xero note: the
      // cancellation-flow literal plus the two Internet Banking payment-credit
      // literals (late capacity failure, and a payment landing on an
      // already-cancelled booking, #1357).
      description: {
        in: [
          `Cancellation refund for booking ${bookingLabel}`,
          `Internet Banking payment credit for booking ${bookingLabel}`,
          `Internet Banking payment credit for cancelled booking ${bookingLabel}`,
        ],
      },
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

async function backfillBookingModificationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  bookingModificationId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      sourceBookingModificationId: params.bookingModificationId,
      amountCents: params.refundAmountCents,
      type: CreditType.BOOKING_MODIFICATION_REFUND,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

/**
 * Create an UNAPPLIED Xero credit note for account credit refunds.
 * Unlike createXeroCreditNote(), this:
 * - Does NOT allocate against the original invoice
 * - Does NOT create a cash refund payment
 * The credit note stays as open credit on the member's Xero contact.
 */

export async function createUnappliedXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroUnappliedCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  const queuedOperationId = options?.syncOperationId ?? null;
  const bookingModificationId = options?.bookingModificationId ?? null;
  const linkLocalModel = bookingModificationId ? "BookingModification" : "Payment";
  const linkLocalId = bookingModificationId ?? paymentId;
  const linkRole = bookingModificationId
    ? "MODIFICATION_ACCOUNT_CREDIT_NOTE"
    : "ACCOUNT_CREDIT_NOTE";
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: linkLocalModel,
      localId: linkLocalId,
      xeroObjectType: "CREDIT_NOTE",
      role: linkRole,
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });

  if (existingLink?.xeroObjectId) {
    if (bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: existingLink.xeroObjectId,
      });
    } else {
      await backfillCancellationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        refundAmountCents,
        creditNoteId: existingLink.xeroObjectId,
      });
    }

    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId: existingLink.xeroObjectId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
        extraLinks: [
          {
            localModel: linkLocalModel,
            localId: linkLocalId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingLink.xeroObjectId,
            xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
            role: linkRole,
          },
        ],
      });
    }

    logger.info(
      { paymentId, creditNoteId: existingLink.xeroObjectId },
      "Xero account-credit note already exists, skipping"
    );

    return existingLink.xeroObjectId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const creditLineItem: LineItem = {
    description: bookingModificationId
      ? `Account credit from booking modification ${bookingModificationId.slice(0, 8)} (Booking ${payment.booking.id.slice(0, 8)})`
      : `Account credit from booking ${payment.booking.id.slice(0, 8)} (${formatDateOnly(new Date(payment.booking.checkIn))} - ${formatDateOnly(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    creditLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    creditLineItem.accountCode = accountCode;
  }

  // Club calendar day, for the same reason as the refund note above
  // (INV-DATE-019, #2834), read once outside the closure.
  const creditNoteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: creditNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: bookingModificationId
      ? `Modification Credit - Booking ${payment.booking.id.slice(0, 8)}`
      : `Account Credit - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "payment",
    linkLocalId,
    bookingModificationId ? "mod-unapplied-credit-note" : "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = { creditNotes: [buildCreditNote(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: linkLocalModel,
      localId: linkLocalId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createUnappliedXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createUnappliedXeroCreditNote",
            context: `createCreditNotes(unapplied ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create unapplied Xero credit note");
    }

    if (bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: createdNote.creditNoteID,
      });
    } else {
      await backfillCancellationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        refundAmountCents,
        creditNoteId: createdNote.creditNoteID,
      });
    }

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: linkLocalModel,
          localId: linkLocalId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: linkRole,
        },
      ],
    });

    logger.info(
      { paymentId, creditNoteId: createdNote.creditNoteID },
      "Created unapplied Xero credit note for account credit"
    );

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

export async function createUnappliedXeroCreditNoteForModification(params: {
  paymentId: string;
  refundAmountCents: number;
  bookingModificationId: string;
  createdByMemberId?: string;
  syncOperationId?: string;
}): Promise<string> {
  return createUnappliedXeroCreditNote(
    params.paymentId,
    params.refundAmountCents,
    {
      createdByMemberId: params.createdByMemberId,
      syncOperationId: params.syncOperationId,
      bookingModificationId: params.bookingModificationId,
    },
  );
}

/**
 * Allocate an existing Xero credit note against an invoice.
 * Used when account credit (backed by a Xero credit note) is applied to a new booking.
 */

export async function allocateCreditNoteToInvoice(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  options?: {
    localModel?: string;
    localId?: string;
    role?: string;
    createdByMemberId?: string;
    syncOperationId?: string;
    appliedCreditContext?: {
      parentOperationId: string | null;
      bookingId: string;
      paymentId: string;
    };
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // An allocation carries its own date, which is when the credit is applied to
  // the invoice in the ledger. Club calendar day (INV-DATE-019, #2834), read
  // once so a retried provider call sends the same date it first sent.
  const allocationDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = {
    creditNoteId,
    invoiceId,
    amountCents,
    ...(options?.appliedCreditContext
      ? { appliedCreditContext: options.appliedCreditContext }
      : {}),
  };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel: options?.localModel,
      localId: options?.localId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: invoiceId },
                amount: amountCents / 100,
                date: allocationDate,
              },
            ],
          },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateCreditNoteToInvoice",
        context: `createCreditNoteAllocation(${creditNoteId} -> ${invoiceId})`,
      }
    );

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
                xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
                role: options.role ?? "CREDIT_NOTE_ALLOCATION",
                metadata: {
                  creditNoteId,
                  invoiceId,
                  amountCents,
                },
              },
            ]
          : [],
    });

    logger.info(
      { creditNoteId, invoiceId, amountCents },
      "Allocated Xero credit note against invoice"
    );
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// XER-01: Xero Invoice Adjustment on Booking Modification
// ---------------------------------------------------------------------------

/**
 * Create a supplementary Xero invoice when a booking modification increases
 * the price. Optionally includes a separate line item for a late-notice
 * change fee.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
