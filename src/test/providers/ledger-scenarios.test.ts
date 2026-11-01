import { describe, expect, it } from "vitest";
import { observeInvoicePayables } from "@/lib/xero-invoice-payable-observation";
import { judgeRefundNoteWrite, xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";
import { XeroFake } from "./xero-fake";
import { StripeFake } from "./stripe-fake";
import { ingestProviders, invoiceWire, RoundTripJournal } from "./round-trip-harness";

/** Executable provider/model witnesses from #4461's ledger list, not bug closures. */
describe("ledger-switch scenarios against stateful providers", () => {
  it("#3911: voiding an unpaid edit credit leaves the bank-transfer debt unpaid, with no cash", () => {
    const xero = new XeroFake(); const stripe = new StripeFake();
    const c = xero.createContact("contact", "member-a");
    const i = xero.createInvoice("invoice", c.contactID, 10000);
    const n = xero.createCreditNote("edit", c.contactID, 2000);
    const a = xero.allocate("allocation", n.creditNoteID, i.invoiceID, 2000);
    expect(xero.snapshot().invoices[0]).toMatchObject({ amountDueCents: 8000, amountPaidCents: 0 });
    xero.removeAllocation(a.allocationID); xero.voidCreditNote(n.creditNoteID);
    // Use the real production observer at the wire boundary.
    expect(observeInvoicePayables(invoiceWire(xero), [i.invoiceID], "NZD", new Date().toISOString())[0]).toMatchObject({ kind: "payable", dueCents: 10000 });
    const journal = new RoundTripJournal(); ingestProviders(journal, xero, stripe);
    expect(journal.totals(["member-a"])["member-a"]).toMatchObject({ charged: 10000, bank: 0, credit: 0, allocated: 0 });
  });

  it("#4336: a retained live reading arriving after a void cannot revive the refund note", () => {
    const xero = new XeroFake();
    const c = xero.createContact("contact", "member-a");
    const n = xero.createCreditNote("refund", c.contactID, 2000);
    const old = xeroCreditNoteSnapshotMetadata({ ...xero.snapshot().creditNotes[0], total: 20, updatedDateUTC: new Date() });
    xero.voidCreditNote(n.creditNoteID);
    const current = xeroCreditNoteSnapshotMetadata({ ...xero.snapshot().creditNotes[0], total: 20, updatedDateUTC: new Date() });
    // The production terminal-void rule wins even at equal frozen timestamps.
    expect(judgeRefundNoteWrite(old, current)).toBe("keep-stored-snapshot");
    expect(old.status).toBe("AUTHORISED");
    expect(current.status).toBe("VOIDED");
  });

  it("#4434: an $80 receipt needs two invoices when the first has only $50 room", () => {
    const xero = new XeroFake(); const stripe = new StripeFake();
    const c = xero.createContact("contact", "member-a");
    const first = xero.createInvoice("primary", c.contactID, 5000);
    const second = xero.createInvoice("change", c.contactID, 3000);
    expect(() => xero.payInvoice("wrong", first.invoiceID, 8000)).toThrow("Payment amount exceeds");
    expect(xero.snapshot().payments).toHaveLength(0);
    xero.payInvoice("first-receipt", first.invoiceID, 5000);
    xero.payInvoice("second-receipt", second.invoiceID, 3000);
    // Retry both writes after a lost response: neither duplicates cash.
    xero.payInvoice("first-receipt", first.invoiceID, 5000);
    xero.payInvoice("second-receipt", second.invoiceID, 3000);
    const journal = new RoundTripJournal(); ingestProviders(journal, xero, stripe);
    expect(journal.totals(["member-a"])["member-a"]).toMatchObject({ charged: 8000, bank: 8000 });
    expect(xero.snapshot().invoices.map(i => i.amountDueCents)).toEqual([0, 0]);
  });

  it("#4380: a late $50 capture and its dashboard refund net to zero", () => {
    const xero = new XeroFake(); const stripe = new StripeFake();
    const i = stripe.createIntent("late", "member-a", 5000);
    stripe.capture("capture", i.id, 5000);
    stripe.dashboardRefund(i.id, 5000);
    const c = xero.createContact("contact", "member-a");
    const invoice = xero.createInvoice("late-capture", c.contactID, 5000);
    xero.payInvoice("receipt", invoice.invoiceID, 5000);
    const note = xero.createCreditNote("hand-back", c.contactID, 5000);
    // A paid invoice refuses allocation; a credit-note payment records the refund.
    expect(() => xero.allocate("wrong", note.creditNoteID, invoice.invoiceID, 5000)).toThrow("already been paid off");
    xero.payCreditNote("refund", note.creditNoteID, 5000);
    const journal = new RoundTripJournal(); ingestProviders(journal, xero, stripe);
    const totals = journal.totals(["member-a"])["member-a"];
    expect(totals.card - totals.refunded).toBe(0);
    expect(totals).toMatchObject({ card: 5000, refunded: 5000 });
    expect(totals).toMatchObject({ charged: 5000, credit: 5000, bank: 0 });
    expect(xero.snapshot().payments.map(p => p.amountCents)).toEqual([5000, 5000]);
  });
});
