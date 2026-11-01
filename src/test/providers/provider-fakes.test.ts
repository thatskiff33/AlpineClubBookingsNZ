import { describe, expect, it } from "vitest";
import { STRIPE_WEBHOOK_EVENT_TYPES } from "@/lib/stripe-webhook-events";
import { XeroFake, XeroValidationError } from "./xero-fake";
import { StripeFake, StripeFakeError } from "./stripe-fake";

function xeroSetup() {
  const xero = new XeroFake();
  const contact = xero.createContact("contact", "member-a");
  const invoice = xero.createInvoice("invoice", contact.contactID, 8000);
  const credit = xero.createCreditNote("credit", contact.contactID, 5000);
  return { xero, contact, invoice, credit };
}
function stripeSetup() {
  const stripe = new StripeFake();
  const intent = stripe.createIntent("intent", "member-a", 8000);
  return { stripe, intent };
}

describe("Xero state and rejection atomicity", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid payment/credit/allocation cents %s without a partial write", amount => {
    const { xero, contact, invoice, credit } = xeroSetup();
    const before = xero.snapshot();
    expect(() => xero.payInvoice("pay", invoice.invoiceID, amount)).toThrow(XeroValidationError);
    expect(() => xero.createCreditNote("new-credit", contact.contactID, amount)).toThrow(XeroValidationError);
    expect(() => xero.allocate("allocate", credit.creditNoteID, invoice.invoiceID, amount)).toThrow(XeroValidationError);
    expect(xero.snapshot()).toEqual(before);
  });

  it("rejects overpayment, over-allocation, foreign contact and missing object", () => {
    const { xero, invoice, credit } = xeroSetup();
    const other = xero.createContact("other-contact", "member-b");
    const foreign = xero.createCreditNote("foreign", other.contactID, 5000);
    const before = xero.snapshot();
    expect(() => xero.payInvoice("overpay", invoice.invoiceID, 8001)).toThrow("exceeds");
    expect(() => xero.allocate("over-credit", credit.creditNoteID, invoice.invoiceID, 5001)).toThrow("greater than");
    expect(() => xero.allocate("foreign-allocation", foreign.creditNoteID, invoice.invoiceID, 1)).toThrow("same contact");
    expect(() => xero.payInvoice("missing", "missing", 1)).toThrow("not found");
    expect(xero.snapshot()).toEqual(before);
  });

  it("rejects paid-invoice allocation and restores capacity after removing an allocation", () => {
    const { xero, invoice, credit } = xeroSetup();
    xero.payInvoice("partial", invoice.invoiceID, 3000);
    const allocation = xero.allocate("allocate", credit.creditNoteID, invoice.invoiceID, 5000);
    expect(xero.snapshot().invoices[0]).toMatchObject({ status: "PAID", amountPaidCents: 3000, amountDueCents: 0 });
    expect(() => xero.allocate("paid", credit.creditNoteID, invoice.invoiceID, 1)).toThrow("already been paid off");
    expect(() => xero.voidInvoice(invoice.invoiceID)).toThrow("payments or allocations");
    expect(() => xero.voidCreditNote(credit.creditNoteID)).toThrow("has allocations");
    xero.removeAllocation(allocation.allocationID);
    expect(xero.snapshot().creditNotes[0]).toMatchObject({ status: "AUTHORISED", remainingCreditCents: 5000 });
    expect(xero.snapshot().invoices[0]).toMatchObject({ status: "AUTHORISED", amountDueCents: 5000 });
  });

  it("voids are terminal and detached reads cannot change state", () => {
    const { xero, invoice, credit } = xeroSetup();
    xero.voidInvoice(invoice.invoiceID); xero.voidCreditNote(credit.creditNoteID);
    const snapshot = xero.snapshot(); snapshot.invoices[0].status = "AUTHORISED";
    expect(() => xero.payInvoice("voided", invoice.invoiceID, 1)).toThrow("valid status");
    expect(() => xero.allocate("voided", credit.creditNoteID, invoice.invoiceID, 1)).toThrow("valid status");
    expect(xero.snapshot().invoices[0].status).toBe("VOIDED");
  });

  it("replays creates and payments, rejects key reuse, and does not cache validation failures", () => {
    const { xero, contact, invoice } = xeroSetup();
    expect(xero.createInvoice("invoice", contact.contactID, 8000)).toEqual(invoice);
    expect(() => xero.createInvoice("invoice", contact.contactID, 8001)).toThrow("different parameters");
    expect(() => xero.payInvoice("pay", invoice.invoiceID, 9000)).toThrow();
    const payment = xero.payInvoice("pay", invoice.invoiceID, 8000);
    expect(xero.payInvoice("pay", invoice.invoiceID, 8000)).toEqual(payment);
    expect(xero.snapshot().payments).toHaveLength(1);
    xero.deletePayment(payment.paymentID); xero.voidInvoice(invoice.invoiceID);
    expect(xero.snapshot().invoices[0]).toMatchObject({ status: "VOIDED", amountPaidCents: 0 });
    const zero = xero.createInvoice("free", contact.contactID, 0);
    expect(zero.status).toBe("PAID");
  });

  it("credit-note payouts consume credit, and deleting them releases it without reviving a later void", () => {
    const { xero, credit } = xeroSetup();
    const before = xero.snapshot();
    expect(() => xero.payCreditNote("too-much", credit.creditNoteID, 5001)).toThrow("exceeds");
    expect(xero.snapshot()).toEqual(before);
    const p = xero.payCreditNote("refund", credit.creditNoteID, 5000);
    expect(xero.payCreditNote("refund", credit.creditNoteID, 5000)).toEqual(p);
    expect(xero.snapshot().creditNotes[0]).toMatchObject({ status: "PAID", remainingCreditCents: 0 });
    expect(() => xero.voidCreditNote(credit.creditNoteID)).toThrow("payments");
    xero.deletePayment(p.paymentID);
    xero.voidCreditNote(credit.creditNoteID);
    xero.deletePayment(p.paymentID);
    expect(xero.snapshot().creditNotes[0].status).toBe("VOIDED");
    expect(() => xero.payCreditNote("after-void", credit.creditNoteID, 1)).toThrow("valid status");
  });
});

