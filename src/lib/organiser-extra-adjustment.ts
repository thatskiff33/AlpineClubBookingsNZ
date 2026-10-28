/** Durable Xero execution for organiser-extra waivers and bank-refund notes. */
import { CreditNote, Invoice, LineAmountTypes } from "xero-node";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { settleRefundNoteFromXero } from "@/lib/xero-refund-note-settlement";
import { syncOrganiserExtraInvoiceCash } from "@/lib/organiser-extra-receipt";
import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { bindOrganiserExtraRefundToHandBack, reserveOrganiserExtraNetting } from "@/lib/organiser-extra-netting";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";
import type { OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

export async function executeOrganiserExtraAdjustment(payload: OrganiserExtraAdjustmentPayload, claim: XeroOperationClaim): Promise<void> {
  const operation = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: claim.id }, select: { xeroObjectId: true, correlationKey: true } });
  let invoiceId = payload.invoiceId;
  if (!invoiceId && payload.modificationId) {
    const link = await prisma.xeroObjectLink.findFirst({ where: { localModel: "BookingModification", localId: payload.modificationId, role: "SUPPLEMENTARY_INVOICE", active: true }, select: { xeroObjectId: true } });
    invoiceId = link?.xeroObjectId ?? null;
  }
  if (!invoiceId) throw new XeroAppliedCreditOperationBusyError("Organiser extra adjustment waits for its queued invoice", "PENDING");
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoiceResponse = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, invoiceId!), { operation: "getInvoice", resourceType: "INVOICE", workflow: "organiserExtraAdjustment", context: `organiser extra ${invoiceId}` });
  const invoice = invoiceResponse.body.invoices?.[0];
  if (!invoice?.invoiceID) throw new Error("Organiser extra invoice was not found");
  let dueCents = providerAmountToCents(invoice.amountDue);
  const { classifyXeroInvoiceCashEvidence, quantifyXeroInvoiceCashCents } = await import("@/lib/xero-inbound/invoice-paid-effects");
  const cash = quantifyXeroInvoiceCashCents(invoice);
  let cashCents = cash.knownCents;
  if (dueCents === null || !cash.complete || classifyXeroInvoiceCashEvidence(invoice) === "indeterminate") throw new Error("Organiser extra invoice amounts are unreadable");
  if (payload.modificationId) await syncOrganiserExtraInvoiceCash(invoice);
  const key = operation.correlationKey ?? claim.id;
  const date = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
  const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: payload.bookingId }, select: { id: true } });

  if (payload.purpose === "waive" && !operation.xeroObjectId) {
    // A bank-feed reconciliation may race the app's local read. Recognise that
    // cash and reserve its policy refund before completing the old waiver.
    await reserveCashThatRacedWaiver(payload, cashCents, Math.max(0, payload.amountCents - dueCents), claim.id);
    if (String(invoice.status) === "VOIDED" || String(invoice.status) === "DELETED") {
      await completeXeroSyncOperation(claim, { responsePayload: { alreadyVoided: true } });
      return;
    }
    if (cashCents === 0 && dueCents > 0 && payload.amountCents >= dueCents) {
      await callXeroApi(() => xero.accountingApi.updateInvoice(tenantId, invoiceId!, { invoices: [{ invoiceID: invoiceId!, status: Invoice.StatusEnum.VOIDED }] }, undefined, `${key}:void`), { operation: "updateInvoice", resourceType: "INVOICE", workflow: "organiserExtraAdjustment", context: `void organiser extra ${invoiceId}` });
      await completeXeroSyncOperation(claim, { responsePayload: { voided: true, invoiceId } });
      return;
    }
    if (dueCents <= 0) {
      await completeXeroSyncOperation(claim, { responsePayload: { nothingDue: true, invoiceId } });
      return;
    }
  }

  if (payload.purpose === "refund") {
    if (!payload.handBackTaskId) throw new Error("Organiser refund note has no completed bank-transfer hand-back");
    const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: payload.handBackTaskId }, select: { status: true } });
    if (task.status !== "COMPLETED") throw new XeroAppliedCreditOperationBusyError("Organiser refund awaits its bank-transfer hand-back", "PENDING");
  }
  const amountCents = payload.purpose === "waive" ? Math.min(payload.amountCents, dueCents) : payload.amountCents;
  let noteId = operation.xeroObjectId;
  if (!noteId) {
    const account = await getResolvedAccountMapping("hutFeeRefunds");
    if (!invoice.contact?.contactID) throw new Error("Organiser invoice has no Xero contact");
    const created = await callXeroApi(() => xero.accountingApi.createCreditNotes(tenantId, { creditNotes: [{ type: CreditNote.TypeEnum.ACCRECCREDIT, contact: { contactID: invoice.contact!.contactID }, date, status: CreditNote.StatusEnum.AUTHORISED, lineAmountTypes: LineAmountTypes.Inclusive,
      reference: `Booking ${payload.bookingId} — ${payload.purpose === "waive" ? "unpaid extra waived" : "organiser bank-transfer refund"} (${invoice.invoiceNumber ?? invoiceId})`,
      lineItems: [{ description: payload.purpose === "waive" ? "Unpaid organiser extra released; no cancellation percentage applies" : "Refund paid back to the group organiser by bank transfer", quantity: 1, unitAmount: amountCents / 100, accountCode: account.code ?? "200" }],
    }] }, undefined, undefined, `${key}:credit-note`), { operation: "createCreditNotes", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `credit organiser invoice ${invoiceId}` });
    noteId = created.body.creditNotes?.[0]?.creditNoteID ?? null;
    if (!noteId) throw new Error("Xero did not create the organiser credit note");
    // Persist the returned identity BEFORE allocation/payment. A retry never
    // depends solely on the provider's expiring idempotency cache.
    const saved = await prisma.xeroSyncOperation.updateMany({ where: { id: claim.id, status: "RUNNING", startedAt: claim.startedAt }, data: { xeroObjectId: noteId, xeroObjectType: "CREDIT_NOTE" } });
    if (saved.count !== 1) throw new Error("Organiser adjustment lost its operation claim");
  }
  if (payload.purpose === "waive") {
    const noteResponse = await callXeroApi(() => xero.accountingApi.getCreditNote(tenantId, noteId!), { operation: "getCreditNote", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `read waiver ${noteId}` });
    const note = noteResponse.body.creditNotes?.[0];
    if (!note?.creditNoteID || String(note.status) === "VOIDED" || String(note.status) === "DELETED") throw new Error("Organiser waiver credit note is missing or voided");
    // Note creation/read can take long enough for a bank-feed payment to land.
    // Size the allocation from a fresh invoice, not the pre-create snapshot.
    const latestResponse = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, invoiceId!), { operation: "getInvoice", resourceType: "INVOICE", workflow: "organiserExtraAdjustment", context: `refresh organiser extra ${invoiceId}` });
    const latestInvoice = latestResponse.body.invoices?.[0];
    const latestCash = latestInvoice && quantifyXeroInvoiceCashCents(latestInvoice);
    dueCents = latestInvoice ? providerAmountToCents(latestInvoice.amountDue) : null;
    if (!latestInvoice?.invoiceID || dueCents === null || !latestCash?.complete || classifyXeroInvoiceCashEvidence(latestInvoice) === "indeterminate") throw new Error("Organiser extra invoice amounts are unreadable");
    cashCents = latestCash.knownCents;
    if (payload.modificationId) await syncOrganiserExtraInvoiceCash(latestInvoice);
    const alreadyAllocated = (note.allocations ?? []).reduce((sum, a) => sum + (a.invoice?.invoiceID === invoiceId ? providerAmountToCents(a.amount) ?? 0 : 0), 0);
    let totalCents = providerAmountToCents(note.total);
    if (totalCents === null) throw new Error("Organiser waiver note total is unreadable");
    // A payment between create and allocate can make the first note too large.
    // Re-read on every attempt and shrink an unallocated note before applying it.
    // Add OUR allocation back to due when measuring raced cash on a retry.
    await reserveCashThatRacedWaiver(payload, cashCents, Math.max(0, payload.amountCents - dueCents - alreadyAllocated), claim.id);
    const revisedTotalCents = Math.min(totalCents, dueCents + alreadyAllocated);
    if (revisedTotalCents < totalCents) {
      if (alreadyAllocated > 0 || (note.payments?.length ?? 0) > 0 || (note.allocations?.length ?? 0) > 0) throw new Error("Organiser waiver was settled elsewhere before it could be resized");
      await callXeroApi(() => xero.accountingApi.updateCreditNote(tenantId, noteId!, { creditNotes: [{ creditNoteID: noteId!,
        ...(revisedTotalCents === 0 ? { status: CreditNote.StatusEnum.VOIDED } : { lineItems: [{ ...note.lineItems?.[0], description: "Unpaid organiser extra released; no cancellation percentage applies", quantity: 1, unitAmount: revisedTotalCents / 100 }] }),
      }] }, undefined, `${key}:resize:${cashCents}:${revisedTotalCents}`), { operation: "updateCreditNote", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `resize organiser waiver ${noteId}` });
      totalCents = revisedTotalCents;
    }
    const remainingCents = totalCents - alreadyAllocated;
    if (remainingCents > 0) {
      await callXeroApi(() => xero.accountingApi.createCreditNoteAllocation(tenantId, noteId!, { allocations: [{ invoice: { invoiceID: invoiceId! }, amount: remainingCents / 100, date }] }, undefined, `${key}:allocation:${remainingCents}`), { operation: "createCreditNoteAllocation", resourceType: "ALLOCATION", workflow: "organiserExtraAdjustment", context: `allocate organiser waiver ${noteId}` });
    }
    await completeXeroSyncOperation(claim, { xeroObjectId: noteId, xeroObjectType: "CREDIT_NOTE", responsePayload: { invoiceId, amountCents: totalCents, allocated: true }, extraLinks: [{ localModel: "Booking", localId: payload.bookingId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, role: "ORGANISER_EXTRA_WAIVER", metadata: { invoiceId, amountCents: totalCents } }] });
  } else {
    const settlement = await settleRefundNoteFromXero({ paymentId: payment.id, creditNoteId: noteId, creationKeys: [key], refundMethod: "internet-banking", refundMethodRecorded: true, fallbackPaymentDate: async () => date });
    if (settlement.outcome.refundPaymentErr) throw settlement.outcome.refundPaymentErr;
    await completeXeroSyncOperation(claim, { xeroObjectId: noteId, xeroObjectType: "CREDIT_NOTE", responsePayload: { invoiceId, amountCents, refundPayment: settlement.outcome.refundPaymentResponseBody, refundPaymentSkipped: settlement.outcome.refundPaymentSkipReason }, extraLinks: [{ localModel: "Payment", localId: payment.id, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, role: "ORGANISER_EXTRA_REFUND", metadata: { invoiceId, amountCents, handBackTaskId: payload.handBackTaskId } }] });
  }
}

