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
} from "xero-node";
import { PaymentSource, PaymentTransactionKind } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { getStayNights } from "./pricing";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  recordWithheldBookingEmail,
  resolveBookingEmailGate,
  XERO_BOOKING_INVOICE_EMAIL_TEMPLATE,
} from "@/lib/booking-email-suppression";
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
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
} from "@/lib/xero-invoice-email";
import {
  describeGuestRateMembershipLabel,
  getAccountMapping,
  getHutFeeItemCodeMap,
  isHutFeeResolverConfigured,
  resolveHutFeeItemCode,
  type HutFeeItemCodeResolver,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { requireContainedXeroContactForInvoiceOperation } from "@/lib/xero-contact-containment-proof";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "./xero-invoice-helpers";
import { providerAmountToCents } from "@/lib/money-provider-amount";

// #1765 — the aggregate Payment statuses that prove cash was captured at some
// point. Settlement gating must pair one of these with a positive NET capture
// (amountCents − refundedAmountCents); `status === "SUCCEEDED"` alone
// misclassifies a repay-after-refund payment, whose aggregate sits in
// PARTIALLY_REFUNDED even though its repay capture settles the invoice.
const STRIPE_CAPTURED_PAYMENT_STATUSES = new Set<string>([
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

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
 * @param itemCodeResolver - Per-guest hut-fee item code resolver keyed by
 *   membership type (#1930, E4). When provided with a seasonType, each guest
 *   gets its own item code from its rateMembershipType snapshot (NULL falls
 *   back isMember -> FULL/NON_MEMBER).
 * @param itemCode - Single hutFeesIncome item code applied to all guests, used
 *   only when the resolver is absent/unconfigured or no seasonType is known —
 *   never as a fallback for a per-guest miss once keyed rows exist.
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
      formatDateOnly(new Date(last.endExclusive)) === formatDateOnly(night.stayDate);
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
    // Rate-membership-type snapshot (#1930, E4) — drives the hut-fee item code.
    rateMembershipTypeId?: string | null;
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
  itemCodeResolver?: HutFeeItemCodeResolver,
  seasonType?: string | null,
): LineItem[] {
  const applyCodes = (
    lineItem: LineItem,
    guest: { ageTier: string; isMember: boolean; rateMembershipTypeId?: string | null },
  ) => {
    // Resolve item code with main's exact precedence (#1930, E4): when the
    // per-guest resolver is configured (keyed rows or legacy hutFeeItem) AND a
    // seasonType is known, the resolver's answer is FINAL — a miss with keyed
    // rows present yields NO item code (account-coded line), never the single
    // hutFeesIncome item code. The hutFeesIncome item code param applies only
    // when the resolver is absent/unconfigured or the seasonType is unknown.
    const resolverActive = Boolean(
      itemCodeResolver && seasonType && isHutFeeResolverConfigured(itemCodeResolver),
    );
    const guestItemCode = resolverActive
      ? resolveHutFeeItemCode(itemCodeResolver!, guest, seasonType)
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
    guest: {
      firstName: string;
      lastName: string;
      ageTier: string;
      isMember: boolean;
      rateMembershipTypeId?: string | null;
    }
  ): LineItem => {
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      // #2543: the label follows the RATE snapshot, so it agrees with the item
      // code `applyCodes` resolves from the same field. See
      // `describeGuestRateMembershipLabel`.
      `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
      `${run.nightCount} night${run.nightCount !== 1 ? "s" : ""}`,
      `${formatDateOnly(run.startDate)} - ${formatDateOnly(run.endExclusive)}`,
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
          // #2543 — same rate-driven label as `runToLineItem`.
          `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
          `${nights} night${nights !== 1 ? "s" : ""}`,
          `${formatDateOnly(checkIn)} - ${formatDateOnly(checkOut)}`,
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
  payment: {
    source: PaymentSource;
    status: string;
    amountCents: number;
    refundedAmountCents: number;
    creditAppliedCents: number;
  },
  bookingId: string,
  createdByMemberId?: string
): Promise<void> {
  // Proceed ONLY for a card cash capture that recorded a credit-reduced mirror
  // (`creditAppliedCents > 0`). The positive test also skips on 0 / a missing
  // mirror (legacy full-price captures, no-credit bookings), which is required:
  // allocating against a full-price-paid invoice would over-allocate.
  // #1765 — capture evidence is "captured status + positive net cash", not
  // `status === "SUCCEEDED"`: a repay-after-refund payment aggregates to
  // PARTIALLY_REFUNDED at invoice time even though its repay capture settles
  // the invoice, and skipping here would strand the applied slice outstanding.
  // A fully-refunded-out payment (net 0) still must not allocate.
  if (
    payment.source === PaymentSource.INTERNET_BANKING ||
    !STRIPE_CAPTURED_PAYMENT_STATUSES.has(payment.status) ||
    payment.amountCents - (payment.refundedAmountCents ?? 0) <= 0 ||
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
): Promise<string | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // Per-night rows (issue #713) so non-contiguous stays produce one line
      // item per contiguous run.
      guests: { include: { nights: true } },
      payment: true,
      promoRedemption: { include: { promoCode: true } },
      // #2258: recipient for the withheld-send audit row when the booking's
      // "No emails" switch stops Xero emailing the invoice.
      member: { select: { email: true } },
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
    // #2262 H3 — a CLAIMED operation (the operator retry claims FAILED/PARTIAL
    // -> RUNNING before calling in; the outbox claims PENDING -> RUNNING) must
    // not be stranded RUNNING when the invoice already exists: close it
    // SUCCEEDED against the existing invoice so the ops panel reads true.
    if (options?.syncOperationId) {
      await completeXeroSyncOperation(options.syncOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: "Invoice already exists for this payment; link re-asserted.",
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: booking.payment.xeroInvoiceId,
        xeroObjectNumber: booking.payment.xeroInvoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(booking.payment.xeroInvoiceId),
      });
    }
    return booking.payment.xeroInvoiceId;
  }

  // B5 (#2262) HIGH #2, level 3 — the residual-race backstop.
  //
  // The choke point (enqueueXeroBookingInvoiceOperation) refuses to queue a
  // mint for a manually settled booking, and mark-paid refuses under lock(1)
  // while a CREATE-INVOICE operation is PENDING/RUNNING. Neither closes the
  // hairline window where an operation is enqueued microseconds BEFORE the
  // settle commits: that operation is still PENDING and the cron will run it
  // minutes later. This re-check, at execution time against a fresh read, is
  // what makes "a manual mark-paid can never race a mint" literally true.
  //
  // Abandon LOUDLY (#1765 loud-skip pattern): no invoice is created, no email
  // is sent, the ids are logged at warn, and the sync operation is closed with
  // a NON-SUCCEEDED terminal status carrying a populated reason, so it is
  // visible to an operator and never silently replayed.
  if (booking.payment.manuallyMarkedPaidAt) {
    const skipReason =
      "Booking was manually marked paid (cash / off-Xero) after this invoice operation was queued — no Xero invoice is expected, so none was created and nothing was emailed (#2262).";
    logger.warn(
      {
        bookingId,
        paymentId: booking.payment.id,
        manuallyMarkedPaidAt: booking.payment.manuallyMarkedPaidAt,
        syncOperationId: options?.syncOperationId ?? null,
      },
      skipReason
    );
    if (options?.syncOperationId) {
      await completeXeroSyncOperation(options.syncOperationId, {
        status: "CANCELLED",
        responsePayload: { skipped: true, reason: skipReason },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  // #3036 review P1-12: this client was built two lines up, so hand it to the
  // containment verification rather than making it authenticate a second time.
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    ...options,
    xero,
    tenantId,
  });

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

  // Season type for item-code mapping, from the booking's own lodge (#2913).
  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
      ...lodgeNullTolerantScope(booking.lodgeId),
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
      rateMembershipTypeId: g.rateMembershipTypeId,
      priceCents: g.priceCents,
      nights: (g.nights ?? []).map((n) => ({ stayDate: n.stayDate, priceCents: n.priceCents })),
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    // Always pass the resolver: on a legacy-only install (no keyed rows) it
    // resolves the flat hutFeeItem; when unconfigured or without a seasonType,
    // buildInvoiceLineItems falls to hutFeeMapping.itemCode (#1930, E4).
    // Byte-identical to main's boolean-keyed map precedence.
    hutFeeItemCodeMap,
    bookingSeasonType,
  );

  // Add signed promo adjustment line if applicable. Negative values behave
  // like discounts; positive values are extra revenue.
  if (booking.promoAdjustmentCents !== 0) {
    const promo = booking.promoRedemption?.promoCode ?? null;
    const firstGuest = booking.guests[0];

    // Fall back to hut-fee item code for legacy / non-promo discounts. Unlike
    // the guest lines, main's promo fallback DID fall through to the single
    // hutFeesIncome item code on a per-guest miss — preserved here (#1930, E4).
    const fallbackItemCode = (bookingSeasonType && firstGuest && isHutFeeResolverConfigured(hutFeeItemCodeMap))
      ? (resolveHutFeeItemCode(hutFeeItemCodeMap, firstGuest, bookingSeasonType) ?? hutFeeMapping.itemCode)
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

  // #2262 H3 — provenance RE-ASSERTED after the operation exists, from a fresh
  // read. The top-of-function check reads a snapshot taken before the contact
  // and account-mapping round-trips; a manual mark-paid can commit in those
  // seconds (its settle-time fence only refuses while an op is PENDING/RUNNING/
  // WAITING_PAYMENT, and this run's op may not have existed when the settle's
  // fence read ran). Re-checking here — strictly after the op above is visible
  // to that fence — closes the interleaving: whichever of the two commits
  // second now sees the other. Abandon per the #1765 loud-skip pattern: no
  // invoice, no email, ids at warn, operation closed CANCELLED with the reason.
  const freshProvenance = await prisma.payment.findUnique({
    where: { id: booking.payment.id },
    select: { manuallyMarkedPaidAt: true },
  });
  if (freshProvenance?.manuallyMarkedPaidAt) {
    const lateSkipReason =
      "Booking was manually marked paid (cash / off-Xero) while this invoice mint was preparing — no Xero invoice is expected, so none was created and nothing was emailed (#2262).";
    logger.warn(
      {
        bookingId,
        paymentId: booking.payment.id,
        manuallyMarkedPaidAt: freshProvenance.manuallyMarkedPaidAt,
        syncOperationId: operationId,
      },
      lateSkipReason
    );
    await completeXeroSyncOperation(operationId!, {
      status: "CANCELLED",
      responsePayload: { skipped: true, reason: lateSkipReason },
    });
    return null;
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
    // #1765 — settlement evidence comes from the captured-transaction ledger,
    // mirrored by reconcilePaymentAggregates as `amountCents = gross captured`
    // and `refundedAmountCents = refunded`, NEVER from the aggregate status
    // alone: a repay-after-refund payment sits in PARTIALLY_REFUNDED at
    // invoice time (prod case: gross 28500 / refunded 19500) even though its
    // repay capture fully settles the invoice. The recorded amount is the NET
    // capture (gross − refunded): cash handed back to the member is not
    // settlement, and the refunded slice reconciles against its own credit
    // note, never against this invoice. Capped at the invoice's amount due —
    // Xero hard-rejects an overpayment (e.g. a legacy full-price capture on a
    // since-repriced booking).
    let paymentResponseBody: XeroPayment | null = null;
    let paymentWriteError: unknown = null;
    const paymentSource = booking.payment.source ?? PaymentSource.STRIPE;
    const paymentCaptured = STRIPE_CAPTURED_PAYMENT_STATUSES.has(
      booking.payment.status
    );
    const netCapturedCents = Math.max(
      0,
      booking.payment.amountCents - (booking.payment.refundedAmountCents ?? 0)
    );
    const shouldRecordStripeInvoicePayment =
      paymentSource === PaymentSource.STRIPE &&
      paymentCaptured &&
      netCapturedCents > 0;
    const paymentSkipped = paymentCaptured && !shouldRecordStripeInvoicePayment;
    const paymentSkipReason = !paymentSkipped
      ? null
      : paymentSource === PaymentSource.INTERNET_BANKING
        ? "Internet Banking invoice payments are reconciled from Xero instead of recorded as Stripe bank payments."
        : (booking.payment.refundedAmountCents ?? 0) > 0
          ? "Captured Stripe cash was fully refunded; no net cash remains to record against the invoice."
          : "Zero-total invoice does not require Xero payment recording.";

    if (shouldRecordStripeInvoicePayment) {
      // THE ONE BEHAVIOUR DELTA IN THIS CONVERSION, stated for the record
      // (#2685 review). The test this replaced was `typeof … === "number"`;
      // `providerAmountToCents` also requires the number to be FINITE. The only
      // inputs that differ are `NaN` and `±Infinity`, which Xero's JSON cannot
      // produce — and for those the old code took the `Math.min` branch and sent
      // `amount: NaN` to Xero, while this one falls to `netCapturedCents`, the
      // same figure an absent `amountDue` has always produced. No finite
      // provider amount converts to a different cent value.
      const invoiceAmountDueCents = providerAmountToCents(
        createdInvoice.amountDue,
      );
      const invoicePaymentCents =
        invoiceAmountDueCents === null
          ? netCapturedCents
          : Math.min(netCapturedCents, invoiceAmountDueCents);
      const payment: XeroPayment = {
        invoice: { invoiceID: createdInvoice.invoiceID },
        account: { code: bankCode },
        amount: invoicePaymentCents / 100,
        // Bank-reconciliation input, so the club's calendar day rather than the
        // UTC one (INV-DATE-019, #2834). The invoice's own `date`/`dueDate`
        // above are derived from `checkIn` and `createdAt` and were settled on
        // #2697; this payment was the remaining instant in this file.
        date: formatDateOnlyForTimeZone(new Date()),
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
      // #1765 — every skip of a captured payment's Xero write is loud and
      // carries a populated reason; the silent status-gated skip is the exact
      // defect that hid the repay-settled invoice's missing payment.
      logger.warn(
        {
          bookingId,
          invoiceId: createdInvoice.invoiceID,
          paymentSource,
          paymentStatus: booking.payment.status,
          netCapturedCents,
        },
        paymentSkipReason ??
          "Skipped recording a Xero payment for a captured Stripe payment without a matched reason"
      );
    }

    let invoiceEmailResponseBody: unknown = null;
    let invoiceEmailError: unknown = null;
    const shouldEmailInvoice =
      booking.payment.source === PaymentSource.INTERNET_BANKING;

    // #2258 (owner decision D10): the per-booking "No emails" switch withholds
    // EVERYTHING for the booking, including the invoice email XERO sends on our
    // behalf. Only the EMAILING is skipped — the invoice itself is already
    // raised in Xero and is untouched, so an admin can still send it from Xero.
    // (Clearing the switch and re-driving this workflow does NOT resend it: the
    // emailInvoice call carries a per-invoice idempotency key, so a re-drive is
    // a no-op. Xero is the place to resend from.) The switch is re-read here
    // rather than taken from the booking snapshot loaded at the top of this
    // function, because invoice creation involves several provider round-trips
    // and an admin can flip the switch in between.
    //
    // The two non-send decisions are kept STRICTLY apart, because conflating
    // them is money-adjacent (#1705): a deliberate `withhold` is a terminal,
    // intended outcome, while `unknown` means the switch could not be READ. Both
    // fail closed and send nothing, but an `unknown` is a FAULT — it must not be
    // filed as "the admin asked for silence" (that would put a false line in the
    // booking's withheld list for a booking whose switch is OFF, #2259) and it
    // must not let the sync operation report SUCCEEDED. It therefore populates
    // invoiceEmailError, exactly as a failed emailInvoice call would, so the
    // operation completes PARTIAL and stays VISIBLE to an operator.
    //
    // Visible, not automatically recoverable: re-driving this workflow will not
    // resend, because the function short-circuits at the top on
    // payment.xeroInvoiceId (persisted later in this same run) and never
    // reaches the email block, and the emailInvoice idempotency key would
    // no-op anyway. The truthful remediation is to send the invoice from Xero
    // by hand. The operations panel's payment repair must NOT be used on an
    // email-only PARTIAL — it records a payment against an unpaid
    // Internet Banking invoice — and is refused for exactly that case
    // (partialInvoiceOperationHasPaymentFault in xero-operation-retry.ts).
    const invoiceEmailGate = shouldEmailInvoice
      ? await resolveBookingEmailGate(
          { bookingId },
          XERO_BOOKING_INVOICE_EMAIL_TEMPLATE,
        )
      : null;
    const invoiceEmailWithheld = invoiceEmailGate?.decision === "withhold";
    const invoiceEmailGateUnreadable = invoiceEmailGate?.decision === "unknown";

    if (invoiceEmailWithheld) {
      await recordWithheldBookingEmail({
        bookingId,
        templateName: XERO_BOOKING_INVOICE_EMAIL_TEMPLATE,
        subject: `Xero invoice ${
          createdInvoice.invoiceNumber ?? createdInvoice.invoiceID ?? "(unnumbered)"
        } for your Internet Banking booking payment`,
        to: booking.member.email,
        detail:
          'Withheld: this booking has the "No emails" switch turned on. The invoice exists in Xero but was not emailed.',
      });
      logger.warn(
        { bookingId, invoiceId: createdInvoice.invoiceID },
        'Skipped the Xero invoice email for a booking with "No emails" turned on',
      );
    }

    if (invoiceEmailGateUnreadable) {
      // NOT a withhold: no SKIPPED_NO_EMAILS row is written, because the switch
      // may well be off and the member is simply owed their invoice email.
      invoiceEmailError = new Error(
        `Could not read the "No emails" switch for booking ${bookingId}; the Xero invoice email was not sent`,
      );
      logger.error(
        { bookingId, invoiceId: createdInvoice.invoiceID },
        "Did not email the Xero invoice because the booking's \"No emails\" switch could not be read; the sync operation is marked PARTIAL so the unsent invoice email stays visible",
      );
    }

    /*
      Environment-safety boundary (#3035, ENV-SAFETY 2; epic #2986).
      INV-CONFIG-004. Asking Xero to email the invoice is a send to the member's
      real address, so it is gated like a message this application sends itself.

      Resolved AFTER the "No emails" gate above, so the club's own decision is
      still recorded as the club's own decision on a copy, and the environment is
      only consulted when something would otherwise be transmitted. What a
      non-allow answer means for the sync operation is decided once, in
      `resolveXeroInvoiceEmailPolicy` (`xero-invoice-email.ts`), which returns the
      `logMessage`, the `suppressedForNonProduction` flag and the `error` — or
      absence of one — that decide whether this operation reports SUCCEEDED or
      PARTIAL. (An earlier draft of this comment named a
      `classifyXeroInvoiceEmailWithheld` helper that never existed.)

      NOT AUTOMATICALLY RECOVERABLE, exactly like the unreadable-switch case
      above: re-driving this workflow short-circuits on `payment.xeroInvoiceId`
      and never reaches the email block, so the truthful remediation for an
      unconfirmed role is to declare the role and send that one invoice from Xero
      by hand.
    */
    const invoiceEmailPolicy =
      shouldEmailInvoice && !invoiceEmailWithheld && !invoiceEmailGateUnreadable
        ? await resolveXeroInvoiceEmailPolicy()
        : null;
    const invoiceEmailWithheldForEnvironment =
      invoiceEmailPolicy?.kind === "withhold" &&
      invoiceEmailPolicy.suppressedForNonProduction;
    if (invoiceEmailPolicy?.kind === "withhold") {
      const context = { bookingId, invoiceId: createdInvoice.invoiceID };
      if (invoiceEmailPolicy.error) {
        invoiceEmailError = invoiceEmailPolicy.error;
        logger.error(context, invoiceEmailPolicy.logMessage);
      } else {
        logger.info(context, invoiceEmailPolicy.logMessage);
      }
    }

    if (invoiceEmailPolicy?.kind === "allow") {
      const invoiceEmailIdempotencyKey = buildXeroIdempotencyKey(
        "booking",
        bookingId,
        "invoice-email",
        createdInvoice.invoiceID,
        "v1"
      );

      try {
        const emailResponse = await sendXeroInvoiceEmail({
          clearance: invoiceEmailPolicy.clearance,
          xero,
          tenantId,
          invoiceId: createdInvoice.invoiceID!,
          idempotencyKey: invoiceEmailIdempotencyKey,
          workflow: "createXeroInvoiceForBooking",
          context: `emailInvoice(booking ${bookingId})`,
        });
        invoiceEmailResponseBody = emailResponse.body;
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
        invoiceEmailSkipped:
          !shouldEmailInvoice ||
          invoiceEmailWithheld ||
          invoiceEmailGateUnreadable ||
          invoiceEmailPolicy?.kind === "withhold",
        // #2258: a DELIBERATE withhold only. An unreadable switch is a fault and
        // is reported through invoiceEmailError above (status PARTIAL), never
        // here — the two must stay distinguishable to an operator.
        invoiceEmailWithheldByNoEmails: invoiceEmailWithheld,
        // #3035: the environment-safety suppression, which is a THIRD reason and
        // must not be read as either of the two above. A confirmed copy did not
        // email the invoice; nothing failed and nobody asked for silence.
        invoiceEmailWithheldForEnvironment,
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
  const stayNarration = `${nights} night${nights !== 1 ? "s" : ""} - ${formatDateOnly(checkIn)} - ${formatDateOnly(checkOut)}`;
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
      ...lodgeNullTolerantScope(booking.lodgeId),
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
      rateMembershipTypeId: g.rateMembershipTypeId,
      priceCents: g.priceCents,
      nights: (g.nights ?? []).map((n) => ({ stayDate: n.stayDate, priceCents: n.priceCents })),
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap,
    bookingSeasonType,
  );

  const invoiceUpdateIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    invoiceId,
    formatDateOnly(checkIn),
    formatDateOnly(checkOut),
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

    /*
      INV-CONFIG-005 (#3036): this path does NOT go through
      `findOrCreateXeroContact`, and re-pricing an invoice can RAISE its amount
      due. On a copy restored from the club's live database the invoice was
      raised on the live site, so nothing here had ever looked at what its
      contact holds — and Xero emails invoice reminders for an outstanding
      AUTHORISED invoice from its own servers, to whatever address that contact
      holds.

      IT RUNS HERE, below the invoice read, because the contact this update
      re-sends is `currentInvoice.contact` — not the member's link, which can be a
      different contact after a merge or an admin re-link. The first version of
      this check ran at the top of the function against the member's link and
      therefore proved containment of a contact this update never touches.
    */
    await requireContainedXeroContactForInvoiceOperation({
      resolveXeroContactId: async () => currentInvoice.contact?.contactID,
      memberId: booking.memberId,
      workflow: "updateXeroBookingInvoiceForBooking",
      xero,
      tenantId,
    });

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
      // Preserve the due date the invoice was ISSUED with, exactly like
      // `reference`, `invoiceNumber` and `lineAmountTypes` below.
      //
      // `createdAt` never changes, so recomputing this was a value-stable no-op
      // until #2697 corrected the derivation. From that point on, recomputing it
      // would silently move an already-issued invoice's due date by a day the
      // next time an unrelated edit synced — and the owner decision on #2697 is
      // that already-issued invoices are untouched, with no write-back. Only
      // newly created invoices get the corrected date.
      dueDate: currentInvoice.dueDate ?? getBookingInvoiceDueDate(booking),
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
