/** Xero-only correction of existing credit; shared with Ledger M5 (#4517, #5241). */
import { CreditNote, Invoice, type XeroClient } from "xero-node";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { xeroOffsettingLineAmountTypes } from "@/lib/xero-tax-rendering";

type Session = { xero: XeroClient; tenantId: string };
export interface XeroCreditNoteCorrectionInput {
  noteId: string;
  cents: number;
  mode: "VOID" | "INVOICE";
  /** Stable, unique per request and note; also used to recover a lost create reply. */
  reference: string;
  keyBase: string;
  /** Durable caller fence, set before a write that might land without a reply. */
  beforeMutation?: () => Promise<void>;
}
export interface XeroCreditNoteCorrectionResult {
  xeroInvoiceId: string | null;
  xeroAllocationId: string | null;
}

function meter(operation: string, resourceType: "CREDIT_NOTE" | "INVOICE" | "ALLOCATION") {
  return { operation, resourceType, workflow: "correctXeroCreditNote", context: operation } as const;
}

async function readNote({ xero, tenantId }: Session, noteId: string): Promise<CreditNote> {
  const response = await callXeroApi(() => xero.accountingApi.getCreditNote(tenantId, noteId), meter("getCreditNote", "CREDIT_NOTE"));
  const [note, ...rest] = response.body.creditNotes ?? [];
  if (!note || rest.length || note.creditNoteID !== noteId || note.type !== CreditNote.TypeEnum.ACCRECCREDIT || !note.contact?.contactID) {
    throw new Error("NOTE_CHANGED_IN_XERO: the original credit note cannot be verified. Retry after checking Xero.");
  }
  return note;
}

