import "server-only";

import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import {
  creditReleaseShareOverlaps,
  GAP_SEND_STATE_SELECT,
  gapPaymentMayBeInXero,
  readRecordedByPrimaryOrGap,
} from "@/lib/additional-capture-recorder";
import { GAP_COVERED_INTENTS_KEY, unpaidPrimaryInvoiceGapPayload } from "@/lib/additional-capture-receipt-payload";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { createAuditLog } from "@/lib/audit";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { readCreditReleaseCaptureShare, type CreditReleaseCaptureShare } from "@/lib/credit-release-capture-share";
import {
  creditReleaseShareFromPlan,
  planCreditReleasePayments,
  type AskLedgerRow,
  type CreditReleasePaymentItem,
} from "@/lib/credit-release-payment-plan";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";
import { prisma } from "@/lib/prisma";
import { readStripeCaptureDocumentDate } from "@/lib/stripe-capture-date";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import { asRecord } from "@/lib/xero-json";
import { readPrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-gap-anchors";
import {
  openBalanceCents,
  readXeroInvoiceBalance,
  type XeroInvoiceBalanceReader,
} from "@/lib/xero-invoice-balance";
import { buildXeroIdempotencyKey, sanitizeForJson } from "@/lib/xero-sync";

/**
 * THE CARD PAYMENT FOR RELEASED CREDIT, RECORDED IN XERO (#4253, `INV-ADDPAY-045`).
 *
 * Owner decision (D1): the money the member pays by card for credit released after
 * a Xero offset is recorded as a payment on the booking's EXISTING invoice, from
 * the Stripe account, dated the day Stripe took it - never a second invoice. That
 * is what makes Xero's receivable and the member's card agree.
 *
 * It is a SWEEP, not a queue row, on purpose. What is owed is a fact of the ledger
 * (a captured request in a chain that carries a credit-release request), so each
 * run re-derives it (`planCreditReleasePayments`) and the recorded payment's
 * `XeroObjectLink` is the only marker of "done". A payment that fails is simply
 * seen again; the Xero idempotency key makes a repeat harmless; and the retry is
 * bounded, because every failed attempt is an operation row an officer can see.
 *
 * It FAILS CLOSED, and says why in plain English: an invoice Xero no longer shows
 * as open, or one that owes less than the card took, means the member has paid the
 * same money twice (by bank transfer, or against a credit note) and part of the
 * card payment is a refund the club owes. Nothing is recorded and an officer is
 * told, once a day.
 *
 * #4494 (`INV-PAY-139`): ONE RECORDER PER CAPTURE, both orderings. The #3980 gap
 * invoice never pays itself from this sweep's share (`attributeGapCash`), but a
 * gap invoice queued before that fix, or by the previous colour during a
 * cutover, may have. So the sweep holds, with an alert, a payment such a gap
 * invoice may already have taken part of, and waits for one that has not sent
 * ({@link recordOne}); and a gap invoice's send, an officer's Retry and the
 * PARTIAL repair record no payment where a capture it pays from overlaps this
 * sweep's share ({@link unpaidGapPayloadIfOverlapping}). All read outside any
 * transaction and fail closed.
 */
export const CREDIT_RELEASE_PAYMENT_ROLE = "CREDIT_RELEASE_PAYMENT";
export const CREDIT_RELEASE_PAYMENT_LOCAL_MODEL = "PaymentTransaction";

/** A failed recording is retried no sooner than this, and no more than the cap. */
export const CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS = 60 * 60 * 1000;
export const CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS = 5;
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Requests older than this are no longer live work for the sweep; an officer was told long before. */
export const CREDIT_RELEASE_PAYMENT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const CREDIT_RELEASE_PAYMENT_CANDIDATES = 500;
/**
 * An attempt that never finished (the process died after Xero may have taken the payment) is
 * replayed under the same Xero key for this long, then held for an officer: past it, Xero's own
 * replay protection is not relied on.
 */
export const CREDIT_RELEASE_PAYMENT_IN_DOUBT_MS = 12 * 60 * 60 * 1000;

export function creditReleasePaymentIdempotencyKey(askRowId: string, invoiceId: string): string {
  return buildXeroIdempotencyKey("payment-transaction", askRowId, "credit-release-payment", invoiceId, "v1");
}

export type CreditReleasePaymentRunResult = {
  recorded: number;
  held: number;
  failed: number;
  waiting: number;
};

export type CreditReleasePaymentDeps = {
  readInvoiceBalance: XeroInvoiceBalanceReader;
  createPayment: typeof createXeroPaymentForInvoice;
  captureDate: typeof readStripeCaptureDocumentDate;
};

const PRODUCTION_DEPS: CreditReleasePaymentDeps = {
  readInvoiceBalance: readXeroInvoiceBalance,
  createPayment: createXeroPaymentForInvoice,
  captureDate: readStripeCaptureDocumentDate,
};

async function alertOnce(key: string, bookingId: string, headline: string, detail: string): Promise<void> {
  try {
    if (!(await claimAlertCooldown({ key, windowMs: ALERT_WINDOW_MS }))) return;
    await sendAdminXeroSyncErrorAlert({
      errorType: "CREDIT_RELEASE_PAYMENT",
      operation: `${headline} (booking ${bookingId.slice(0, 8)})`,
      errorMessage: detail,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err, key, bookingId }, "Failed to send a credit-release payment alert");
  }
}

/**
 * #4494 (delta review r2-2): what an officer is told about a credit-release
 * payment held behind an unsent gap invoice, by why it is held. One that can
 * still run (queued, or FAILED and replayable, only past the wait) records on
 * its own once sent; one that cannot (marked non-replayable) never will, and
 * resolving it only makes the hold permanent.
 */
export function gapUnsentAlertDetail(gapSend: { operationId: string; rerunnable: boolean }): string {
  const lead = `The member paid by card for credit that was used in Xero, but the booking's extra invoice for its remaining balance (Xero operation ${gapSend.operationId}) names the same card payment and has not been sent. Nothing was recorded.`;
  return gapSend.rerunnable
    ? `${lead} Retry that operation in Xero Operations, or wait for it to send: once it has, this payment is recorded automatically.`
    : `${lead} That operation will not run again, so this payment will not be recorded automatically. Please record the card payment against the booking's invoice by hand. Do not resolve the extra invoice expecting this payment to record itself.`;
}

export async function recordCreditReleasePayments(
  options: { limit?: number; deps?: Partial<CreditReleasePaymentDeps>; now?: Date } = {},
): Promise<CreditReleasePaymentRunResult> {
  const deps = { ...PRODUCTION_DEPS, ...options.deps };
  const now = options.now ?? new Date();
  const result: CreditReleasePaymentRunResult = { recorded: 0, held: 0, failed: 0, waiting: 0 };

  // Payments with a credit-release request AND a captured card payment, recent enough to be live
  // work: a booking whose request nobody paid, or one recorded long ago, never fills the slice.
  const candidates = await prisma.payment.findMany({
    where: {
      AND: [
        {
          transactions: {
            some: {
              kind: PaymentTransactionKind.ADDITIONAL,
              reason: CREDIT_RELEASE_ASK_REASON,
              withdrawnAt: null,
              createdAt: { gt: new Date(now.getTime() - CREDIT_RELEASE_PAYMENT_LOOKBACK_MS) },
            },
          },
        },
        {
          transactions: {
            some: {
              kind: PaymentTransactionKind.ADDITIONAL,
              source: PaymentSource.STRIPE,
              status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      transactions: { where: { reason: CREDIT_RELEASE_ASK_REASON }, orderBy: [...LEDGER_ROWS_OLDEST_FIRST], select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: CREDIT_RELEASE_PAYMENT_CANDIDATES,
  });
  const recordedLinks = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: CREDIT_RELEASE_PAYMENT_LOCAL_MODEL,
      localId: { in: candidates.flatMap((candidate) => candidate.transactions.map((row) => row.id)) },
      role: CREDIT_RELEASE_PAYMENT_ROLE,
      active: true,
    },
    select: { localId: true },
  });
  const done = new Set(recordedLinks.map((link) => link.localId));
  const paymentIds = candidates
    .filter((candidate) => candidate.transactions.some((row) => !done.has(row.id)))
    .map((candidate) => candidate.id)
    .slice(0, options.limit ?? 25);

  for (const paymentId of paymentIds) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        bookingId: true,
        xeroInvoiceId: true,
        transactions: {
          where: { kind: PaymentTransactionKind.ADDITIONAL },
          orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
          select: {
            id: true,
            source: true,
            status: true,
            reason: true,
            amountCents: true,
            carriedAskCents: true,
            withdrawnAt: true,
            stripePaymentIntentId: true,
          },
        },
      },
    });
    if (!payment) continue;
    const plan = planCreditReleasePayments(payment.transactions as AskLedgerRow[]);
    for (const askRowId of plan.unexplainedRowIds) {
      if (done.has(askRowId)) continue;
      result.held += 1;
      await alertOnce(
        `credit-release-payment-unexplained:${askRowId}`,
        payment.bookingId,
        "A card payment for credit used in Xero could not be matched",
        "The member paid by card for credit that was used in Xero, but the booking's payment requests since then could not be matched to it with certainty, so nothing was recorded in Xero. Please record the card payment against the booking's invoice by hand.",
      );
    }
    for (const item of plan.items) {
      if (done.has(item.askRowId)) continue;
      // #4494: this capture's whole credit-release share, read off THIS run's plan
      // by the one fold `readCreditReleaseCaptureShare` uses (`creditReleaseShareFromPlan`).
      const capture = {
        share: creditReleaseShareFromPlan(plan, item.capturedByIntentId),
        amountCents: payment.transactions.find((row) => row.id === item.capturedByRowId)?.amountCents ?? 0,
      };
      const outcome = await recordOne({ item, capture, payment, deps, now });
      result[outcome] += 1;
    }
  }
  return result;
}

