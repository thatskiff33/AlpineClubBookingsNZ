/**
 * #4434 (`INV-PAY-139`): sending a change-capture receipt's planned legs.
 * The worker (`additional-capture-xero-receipt.ts`) decides the plan and
 * stores it; this writes one Xero payment per leg, outside any lock, and
 * finishes the row. A retry skips a leg already linked and adopts a payment
 * only when the reference, the amount and no other role all match.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { answerKeptLateCaptureRefunds } from "@/lib/kept-late-capture-change-receipt";
import { amountDueOn, legOwnsPayment, type InvoiceRead } from "@/lib/additional-capture-receipt-invoice-read";
import { receiptUnrecordedCents, type AdditionalCaptureReceiptPlan } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE } from "@/lib/additional-capture-receipt-link";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { asRecord } from "@/lib/xero-json";
import type { cardSettleAppliedCreditCents } from "@/lib/xero-primary-invoice-fee-gap";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import type { AdditionalCaptureReceiptProviders, AdditionalCaptureReceiptRefusal } from "@/lib/additional-capture-xero-receipt";

type CardSettlePayment = Parameters<typeof cardSettleAppliedCreditCents>[1];
type XeroClient = Awaited<ReturnType<AdditionalCaptureReceiptProviders["getAuthenticatedXeroClient"]>>;

/** Another writer that now records the capture. */
type OtherRecorder = { kind: string; operationId: string | null; changeId: string | null };

export async function sendAdditionalCaptureReceiptLegs(input: {
  plan: AdditionalCaptureReceiptPlan;
  fromStore: boolean;
  providers: AdditionalCaptureReceiptProviders;
  existingLinks: ReadonlyArray<{ xeroObjectId: string | null; metadata: unknown }>;
  reference: string;
  paymentIntentId: string;
  paymentTransactionId: string;
  paymentId: string;
  bookingId: string;
  operationId: string;
  createdByMemberId?: string;
  syncOperation: XeroOperationClaim;
  paymentKey: (invoiceId: string) => string;
  readInvoice: (client: XeroClient, invoiceId: string) => Promise<InvoiceRead | null>;
  primaryRoom: (read: InvoiceRead, payment: CardSettlePayment, capturedCents: number) => Promise<number>;
  refuse: (reason: AdditionalCaptureReceiptRefusal, details?: Record<string, unknown>) => Promise<null>;
  recorderNowElsewhere: () => Promise<OtherRecorder | null>;
  settleOtherRecorder: (other: OtherRecorder, invoiceId: string) => Promise<void>;
  alertOfficer: (paymentIntentId: string, operationId: string, message: string) => Promise<void>;
}): Promise<string | null> {
  const { plan, providers } = input;
  const client = await providers.getAuthenticatedXeroClient();
  const linkedByInvoice = new Map<string, string>();
  for (const link of input.existingLinks) {
    const invoiceId = asRecord(link.metadata)?.invoiceId;
    if (typeof invoiceId === "string" && link.xeroObjectId) linkedByInvoice.set(invoiceId, link.xeroObjectId);
  }
  const paymentIds: string[] = [];
  let recoveredExisting = false;
  for (const leg of plan.legs) {
    const linked = linkedByInvoice.get(leg.invoiceId);
    if (linked) {
      paymentIds.push(linked);
      continue;
    }
    const read = await input.readInvoice(client, leg.invoiceId);
    if (!read) return input.refuse("xero-unreadable", { plan, invoiceId: leg.invoiceId });
    const owned = await findReceiptLegPayment(read, input.reference, leg.amountCents);
    if (owned?.paymentID) {
      paymentIds.push(owned.paymentID);
      recoveredExisting = true;
      if (input.fromStore) {
        const other = await input.recorderNowElsewhere();
        if (other) await input.settleOtherRecorder(other, leg.invoiceId);
      }
      continue;
    }
    if (input.fromStore) {
      // A new payment is never sent once another document records the capture.
      const other = await input.recorderNowElsewhere();
      if (other) {
        return input.refuse("recorded-elsewhere", {
          plan,
          recorder: other.kind,
          recorderOperationId: other.operationId,
          recordedNote: alreadyRecordedNote(paymentIds),
        });
      }
      const roomCents =
        leg.target === "PRIMARY_INVOICE"
          ? await input.primaryRoom(
              read,
              await prisma.payment.findUniqueOrThrow({
                where: { id: input.paymentId },
                select: { source: true, status: true, amountCents: true, refundedAmountCents: true, creditAppliedCents: true },
              }),
              leg.amountCents,
            )
          : amountDueOn(read);
      if (roomCents < leg.amountCents) {
        return input.refuse("figures-changed", {
          plan,
          amountDueCents: read.amountDueCents,
          roomCents,
          invoiceId: leg.invoiceId,
          recordedNote: alreadyRecordedNote(paymentIds),
        });
      }
    }
    paymentIds.push(
      await providers.createXeroPaymentForInvoice({
        localModel: "PaymentTransaction",
        localId: input.paymentTransactionId,
        invoiceId: leg.invoiceId,
        amountCents: leg.amountCents,
        idempotencyKey: input.paymentKey(leg.invoiceId),
        reference: input.reference,
        role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
        createdByMemberId: input.createdByMemberId,
        metadata: { invoiceId: leg.invoiceId, target: leg.target, amountCents: leg.amountCents, paymentIntentId: input.paymentIntentId },
        date: plan.date,
      }),
    );
  }
  await completeRecordedReceipt(input, { paymentIds, recoveredExisting });
  return paymentIds[0] ?? null;
}

