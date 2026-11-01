import { createReplayWriter } from "./replay-write";

/** Stateful, cent-based subset of Xero Accounting. No transport or credentials. */
type Contact = { contactID: string; memberId: string };
type Invoice = {
  invoiceID: string; contactID: string; totalCents: number;
  status: "AUTHORISED" | "PAID" | "VOIDED";
};
type CreditNote = {
  creditNoteID: string; contactID: string; totalCents: number;
  status: "AUTHORISED" | "PAID" | "VOIDED";
};
type Payment = { paymentID: string; amountCents: number; status: "AUTHORISED" | "DELETED" } &
  ({ invoiceID: string; creditNoteID?: never } | { creditNoteID: string; invoiceID?: never });
type Allocation = { allocationID: string; creditNoteID: string; invoiceID: string; amountCents: number };

export class XeroValidationError extends Error {
  readonly response;
  constructor(message: string) {
    super(message);
    this.name = "XeroValidationError";
    this.response = { statusCode: 400, body: { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: message }] }] } };
  }
}

export class XeroFake {
  private contacts = new Map<string, Contact>();
  private invoices = new Map<string, Invoice>();
  private payments = new Map<string, Payment>();
  private creditNotes = new Map<string, CreditNote>();
  private allocations = new Map<string, Allocation>();
  private readonly write = createReplayWriter(() => new XeroValidationError("Idempotency key reused with different parameters"));

