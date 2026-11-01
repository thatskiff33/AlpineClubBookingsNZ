import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/provider-contracts.json";
import { StripeFake } from "./stripe-fake";
import { XeroFake } from "./xero-fake";
import { invoiceWire, invoiceWireDueCents } from "./round-trip-harness";

/** Fixed expectations are authored separately in JSON; never regenerate from the fake. */
describe("provider fixture contracts (synthetic; sandbox conformance unverified)", () => {
  it("pins Xero partial payment, allocation refusal, allocation removal, void and payment deletion", () => {
    const xero = new XeroFake();
    const c = xero.createContact("contact", "member-a");
    const i = xero.createInvoice("invoice", c.contactID, 8000);
    const payment = xero.payInvoice("payment", i.invoiceID, 5000);
    expect(invoiceWire(xero).Invoices[0]).toEqual(fixtures.xero.partPaid);
    expect(invoiceWireDueCents(xero)).toEqual([3000]);
    const n = xero.createCreditNote("credit", c.contactID, 3000);
    const a = xero.allocate("allocation", n.creditNoteID, i.invoiceID, 3000);
    expect(invoiceWire(xero).Invoices[0]).toEqual(fixtures.xero.allocated);
    const other = xero.createCreditNote("other-credit", c.contactID, 1000);
    expect(() => xero.allocate("paid-allocation", other.creditNoteID, i.invoiceID, 1000)).toThrow(expect.objectContaining({ response: fixtures.xero.paidAllocationError }));
    xero.removeAllocation(a.allocationID);
    xero.voidCreditNote(n.creditNoteID);
    expect(xero.snapshot().creditNotes[0]).toEqual(fixtures.xero.voidedCredit);
    xero.deletePayment(payment.paymentID);
    expect(xero.snapshot().payments[0]).toEqual(fixtures.xero.deletedPayment);
    expect(invoiceWireDueCents(xero)).toEqual([8000]);
  });

  it("pins Stripe partial capture, pending/success/failed-later refund and dashboard refund", () => {
    const stripe = new StripeFake();
    const i = stripe.createIntent("intent", "member-a", 8000);
    expect(i).toMatchObject(fixtures.stripe.authorised);
    expect(stripe.capture("capture", i.id, 5000)).toMatchObject(fixtures.stripe.captured);
    const r = stripe.refund("refund", i.id, 2000, "pending");
    expect(r).toMatchObject(fixtures.stripe.pending);
    stripe.succeedRefund(r.id);
    expect(stripe.snapshot().refunds[0]).toMatchObject(fixtures.stripe.succeeded);
    stripe.failRefund(r.id);
    expect(stripe.snapshot().refunds[0]).toMatchObject(fixtures.stripe.failedLater);
    expect(stripe.dashboardRefund(i.id, 5000)).toMatchObject(fixtures.stripe.dashboard);
    expect(() => stripe.refund("over-refund", i.id, 1)).toThrow(expect.objectContaining(fixtures.stripe.overRefundError));
    expect(stripe.snapshot().events.map(e => e.type)).toEqual(fixtures.stripe.eventTypes);
    expect(stripe.snapshot().events.at(-1)?.data.object).toMatchObject(fixtures.stripe.refundedCharge);
    // Webhook payloads are point-in-time copies, not references to mutable state.
    expect(stripe.snapshot().events[1].data.object).toMatchObject(fixtures.stripe.pending);
  });
});