/** A payment on the invoice that is this leg's own: same reference, same amount, and not another role's link. */
export async function findReceiptLegPayment(read: InvoiceRead | null, reference: string, amountCents: number) {
  const ids = (read?.invoice.payments ?? []).flatMap((payment) => (payment.paymentID ? [payment.paymentID] : []));
  if (ids.length === 0) return null;
  const others = await prisma.xeroObjectLink.findMany({
    where: { xeroObjectId: { in: ids }, active: true, role: { not: ADDITIONAL_CAPTURE_PAYMENT_ROLE } },
    select: { xeroObjectId: true },
  });
  return legOwnsPayment(read, reference, amountCents, new Set(others.map((link) => link.xeroObjectId)));
}

function alreadyRecordedNote(paymentIds: readonly string[]): string {
  return paymentIds.length > 0 ? `Already recorded: ${paymentIds.join(", ")}.` : "";
}

export async function completeRecordedReceipt(
  input: {
    plan: AdditionalCaptureReceiptPlan;
    paymentTransactionId: string;
    paymentIntentId: string;
    paymentId: string;
    bookingId: string;
    operationId: string;
    syncOperation: XeroOperationClaim;
    alertOfficer: (paymentIntentId: string, operationId: string, message: string) => Promise<void>;
  },
  recorded: { paymentIds: string[]; recoveredExisting: boolean },
): Promise<void> {
  const { plan } = input;
  const unrecordedCents = receiptUnrecordedCents(plan);
  const firstPaymentId = recorded.paymentIds[0];
  if (!firstPaymentId) return;
  await completeXeroSyncOperation(input.syncOperation, {
    responsePayload: {
      paymentId: firstPaymentId,
      paymentIds: recorded.paymentIds,
      plan,
      recoveredExisting: recorded.recoveredExisting,
      unrecordedCents,
    },
    xeroObjectType: "PAYMENT",
    xeroObjectId: firstPaymentId,
    xeroObjectUrl: buildXeroInvoiceUrl(plan.invoiceId),
    extraLinks: plan.legs.map((leg, index) => ({
      localModel: "PaymentTransaction" as const,
      localId: input.paymentTransactionId,
      xeroObjectType: "PAYMENT" as const,
      xeroObjectId: recorded.paymentIds[index] ?? firstPaymentId,
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      metadata: { invoiceId: leg.invoiceId, target: leg.target, amountCents: leg.amountCents, paymentIntentId: input.paymentIntentId },
    })),
  });
  if (unrecordedCents > 0) {
    const format = await clubFormatValues();
    const placed = plan.legs.map((leg) => `${formatCents(leg.amountCents, format)} on ${leg.invoiceId}`).join(", ");
    const message = `A card payment for a booking change was recorded in Xero for ${placed} of the ${formatCents(plan.capturedCents, format)} captured. The remaining ${formatCents(unrecordedCents, format)} is not on any Xero invoice.`;
    logger.error({ operationId: input.operationId, bookingId: input.bookingId, paymentIntentId: input.paymentIntentId, plan, unrecordedCents }, message);
    await input.alertOfficer(input.paymentIntentId, input.operationId, message);
  }
  if (plan.target !== "PRIMARY_INVOICE") await flagRefundNotesNamingAnotherInvoice(input, plan.invoiceId);
  await answerKeptLateCaptureRefunds(input.paymentIntentId);
}

/**
 * A Stripe refund of this capture taken before its receipt reached Xero queued
 * a refund note naming the booking's own invoice. The note is unallocated, so
 * the books balance either way, but it names the wrong document; an officer is
 * told, once, for the first invoice this receipt pays.
 */
async function flagRefundNotesNamingAnotherInvoice(
  input: {
    paymentIntentId: string;
    paymentId: string;
    operationId: string;
    alertOfficer: (paymentIntentId: string, operationId: string, message: string) => Promise<void>;
  },
  receiptInvoiceId: string,
): Promise<void> {
  const firstRefund = await prisma.paymentRefund.findFirst({
    where: { stripePaymentIntentId: input.paymentIntentId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!firstRefund) return;
  const notes = await prisma.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      localModel: "Payment",
      localId: input.paymentId,
      status: { not: "CANCELLED" },
      createdAt: { gte: firstRefund.createdAt },
    },
    select: { id: true, requestPayload: true },
  });
  const naming = notes.filter((note) => asRecord(note.requestPayload)?.creditsInvoiceId !== receiptInvoiceId);
  if (naming.length === 0) return;
  await input.alertOfficer(
    input.paymentIntentId,
    input.operationId,
    `This card payment was refunded before its Xero receipt was recorded against supplementary invoice ${receiptInvoiceId}, and its refund credit note (outbox operation ${naming.map((note) => note.id).join(", ")}) names the booking's own invoice instead. The amounts balance; check the note's reference in Xero.`,
  );
}
