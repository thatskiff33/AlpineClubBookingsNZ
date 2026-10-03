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

import {
  findKeptLateCaptureInvoiceIdForPayment,
  findLateCapturePaymentIntents,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import {
  readResolvedRefundCreditNoteCoverage,
  sumRefundCreditNoteCoverageCents,
} from "@/lib/xero-resolved-in-xero-fences";
import { CreditNote, LineAmountTypes, type LineItem } from "xero-node";
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import { getResolvedAccountMapping } from "./xero-mappings";
import { retryXeroWriteWithContactRepair, type FindOrCreateXeroContactOptions } from "./xero-contacts";
import {
  findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair,
} from "@/lib/organisation-xero-contacts";
import { formatDateOnly } from "@/lib/date-only";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { buildSyntheticAllocationId } from "./xero-invoice-helpers";
import { resolveModificationDocumentLineItems } from "@/lib/xero-modification-line-items";
import type { CashRefundMethod } from "./xero-invoice-payments";
import {
  finishRefundCreditNoteSettlement,
  refundCreditNoteCompletion,
  refundNoteSettlementInterrupted,
  settleRefundCreditNote,
} from "@/lib/xero-refund-note-settlement";
import {
  buildRefundDocumentDescription,
  buildRefundDocumentReference,
  resolveRefundNoteMethod,
} from "@/lib/xero-refund-method";
import type { ClubFormat } from "@/lib/club-format";
import { cancellationCreditDescription } from "@/lib/cancellation-settled-money";
import {
  readRefundRequestIdFromPayload,
  REFUND_REQUEST_CREDIT_NOTE_ROLE,
} from "@/lib/refund-request-credit-note";

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
  /**
   * How the money went back (`INV-PAY-101`, #3529): the wording on the note and
   * the bank account its settling payment posts to. Threaded from the caller
   * that made the settlement decision through the outbox payload. Absent on
   * rows queued before the field existed, where the payment's source is the
   * only evidence and `defaultRefundMethodForPaymentSource` reads it.
   */
  refundMethod?: CashRefundMethod;
  /** #3635 round-3 R4: the late capture this note answers (its receipt is named). */
  paymentIntentId?: string;
  /** #3635 round-3 R3: the club day the refund left Stripe; omitted, today. */
  documentDate?: string;
  /**
   * #3827 (D-3813-8, `INV-PAY-116`): this is that refund request's OWN note,
   * raised when its task is marked paid back. Keyed by the request, linked
   * under `REFUND_REQUEST_CREDIT_NOTE_ROLE`, never per-delta and never the
   * payment's one refund-note pointer.
   */
  refundRequestId?: string;
}

/**
 * #3827 (D-3813-8): the one key of a refund request's own refund credit note -
 * its outbox row's correlation and idempotency key and the Xero idempotency
 * key alike. Keyed by the request, never by the amount.
 */
export function refundRequestCreditNoteKey(paymentId: string, refundRequestId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "refund-request-credit-note", refundRequestId, "v1");
}

