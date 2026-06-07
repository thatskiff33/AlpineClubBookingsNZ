/**
 * Booking-invoice create / update against Xero.
 *
 * Owns `buildInvoiceLineItems`, `createXeroInvoiceForBooking`, and
 * `updateXeroBookingInvoiceForBooking`. The create path also records the
 * matching Xero payment when the Stripe charge succeeded with a
 * non-zero amount.
 */

import {
  Invoice,
  Invoices,
  LineItem,
  LineAmountTypes,
  Payment as XeroPayment,
  RequestEmpty,
} from "xero-node";
import { PaymentSource, PaymentTransactionKind } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { getStayNights } from "./pricing";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  getAccountMapping,
  getHutFeeItemCodeMap,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import {
  formatDate,
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "./xero-invoice-helpers";

export interface CreateXeroBookingInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface UpdateXeroBookingInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

// ---------------------------------------------------------------------------
// Line-item construction
// ---------------------------------------------------------------------------

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
 *
 * @param itemCodeMap - Per-guest item code lookup keyed by "${ageTier}_${seasonType}_${isMember}".
 *   When provided with a seasonType, each guest gets their own item code based on their
 *   age tier, membership status, and the booking's season type.
 * @param itemCode - Legacy single item code applied to all guests (used when itemCodeMap is empty).
 */
export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    priceCents: number;
  }>,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeMap?: Map<string, string>,
  seasonType?: string | null,
): LineItem[] {
  return guests.map((guest) => {
    const perNightCents = nights > 0 ? Math.round(guest.priceCents / nights) : guest.priceCents;
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
      `${nights} night${nights !== 1 ? "s" : ""}`,
      `${formatDate(checkIn)} - ${formatDate(checkOut)}`,
    ].join(" - ");

    const lineItem: LineItem = {
      description,
      quantity: nights,
      unitAmount: perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    };

    // Resolve item code: prefer per-guest granular mapping, fall back to legacy flat code
    const guestItemCode = (itemCodeMap && seasonType)
      ? (itemCodeMap.get(`${guest.ageTier}_${seasonType}_${guest.isMember}`) ?? null)
      : (itemCode ?? null);

    // If itemCode is set, Xero auto-fills the account from the Item's config.
    // If accountCode is also explicitly configured, it overrides the Item's default.
    if (guestItemCode) {
      lineItem.itemCode = guestItemCode;
    }
    // Include the account code when there is no item code, when a non-default account
    // is supplied, or when the admin explicitly configured the default account code to
    // override the selected Xero Item's own default.
    if (!guestItemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
      lineItem.accountCode = accountCode;
    }

    return lineItem;
  });
}

