/**
 * Supplementary Xero invoices for positive booking modifications.
 *
 * When a booking modification increases the total (extra guests, longer
 * stay, switch to a higher rate), `createXeroSupplementaryInvoice`
 * creates a small invoice for the delta and records the matching Stripe
 * payment if one has already settled.
 */

import {
  Invoice,
  LineItem,
  LineAmountTypes,
  Payment as XeroPayment,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
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
} from "./xero-contacts";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  xeroDocumentDateForClubToday,
  xeroDocumentDateFromInstant,
} from "@/lib/xero-provider-dates";

export async function createXeroSupplementaryInvoice(params: {
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  recordPayment?: boolean;
  repairExistingLink?: boolean;
  syncOperationId?: string;
}): Promise<string | null> {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
    createdByMemberId,
    recordPayment = true,
    repairExistingLink,
    syncOperationId,
  } = params;

  // A supplementary invoice is always for a specific booking MODIFICATION, so it
  // must carry a distinct bookingModificationId. Without one the Xero idempotency
  // key would fall back to bookingId and two same-amount deltas on one booking
  // would share a key, letting Xero dedup the second createInvoices call and
  // under-invoice. Both callers always pass it; throwing surfaces any misuse
  // instead of silently collapsing the key (invariant (c), #1234).
  if (!bookingModificationId) {
    throw new Error(
      "Supplementary invoice requires a bookingModificationId for a distinct Xero idempotency key"
    );
  }

  // A supplementary invoice only exists to bill a positive NET (#1356): the
  // components are signed (a mixed-sign edit carries its price reduction as a
  // negative line), and Xero rejects a negative-total ACCREC invoice. A
  // non-positive net belongs to the credit-note paths, so complete the
  // operation as skipped rather than billing a gross fee the member never paid.
  const netAmountCents = priceDiffCents + changeFeeCents;
  if (netAmountCents <= 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason:
            "Supplementary invoice net amount is not positive; a reduction settles via a modification credit note instead.",
        },
      });
    }
    return null;
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    createdByMemberId,
    repairExistingLink,
  });
  const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
  const incomeCode = incomeMapping.code ?? "200";
  // A negative price adjustment is a give-back, so it posts to the
  // hutFeeRefunds mapping like the standalone-reduction credit-note path
  // (owner decision on #1356): clubs that prefer a single account map
  // hutFeeRefunds to the same code as hutFeesIncome in the Xero mapping.
  const refundMapping =
    priceDiffCents < 0 ? await getResolvedAccountMapping("hutFeeRefunds") : null;

  const lineItems: LineItem[] = [];

  // The price-adjustment line is SIGNED (#1356): a mixed-sign edit emits a
  // negative price line next to the positive fee line so the line items sum
  // exactly to the net charge by construction (the #1163 exact-total rule).
  if (priceDiffCents !== 0) {
    const lineMapping = refundMapping ?? incomeMapping;
    const lineCode = lineMapping.code ?? "200";
    const li: LineItem = {
      description: `Booking modification - price adjustment (Booking ${bookingId.slice(0, 8)})`,
      quantity: 1,
      unitAmount: priceDiffCents / 100,
      taxType: "OUTPUT2",
    };
    if (lineMapping.itemCode) li.itemCode = lineMapping.itemCode;
    if (!lineMapping.itemCode || lineCode !== "200" || lineMapping.codeExplicitlyConfigured) {
      li.accountCode = lineCode;
    }
    lineItems.push(li);
  }

  if (changeFeeCents > 0) {
    const li: LineItem = {
      description: "Late notice booking change fee",
      quantity: 1,
      unitAmount: changeFeeCents / 100,
      taxType: "OUTPUT2",
    };
    if (incomeMapping.itemCode) li.itemCode = incomeMapping.itemCode;
    if (!incomeMapping.itemCode || incomeCode !== "200" || incomeMapping.codeExplicitlyConfigured) {
      li.accountCode = incomeCode;
    }
    lineItems.push(li);
  }

  const bookingModification = await prisma.bookingModification.findUnique({
    where: { id: bookingModificationId },
    select: { createdAt: true },
  });
  // Both halves of this are real instants — `BookingModification.createdAt` is a
  // `DateTime @default(now())`, and the fallback is the clock itself — so both
  // land on the previous UTC day for roughly the first half of every New Zealand
  // day. The club's calendar is the only correct one here (INV-DATE-019, #2834).
  const supplementaryInvoiceDueDate = xeroDocumentDateFromInstant(
    bookingModification?.createdAt ?? new Date(),
    await readClubTimeZoneOutsideRequest(),
  );
  // Read the club day ONCE. `buildInvoice` is called for the recorded
  // `requestPayload` and again for each contact-repair attempt, so a per-call
  // clock read could record one date and send another across midnight.
  const supplementaryInvoiceIssueDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: supplementaryInvoiceIssueDate,
    dueDate: supplementaryInvoiceDueDate,
    reference: `Supplementary for booking ${bookingId.slice(0, 8)}${booking.payment?.xeroInvoiceId ? ` (original: ${booking.payment.xeroInvoiceId})` : ""}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const localModel = "BookingModification";
  const localId = bookingModificationId;
  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "booking-mod",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

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
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroSupplementaryInvoice",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createInvoices(
              tenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              invoiceIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroSupplementaryInvoice",
            context: `createInvoices(supplementary ${localId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create supplementary Xero invoice");
    }

    let paymentResponseBody: XeroPayment | null = null;
    let paymentError: unknown = null;
    const paymentSkipped = !recordPayment;
    const paymentSkipReason = paymentSkipped
      ? "Supplementary invoice payment recording is deferred until an additional Stripe payment succeeds or an admin records payment."
      : null;

    if (recordPayment) {
      try {
        const stripeBankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
        // The recorded payment is the NET — exactly what the additional
        // Stripe PaymentIntent captured (#1356). Recording anything larger
        // than the capture overstates the Stripe clearing account.
        const paymentIdempotencyKey = buildXeroIdempotencyKey(
          "booking-mod",
          localId,
          "supplementary-payment",
          netAmountCents,
          "v1"
        );
        // Bank-reconciliation input: the club's calendar day, not the UTC one
        // (INV-DATE-019, #2834). Read ONCE, outside the closure, for the same
        // reason as the issue date above — `callXeroApi` re-invokes this
        // callback on every retry attempt, so a read inside it could send a
        // different date on a retry that crossed club midnight.
        const supplementaryPaymentDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayments(
              tenantId,
              {
                payments: [{
                  invoice: { invoiceID: created.invoiceID },
                  account: { code: stripeBankCode },
                  amount: netAmountCents / 100,
                  date: supplementaryPaymentDate,
                  reference: `Stripe payment for booking modification ${bookingId.slice(0, 8)}`,
                }],
              },
              undefined,
              paymentIdempotencyKey
            ),
          {
            operation: "createPayments",
            resourceType: "PAYMENT",
            workflow: "createXeroSupplementaryInvoice",
            context: `createPayments(supplementary ${localId})`,
          }
        );
        paymentResponseBody = paymentResponse.body.payments?.[0] ?? null;
      } catch (error) {
        paymentError = error;
        // Non-fatal: invoice exists, payment recording is for reconciliation convenience
        logger.warn({ err: error, invoiceId: created.invoiceID }, "Failed to record Xero payment for supplementary invoice");
      }
    } else {
      logger.info(
        { bookingId, invoiceId: created.invoiceID },
        "Skipping Xero payment recording for supplementary invoice"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError,
        paymentSkipped,
        paymentSkipReason,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel,
          localId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "SUPPLEMENTARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel,
                localId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "SUPPLEMENTARY_INVOICE_PAYMENT",
                metadata: {
                  invoiceId: created.invoiceID,
                  amountCents: netAmountCents,
                },
              },
            ]
          : []),
      ],
    });

    return created.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

/**
 * Create a Xero credit note when a booking modification decreases the price.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