/** Stamped on a late-capture refund note the app does not raise (`INV-PAY-110`). */
export const LATE_CAPTURE_REFUND_NOTE_SKIPPED = "late-capture-refund-not-app-recorded";

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
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        include: { member: true, organisation: { select: { name: true, email: true } }, guests: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  const queuedOperationId = options?.syncOperationId ?? null;
  // #3635 (`INV-PAY-110`, round-3 R5): a note for a LATE CAPTURE names that
  // capture's own receipt - its kept invoice, or its change's supplementary
  // invoice - and never `payment.xeroInvoiceId`, which for a late capture is
  // the pre-cancel invoice the cancel already cleared. With no receipt the app
  // recorded (none, or one an officer recorded and resolved by hand) no note is
  // raised: the row completes as skipped, and the repair tool tells an officer
  // to record the refund by hand. A released invoice not yet in Xero is a
  // transient failure, retried like any other.
  const lateCaptureIntent =
    options?.paymentIntentId &&
    (await findLateCapturePaymentIntents([options.paymentIntentId])).has(options.paymentIntentId)
      ? options.paymentIntentId
      : null;
  let originalInvoiceId: string | null;
  if (lateCaptureIntent) {
    const receipt = await readLateCaptureXeroReceipt(lateCaptureIntent);
    if (receipt.kind !== "recorded") {
      logger.warn(
        { paymentId, paymentIntentId: lateCaptureIntent, receipt: receipt.kind },
        "Late-capture refund credit note not raised: the app never recorded this capture's receipt in Xero"
      );
      if (queuedOperationId) {
        await completeXeroSyncOperation(queuedOperationId, {
          responsePayload: {
            skipped: LATE_CAPTURE_REFUND_NOTE_SKIPPED,
            receipt: receipt.kind,
            paymentIntentId: lateCaptureIntent,
          },
        });
      }
      return "";
    }
    if (!receipt.invoiceId) {
      throw new Error(
        `The receipt of late capture ${lateCaptureIntent} has not reached Xero yet, so its refund credit note waits for it`
      );
    }
    originalInvoiceId = receipt.invoiceId;
  } else {
    // A note for the payment as a whole: a kept capture's own invoice first,
    // since the payment's own may be the cleared pre-cancel one. The note is
    // unallocated either way (it settles by its own refund payment), so the id
    // records which document it answers.
    originalInvoiceId =
      (await findKeptLateCaptureInvoiceIdForPayment(paymentId)) ?? payment.xeroInvoiceId;
  }
  if (!originalInvoiceId) {
    throw new Error(`No Xero invoice linked to payment: ${paymentId}`);
  }
  const refundRequestId = options?.refundRequestId ?? null;
  const watermarkCents = options?.watermarkCents;
  // #3827 (D-3813-8): a refund request's own note is never per-delta.
  const isDeltaMode =
    refundRequestId === null &&
    typeof watermarkCents === "number" && Number.isFinite(watermarkCents);
  const { refundMethod, refundMethodRecorded } = resolveRefundNoteMethod(
    options?.refundMethod,
    payment.source,
  );
  // The credit note's own date decides which GST period and financial year the
  // refund lands in, so it is the club's calendar day (INV-DATE-019, #2834).
  // #3635 round-3 R3: a late capture's refund noted after the fact is dated the
  // day it left Stripe, so it lands in the period the payout does.
  const resolveCreditNoteDate = async () =>
    options?.documentDate ??
    xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  // #3548 (`INV-PAY-111`): this row's OWN recorded note, before any coverage
  // read or mint. A row that already raised a note and recorded no outcome
  // for it is finished on that note, never a second one.
  if (queuedOperationId) {
    const own = await prisma.xeroSyncOperation.findUnique({
      where: { id: queuedOperationId },
      select: { xeroObjectId: true, correlationKey: true, idempotencyKey: true },
    });
    if (
      own?.xeroObjectId &&
      (await refundNoteSettlementInterrupted(paymentId, own.xeroObjectId, {
        ignoreOperationId: queuedOperationId,
      }))
    ) {
      try {
        await finishRefundCreditNoteSettlement({
          operationId: queuedOperationId,
          paymentId,
          creditNoteId: own.xeroObjectId,
          creationKeys: [own.correlationKey, own.idempotencyKey],
          originalInvoiceId,
          refundMethod,
          refundMethodRecorded,
          fallbackPaymentDate: resolveCreditNoteDate,
          refundRequestId,
        });
      } catch (error) {
        await failXeroSyncOperation(queuedOperationId, error);
        throw error;
      }
      return own.xeroObjectId;
    }
  }

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

    // #3635 (`INV-INT-025`): the same coverage the enqueue capped against -
    // links plus the notes an officer raised by hand in Xero - so a note
    // resolved after this one was queued is not credited a second time here.
    const resolvedCoverage = await readResolvedRefundCreditNoteCoverage(paymentId);
    if (resolvedCoverage.unreadableOperationIds.length > 0) {
      throw new Error(
        `Refusing to create a Xero refund credit note for payment ${paymentId}: a note resolved by hand in Xero on this payment has no readable amount (#3635). Raise this refund's credit note in Xero by hand.`
      );
    }
    const coveredCents = await sumRefundCreditNoteCoverageCents(paymentId, resolvedCoverage);
    // #3635 round-3 R1: the cash a note may answer, the figure the enqueue
    // capped against, never refunds of late captures Xero never received.
    const { evidence, eligibleCashCents } = await resolveRefundNoteEligibleCash({
      id: payment.id,
      bookingId: payment.bookingId,
      refundedAmountCents: payment.refundedAmountCents,
    });
    const uncoveredCents = Math.max(
      0,
      eligibleCashCents - coveredCents
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
  } else if (refundRequestId !== null) {
    // #3827 (D-3813-8): THIS request's own note, and only it, covers this
    // request. Another request's note, or the payment's one refund note,
    // never does - that absorption is what the decision removed.
    const ownNote = (
      (await prisma.xeroObjectLink.findMany({
        where: {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          role: REFUND_REQUEST_CREDIT_NOTE_ROLE,
          active: true,
        },
        select: { xeroObjectId: true, xeroObjectNumber: true, metadata: true },
      })) ?? []
    ).find((link) => readRefundRequestIdFromPayload(link.metadata) === refundRequestId);
    existingCreditNoteId = ownNote?.xeroObjectId ?? null;
    existingCreditNoteNumber = ownNote?.xeroObjectNumber ?? null;
  } else {
    const canonicalRefundCreditNote =
      await findCanonicalPaymentRefundCreditNote(paymentId);
    existingCreditNoteId =
      payment.xeroRefundCreditNoteId ?? canonicalRefundCreditNote?.xeroObjectId ?? null;
    existingCreditNoteNumber =
      canonicalRefundCreditNote?.xeroObjectNumber ?? null;
  }
  const noteLinkRole = refundRequestId !== null ? REFUND_REQUEST_CREDIT_NOTE_ROLE : "REFUND_CREDIT_NOTE";

  const creditNoteIdempotencyKey = refundRequestId !== null
    ? refundRequestCreditNoteKey(paymentId, refundRequestId)
    : isDeltaMode
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
  // #3635 round-3 R4/R3: which capture this note answers, and its date, ride
  // in the recorded payload and the link so a retry keeps both and the
  // capture's notes can be counted.
  const lateCaptureFields = {
    ...(options?.paymentIntentId ? { paymentIntentId: options.paymentIntentId } : {}),
    ...(options?.documentDate ? { documentDate: options.documentDate } : {}),
    // #3827 (D-3813-8): rides at the top level of the executed payload too, so
    // a retry or a repair of this row keeps it a request's own note.
    ...(refundRequestId !== null ? { refundRequestId } : {}),
  };

  // Idempotency guard: skip if a credit note already covers this payment/delta.
  // This row raised nothing, so it is closed as covered by that note, which
  // carries its own payment outcome (`INV-PAY-111`).
  if (existingCreditNoteId) {
    if (refundRequestId === null && payment.xeroRefundCreditNoteId !== existingCreditNoteId) {
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
      role: noteLinkRole,
    });
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId,
          coveredByExistingNote: true,
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
            role: noteLinkRole,
          },
        ],
      });
    }
    logger.info({ paymentId, creditNoteId: existingCreditNoteId }, "Xero credit note already exists, skipping");
    return existingCreditNoteId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  /*
    Ensure the INVOICED PARTY has a Xero contact (#3368; the obligation this
    stage inherited from #3367 in writing on 13 September 2026).

    Stage 2 made the Organisation the invoiced party in the INVOICE builder
    only. A credit note on a returning school's EARLIER booking still resolved
    through `booking.memberId`, found no contact link on that invented school
    member, searched Xero by EMAIL — the school's address sits on both records
    — and was refused by stage 2's two-homes rule. That refusal is the window
    the issue comment names, and this line is what closes it.

    Where no organisation is linked this is today's behaviour to the letter:
    the same member id, the same options object, the same function underneath.
  */
  const contactId = await findOrCreateXeroContactForInvoicedParty(
    payment.booking,
    options,
  );
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";
  const refundLineItem: LineItem = {
    description: buildRefundDocumentDescription({
      method: refundMethod,
      bookingId: payment.booking.id,
      stay: {
        checkIn: formatDateOnly(new Date(payment.booking.checkIn)),
        checkOut: formatDateOnly(new Date(payment.booking.checkOut)),
      },
    }),
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

  // The stay dates above are `@db.Date` lodge nights, left on truncation —
  // INV-DATE-019's first boundary with INV-DATE-026, not INV-DATE-010 (#3080).
  // Read once, outside the closure: it runs per payload and per repair attempt.
  const creditNoteDate = await resolveCreditNoteDate();

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: creditNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [refundLineItem],
    reference: buildRefundDocumentReference({
      method: refundMethod,
      bookingId: payment.booking.id,
    }),
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  let operationId = queuedOperationId;
  // `refundMethod` rides in the recorded payload so a retry or a repair of
  // this row settles against the same account and says the same thing.
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    allocation: {
      invoiceId: originalInvoiceId,
      amount: effectiveRefundAmountCents / 100,
    },
    refundMethod,
    ...lateCaptureFields,
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
      memberId: bookingOwner(payment.booking).memberId,
      currentContactId: contactId,
      // `INV-INT-019`: THE REPAIR ENTITY MATCHES THE INVOICED PARTY (#3368).
      // The default repair resolves through `findOrCreateXeroContact`, which
      // searches Xero by EMAIL first, so on a school's booking it would find
      // the teacher's personal contact and re-issue the SCHOOL's credit note
      // against a person — the #2912 prohibition through the back door.
      repairContactLink: invoicedPartyContactRepair(payment.booking),
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
        refundMethod,
        ...lateCaptureFields,
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

    // #3548 (`INV-PAY-111`): record the note the moment Xero returns it (its
    // id on the payment, its covering link, and its id on this row) in ONE
    // transaction. A process that dies after this is retried on this note:
    // coverage counts it (no per-delta re-mint), and the row names it (the
    // retry leg finishes it, `finishRefundCreditNoteSettlement`).
    const noteLinkMetadata = {
      amountCents: effectiveRefundAmountCents,
      watermarkCents:
        effectiveWatermarkCents ??
        options?.watermarkCents ??
        effectiveRefundAmountCents,
      ...(options?.paymentIntentId ? { paymentIntentId: options.paymentIntentId } : {}),
      ...(refundRequestId !== null ? { refundRequestId } : {}),
    };
    const createdNoteId = createdNote.creditNoteID;
    const createdNoteNumber = createdNote.creditNoteNumber ?? null;
    await prisma.$transaction(async (tx) => {
      // #3827 (D-3813-8): a request's own note never takes the pointer.
      if (refundRequestId === null) {
        await tx.payment.update({
          where: { id: paymentId },
          data: { xeroRefundCreditNoteId: createdNoteId },
        });
      }
      await upsertXeroObjectLink(
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNoteId,
          xeroObjectNumber: createdNoteNumber,
          role: noteLinkRole,
          metadata: noteLinkMetadata,
        },
        { store: tx }
      );
      await tx.xeroSyncOperation.update({
        where: { id: operationId! },
        data: {
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNoteId,
          xeroObjectNumber: createdNoteNumber,
        },
      });
    });

    // The first attempt's settlement and completion, shared with the retry
    // that finishes an interrupted attempt (#3548): one path, one payload.
    const outcome = await settleRefundCreditNote({
      xero,
      tenantId,
      paymentId,
      creditNoteId: createdNote.creditNoteID,
      amountCents: effectiveRefundAmountCents,
      refundMethod,
      refundMethodRecorded,
      paymentDate: creditNoteDate,
    });

    await completeXeroSyncOperation(
      operationId!,
      refundCreditNoteCompletion({
        paymentId,
        creditNoteBody: response.body,
        creditNoteId: createdNote.creditNoteID,
        creditNoteNumber: createdNote.creditNoteNumber ?? null,
        noteLinkMetadata,
        originalInvoiceId,
        refundMethod,
        outcome,
        refundRequestId,
      })
    );

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
          cancellationCreditDescription(params.bookingId),
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
  /** The club's format (#3565); see `createXeroCreditNoteForModification`. */
  format: ClubFormat,
  options?: CreateXeroUnappliedCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        include: { member: true, organisation: { select: { name: true, email: true } } },
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
    // #3369: these stamp the Xero note onto the MEMBER CREDIT the refund
    // created, and an organisation-owned booking has no member credit to
    // stamp — credit belongs to a person's account, and this programme does
    // not invent an organisation ledger. The note itself is created either
    // way; only the local link is member-scoped.
    const creditMemberId = bookingOwner(payment.booking).memberId;
    if (creditMemberId && bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: creditMemberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: existingLink.xeroObjectId,
      });
    } else if (creditMemberId) {
      await backfillCancellationCreditXeroNote({
        memberId: creditMemberId,
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
  // The invoiced party, for the reason spelled out in `createXeroCreditNote`
  // above (#3368/#3367). An account-credit note is raised against the same
  // customer the original invoice was.
  const contactId = await findOrCreateXeroContactForInvoicedParty(
    payment.booking,
    options,
  );
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  // #3530 (`INV-MOD-058`): a modification's note carries the edit's stored
  // lines, inverted, when they explain exactly what it credits; otherwise the
  // single line below as before, the reason recorded on the operation. A
  // cancellation's note has no edit behind it and is never itemised.
  const itemised = bookingModificationId
    ? await resolveModificationDocumentLineItems({
        bookingId: payment.booking.id,
        bookingModificationId,
        document: "MODIFICATION_CREDIT_NOTE",
        billedCents: refundAmountCents,
      }, format)
    : null;

  // Account credit by construction (`INV-PAY-101`): this note is left
  // unapplied on the contact, so its method is not a caller's choice.
  const creditLineItem: LineItem = {
    description: buildRefundDocumentDescription({
      method: "account-credit",
      bookingId: payment.booking.id,
      modificationId: bookingModificationId ?? null,
      stay: {
        checkIn: formatDateOnly(new Date(payment.booking.checkIn)),
        checkOut: formatDateOnly(new Date(payment.booking.checkOut)),
      },
    }),
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
    lineItems: itemised?.lineItems ?? [creditLineItem],
    reference: buildRefundDocumentReference({
      method: "account-credit",
      bookingId: payment.booking.id,
    }),
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
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    ...(itemised ? { priceLines: itemised.record } : {}),
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
      memberId: bookingOwner(payment.booking).memberId,
      currentContactId: contactId,
      // The invoiced party, as above (#3368, `INV-INT-019`).
      repairContactLink: invoicedPartyContactRepair(payment.booking),
      workflow: "createUnappliedXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        ...(itemised ? { priceLines: itemised.record } : {}),
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

    // #3369: these stamp the Xero note onto the MEMBER CREDIT the refund
    // created, and an organisation-owned booking has no member credit to
    // stamp — credit belongs to a person's account, and this programme does
    // not invent an organisation ledger. The note itself is created either
    // way; only the local link is member-scoped.
    const creditMemberId = bookingOwner(payment.booking).memberId;
    if (creditMemberId && bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: creditMemberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: createdNote.creditNoteID,
      });
    } else if (creditMemberId) {
      await backfillCancellationCreditXeroNote({
        memberId: creditMemberId,
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
  /**
   * The club's format (#3565), for any amount a line description renders (a
   * promotion delta reads "reduced by $20.00" on the Xero line). Resolved once
   * by the job or request that raised this document, never here.
   */
  format: ClubFormat;
}): Promise<string> {
  return createUnappliedXeroCreditNote(
    params.paymentId,
    params.refundAmountCents,
    params.format,
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