export async function createXeroInvoiceForBooking(
  bookingId: string,
  options?: CreateXeroBookingInvoiceOptions
): Promise<string> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  if (!booking.payment) throw new Error(`No payment record for booking: ${bookingId}`);

  // Skip if invoice already created
  if (booking.payment.xeroInvoiceId) {
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      xeroObjectId: booking.payment.xeroInvoiceId,
      xeroObjectNumber: booking.payment.xeroInvoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(booking.payment.xeroInvoiceId),
      role: "PRIMARY_INVOICE",
    });
    return booking.payment.xeroInvoiceId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(booking.memberId, options);

  // Resolve account codes, item codes, and season type
  const [hutFeeMapping, stripeBankCode, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getAccountMapping("stripeBankAccount"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";
  const bankCode = stripeBankCode ?? "606";

  // Calculate nights using the same logic as the pricing engine
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  // Determine season type from check-in date for item code mapping
  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
    },
    select: { type: true },
  });
  if (season) {
    bookingSeasonType = season.type;
  }

  // Build line items with per-guest item codes
  const lineItems = buildInvoiceLineItems(
    booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      priceCents: g.priceCents,
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
    bookingSeasonType,
  );

  // Add signed promo adjustment line if applicable. Negative values behave
  // like discounts; positive values are extra revenue.
  if (booking.promoAdjustmentCents !== 0) {
    const promo = booking.promoRedemption?.promoCode ?? null;
    const firstGuest = booking.guests[0];

    // Fall back to hut-fee item code for legacy / non-promo discounts.
    const fallbackItemCode = (hutFeeItemCodeMap.size > 0 && bookingSeasonType && firstGuest)
      ? (hutFeeItemCodeMap.get(`${firstGuest.ageTier}_${bookingSeasonType}_${firstGuest.isMember}`) ?? hutFeeMapping.itemCode)
      : hutFeeMapping.itemCode;

    const discountItemCode = promo?.xeroItemCode ?? fallbackItemCode;
    const discountAccountCode = promo?.xeroAccountCode ?? incomeCode;
    const accountExplicitlyConfigured =
      promo?.xeroAccountCode != null || hutFeeMapping.codeExplicitlyConfigured;

    const discountLineItem: LineItem = {
      description: promo ? `Promo adjustment - ${promo.code}` : "Promo adjustment",
      quantity: 1,
      unitAmount: booking.promoAdjustmentCents / 100,
      taxType: "OUTPUT2",
    };
    if (discountItemCode) {
      discountLineItem.itemCode = discountItemCode;
    }
    if (!discountItemCode || accountExplicitlyConfigured || discountAccountCode !== "200") {
      discountLineItem.accountCode = discountAccountCode;
    }
    lineItems.push(discountLineItem);
  }

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: getBookingInvoiceIssueDate(booking),
    dueDate: getBookingInvoiceDueDate(booking),
    reference: `Booking ${bookingId.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
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
      localModel: "Payment",
      localId: booking.payment.id,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForBooking",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
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
            workflow: "createXeroInvoiceForBooking",
            context: `createInvoices(booking ${bookingId})`,
          }
        ),
    });

    const createdInvoice = response.body.invoices?.[0];
    if (!createdInvoice?.invoiceID) {
      throw new Error("Failed to create Xero invoice");
    }

    // Record payment against the invoice in Xero when real funds moved.
    // Xero already marks zero-total invoices as PAID and rejects $0 payments.
    let paymentResponseBody: XeroPayment | null = null;
    let paymentWriteError: unknown = null;
    const paymentSkipped = booking.payment.status === "SUCCEEDED" && booking.payment.amountCents === 0;

    if (booking.payment.status === "SUCCEEDED" && booking.payment.amountCents > 0) {
      const payment: XeroPayment = {
        invoice: { invoiceID: createdInvoice.invoiceID },
        account: { code: bankCode },
        amount: booking.payment.amountCents / 100,
        date: formatDate(new Date()),
        reference: `Stripe ${booking.payment.stripePaymentIntentId ?? "payment"}`,
      };
      const paymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        booking.payment.id,
        "invoice-payment",
        "v1"
      );

      try {
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayment(
              tenantId,
              payment,
              paymentIdempotencyKey
            ),
          {
            operation: "createPayment",
            resourceType: "PAYMENT",
            workflow: "createXeroInvoiceForBooking",
            context: `createPayment(booking ${bookingId})`,
          }
        );
        paymentResponseBody = paymentResponse.body;
      } catch (error) {
        paymentWriteError = error;
        logger.warn(
          { err: error, bookingId, invoiceId: createdInvoice.invoiceID },
          "Created Xero invoice but failed to record the corresponding Xero payment"
        );
      }
    } else if (paymentSkipped) {
      logger.info(
        { bookingId, invoiceId: createdInvoice.invoiceID },
        "Skipping Xero payment recording for zero-total booking invoice"
      );
    }

    let invoiceEmailResponseBody: unknown = null;
    let invoiceEmailError: unknown = null;
    const shouldEmailInvoice =
      booking.payment.source === PaymentSource.INTERNET_BANKING;

    if (shouldEmailInvoice) {
      const invoiceEmailIdempotencyKey = buildXeroIdempotencyKey(
        "booking",
        bookingId,
        "invoice-email",
        createdInvoice.invoiceID,
        "v1"
      );

      try {
        const emailResponse = await callXeroApi(
          () =>
            xero.accountingApi.emailInvoice(
              tenantId,
              createdInvoice.invoiceID!,
              new RequestEmpty(),
              invoiceEmailIdempotencyKey
            ),
          {
            operation: "emailInvoice",
            resourceType: "INVOICE",
            workflow: "createXeroInvoiceForBooking",
            context: `emailInvoice(booking ${bookingId})`,
          }
        );
        invoiceEmailResponseBody = emailResponse.body ?? null;
      } catch (error) {
        invoiceEmailError = error;
        logger.warn(
          { err: error, bookingId, invoiceId: createdInvoice.invoiceID },
          "Created Xero invoice but failed to email it to the contact"
        );
      }
    }

    // Store the Xero invoice ID and number on the payment record
    await prisma.payment.update({
      where: { id: booking.payment.id },
      data: {
        xeroInvoiceId: createdInvoice.invoiceID,
        xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
      },
    });
    await prisma.paymentTransaction.updateMany({
      where: {
        paymentId: booking.payment.id,
        source: PaymentSource.INTERNET_BANKING,
        kind: PaymentTransactionKind.PRIMARY,
      },
      data: {
        xeroInvoiceId: createdInvoice.invoiceID,
        xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
      },
    });

    await completeXeroSyncOperation(operationId!, {
      status: paymentWriteError || invoiceEmailError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError: paymentWriteError,
        paymentSkipped,
        paymentSkipReason: paymentSkipped
          ? "Zero-total invoice does not require Xero payment recording."
          : null,
        invoiceEmail: invoiceEmailResponseBody,
        invoiceEmailError,
        invoiceEmailSkipped: !shouldEmailInvoice,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      extraLinks: [
        {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: createdInvoice.invoiceID,
          xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
          role: "PRIMARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: booking.payment.id,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "INVOICE_PAYMENT",
                metadata: {
                  invoiceId: createdInvoice.invoiceID,
                  amount: paymentResponseBody.amount ?? booking.payment.amountCents / 100,
                },
              },
            ]
          : []),
      ],
    });

    return createdInvoice.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}


function copyMutableLineItemFields(lineItem: LineItem): LineItem {
  const next: LineItem = {};

  if (lineItem.lineItemID) next.lineItemID = lineItem.lineItemID;
  if (lineItem.description) next.description = lineItem.description;
  if (typeof lineItem.quantity === "number") next.quantity = lineItem.quantity;
  if (typeof lineItem.unitAmount === "number") next.unitAmount = lineItem.unitAmount;
  if (lineItem.itemCode) next.itemCode = lineItem.itemCode;
  if (lineItem.accountCode) next.accountCode = lineItem.accountCode;
  if (lineItem.taxType) next.taxType = lineItem.taxType;
  if (typeof lineItem.taxAmount === "number") next.taxAmount = lineItem.taxAmount;
  if (typeof lineItem.lineAmount === "number") next.lineAmount = lineItem.lineAmount;
  if (lineItem.tracking) next.tracking = lineItem.tracking;
  if (typeof lineItem.discountRate === "number") next.discountRate = lineItem.discountRate;
  if (typeof lineItem.discountAmount === "number") next.discountAmount = lineItem.discountAmount;

  return next;
}

function mergeBookingInvoiceLineItemDescriptions(
  existingLineItems: LineItem[],
  desiredGuestLineItems: LineItem[],
  checkIn: Date,
  checkOut: Date,
  nights: number
): LineItem[] {
  const stayNarration = `${nights} night${nights !== 1 ? "s" : ""} - ${formatDate(checkIn)} - ${formatDate(checkOut)}`;
  let guestLineIndex = 0;

  return existingLineItems.map((existingLineItem) => {
    const nextLineItem = copyMutableLineItemFields(existingLineItem);
    const description = existingLineItem.description ?? "";

    const normalizedDescription = description.trim().toLowerCase();
    if (
      normalizedDescription === "discount" ||
      normalizedDescription.startsWith("discount -") ||
      normalizedDescription === "promo adjustment" ||
      normalizedDescription.startsWith("promo adjustment -")
    ) {
      return nextLineItem;
    }

    const desiredLineItem = desiredGuestLineItems[guestLineIndex];
    guestLineIndex += 1;

    if (desiredLineItem?.description) {
      nextLineItem.description = desiredLineItem.description;
      return nextLineItem;
    }

    const dateSuffixPattern = / - \d+ nights? - \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}$/;
    if (description && dateSuffixPattern.test(description)) {
      nextLineItem.description = description.replace(dateSuffixPattern, ` - ${stayNarration}`);
    }

    return nextLineItem;
  });
}

function readXeroAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getPrimaryInvoiceUpdateSkipReason(invoice: Invoice): string | null {
  const amountPaid = readXeroAmount(invoice.amountPaid);
  const amountCredited = readXeroAmount(invoice.amountCredited);
  const status = String(invoice.status ?? "").toUpperCase();

  if (amountPaid > 0 || status === "PAID" || invoice.fullyPaidOnDate) {
    return "Skipped primary Xero invoice update because the invoice has payment applied.";
  }

  if (amountCredited > 0) {
    return "Skipped primary Xero invoice update because the invoice has credit applied.";
  }

  if (status === "VOIDED" || status === "DELETED") {
    return `Skipped primary Xero invoice update because the invoice status is ${status}.`;
  }

  return null;
}


export async function updateXeroBookingInvoiceForBooking(
  bookingId: string,
  options?: UpdateXeroBookingInvoiceOptions
): Promise<string | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
    },
  });

  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  if (!booking.payment) throw new Error(`No payment record for booking: ${bookingId}`);

  const invoiceId = booking.payment.xeroInvoiceId;
  if (!invoiceId) {
    if (options?.syncOperationId) {
      await completeXeroSyncOperation(options.syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
    },
    select: { type: true },
  });
  if (season) {
    bookingSeasonType = season.type;
  }

  const desiredGuestLineItems = buildInvoiceLineItems(
    booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      priceCents: g.priceCents,
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
    bookingSeasonType,
  );

  const invoiceUpdateIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    invoiceId,
    formatDate(checkIn),
    formatDate(checkOut),
    "v1"
  );

  let operationId = options?.syncOperationId ?? null;
  if (!operationId) {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: booking.payment.id,
      idempotencyKey: invoiceUpdateIdempotencyKey,
      correlationKey: invoiceUpdateIdempotencyKey,
      requestPayload: {
        bookingId,
        invoiceId,
      },
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const currentInvoiceResponse = await callXeroApi(
      () => xero.accountingApi.getInvoice(tenantId, invoiceId),
      {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "updateXeroBookingInvoiceForBooking",
        context: `getInvoice(booking ${bookingId})`,
      }
    );
    const currentInvoice = currentInvoiceResponse.body.invoices?.[0];
    if (!currentInvoice) {
      throw new Error(`Xero invoice not found: ${invoiceId}`);
    }
    if (!currentInvoice.contact) {
      throw new Error(`Xero invoice ${invoiceId} is missing its contact.`);
    }

    const skipReason = getPrimaryInvoiceUpdateSkipReason(currentInvoice);
    if (skipReason) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: skipReason,
          previousInvoice: currentInvoiceResponse.body,
          bookingId,
          invoiceId,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: invoiceId,
        xeroObjectNumber: currentInvoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
        extraLinks: [
          {
            localModel: "Payment",
            localId: booking.payment.id,
            xeroObjectType: "INVOICE",
            xeroObjectId: invoiceId,
            xeroObjectNumber: currentInvoice.invoiceNumber ?? null,
            xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
            role: "PRIMARY_INVOICE",
          },
        ],
      });

      return invoiceId;
    }

    const currentLineItems = currentInvoice.lineItems ?? [];
    if (currentLineItems.length === 0) {
      throw new Error(`Xero invoice ${invoiceId} has no line items to update safely.`);
    }

    const updatedInvoice: Invoice = {
      type: currentInvoice.type ?? Invoice.TypeEnum.ACCREC,
      contact: currentInvoice.contact,
      lineItems: mergeBookingInvoiceLineItemDescriptions(
        currentLineItems,
        desiredGuestLineItems,
        checkIn,
        checkOut,
        nights
      ),
      date: getBookingInvoiceIssueDate(booking),
      dueDate: getBookingInvoiceDueDate(booking),
      reference: currentInvoice.reference ?? `Booking ${bookingId.slice(0, 8)}`,
      invoiceNumber: currentInvoice.invoiceNumber,
      lineAmountTypes: currentInvoice.lineAmountTypes ?? LineAmountTypes.Inclusive,
    };
    const requestPayload: Invoices = { invoices: [updatedInvoice] };

    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson({
          ...requestPayload,
          bookingId,
          invoiceId,
        }),
      },
    });

    const response = await callXeroApi(
      () =>
        xero.accountingApi.updateInvoice(
          tenantId,
          invoiceId,
          requestPayload,
          undefined,
          invoiceUpdateIdempotencyKey
        ),
      {
        operation: "updateInvoice",
        resourceType: "INVOICE",
        workflow: "updateXeroBookingInvoiceForBooking",
        context: `updateInvoice(booking ${bookingId})`,
      }
    );

    const updated = response.body.invoices?.[0];
    await completeXeroSyncOperation(operationId, {
      responsePayload: {
        previousInvoice: currentInvoiceResponse.body,
        invoice: response.body,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: updated?.invoiceID ?? invoiceId,
      xeroObjectNumber: updated?.invoiceNumber ?? currentInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(updated?.invoiceID ?? invoiceId),
      extraLinks: [
        {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: updated?.invoiceID ?? invoiceId,
          xeroObjectNumber: updated?.invoiceNumber ?? currentInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(updated?.invoiceID ?? invoiceId),
          role: "PRIMARY_INVOICE",
        },
      ],
    });

    return updated?.invoiceID ?? invoiceId;
  } catch (error) {
    await failXeroSyncOperation(operationId, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Credit note on refund
// ---------------------------------------------------------------------------

/**
 * Create a Xero credit note when a booking refund is processed.
 *
 * @param paymentId - The Payment record ID (not Stripe payment intent ID)
 * @param refundAmountCents - The refund amount in cents
 * @returns The Xero credit note ID
 */