async function reserveCashThatRacedWaiver(payload: OrganiserExtraAdjustmentPayload, cashCents: number, waivedCentsNowPaid: number, operationId: string): Promise<void> {
  if (!payload.modificationId || cashCents <= payload.cashAtPlanCents || waivedCentsNowPaid <= 0) return;
  const modification = await prisma.bookingModification.findUniqueOrThrow({ where: { id: payload.modificationId }, select: { priceDiffCents: true, changeFeeCents: true } });
  const newlyPaidPriceCents = Math.max(0, Math.min(cashCents, modification.priceDiffCents + modification.changeFeeCents) - Math.max(modification.changeFeeCents, payload.cashAtPlanCents));
  const racedBasisCents = Math.min(waivedCentsNowPaid, newlyPaidPriceCents);
  const refundCents = Math.floor(racedBasisCents * payload.refundPercentage / 100);
  if (refundCents <= 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const occurrenceKey = editRefundHandBackOccurrenceKey(`organiser-extra-racing-cash:${operationId}:${cashCents}`);
    const previous = await tx.manualRefundTask.findUnique({ where: { occurrenceKey }, select: { id: true } });
    if (previous) return;
    const priorPlans = await tx.xeroSyncOperation.findMany({ where: { queueType: payload.queueType, localId: payload.bookingId }, select: { requestPayload: true } });
    const reservedBasisCents = priorPlans.map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)).reduce((sum, plan) => sum + (plan?.scopeId.startsWith(`racing-cash:${operationId}:`) ? plan.priceBasisCents ?? 0 : 0), 0);
    const additionalBasisCents = Math.max(0, racedBasisCents - reservedBasisCents);
    const additionalRefundCents = Math.floor(additionalBasisCents * payload.refundPercentage / 100);
    if (additionalRefundCents <= 0) return;
    const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: payload.bookingId }, select: { id: true } });
    const task = await tx.manualRefundTask.create({ data: { bookingId: payload.bookingId, paymentId: payment.id, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey, amountCents: additionalRefundCents, raisedAmountCents: additionalRefundCents, reason: "Refund the group organiser by bank transfer: an extra invoice was paid while its cancellation or reduction was being processed." }, select: { id: true } });
    const scopeId = `racing-cash:${operationId}:${cashCents}`;
    await reserveOrganiserExtraNetting(tx, { state: { bookingId: payload.bookingId, invoices: [{ modificationId: payload.modificationId!, invoiceId: payload.invoiceId, priceCents: modification.priceDiffCents, feeCents: modification.changeFeeCents, cashCents, waivedCents: 0, refundedCents: 0 }] }, scopeId, reductionCents: 0, refundAmountCents: additionalRefundCents, refundBasisCents: additionalBasisCents, refundPercentage: payload.refundPercentage });
    await bindOrganiserExtraRefundToHandBack(tx, { bookingId: payload.bookingId, handBackTaskId: task.id, scopeId });
  });
}