async function findInvoices({ xero, tenantId }: Session, reference: string): Promise<Invoice[]> {
  if (!reference || /["\\\r\n]/.test(reference)) throw new Error("Invalid credit correction reference");
  const response = await callXeroApi(() => xero.accountingApi.getInvoices(
    tenantId, undefined, `Reference=="${reference}"`, undefined, undefined, undefined, undefined, undefined, 1, false,
  ), meter("getInvoices", "INVOICE"));
  return response.body.invoices ?? [];
}

/** Reads only. The caller must claim cancellation against a worker before restoring cents. */
export async function assertXeroCreditNoteCorrectionUntouched(input: { noteId: string; reference: string }): Promise<void> {
  const session = await getAuthenticatedXeroClient();
  const note = await readNote(session, input.noteId);
  const invoices = await findInvoices(session, input.reference);
  if (note.status !== CreditNote.StatusEnum.AUTHORISED && note.status !== CreditNote.StatusEnum.PAID || invoices.length) {
    throw new Error("CORRECTION_ALREADY_STARTED: Xero was changed; retry the correction instead of cancelling.");
  }
}

/**
 * Void a whole untouched note, otherwise bill only the cents taken back and
 * allocate that invoice against the note. Never creates another credit note.
 * Each write has its own stable key and each retry reads provider state first.
 */
export async function correctXeroCreditNote(input: XeroCreditNoteCorrectionInput): Promise<XeroCreditNoteCorrectionResult> {
  if (!Number.isSafeInteger(input.cents) || input.cents <= 0 || !input.keyBase) throw new Error("Invalid credit correction amount or key");
  const session = await getAuthenticatedXeroClient();
  const { xero, tenantId } = session;
  const note = await readNote(session, input.noteId);
  const key = (step: string) => `${input.keyBase}:${input.noteId}:${step}`;
  // The club's calendar day (INV-DATE-019), read once: a retry under the same key sends the same date.
  const documentDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
  const total = exactProviderAmountToCents(note.total);
  const remaining = exactProviderAmountToCents(note.remainingCredit);
  if (input.mode === "VOID") {
    if (total !== input.cents) throw new Error("NOTE_CHANGED_IN_XERO: the note total no longer matches the full deduction.");
    if (note.status === CreditNote.StatusEnum.VOIDED) return { xeroInvoiceId: null, xeroAllocationId: null };
    if (note.status !== CreditNote.StatusEnum.AUTHORISED || remaining !== total || note.allocations?.some(a => !a.isDeleted) || note.payments?.length) {
      throw new Error("NOTE_CHANGED_IN_XERO: the note is no longer wholly unused; cancel and request the deduction again.");
    }
    await input.beforeMutation?.();
    const response = await callXeroApi(() => xero.accountingApi.updateCreditNote(
      tenantId, input.noteId, { creditNotes: [{ creditNoteID: input.noteId, status: CreditNote.StatusEnum.VOIDED }] }, undefined, key("void"),
    ), meter("updateCreditNote", "CREDIT_NOTE"));
    if (response.body.creditNotes?.[0]?.status !== CreditNote.StatusEnum.VOIDED) throw new Error("Xero did not confirm the credit note was voided");
    return { xeroInvoiceId: null, xeroAllocationId: null };
  }

  const lines = note.lineItems ?? [];
  const first = lines[0];
  if (!first?.accountCode || !first.taxType || lines.some(line => line.accountCode !== first.accountCode || line.taxType !== first.taxType)) {
    throw new Error("NOTE_MIXED_LINES: the credit note has mixed or missing account codes or tax rates; cancel this correction and ask the treasurer to check the note.");
  }
  const candidates = await findInvoices(session, input.reference);
  if (candidates.length > 1) throw new Error("CORRECTION_INVOICE_CHANGED: several invoices use the correction reference.");
  let invoice: Invoice | undefined = candidates[0];
  if (!invoice) {
    if (note.status !== CreditNote.StatusEnum.AUTHORISED || remaining === null || remaining < input.cents) {
      throw new Error("NOTE_CHANGED_IN_XERO: the credit note has insufficient free credit for this deduction.");
    }
    await input.beforeMutation?.();
    const response = await callXeroApi(() => xero.accountingApi.createInvoices(tenantId, { invoices: [{
      type: Invoice.TypeEnum.ACCREC,
      status: Invoice.StatusEnum.AUTHORISED,
      contact: { contactID: note.contact!.contactID },
      reference: input.reference,
      sentToContact: false,
      date: documentDate,
      dueDate: documentDate,
      currencyCode: note.currencyCode,
      lineAmountTypes: xeroOffsettingLineAmountTypes(note),
      lineItems: [{ description: input.reference, quantity: 1, unitAmount: input.cents / 100, accountCode: first.accountCode, taxType: first.taxType }],
    }] }, undefined, undefined, key("invoice")), meter("createInvoices", "INVOICE"));
    invoice = response.body.invoices?.[0];
  }
  if (!invoice?.invoiceID || invoice.reference !== input.reference || invoice.type !== Invoice.TypeEnum.ACCREC ||
    invoice.contact?.contactID !== note.contact!.contactID || exactProviderAmountToCents(invoice.total) !== input.cents ||
    invoice.currencyCode !== note.currencyCode || !invoice.lineItems?.length ||
    invoice.lineItems.some(line => line.accountCode !== first.accountCode || line.taxType !== first.taxType) ||
    invoice.status !== Invoice.StatusEnum.AUTHORISED && invoice.status !== Invoice.StatusEnum.PAID) {
    throw new Error("CORRECTION_INVOICE_CHANGED: the invoice with this reference does not match the correction; check Xero before retrying.");
  }
  const invoiceId = invoice.invoiceID;
  const allocated = (note.allocations ?? []).filter(a => !a.isDeleted && a.invoice?.invoiceID === invoiceId);
  if (allocated.length) {
    if (allocated.length !== 1 || exactProviderAmountToCents(allocated[0]!.amount) !== input.cents || !allocated[0]!.allocationID) {
      throw new Error("CORRECTION_INVOICE_CHANGED: the correction allocation no longer matches the deduction.");
    }
    return { xeroInvoiceId: invoiceId, xeroAllocationId: allocated[0]!.allocationID! };
  }
  if (note.status !== CreditNote.StatusEnum.AUTHORISED || remaining === null || remaining < input.cents ||
    invoice.status !== Invoice.StatusEnum.AUTHORISED || exactProviderAmountToCents(invoice.amountDue) !== input.cents) {
    throw new Error("NOTE_CHANGED_IN_XERO: the correction invoice or the credit note has already been used; check Xero and retry.");
  }
  await input.beforeMutation?.();
  const response = await callXeroApi(() => xero.accountingApi.createCreditNoteAllocation(
    tenantId, input.noteId, { allocations: [{ invoice: { invoiceID: invoiceId }, amount: input.cents / 100, date: documentDate }] }, undefined, key("allocation"),
  ), meter("createCreditNoteAllocation", "ALLOCATION"));
  const allocation = response.body.allocations?.[0];
  if (!allocation?.allocationID || allocation.invoice?.invoiceID !== invoiceId || exactProviderAmountToCents(allocation.amount) !== input.cents) {
    throw new Error("Xero did not confirm the correction allocation; retry to read its result");
  }
  return { xeroInvoiceId: invoiceId, xeroAllocationId: allocation.allocationID };
}