async function recordOne({
  item,
  capture,
  payment,
  deps,
  now,
}: {
  item: CreditReleasePaymentItem;
  /** The capture's whole credit-release share (every item it collected) and its gross amount. */
  capture: { share: CreditReleaseCaptureShare; amountCents: number };
  payment: { bookingId: string; xeroInvoiceId: string | null };
  deps: CreditReleasePaymentDeps;
  now: Date;
}): Promise<"recorded" | "held" | "failed" | "waiting"> {
  const invoiceId = payment.xeroInvoiceId;
  // No invoice to record against yet: the booking's own invoice is raised first, then this runs.
  if (!invoiceId) return "waiting";

  const attempts = await prisma.xeroSyncOperation.findMany({
    where: {
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: CREDIT_RELEASE_PAYMENT_LOCAL_MODEL,
      localId: item.askRowId,
      status: "FAILED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (attempts.length >= CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS) return "failed";
  const last = attempts[0];
  if (last && now.getTime() - last.createdAt.getTime() < CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS) return "waiting";

  // An attempt that may have reached Xero: the balance below may already be net of it, so it must
  // not be read as "paid twice". Replayed under the same key (Xero returns the original payment),
  // or held for an officer once too old to trust that.
  const inDoubt = await prisma.xeroSyncOperation.findFirst({
    where: {
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: CREDIT_RELEASE_PAYMENT_LOCAL_MODEL,
      localId: item.askRowId,
      status: { in: ["PENDING", "RUNNING"] },
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const replayInDoubt = inDoubt !== null && now.getTime() - inDoubt.createdAt.getTime() < CREDIT_RELEASE_PAYMENT_IN_DOUBT_MS;
  if (inDoubt && !replayInDoubt) {
    await alertOnce(
      `credit-release-payment-in-doubt:${item.askRowId}`,
      payment.bookingId,
      "A card payment for credit used in Xero may or may not be recorded",
      "An attempt to record the member's card payment for credit that was used in Xero did not finish, and is too old to retry safely. Please check the booking's invoice in Xero: record the payment by hand if it is missing.",
    );
    return "held";
  }

  // #4494: a gap invoice queued before the fix may pay itself from this capture.
  // What it and the primary recorded, beside the sweep's share, must fit inside
  // what the card took (the reader the receipt's recorder uses). A gap that has
  // not sent is re-checked at its send, so the sweep waits for it, silently,
  // while it can still send; past that an officer is told which row it is.
  const figures = await readPrimaryInvoiceFeeAtLink(payment.bookingId, invoiceId);
  const recorded = await readRecordedByPrimaryOrGap(item.capturedByIntentId, figures?.atLink, prisma, { withGapSendState: { now } });
  if (creditReleaseShareOverlaps(recorded, capture.share, capture.amountCents)) {
    const gapSend = recorded.kind === "primary-invoice" ? undefined : recorded.gapSend;
    if (gapSend && !gapSend.mayBeInXero) {
      if (gapSend.canStillSend) return "waiting";
      await alertOnce(
        `credit-release-payment-gap-unsent:${item.askRowId}`,
        payment.bookingId,
        "A card payment for credit used in Xero is waiting on an unsent invoice",
        gapUnsentAlertDetail(gapSend),
      );
      return "held";
    }
    await alertOnce(
      `credit-release-payment-gap-overlap:${item.askRowId}`,
      payment.bookingId,
      "A card payment for credit used in Xero was not recorded",
      "The member paid by card for credit that was used in Xero, but the booking's extra invoice for its remaining balance has recorded, or may have recorded, part of the same card payment. Nothing was recorded here, so the payment is not counted twice. Please check both invoices in Xero, and record against the booking's invoice only what is not already there.",
    );
    return "held";
  }

  let dueCents: number | null = null;
  if (!replayInDoubt) {
    try {
      dueCents = openBalanceCents(await deps.readInvoiceBalance(invoiceId));
    } catch (err) {
      logger.warn({ err, askRowId: item.askRowId }, "Could not read the booking's Xero invoice to record a credit-release payment; will retry");
      return "waiting";
    }
  }
  if (!replayInDoubt && (dueCents === null || dueCents < item.ownCents)) {
    await alertOnce(
      `credit-release-payment-overpaid:${item.askRowId}`,
      payment.bookingId,
      "A card payment for credit used in Xero was not recorded",
      "The member paid by card for credit that was used in Xero, but Xero no longer shows that much owing on the booking's invoice (it may have been paid another way). Nothing was recorded in Xero. Please check the invoice and refund the card payment if the money was paid twice.",
    );
    return "held";
  }

  const zone = await readClubTimeZoneOutsideRequest();
  const date = (await deps.captureDate(item.capturedByIntentId, zone)) ?? undefined;
  try {
    const paymentId = await deps.createPayment({
      localModel: CREDIT_RELEASE_PAYMENT_LOCAL_MODEL,
      localId: item.askRowId,
      invoiceId,
      amountCents: item.ownCents,
      idempotencyKey: creditReleasePaymentIdempotencyKey(item.askRowId, invoiceId),
      reference: `Stripe ${item.capturedByIntentId}`,
      role: CREDIT_RELEASE_PAYMENT_ROLE,
      metadata: { invoiceId, amountCents: item.ownCents, paymentIntentId: item.capturedByIntentId },
      ...(date ? { date } : {}),
    });
    await createAuditLog({
      action: "xero.credit_release_payment.recorded",
      targetId: payment.bookingId,
      entityType: "Booking",
      entityId: payment.bookingId,
      category: "xero",
      severity: "info",
      outcome: "success",
      summary: "A card payment for credit used in Xero was recorded against the booking's invoice",
      metadata: { askRowId: item.askRowId, amountCents: item.ownCents, xeroPaymentId: paymentId, paymentIntentId: item.capturedByIntentId },
    });
    return "recorded";
  } catch (err) {
    logger.error({ err, askRowId: item.askRowId }, "Failed to record a credit-release card payment in Xero; it is retried");
    if (attempts.length + 1 >= CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS) {
      await alertOnce(
        `credit-release-payment-failed:${item.askRowId}`,
        payment.bookingId,
        "A card payment for credit used in Xero could not be recorded",
        "The member's card payment for credit that was used in Xero could not be recorded in Xero after several tries. Please record it against the booking's invoice by hand.",
      );
    }
    return "failed";
  }
}

/**
 * #4494 (`INV-ADDPAY-046`, `INV-PAY-139`): THE GAP INVOICE'S SEND-TIME CHECK.
 * Asked just before a #3980 gap invoice's Stripe payment is sent - by the
 * outbox's send and by an officer's Retry - for a payload queued before the fix
 * or by the previous colour. True where any capture it pays from overlaps this
 * sweep's share of it: the share the ledger gives
 * (`readCreditReleaseCaptureShare`), or what the sweep already recorded (its
 * `CREDIT_RELEASE_PAYMENT` links), whichever is more. The caller then raises the
 * invoice unpaid; an officer is told once a day. Reads only, no lock.
 */
export async function gapPaymentOverlapsCreditRelease(input: {
  operationId: string;
  bookingId: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const intents = input.payload[GAP_COVERED_INTENTS_KEY];
  if (!Array.isArray(intents) || intents.length === 0) return false;
  const booking = await prisma.payment.findUnique({ where: { bookingId: input.bookingId }, select: { xeroInvoiceId: true } });
  const figures = booking?.xeroInvoiceId ? await readPrimaryInvoiceFeeAtLink(input.bookingId, booking.xeroInvoiceId) : null;
  for (const intent of intents) {
    if (typeof intent !== "string") continue;
    const [share, links, capture, recorded] = await Promise.all([
      readCreditReleaseCaptureShare(intent),
      prisma.xeroObjectLink.findMany({
        where: { role: CREDIT_RELEASE_PAYMENT_ROLE, active: true, metadata: { path: ["paymentIntentId"], equals: intent } },
        select: { metadata: true },
      }),
      prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: intent }, select: { amountCents: true } }),
      readRecordedByPrimaryOrGap(intent, figures?.atLink),
    ]);
    const amountCents = capture?.amountCents ?? 0;
    // A link with no recorded figure is read as all of the capture: fail closed.
    const linkedCents = links.reduce((sum, link) => {
      const cents = asRecord(link.metadata)?.amountCents;
      return sum + (typeof cents === "number" ? cents : amountCents);
    }, 0);
    const swept = { held: share.held, ownCents: Math.max(share.ownCents, linkedCents) };
    if (!creditReleaseShareOverlaps(recorded, swept, amountCents)) continue;
    await alertOnce(
      `credit-release-gap-payment-overlap:${input.operationId}`,
      input.bookingId,
      "A booking's extra Xero invoice did not record a card payment",
      "The booking's extra invoice for its remaining balance would have recorded a card payment the member made for credit used in Xero, which belongs on the booking's own invoice. No payment was recorded on the extra invoice, so the money is not counted twice. An earlier attempt may already have recorded one: please check both invoices in Xero.",
    );
    return true;
  }
  return false;
}

/**
 * #4494 fix round: THE GAP INVOICE'S PAYLOAD TO SEND WITH, where its payment
 * would overlap the sweep's share ({@link gapPaymentOverlapsCreditRelease}):
 * unpaid, naming no capture where its payment provably never reached Xero, or
 * unpaid and still naming its captures where an earlier attempt's may be there
 * (`gapPaymentMayBeInXero`), so the sweep keeps holding. Null: pay as queued.
 * The outbox's send, an officer's Retry and the PARTIAL repair all ask this.
 */
export async function unpaidGapPayloadIfOverlapping(input: {
  operationId: string;
  bookingId: string;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  if (input.payload.primaryInvoiceGap !== true || input.payload.recordPayment === false) return null;
  if (!(await gapPaymentOverlapsCreditRelease(input))) return null;
  const row = await prisma.xeroSyncOperation.findUnique({ where: { id: input.operationId }, select: GAP_SEND_STATE_SELECT });
  // No row to read is not proof it never sent: keep the captures named.
  const keepCoverage = row ? await gapPaymentMayBeInXero(row) : true;
  return unpaidPrimaryInvoiceGapPayload(input.payload, { keepCoverage });
}

/**
 * #4494 fix round: an officer's repair of a PARTIAL gap invoice - the invoice
 * in Xero, its payment not recorded - records no payment where it would
 * overlap the sweep's share. The unpaid payload, still naming its captures (a
 * payment call that errored may have landed), is written under the repair's
 * claim, and the repair closes with the reason. A gap payload already unpaid
 * is skipped without asking again (d-2: the write and the close are separate,
 * so a failed close leaves that decision behind). Null: repair as before.
 */
export async function skipPartialGapRepairPayment(
  operation: { id: string; localModel: string | null; requestPayload: unknown },
  claim: { id: string; startedAt: Date | null },
): Promise<{ paymentOutcome: Record<string, unknown>; message: string } | null> {
  const payload = asRecord(operation.requestPayload);
  const bookingId = payload?.bookingId;
  if (operation.localModel !== "BookingModification" || !payload || typeof bookingId !== "string") return null;
  // Delta review d-2: a gap payload already set unpaid is a decision made (by an
  // earlier repair whose close failed, or at its queue): never paid, never re-asked.
  const decided = payload.primaryInvoiceGap === true && payload.recordPayment === false;
  if (!decided) {
    const unpaid = await unpaidGapPayloadIfOverlapping({ operationId: operation.id, bookingId, payload });
    if (!unpaid) return null;
    await prisma.xeroSyncOperation.updateMany({
      where: { id: claim.id, status: "RUNNING", startedAt: claim.startedAt },
      data: { requestPayload: sanitizeForJson(unpaid) },
    });
  }
  const reason =
    "Not recorded: the card payment this extra invoice would record is the member's payment for credit used in Xero, which belongs on the booking's own invoice.";
  return {
    paymentOutcome: { payment: null, paymentSkipped: true, paymentSkipReason: reason },
    message: `Closed without recording a payment. ${reason} Please check both invoices in Xero.`,
  };
}