  private cents(value: number) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new XeroValidationError("Amount must be positive integer cents");
  }

  private get<T>(map: Map<string, T>, id: string): T {
    const value = map.get(id);
    if (!value) throw new XeroValidationError("Object not found");
    return value;
  }

  createContact(key: string, memberId: string) {
    return this.write(key, ["contact", memberId], () => {
      if (!memberId.trim()) throw new XeroValidationError("Contact name is required");
      const contact = { contactID: `contact-${this.contacts.size + 1}`, memberId };
      this.contacts.set(contact.contactID, contact);
      return contact;
    });
  }

  createInvoice(key: string, contactID: string, totalCents: number) {
    return this.write(key, ["invoice", contactID, totalCents], () => {
      this.get(this.contacts, contactID);
      if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new XeroValidationError("Invoice total must be non-negative integer cents");
      const invoice: Invoice = { invoiceID: `invoice-${this.invoices.size + 1}`, contactID, totalCents, status: totalCents === 0 ? "PAID" : "AUTHORISED" };
      this.invoices.set(invoice.invoiceID, invoice);
      return invoice;
    });
  }

  createCreditNote(key: string, contactID: string, totalCents: number) {
    return this.write(key, ["credit", contactID, totalCents], () => {
      this.get(this.contacts, contactID);
      this.cents(totalCents);
      const note: CreditNote = { creditNoteID: `credit-${this.creditNotes.size + 1}`, contactID, totalCents, status: "AUTHORISED" };
      this.creditNotes.set(note.creditNoteID, note);
      return note;
    });
  }

  private paid(invoiceID: string) {
    return [...this.payments.values()].filter(p => p.invoiceID === invoiceID && p.status === "AUTHORISED").reduce((n, p) => n + p.amountCents, 0);
  }

  private credited(invoiceID: string) {
    return [...this.allocations.values()].filter(a => a.invoiceID === invoiceID).reduce((n, a) => n + a.amountCents, 0);
  }

  private remaining(note: CreditNote) {
    const allocated = [...this.allocations.values()].filter(a => a.creditNoteID === note.creditNoteID).reduce((n, a) => n + a.amountCents, 0);
    const refunded = [...this.payments.values()].filter(p => p.creditNoteID === note.creditNoteID && p.status === "AUTHORISED").reduce((n, p) => n + p.amountCents, 0);
    return note.totalCents - allocated - refunded;
  }

  private refresh(invoice: Invoice) {
    if (invoice.status !== "VOIDED") invoice.status = invoice.totalCents === this.paid(invoice.invoiceID) + this.credited(invoice.invoiceID) ? "PAID" : "AUTHORISED";
  }

  payInvoice(key: string, invoiceID: string, amountCents: number) {
    return this.write(key, ["payment", invoiceID, amountCents], () => {
      this.cents(amountCents);
      const invoice = this.get(this.invoices, invoiceID);
      if (invoice.status !== "AUTHORISED") throw new XeroValidationError("Invoice not of valid status for payment");
      if (amountCents > invoice.totalCents - this.paid(invoiceID) - this.credited(invoiceID)) throw new XeroValidationError("Payment amount exceeds the amount outstanding on this document");
      const payment: Payment = { paymentID: `payment-${this.payments.size + 1}`, invoiceID, amountCents, status: "AUTHORISED" };
      this.payments.set(payment.paymentID, payment);
      this.refresh(invoice);
      return payment;
    });
  }

  allocate(key: string, creditNoteID: string, invoiceID: string, amountCents: number) {
    return this.write(key, ["allocation", creditNoteID, invoiceID, amountCents], () => {
      this.cents(amountCents);
      const invoice = this.get(this.invoices, invoiceID);
      const note = this.get(this.creditNotes, creditNoteID);
      if (invoice.status === "PAID") throw new XeroValidationError("The invoice you are trying to allocate to has already been paid off");
      if (invoice.status !== "AUTHORISED" || note.status !== "AUTHORISED") throw new XeroValidationError("Document not of valid status for allocation");
      if (invoice.contactID !== note.contactID) throw new XeroValidationError("Credit note and invoice must have the same contact");
      if (amountCents > this.remaining(note) || amountCents > invoice.totalCents - this.paid(invoiceID) - this.credited(invoiceID)) throw new XeroValidationError("Credit Note cannot be allocated as amount is greater than amount outstanding");
      const allocation = { allocationID: `allocation-${this.nextAllocation++}`, creditNoteID, invoiceID, amountCents };
      this.allocations.set(allocation.allocationID, allocation);
      if (this.remaining(note) === 0) note.status = "PAID";
      this.refresh(invoice);
      return allocation;
    });
  }
  private nextAllocation = 1;

  /** A payment on an ACCRECCREDIT records money handed back, not an allocation. */
  payCreditNote(key: string, creditNoteID: string, amountCents: number) {
    return this.write(key, ["credit-payment", creditNoteID, amountCents], () => {
      this.cents(amountCents);
      const note = this.get(this.creditNotes, creditNoteID);
      if (note.status !== "AUTHORISED") throw new XeroValidationError("Credit note not of valid status for payment");
      if (amountCents > this.remaining(note)) throw new XeroValidationError("Payment amount exceeds the amount outstanding on this document");
      const payment: Payment = { paymentID: `payment-${this.payments.size + 1}`, creditNoteID, amountCents, status: "AUTHORISED" };
      this.payments.set(payment.paymentID, payment);
      if (this.remaining(note) === 0) note.status = "PAID";
      return payment;
    });
  }

  removeAllocation(allocationID: string) {
    const allocation = this.get(this.allocations, allocationID);
    this.allocations.delete(allocationID);
    this.get(this.creditNotes, allocation.creditNoteID).status = "AUTHORISED";
    this.refresh(this.get(this.invoices, allocation.invoiceID));
  }

  deletePayment(paymentID: string) {
    const payment = this.get(this.payments, paymentID);
    if (payment.status === "DELETED") return;
    payment.status = "DELETED";
    if (payment.invoiceID !== undefined) this.refresh(this.get(this.invoices, payment.invoiceID));
    else this.get(this.creditNotes, payment.creditNoteID).status = "AUTHORISED";
  }

  voidInvoice(invoiceID: string) {
    const invoice = this.get(this.invoices, invoiceID);
    if (this.paid(invoiceID) || this.credited(invoiceID)) throw new XeroValidationError("Invoice has payments or allocations");
    invoice.status = "VOIDED";
  }

  voidCreditNote(creditNoteID: string) {
    const note = this.get(this.creditNotes, creditNoteID);
    if (this.remaining(note) !== note.totalCents) throw new XeroValidationError("Credit note has allocations or payments");
    note.status = "VOIDED";
  }

  /** Snapshots are detached: a retained read can arrive after a later void. */
  snapshot() {
    return structuredClone({
      contacts: [...this.contacts.values()], payments: [...this.payments.values()], allocations: [...this.allocations.values()],
      invoices: [...this.invoices.values()].map(i => ({ ...i, amountPaidCents: this.paid(i.invoiceID), amountCreditedCents: this.credited(i.invoiceID), amountDueCents: i.status === "VOIDED" ? 0 : i.totalCents - this.paid(i.invoiceID) - this.credited(i.invoiceID) })),
      creditNotes: [...this.creditNotes.values()].map(n => ({ ...n, remainingCreditCents: n.status === "VOIDED" ? 0 : this.remaining(n) })),
    });
  }
}
