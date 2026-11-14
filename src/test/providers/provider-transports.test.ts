import { afterEach, describe, expect, it, vi } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";
import Stripe from "stripe";
import { xeroTransport } from "./xero-transport";
import { stripeTransport } from "./stripe-transport";
import { XeroFake } from "./xero-fake";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { isCreditNoteOverAllocationText } from "@/lib/xero-credit-note-spent-outside-app";
import { StripeFake } from "./stripe-fake";
import { setXeroClientForTests, resetXeroClientForTests } from "@/lib/xero-test-client-override";
import { getAuthenticatedXeroClient, resetXeroRateLimitStateForTests, withXeroRetry, XeroDailyLimitError, getXeroErrorSearchText } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { getStripe, getPaymentIntent, processRefund } from "@/lib/stripe";
import { setStripeClientForTests, resetStripeClientForTests } from "@/lib/stripe-test-client-override";

const invoice = (contactID: string): Invoice => ({ type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.AUTHORISED, contact: { contactID }, lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [{ description: "Stay", quantity: 2, unitAmount: 40 }] });
afterEach(() => { resetXeroClientForTests(); resetXeroRateLimitStateForTests(); resetStripeClientForTests(); vi.unstubAllEnvs(); });

describe("provider transport mapping", () => {
  it("sends SDK invoices and receipts through native Xero JSON, retaining cents and replay identity", async () => {
    const fake = new XeroFake();
    const session = xeroTransport(fake);
    setXeroClientForTests(session);
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const c = fake.createContact("member", "member-a");
    const created = await xero.accountingApi.createInvoices(tenantId, { invoices: [invoice(c.contactID)] }, undefined, undefined, "invoice-key");
    const id = created.body.invoices![0].invoiceID!;
    expect(created.body.invoices![0]).toMatchObject({ total: 80, amountDue: 80, contact: { contactID: c.contactID }, lineItems: [{ quantity: 2, unitAmount: 40 }] });
    await xero.accountingApi.createPayment(tenantId, { invoice: { invoiceID: id }, amount: 50 }, "receipt-key");
    await xero.accountingApi.createPayment(tenantId, { invoice: { invoiceID: id }, amount: 50 }, "receipt-key");
    expect((await xero.accountingApi.getInvoice(tenantId, id)).body.invoices![0]).toMatchObject({ amountDue: 30, amountPaid: 50, payments: [{ amount: 50 }] });
    expect(fake.snapshot().payments).toHaveLength(1);
    // A replay returns the original document: a rebuilt reference is not echoed.
    await xero.accountingApi.createInvoices(tenantId, { invoices: [{ ...invoice(c.contactID), reference: "rebuilt" }] }, undefined, undefined, "invoice-key");
    expect(fake.snapshot().invoices).toHaveLength(1);
    expect((await xero.accountingApi.getInvoice(tenantId, id)).body.invoices![0].reference).toBeUndefined();
    const contact = await xero.accountingApi.createContacts(tenantId, { contacts: [{ name: "member-b", emailAddress: "first@example.invalid" }] }, undefined, "contact-key");
    await xero.accountingApi.createContacts(tenantId, { contacts: [{ name: "member-b", emailAddress: "retry@example.invalid" }] }, undefined, "contact-key");
    expect((await xero.accountingApi.getContact(tenantId, contact.body.contacts![0].contactID!)).body.contacts![0].emailAddress).toBe("first@example.invalid");
  });

  it("totals documents line by line and refuses what would move Xero's total", async () => {
    const fake = new XeroFake(); const { xero, tenantId } = xeroTransport(fake); const api = xero.accountingApi;
    const c = fake.createContact("contact", "member-a");
    const create = (patch: Partial<Invoice>, lines = [{ quantity: 3, unitAmount: 33.33 }]) =>
      api.createInvoices(tenantId, { invoices: [{ ...invoice(c.contactID), lineItems: lines, ...patch }] });
    expect((await create({})).body.invoices![0].total).toBe(99.99);
    expect((await create({ lineAmountTypes: LineAmountTypes.NoTax }, [{ quantity: 1, unitAmount: 10, lineAmount: 10 }])).body.invoices![0].total).toBe(10);
    await expect(create({ lineAmountTypes: LineAmountTypes.Exclusive })).rejects.toThrow("Inclusive and NoTax documents only");
    await expect(create({ lineAmountTypes: undefined })).rejects.toThrow("Inclusive and NoTax documents only");
    await expect(create({}, [{ quantity: 1, unitAmount: 40, discountRate: 10 }])).rejects.toThrow("line discounts");
    await expect(create({}, [{ quantity: 1, unitAmount: 40, discountAmount: 5 }])).rejects.toThrow("line discounts");
    await expect(create({}, [{ quantity: 1, lineAmount: 40 }])).rejects.toThrow("quantity and unit amount only");
    expect(getXeroErrorStatusCode(await create({}, [{ quantity: 1, unitAmount: 40, lineAmount: 45 }]).then(() => null, (e: unknown) => e))).toBe(400);
    await expect(api.createCreditNotes(tenantId, { creditNotes: [{ contact: { contactID: c.contactID }, lineAmountTypes: LineAmountTypes.Exclusive, lineItems: [{ quantity: 1, unitAmount: 80 }] }] })).rejects.toThrow("Inclusive and NoTax documents only");
    expect(fake.snapshot().invoices).toHaveLength(2);
  });

  it("maps credit notes and allocations and preserves Xero validation failures", async () => {
    const fake = new XeroFake(); const { xero, tenantId } = xeroTransport(fake); const api = xero.accountingApi;
    const c = fake.createContact("contact", "member-a"); const i = fake.createInvoice("invoice", c.contactID, 8000);
    const note = await api.createCreditNotes(tenantId, { creditNotes: [{ contact: { contactID: c.contactID }, reference: "refund-ref", lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [{ quantity: 1, unitAmount: 80 }] }] });
    const n = note.body.creditNotes![0].creditNoteID!;
    // The request's own fields come back, as Xero echoes them; the fake's money wins.
    expect(note.body.creditNotes![0]).toMatchObject({ reference: "refund-ref", lineItems: [{ quantity: 1, unitAmount: 80 }], total: 80, remainingCredit: 80 });
    await api.createCreditNoteAllocation(tenantId, n, { allocations: [{ invoice: { invoiceID: i.invoiceID }, amount: 80, date: "2026-07-01" }] }, undefined, "allocation-key");
    await api.createCreditNoteAllocation(tenantId, n, { allocations: [{ invoice: { invoiceID: i.invoiceID }, amount: 80, date: "2026-07-01" }] }, undefined, "allocation-key");
    expect(fake.snapshot().allocations).toEqual([expect.objectContaining({ amountCents: 8000 })]);
    expect((await api.getCreditNote(tenantId, n)).body.creditNotes![0]).toMatchObject({ remainingCredit: 0, allocations: [{ amount: 80, invoice: { invoiceID: i.invoiceID } }] });
    expect((await api.getInvoice(tenantId, i.invoiceID)).body.invoices![0]).toMatchObject({ amountCredited: 80, amountDue: 0, status: "PAID" });
    // A refusal leaves as xero-node's JSON-string 400, which the app's own readers parse.
    const refuse = (invoiceID: string) => api.createCreditNoteAllocation(tenantId, n, { allocations: [{ invoice: { invoiceID }, amount: 1, date: "2026-07-01" }] }).then(() => null, (e: unknown) => e);
    const paidOff = await refuse(i.invoiceID);
    expect(typeof paidOff).toBe("string");
    expect(getXeroErrorStatusCode(paidOff)).toBe(400);
    expect(getXeroErrorSearchText(paidOff)).toContain("already been paid off");
    // More than a note has left, against an open invoice: the wording the app reads as spent outside it.
    const small = fake.createCreditNote("note-2", c.contactID, 5000).creditNoteID;
    const overAllocated: unknown = await api.createCreditNoteAllocation(tenantId, small, { allocations: [{ invoice: { invoiceID: fake.createInvoice("invoice-2", c.contactID, 8000).invoiceID }, amount: 60, date: "2026-07-01" }] }).then(() => null, (e: unknown) => e);
    expect(isCreditNoteOverAllocationText(getXeroErrorSearchText(overAllocated))).toBe(true);
    // A fake bug, not a Xero refusal, still escapes as itself.
    await expect(api.createCreditNoteAllocation(tenantId, n, { allocations: [] })).rejects.toThrow("one document per request");
  });

  it("maps contacts without dropping their containment email", async () => {
    const { xero, tenantId } = xeroTransport(new XeroFake());
    const c = await xero.accountingApi.createContacts(tenantId, { contacts: [{ name: "member-a", emailAddress: "fixture@example.invalid" }] });
    const id = c.body.contacts![0].contactID!;
    expect((await xero.accountingApi.getContact(tenantId, id)).body.contacts![0]).toMatchObject({ contactID: id, emailAddress: "fixture@example.invalid", name: "member-a" });
    const byEmail = await xero.accountingApi.getContacts(tenantId, undefined, 'EmailAddress="FIXTURE@example.invalid"');
    expect(byEmail.body.contacts!.map(c => c.contactID)).toEqual([id]);
    expect((await xero.accountingApi.getContacts(tenantId, undefined, 'EmailAddress="other@example.invalid"')).body.contacts).toEqual([]);
    expect((await xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, [id])).body.contacts).toHaveLength(1);
    await expect(xero.accountingApi.getContacts(tenantId, undefined, 'Name="member-a"')).rejects.toThrow("does not model");
  });

  it("pages lists as Xero does, so the app's paging loops end", async () => {
    const fake = new XeroFake(); const { xero, tenantId } = xeroTransport(fake);
    const c = fake.createContact("contact", "member-a");
    for (const n of [1, 2, 3]) fake.createInvoice(`invoice-${n}`, c.contactID, 1000);
    const ids = async (page?: number) => (await xero.accountingApi.getInvoices(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, page, false, false, undefined, false, 2)).body.invoices!.map(i => i.invoiceID);
    expect(await ids()).toHaveLength(3);
    expect([...await ids(1), ...await ids(2)]).toEqual(await ids());
    expect(await ids(3)).toEqual([]);
    const contactPage = (page: number) => xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, undefined, page, false, false, undefined, 20);
    expect((await contactPage(1)).body.contacts).toHaveLength(1);
    expect((await contactPage(2)).body.contacts).toEqual([]);
  });

  it("raises injected HTTP failures in xero-node's shape, so the real retry wrapper classifies them", async () => {
    const session = xeroTransport(new XeroFake());
    session.failNext({ statusCode: 429, headers: { "retry-after": "60", "x-rate-limit-problem": "day" } });
    await expect(withXeroRetry(() => session.xero.accountingApi.getContacts(session.tenantId))).rejects.toBeInstanceOf(XeroDailyLimitError);
    // The daily-limit latch is the app's own, so the next session request is refused before any call.
    setXeroClientForTests(session);
    await expect(getAuthenticatedXeroClient()).rejects.toBeInstanceOf(XeroDailyLimitError);
  });

  it("maps captures, refund SDK errors and async refund lists through the production client", async () => {
    const fake = new StripeFake(); const transport = stripeTransport(fake); setStripeClientForTests(transport.client);
    const stripe = await getStripe();
    const i = await stripe.paymentIntents.create({ amount: 8000, currency: "nzd", capture_method: "manual", metadata: { memberId: "member-a" } }, { idempotencyKey: "intent-key" });
    await stripe.paymentIntents.capture(i.id, { amount_to_capture: 5000 }, { idempotencyKey: "capture-key" });
    expect(await stripe.paymentIntents.retrieve(i.id)).toMatchObject({ amount_received: 5000, metadata: { memberId: "member-a" } });
    // The capture date the app reads: the expanded charge's time, from the frozen clock.
    const frozen = Math.floor(Date.now() / 1000);
    expect(await getPaymentIntent(i.id, { timeoutMs: 1_000, expand: ["latest_charge"] })).toMatchObject({ created: frozen, latest_charge: { id: `charge-${i.id}`, created: frozen, amount_captured: 5000 } });
    await expect(stripe.paymentIntents.retrieve(i.id, { expand: ["customer"] })).rejects.toThrow("does not model expand customer");
    const r = await processRefund({ paymentIntentId: i.id, amountCents: 2000, idempotencyKey: "refund-key" });
    expect(await processRefund({ paymentIntentId: i.id, amountCents: 2000, idempotencyKey: "refund-key" })).toEqual(r);
    await expect(processRefund({ paymentIntentId: i.id, amountCents: 2000, reason: "duplicate", idempotencyKey: "refund-key" })).rejects.toBeInstanceOf(Stripe.errors.StripeIdempotencyError);
    const listed = []; for await (const item of stripe.refunds.list({ payment_intent: i.id })) listed.push(item);
    expect(listed).toHaveLength(1);
    await expect(processRefund({ paymentIntentId: i.id, amountCents: 4000 })).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    // Without an amount Stripe refunds what is left, and then refuses.
    expect(await stripe.refunds.create({ payment_intent: i.id })).toMatchObject({ amount: 3000 });
    await expect(stripe.refunds.create({ payment_intent: i.id })).rejects.toMatchObject({ code: "charge_already_refunded" });
    fake.failRefund(r.id);
    expect(transport.events().map(e => e.type)).toContain("refund.failed");
    expect(transport.events().find(e => e.type === "charge.refunded")!.data.object).toMatchObject({ amount_refunded: 2000 });
  });

  it("refuses overrides outside tests and refuses retained overrides after an environment change", async () => {
    const xero = xeroTransport(new XeroFake()); const stripe = stripeTransport(new StripeFake()).client;
    setXeroClientForTests(xero); setStripeClientForTests(stripe);
    // The app's connection check agrees with the client it is about to be handed.
    expect(await isXeroConnected()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => setXeroClientForTests(xero)).toThrow("test-only");
    expect(() => setStripeClientForTests(stripe)).toThrow("test-only");
    await expect(getAuthenticatedXeroClient()).rejects.toThrow("test-only");
    await expect(getStripe()).rejects.toThrow("test-only");
    await expect(isXeroConnected()).rejects.toThrow("test-only");
  });

  it("never falls back to a network SDK for unsupported operations", () => {
    expect(() => stripeTransport(new StripeFake()).client.customers).toThrow("does not implement");
    expect(() => xeroTransport(new XeroFake()).xero.accountingApi.emailInvoice).toThrow("does not implement");
  });
});
