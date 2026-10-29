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
import { reserveOrganiserExtraRacedCash } from "@/lib/organiser-extra-raced-cash";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import type { OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

const WAIVER_LINE = "Unpaid organiser extra released; no cancellation percentage applies";
const REFUND_LINE = "Refund paid back to the group organiser by bank transfer";

export async function executeOrganiserExtraAdjustment(payload: OrganiserExtraAdjustmentPayload, claim: XeroOperationClaim): Promise<void> {
  const operation = await prisma.xeroSyncOperation.findUniqueOrThrow({
    where: { id: claim.id },
    select: { xeroObjectId: true, correlationKey: true },
  });
  let invoiceId = payload.invoiceId;
  if (!invoiceId && payload.modificationId) {
    const link = await prisma.xeroObjectLink.findFirst({
      where: { localModel: "BookingModification", localId: payload.modificationId, role: "SUPPLEMENTARY_INVOICE", active: true },
      select: { xeroObjectId: true },
    });
    invoiceId = link?.xeroObjectId ?? null;
  }
  if (!invoiceId) throw new XeroAppliedCreditOperationBusyError("Organiser extra adjustment waits for its queued invoice", "PENDING");
  const extraInvoiceId = invoiceId;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const readInvoice = async (context: string) => {
    const response = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, extraInvoiceId), {
      operation: "getInvoice", resourceType: "INVOICE", workflow: "organiserExtraAdjustment", context: `${context} ${extraInvoiceId}`,
    });
    return response.body.invoices?.[0];
  };
  const invoice = await readInvoice("organiser extra");
  if (!invoice?.invoiceID) throw new Error("Organiser extra invoice was not found");
  let dueCents = providerAmountToCents(invoice.amountDue);
  const { classifyXeroInvoiceCashEvidence, quantifyXeroInvoiceCashCents } = await import("@/lib/xero-inbound/invoice-paid-effects");
  const cash = quantifyXeroInvoiceCashCents(invoice);
  let cashCents = cash.knownCents;
  if (dueCents === null || !cash.complete || classifyXeroInvoiceCashEvidence(invoice) === "indeterminate") {
    throw new Error("Organiser extra invoice amounts are unreadable");
  }
  if (payload.modificationId) await syncOrganiserExtraInvoiceCash(invoice);
  const key = operation.correlationKey ?? claim.id;
  const date = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
  const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: payload.bookingId }, select: { id: true } });

  if (payload.purpose === "waive" && !operation.xeroObjectId) {
    // A bank-feed reconciliation may race the app's local read. Recognise that
    // cash and reserve its policy refund before completing the old waiver.
    if (payload.modificationId) await reserveOrganiserExtraRacedCash(payload.bookingId, { modificationId: payload.modificationId, invoiceId: extraInvoiceId, cashCents });
    // F3: Xero voids only an invoice with no money on it - no payment, and no
    // credit allocated (an earlier waiver's note is one). The combined
    // invoice's own classifier answers that (`INV-SSOT`).
    const { classifyGroupSettlementInvoiceState } = await import("@/lib/xero-group-settlement-invoice-voids");
    const state = classifyGroupSettlementInvoiceState(invoice);
    if (state.kind === "void") {
      await completeXeroSyncOperation(claim, { responsePayload: { alreadyVoided: true } });
      return;
    }
    if (state.kind === "open" && dueCents > 0 && payload.amountCents >= dueCents) {
      await callXeroApi(
        () => xero.accountingApi.updateInvoice(tenantId, extraInvoiceId, { invoices: [{ invoiceID: extraInvoiceId, status: Invoice.StatusEnum.VOIDED }] }, undefined, `${key}:void`),
        { operation: "updateInvoice", resourceType: "INVOICE", workflow: "organiserExtraAdjustment", context: `void organiser extra ${extraInvoiceId}` },
      );
      await completeXeroSyncOperation(claim, { responsePayload: { voided: true, invoiceId: extraInvoiceId } });
      return;
    }
    if (dueCents <= 0) {
      await completeXeroSyncOperation(claim, { responsePayload: { nothingDue: true, invoiceId: extraInvoiceId } });
      return;
    }
  }

  if (payload.purpose === "refund") {
    // Refund notes mirror a bank transfer already sent. Do not pay one out
    // while a delayed/failed waiver still leaves this invoice collectible.
    if (dueCents > 0) throw new XeroAppliedCreditOperationBusyError("Organiser refund awaits its unpaid-balance waiver", "PENDING");
    if (!payload.handBackTaskId) throw new Error("Organiser refund note has no completed bank-transfer hand-back");
    const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: payload.handBackTaskId }, select: { status: true } });
    if (task.status !== "COMPLETED") throw new XeroAppliedCreditOperationBusyError("Organiser refund awaits its bank-transfer hand-back", "PENDING");
  }
  const amountCents = payload.purpose === "waive" ? Math.min(payload.amountCents, dueCents) : payload.amountCents;
  let noteId = operation.xeroObjectId;
  if (!noteId) {
    const account = await getResolvedAccountMapping("hutFeeRefunds");
    if (!invoice.contact?.contactID) throw new Error("Organiser invoice has no Xero contact");
    const waive = payload.purpose === "waive";
    const reference = `Booking ${payload.bookingId} — ${waive ? "unpaid extra waived" : "organiser bank-transfer refund"} (${invoice.invoiceNumber ?? extraInvoiceId})`;
    const created = await callXeroApi(
      () => xero.accountingApi.createCreditNotes(tenantId, { creditNotes: [{
        type: CreditNote.TypeEnum.ACCRECCREDIT, contact: { contactID: invoice.contact!.contactID }, date,
        status: CreditNote.StatusEnum.AUTHORISED, lineAmountTypes: LineAmountTypes.Inclusive, reference,
        lineItems: [{ description: waive ? WAIVER_LINE : REFUND_LINE, quantity: 1, unitAmount: amountCents / 100, accountCode: account.code ?? "200" }],
      }] }, undefined, undefined, `${key}:credit-note`),
      { operation: "createCreditNotes", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `credit organiser invoice ${extraInvoiceId}` },
    );
    noteId = created.body.creditNotes?.[0]?.creditNoteID ?? null;
    if (!noteId) throw new Error("Xero did not create the organiser credit note");
    // Persist the returned identity BEFORE allocation/payment. A retry never
    // depends solely on the provider's expiring idempotency cache.
    const saved = await prisma.xeroSyncOperation.updateMany({
      where: { id: claim.id, status: "RUNNING", startedAt: claim.startedAt },
      data: { xeroObjectId: noteId, xeroObjectType: "CREDIT_NOTE" },
    });
    if (saved.count !== 1) throw new Error("Organiser adjustment lost its operation claim");
  }
  const creditNoteId = noteId;
  if (payload.purpose === "waive") {
    const noteResponse = await callXeroApi(() => xero.accountingApi.getCreditNote(tenantId, creditNoteId), {
      operation: "getCreditNote", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `read waiver ${creditNoteId}`,
    });
    const note = noteResponse.body.creditNotes?.[0];
    if (!note?.creditNoteID || String(note.status) === "VOIDED" || String(note.status) === "DELETED") {
      throw new Error("Organiser waiver credit note is missing or voided");
    }
    // Note creation/read can take long enough for a bank-feed payment to land.
    // Size the allocation from a fresh invoice, not the pre-create snapshot.
    const latestInvoice = await readInvoice("refresh organiser extra");
    const latestCash = latestInvoice && quantifyXeroInvoiceCashCents(latestInvoice);
    dueCents = latestInvoice ? providerAmountToCents(latestInvoice.amountDue) : null;
    if (!latestInvoice?.invoiceID || dueCents === null || !latestCash?.complete || classifyXeroInvoiceCashEvidence(latestInvoice) === "indeterminate") {
      throw new Error("Organiser extra invoice amounts are unreadable");
    }
    cashCents = latestCash.knownCents;
    if (payload.modificationId) await syncOrganiserExtraInvoiceCash(latestInvoice);
    const alreadyAllocated = (note.allocations ?? []).reduce(
      (sum, a) => sum + (a.invoice?.invoiceID === extraInvoiceId ? providerAmountToCents(a.amount) ?? 0 : 0), 0,
    );
    let totalCents = providerAmountToCents(note.total);
    if (totalCents === null) throw new Error("Organiser waiver note total is unreadable");
    // A payment between create and allocate can make the first note too large.
    // Re-read on every attempt and shrink an unallocated note before applying it.
    if (payload.modificationId) await reserveOrganiserExtraRacedCash(payload.bookingId, { modificationId: payload.modificationId, invoiceId: extraInvoiceId, cashCents });
    const revisedTotalCents = Math.min(totalCents, dueCents + alreadyAllocated);
    if (revisedTotalCents < totalCents) {
      if (alreadyAllocated > 0 || (note.payments?.length ?? 0) > 0 || (note.allocations?.length ?? 0) > 0) {
        throw new Error("Organiser waiver was settled elsewhere before it could be resized");
      }
      const resized = revisedTotalCents === 0
        ? { status: CreditNote.StatusEnum.VOIDED }
        : { lineItems: [{ ...note.lineItems?.[0], description: WAIVER_LINE, quantity: 1, unitAmount: revisedTotalCents / 100 }] };
      await callXeroApi(
        () => xero.accountingApi.updateCreditNote(tenantId, creditNoteId, { creditNotes: [{ creditNoteID: creditNoteId, ...resized }] }, undefined, `${key}:resize:${cashCents}:${revisedTotalCents}`),
        { operation: "updateCreditNote", resourceType: "CREDIT_NOTE", workflow: "organiserExtraAdjustment", context: `resize organiser waiver ${creditNoteId}` },
      );
      totalCents = revisedTotalCents;
    }
    const remainingCents = totalCents - alreadyAllocated;
    if (remainingCents > 0) {
      await callXeroApi(
        () => xero.accountingApi.createCreditNoteAllocation(tenantId, creditNoteId, { allocations: [{ invoice: { invoiceID: extraInvoiceId }, amount: remainingCents / 100, date }] }, undefined, `${key}:allocation:${remainingCents}`),
        { operation: "createCreditNoteAllocation", resourceType: "ALLOCATION", workflow: "organiserExtraAdjustment", context: `allocate organiser waiver ${creditNoteId}` },
      );
    }
    await completeXeroSyncOperation(claim, {
      xeroObjectId: creditNoteId, xeroObjectType: "CREDIT_NOTE",
      responsePayload: { invoiceId: extraInvoiceId, amountCents: totalCents, allocated: true },
      extraLinks: [{ localModel: "Booking", localId: payload.bookingId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId, role: "ORGANISER_EXTRA_WAIVER", metadata: { invoiceId: extraInvoiceId, amountCents: totalCents } }],
    });
  } else {
    const settlement = await settleRefundNoteFromXero({
      paymentId: payment.id, creditNoteId, creationKeys: [key], refundMethod: "internet-banking", refundMethodRecorded: true, fallbackPaymentDate: async () => date,
    });
    if (settlement.outcome.refundPaymentErr) throw settlement.outcome.refundPaymentErr;
    await completeXeroSyncOperation(claim, {
      xeroObjectId: creditNoteId, xeroObjectType: "CREDIT_NOTE",
      responsePayload: { invoiceId: extraInvoiceId, amountCents, refundPayment: settlement.outcome.refundPaymentResponseBody, refundPaymentSkipped: settlement.outcome.refundPaymentSkipReason },
      extraLinks: [{ localModel: "Payment", localId: payment.id, xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId, role: "ORGANISER_EXTRA_REFUND", metadata: { invoiceId: extraInvoiceId, amountCents, handBackTaskId: payload.handBackTaskId } }],
    });
  }
}
