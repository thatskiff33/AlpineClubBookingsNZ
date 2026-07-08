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
interface NightPriceRun {
  startDate: Date;
  endExclusive: Date;
  nightCount: number;
  totalCents: number;
  perNightCents: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Split a guest's included nights into maximal blocks of consecutive nights
 * that share the same nightly price (issue #713 date-contiguity + issue #1163
 * price-homogeneity). Each block becomes one Xero line item, so:
 *   - a non-contiguous stay reads as e.g. two lines
 *     "2 nights — 6 Jun – 8 Jun" and "2 nights — 13 Jun – 15 Jun", and
 *   - a stay crossing a price boundary (season change, or locked vs re-priced
 *     nights) splits at that boundary instead of averaging the rate.
 * Every returned run satisfies `perNightCents * nightCount === totalCents`, so a
 * line `{ quantity: nightCount, unitAmount: perNightCents / 100 }` reconciles to
 * the exact cent total by construction — no `round(total/n) * n` drift (#1163).
 * A fully contiguous, uniformly-priced guest still yields exactly one run, so
 * existing invoices are unchanged.
 */
function splitNightsIntoPriceRuns(
  nights: Array<{ stayDate: Date; priceCents: number }>
): NightPriceRun[] {
  const sorted = [...nights].sort(
    (a, b) => a.stayDate.getTime() - b.stayDate.getTime()
  );
  const runs: NightPriceRun[] = [];
  for (const night of sorted) {
    const last = runs[runs.length - 1];
    const contiguous =
      last !== undefined &&
      formatDate(new Date(last.endExclusive)) === formatDate(night.stayDate);
    // Extend the current run only when the date is contiguous AND the nightly
    // price is unchanged; otherwise open a new run. This keeps every run a
    // single price over a whole number of nights.
    if (last && contiguous && last.perNightCents === night.priceCents) {
      last.endExclusive = new Date(night.stayDate.getTime() + ONE_DAY_MS);
      last.nightCount += 1;
      last.totalCents += night.priceCents;
    } else {
      runs.push({
        startDate: night.stayDate,
        endExclusive: new Date(night.stayDate.getTime() + ONE_DAY_MS),
        nightCount: 1,
        totalCents: night.priceCents,
        perNightCents: night.priceCents,
      });
    }
  }
  return runs;
}

/**
 * Split an integer cent total evenly across `count` nights using the
 * largest-remainder method: the first `remainder` nights carry one extra cent.
 * The returned vector always sums to `totalCents` exactly (no floating-point
 * cent accumulation). Callers must guarantee `count > 0`.
 */
function evenlySplitCents(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i < remainder ? base + 1 : base));
}

