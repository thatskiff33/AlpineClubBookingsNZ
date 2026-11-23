import { Prisma } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { asRecord, readString } from "../../xero-json";
import { CAPTURE_RECEIPT_ACCOUNT, planCaptureReceipt, type CaptureReceiptPlan } from "./capture-receipt-plan";
import { memberMoneyEventKeys } from "./keys";
import { writeExportManifest } from "./store";

type Db = Prisma.TransactionClient;

/**
 * A CAPTURE RECEIPT'S EXPORT MANIFEST, FOR THE SENDERS (#4525, Ledger M13).
 * Each capture sender calls this once it has stored a Xero payment id, outside
 * any transaction of its own, and keeps sending exactly what it sent before:
 * a failure here is logged and swallowed, and never changes the Xero result or
 * how the sender's sync operation ends. Where the sender's replay re-reaches
 * the stored payment id, it calls this again and a missing row is written then.
 *
 * Its own short transaction. It locks the capture's PaymentTransaction row
 * (`stripePaymentIntentId` is unique) so two receipts of one capture are
 * planned one after the other and cannot both spend the same cash; that row
 * lock is the only lock it asks for (the insert's foreign key shares the
 * Booking row's key), so it orders against nothing. A capture with no
 * PaymentTransaction row is not serialised: the unique keys refuse only the
 * same key twice. No advisory lock:
 * a manifest changes no booking status or settlement money (`INV-LOCK-001`).
 */
export interface CaptureReceiptManifestInput {
  bookingId: string;
  /** The card capture the payment records, or null when the sender cannot name one capture (a conflict is recorded). */
  paymentIntentId: string | null;
  /** The Xero payment's idempotency key. */
  paymentKey: string;
  /** The cents the stored payment sent. */
  amountCents: number;
  /** The Xero payment id the sender stored. */
  providerPaymentId: string;
  invoiceId: string;
  reference: string;
  /**
   * The bank account code sent. Omitted, it is read from the payment operation
   * stored under the same key (`createXeroPaymentForInvoice`), else null.
   */
  bankCode?: string | null;
}

/** Record the receipt's manifest: COVERED with one coverage row, or CONFLICT alone. First key wins. Never throws. */
export async function recordCaptureReceiptManifest(input: CaptureReceiptManifestInput): Promise<void> {
  const { bookingId, paymentKey, providerPaymentId } = input;
  try {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      logger.warn({ bookingId, paymentKey, providerPaymentId }, "A capture receipt with no positive cents has no export manifest");
      return;
    }
    const bankCode = input.bankCode !== undefined ? input.bankCode : await storedPaymentBankCode(paymentKey);
    const { plan, result } = await prisma.$transaction(async (tx) => {
      const intent = input.paymentIntentId;
      if (intent) await tx.$executeRaw`SELECT 1 FROM "PaymentTransaction" WHERE "stripePaymentIntentId" = ${intent} FOR NO KEY UPDATE`;
      const plan = planCaptureReceipt({
        paymentIntentId: intent,
        paymentKey,
        amountCents: input.amountCents,
        invoiceId: input.invoiceId,
        reference: input.reference,
        bankCode,
        captureDebitCents: intent ? await captureDebitCents(tx, intent) : null,
        alreadyCoveredCents: intent ? await coveredByOtherReceipts(tx, intent, paymentKey) : 0,
      });
      return { plan, result: await writeExportManifest(tx, manifestRow(plan, bookingId, providerPaymentId)) };
    });
    if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ bookingId, paymentKey, providerPaymentId, reason: plan.reason, problem: plan.problem },
        "A capture receipt does not match the journal; its manifest records a conflict");
    }
    if (result === "KEPT_FIRST") {
      logger.info({ bookingId, paymentKey, providerPaymentId }, "The capture receipt's manifest was already recorded differently; the first row stands");
    }
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      logger.info({ bookingId, paymentKey, providerPaymentId }, "Another run recorded the capture receipt's manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, bookingId, paymentKey, providerPaymentId }, "Could not record the capture receipt's export manifest");
  }
}

function manifestRow(plan: CaptureReceiptPlan, bookingId: string, providerPaymentId: string) {
  return {
    documentRole: "CAPTURE_RECEIPT" as const,
    legacyKey: plan.legacyKey,
    bookingId,
    outcome: plan.outcome,
    reason: plan.outcome === "CONFLICT" ? plan.reason : null,
    payloadHash: plan.payloadHash,
    frozenMapping: plan.frozenMapping as Prisma.InputJsonObject,
    lineTotalCents: plan.lineTotalCents,
    providerInvoiceId: providerPaymentId,
    coverage: plan.outcome === "COVERED" ? plan.coverage : [],
  };
}

/** The capture's live R06 receipt cash debit, or null when the journal holds none, or only a reversed one. */
async function captureDebitCents(tx: Db, paymentIntentId: string): Promise<number | null> {
  const event = await tx.memberMoneyEvent.findUnique({
    where: { eventKey: memberMoneyEventKeys.capture(paymentIntentId) },
    select: { journal: { select: { reversedBy: { select: { id: true } },
      lines: { where: { account: CAPTURE_RECEIPT_ACCOUNT, side: "DEBIT" }, select: { amountCents: true } } } } },
  });
  if (!event?.journal || event.journal.reversedBy || event.journal.lines.length === 0) return null;
  return event.journal.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** Cents of the capture that receipts recorded under other keys already cover. */
async function coveredByOtherReceipts(tx: Db, paymentIntentId: string, paymentKey: string): Promise<number> {
  const covered = await tx.memberMoneyExportCoverage.aggregate({
    where: {
      documentRole: "CAPTURE_RECEIPT",
      account: CAPTURE_RECEIPT_ACCOUNT,
      chargeIdentity: memberMoneyEventKeys.capture(paymentIntentId),
      sliceKey: { not: paymentKey },
    },
    _sum: { coveredCents: true },
  });
  return covered._sum.coveredCents ?? 0;
}

/** The bank account code the payment operation stored under this key sent, or null. */
async function storedPaymentBankCode(idempotencyKey: string): Promise<string | null> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: { idempotencyKey, entityType: "PAYMENT" },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const payments = asRecord(operation?.requestPayload)?.payments;
  const first = Array.isArray(payments) ? asRecord(payments[0]) : null;
  return readString(asRecord(first?.account)?.code);
}