describe("Stripe capture and refund state", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cents %s without changing state", amount => {
    const { stripe, intent } = stripeSetup();
    const before = stripe.snapshot();
    expect(() => stripe.createIntent("bad", "member-a", amount)).toThrow(StripeFakeError);
    expect(() => stripe.capture("bad", intent.id, amount)).toThrow(StripeFakeError);
    expect(stripe.snapshot()).toEqual(before);
    stripe.capture("capture", intent.id, 8000);
    const captured = stripe.snapshot();
    expect(() => stripe.refund("bad", intent.id, amount)).toThrow(StripeFakeError);
    expect(stripe.snapshot()).toEqual(captured);
  });

  it("capture is single-use, bounded by authorisation, and replay emits no second event", () => {
    const { stripe, intent } = stripeSetup();
    expect(() => stripe.refund("early", intent.id, 1)).toThrow("not been captured");
    expect(() => stripe.capture("over", intent.id, 8001)).toThrow("exceeds");
    const captured = stripe.capture("capture", intent.id, 5000);
    expect(stripe.capture("capture", intent.id, 5000)).toEqual(captured);
    expect(() => stripe.capture("second", intent.id, 1)).toThrow("not capturable");
    expect(() => stripe.capture("capture", intent.id, 4000)).toThrow("Parameters differ");
    expect(stripe.snapshot().events).toHaveLength(1);
  });

  it("pending refunds reserve capacity, failed-later refunds release it, dashboard refunds consume it", () => {
    const { stripe, intent } = stripeSetup(); stripe.capture("capture", intent.id, 8000);
    const refund = stripe.refund("refund", intent.id, 8000, "pending");
    expect(() => stripe.dashboardRefund(intent.id, 1)).toThrow("exceeds");
    stripe.failRefund(refund.id); stripe.failRefund(refund.id);
    const dashboard = stripe.dashboardRefund(intent.id, 8000);
    expect(dashboard).toMatchObject({ amount: 8000, origin: "dashboard", status: "succeeded" });
    expect(() => stripe.refund("another", intent.id, 1)).toThrow("exceeds");
    expect(() => stripe.succeedRefund(refund.id)).toThrow("not pending");
    expect(stripe.refund("refund", intent.id, 8000, "pending").status).toBe("pending");
    expect(stripe.snapshot().refunds[0].status).toBe("failed");
    expect(stripe.snapshot().events.map(e => e.type)).toEqual(["payment_intent.succeeded", "refund.created", "charge.refunded", "refund.updated", "refund.failed", "refund.created", "charge.refunded"]);
  });

  it("emits subscribed refund events with detached charge and failed-refund payloads", () => {
    const { stripe, intent } = stripeSetup(); stripe.capture("capture", intent.id, 8000);
    const first = stripe.dashboardRefund(intent.id, 2000);
    expect(() => stripe.refund("too-large", intent.id, 6001)).toThrow(expect.objectContaining({ code: "amount_too_large" }));
    stripe.failRefund(first.id);
    stripe.dashboardRefund(intent.id, 8000);
    const subscribed = new Set<string>(STRIPE_WEBHOOK_EVENT_TYPES);
    const events = stripe.snapshot().events.filter(e => subscribed.has(e.type));
    expect(events.map(e => e.type)).toEqual(["payment_intent.succeeded", "charge.refunded", "refund.failed", "charge.refunded"]);
    expect(events[1].data.object).toMatchObject({
      payment_intent: intent.id, amount: 8000, amount_refunded: 2000, refunded: false,
      refunds: { data: [{ id: first.id, status: "succeeded" }], has_more: false },
    });
    expect(events[2].data.object).toMatchObject({ id: first.id, payment_intent: intent.id, charge: `charge-${intent.id}`, status: "failed" });
    expect(events[3].data.object).toMatchObject({ amount_refunded: 8000, refunded: true });
    const count = stripe.snapshot().events.length;
    stripe.failRefund(first.id);
    expect(stripe.snapshot().events).toHaveLength(count);
  });

  it("cancelled authorisations capture nothing; missing objects reject", () => {
    const { stripe, intent } = stripeSetup(); stripe.cancel(intent.id);
    expect(() => stripe.capture("cancelled", intent.id, 100)).toThrow("not capturable");
    expect(() => stripe.capture("missing", "missing", 1)).toThrow("No such");
    expect(() => stripe.failRefund("missing")).toThrow("No such");
    expect(stripe.snapshot().intents[0]).toMatchObject({ status: "canceled", amount_received: 0 });
    expect(stripe.snapshot().events).toHaveLength(0);
  });
});