export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    priceCents: number;
    // Per-night rows (issue #713). When present, line items are emitted per
    // contiguous run; otherwise the guest is billed as one line over the whole
    // booking range, the pre-#713 behaviour.
    nights?: Array<{ stayDate: Date; priceCents: number }> | null;
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
  const applyCodes = (lineItem: LineItem, guest: { ageTier: string; isMember: boolean }) => {
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
  };

  const runToLineItem = (
    run: NightPriceRun,
    guest: { firstName: string; lastName: string; ageTier: string; isMember: boolean }
  ): LineItem => {
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
      `${run.nightCount} night${run.nightCount !== 1 ? "s" : ""}`,
      `${formatDate(run.startDate)} - ${formatDate(run.endExclusive)}`,
    ].join(" - ");
    // perNightCents * nightCount === totalCents by construction, so the line
    // reconciles to the exact cent total (#1163).
    return applyCodes({
      description,
      quantity: run.nightCount,
      unitAmount: run.perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    }, guest);
  };

  return guests.flatMap((guest) => {
    const guestNights = guest.nights ?? [];

    // No per-night detail: bill the whole booking range (legacy path). Split
    // the flat total into an exact per-night cent vector and run it through the
    // same price-run splitter, so the emitted lines reconcile to guest.priceCents
    // by construction (#1163). With no remainder this collapses to one line,
    // byte-identical to the pre-#1163 behaviour.
    if (guestNights.length === 0) {
      if (nights <= 0) {
        // Degenerate range: keep the single legacy line (quantity 0) rather
        // than dividing by zero in the even split.
        const description = [
          `${guest.firstName} ${guest.lastName}`,
          `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
          `${nights} night${nights !== 1 ? "s" : ""}`,
          `${formatDate(checkIn)} - ${formatDate(checkOut)}`,
        ].join(" - ");
        return [applyCodes({
          description,
          quantity: nights,
          unitAmount: guest.priceCents / 100, // Xero uses dollars, not cents
          taxType: "OUTPUT2", // GST on Income (NZ)
        }, guest)];
      }
      const syntheticNights = evenlySplitCents(guest.priceCents, nights).map(
        (priceCents, i) => ({
          stayDate: new Date(checkIn.getTime() + i * ONE_DAY_MS),
          priceCents,
        })
      );
      return splitNightsIntoPriceRuns(syntheticNights).map((run) =>
        runToLineItem(run, guest)
      );
    }

    // One line item per price-homogeneous contiguous run of nights.
    return splitNightsIntoPriceRuns(guestNights).map((run) =>
      runToLineItem(run, guest)
    );
  });
}

/**
 * #1641 — after a CARD booking's invoice is raised with its effective Stripe
 * payment, allocate the member's applied account credit against the invoice so it
 * reaches PAID via (effective cash + credit-note allocation) rather than being left
 * with the applied slice outstanding. Reuses the #1620 allocate-existing engine.
 *
 * Card-gated for three reasons: (1) Internet-Banking invoices allocate via their own
 * fire-after outbox op (#1620) — running it here would double-drive them; (2) a card
 * invoice is only raised after capture (payment SUCCEEDED); (3) a legacy full-price
 * capture carries `creditAppliedCents = 0` (its mirror was never credit-reduced) and
 * must NOT allocate — its invoice is settled in full by real cash and its historical
 * double-pay is repaired by a LOCAL credit restore, not a Xero note (which cannot
 * refund cash already sent). Dynamic import avoids a load-order cycle (mirrors
 * xero-operation-retry's engine import).
 *
 * THROWS on allocation failure so the caller fails the invoice sync op and the retry
 * re-drives the idempotent engine — the invoice is never re-created (the
 * `xeroInvoiceId` short-circuit at the top of createXeroInvoiceForBooking), and the
 * credit-note allocation is idempotent per join-row — rather than silently leaving
 * the applied credit unallocated (the exact defect this closes).
 */
async function settleCardAppliedCreditAllocation(
  payment: { source: PaymentSource; status: string; creditAppliedCents: number },
  bookingId: string,
  createdByMemberId?: string
): Promise<void> {
  // Proceed ONLY for a card cash capture that recorded a credit-reduced mirror
  // (`creditAppliedCents > 0`). The positive test also skips on 0 / a missing
  // mirror (legacy full-price captures, no-credit bookings), which is required:
  // allocating against a full-price-paid invoice would over-allocate.
  if (
    payment.source === PaymentSource.INTERNET_BANKING ||
    payment.status !== "SUCCEEDED" ||
    !(payment.creditAppliedCents > 0)
  ) {
    return;
  }
  const { allocateAppliedCreditForBooking } = await import(
    "@/lib/xero-applied-credit-allocation"
  );
  await allocateAppliedCreditForBooking(bookingId, {
    ...(createdByMemberId ? { createdByMemberId } : {}),
  });
}

export async function createXeroInvoiceForBooking(
  bookingId: string,
  options?: CreateXeroBookingInvoiceOptions
): Promise<string> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // Per-night rows (issue #713) so non-contiguous stays produce one line
      // item per contiguous run.
      guests: { include: { nights: true } },
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
    // Retry-safe: a prior run that raised the invoice but failed before/at the
    // applied-credit allocation re-drives the idempotent engine here (#1641).
    await settleCardAppliedCreditAllocation(
      booking.payment,
      bookingId,
      options?.createdByMemberId
    );
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
      nights: (g.nights ?? []).map((n) => ({ stayDate: n.stayDate, priceCents: n.priceCents })),
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
    const paymentSource = booking.payment.source ?? PaymentSource.STRIPE;
    const shouldRecordStripeInvoicePayment =
      paymentSource === PaymentSource.STRIPE &&
      booking.payment.status === "SUCCEEDED" &&
      booking.payment.amountCents > 0;
    const paymentSkipped =
      booking.payment.status === "SUCCEEDED" && !shouldRecordStripeInvoicePayment;
    const paymentSkipReason =
      booking.payment.amountCents === 0
        ? "Zero-total invoice does not require Xero payment recording."
        : paymentSource === PaymentSource.INTERNET_BANKING
          ? "Internet Banking invoice payments are reconciled from Xero instead of recorded as Stripe bank payments."
          : null;

    if (shouldRecordStripeInvoicePayment) {
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
    } else if (paymentSkipped && paymentSkipReason) {
      logger.info(
        { bookingId, invoiceId: createdInvoice.invoiceID, paymentSource },
        paymentSkipReason
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

    // #1641 — allocate the member's applied credit against this just-raised card
    // invoice so it settles to PAID (effective cash + credit note) and is never left
    // with the applied slice outstanding. xeroInvoiceId is already persisted above,
    // so a throw here fails the op and the retry short-circuits on it (no duplicate
    // invoice). No-op for IB / no-credit / legacy full-price captures.
    await settleCardAppliedCreditAllocation(
      booking.payment,
      bookingId,
      options?.createdByMemberId
    );

    await completeXeroSyncOperation(operationId!, {
      status: paymentWriteError || invoiceEmailError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError: paymentWriteError,
        paymentSkipped,
        paymentSkipReason: paymentSkipped ? paymentSkipReason : null,
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
      guests: { include: { nights: true } }, // per-night rows (issue #713)
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
      nights: (g.nights ?? []).map((n) => ({ stayDate: n.stayDate, priceCents: n.priceCents })),
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
