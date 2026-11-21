import { LineAmountTypes, ObjectSerializer, type LineItem, type XeroClient } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { invoiceWire } from "./round-trip-harness";
import { strictTestClient } from "./transport-client";
import { XeroFake, XeroValidationError } from "./xero-fake";

/**
 * An in-memory Xero session over `XeroFake` (#4908). The app reaches it only
 * through `setXeroClientForTests`, so production code runs unchanged: every
 * call still goes through `callXeroApi`, its environment gate and
 * `withXeroRetry`.
 *
 * Bodies are native Xero JSON passed through xero-node's own
 * `ObjectSerializer`, the same deserializer the SDK runs on an HTTP reply.
 * Invoices reuse `invoiceWire` (`INV-SSOT`). Lists page as Xero does: no
 * `page` returns everything, a `page` returns that slice of `pageSize`
 * (default 100). Document totals are worked out here, line by line, not with
 * the app's own totalling helper, so app and fake cannot agree by construction.
 *
 * Line tax (#5208) follows Xero's documented behaviour: "The tax amount is auto
 * calculated as a percentage of the line amount (see below) based on the tax
 * rate. This value can be overriden if the calculated TaxAmount is not correct."
 * A line sent with a `TaxAmount` keeps it; a line sent with a tax type and none
 * gets round-half-up(line × rate / (10000 + rate)) from `XERO_FAKE_TAX_RATES`,
 * worked out here in integers, not with the app's helper. `recalculateTaxNext`
 * makes the next create or update ignore sent amounts, as a Xero that did not
 * keep them would. An update may rewrite lines but never the document's total.
 *
 * Not modelled: currencies, auth, rate limits beyond what `failNext` injects,
 * payment dates, the organisation record and email. Anything absent from the
 * method table throws, so the app's organisation read falls back as it does
 * when Xero is unreachable.
 */
type Api = XeroClient["accountingApi"];
type Args<K extends keyof Api> = Api[K] extends (...args: infer P) => unknown ? P : never;
type Snapshot = ReturnType<XeroFake["snapshot"]>;

/** The fake organisation's tax rates, in basis points, by Xero tax type. */
export const XERO_FAKE_TAX_RATES: Readonly<Record<string, number>> = { OUTPUT2: 1500, NONE: 0 };

/** A non-2xx reply; xero-node rejects with it serialised (`ApiError.generateError`). */
export type XeroHttpFailure = { statusCode: number; headers?: Record<string, string>; body?: unknown };

export function xeroTransport(fake: XeroFake) {
  let sequence = 0;
  const key = (value?: string) => value ?? `transport:${++sequence}`;
  const failures: XeroHttpFailure[] = [];
  const invoiceInputs = new Map<string, Record<string, unknown>>();
  const contactInputs = new Map<string, Record<string, unknown>>();
  const noteInputs = new Map<string, Record<string, unknown>>();
  let recalculateTax = false;

  // xero-node rejects a non-2xx reply with a JSON string, not an Error or object.
  const reject = ({ statusCode, headers = {}, body }: XeroHttpFailure) =>
    JSON.stringify({ response: { statusCode, headers, body }, body });
  // Every call first consumes an injected failure. A fake refusal leaves as
  // Xero's 400 ValidationException, carrying the fake's message.
  const call = async <T>(model: string, build: () => object): Promise<T> => {
    const failure = failures.shift();
    if (failure) throw reject(failure);
    let built: object;
    try { built = build(); } catch (error) {
      if (!(error instanceof XeroValidationError)) throw error;
      throw reject({ statusCode: 400, body: {
        ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred",
        Elements: [{ ValidationErrors: [{ Message: error.message }] }],
      } });
    }
    return { response: { statusCode: 200, headers: {} }, body: ObjectSerializer.deserialize(built, model) } as T;
  };
  const cents = (amount: unknown) => {
    const value = providerAmountToCents(amount);
    if (value === null) throw new XeroValidationError("Missing or invalid amount");
    return value;
  };
  // Xero's total of an Inclusive or NoTax document: each line's quantity x unit
  // amount, rounded to the cent. Anything that would move the total off that sum
  // (Exclusive tax, discounts, a bare lineAmount) is refused rather than ignored.
  const linesTotalCents = (document: { lineAmountTypes?: LineAmountTypes; lineItems?: LineItem[] }) => {
    const types = document.lineAmountTypes;
    if (types !== LineAmountTypes.Inclusive && types !== LineAmountTypes.NoTax) {
      throw new Error(`The Xero test transport models Inclusive and NoTax documents only, not ${String(types ?? "the Exclusive default")}`);
    }
    return (document.lineItems ?? []).reduce((sum, line) => {
      if (line.discountRate != null || line.discountAmount != null) throw new Error("The Xero test transport does not model line discounts");
      const unitCents = providerAmountToCents(line.unitAmount);
      if (unitCents === null || line.quantity == null) throw new Error("The Xero test transport models lines with a quantity and unit amount only");
      const lineCents = Math.round(line.quantity * unitCents);
      if (line.lineAmount != null && providerAmountToCents(line.lineAmount) !== lineCents) throw new XeroValidationError("Line amount must equal quantity x unit amount");
      return sum + lineCents;
    }, 0);
  };
  // The tax Xero holds on each line of a stored (serialised) document: a sent
  // TaxAmount kept unless recalculating, else the line's own figure at its rate.
  const withLineTax = (document: Record<string, unknown>, recalculate: boolean): Record<string, unknown> => {
    const lines = document.LineItems as Array<Record<string, unknown>> | undefined;
    if (!lines) return document;
    const inclusive = document.LineAmountTypes === LineAmountTypes.Inclusive;
    return { ...document, LineItems: lines.map((line) => {
      if (!inclusive) return { ...line, TaxAmount: 0 };
      if (line.TaxType === undefined) return line;
      const rate = XERO_FAKE_TAX_RATES[String(line.TaxType)];
      if (rate === undefined) throw new XeroValidationError(`TaxType code '${String(line.TaxType)}' does not exist or cannot be used for this type of transaction`);
      if (line.TaxAmount !== undefined && !recalculate) return line;
      const lineCents = Math.round(Number(line.Quantity) * cents(line.UnitAmount));
      // round-half-up(|line| × rate / (10000 + rate)), signed; exact in integers at these magnitudes.
      const divisor = 10_000 + rate;
      const taxCents = Math.sign(lineCents) * Math.floor((2 * Math.abs(lineCents) * rate + divisor) / (2 * divisor));
      return { ...line, TaxAmount: taxCents / 100 };
    }) };
  };
  const takeRecalculate = () => { const value = recalculateTax; recalculateTax = false; return value; };
  const one = <T>(items: T[] | undefined): T => {
    const [item, ...rest] = items ?? [];
    if (item === undefined || rest.length) throw new Error("The Xero test transport models one document per request");
    return item;
  };

  const paymentWire = (p: Snapshot["payments"][number]) => ({
    PaymentID: p.paymentID, Amount: p.amountCents / 100, Status: p.status,
    ...(p.invoiceID !== undefined
      ? { PaymentType: "ACCRECPAYMENT", Invoice: { InvoiceID: p.invoiceID } }
      : { PaymentType: "ARCREDITPAYMENT", CreditNote: { CreditNoteID: p.creditNoteID } }),
  });
  const invoices = () => {
    const state = fake.snapshot();
    return invoiceWire(fake).Invoices.map(wire => {
      const invoice = state.invoices.find(i => i.invoiceID === wire.InvoiceID)!;
      return {
        ...invoiceInputs.get(wire.InvoiceID), ...wire,
        Contact: { ContactID: invoice.contactID },
        AmountPaid: invoice.amountPaidCents / 100, AmountCredited: invoice.amountCreditedCents / 100,
        Payments: state.payments.filter(p => p.invoiceID === invoice.invoiceID && p.status !== "DELETED").map(paymentWire),
      };
    });
  };
  const notes = () => {
    const state = fake.snapshot();
    return state.creditNotes.map(n => ({
      ...noteInputs.get(n.creditNoteID),
      CreditNoteID: n.creditNoteID, Type: "ACCRECCREDIT", CurrencyCode: "NZD", Contact: { ContactID: n.contactID },
      Status: n.status, Total: n.totalCents / 100, RemainingCredit: n.remainingCreditCents / 100,
      Allocations: state.allocations.filter(a => a.creditNoteID === n.creditNoteID).map(allocationWire),
      Payments: state.payments.filter(p => p.creditNoteID === n.creditNoteID && p.status !== "DELETED").map(paymentWire),
    }));
  };
  const allocationWire = (a: Snapshot["allocations"][number]) => ({ AllocationID: a.allocationID, Invoice: { InvoiceID: a.invoiceID }, Amount: a.amountCents / 100 });
  // #5204: overpayments and prepayments, as Xero lists them.
  const cashCredits = (kind: "OVERPAYMENT" | "PREPAYMENT") => fake.snapshot().cashCredits.filter(c => c.kind === kind).map(c => ({
    [kind === "OVERPAYMENT" ? "OverpaymentID" : "PrepaymentID"]: c.cashCreditID,
    Type: kind === "OVERPAYMENT" ? "RECEIVE-OVERPAYMENT" : "RECEIVE-PREPAYMENT",
    Contact: { ContactID: c.contactID }, Date: c.date, Status: c.status, CurrencyCode: "NZD",
    Total: c.totalCents / 100, RemainingCredit: c.remainingCents / 100,
  }));
  const statusWhere = (where?: string) => {
    if (where === undefined) return () => true;
    const status = /^Status=="([A-Z]+)"$/.exec(where)?.[1];
    if (status === undefined) throw new Error(`The Xero test transport does not model the where clause ${where}`);
    return (c: { Status: string }) => c.Status === status;
  };
  // The stored input goes first so the fake's identity always wins.
  const contacts = () => fake.snapshot().contacts.map(c => ({ ...contactInputs.get(c.contactID), ContactID: c.contactID, Name: c.memberId, ContactStatus: "ACTIVE" }));
  const contactsWhere = (where?: string) => {
    if (where === undefined) return () => true;
    const email = /^EmailAddress="([^"]*)"$/.exec(where);
    const address = email?.[1];
    if (address === undefined) throw new Error(`The Xero test transport does not model the where clause ${where}`);
    return (c: Record<string, unknown>) => String(c.EmailAddress ?? "").toLowerCase() === address.toLowerCase();
  };

  // Xero's paging: without `page` every match, with it one slice of `pageSize` (default 100).
  const paged = <T>(items: T[], page?: number, pageSize = 100) =>
    page === undefined ? items : items.slice((page - 1) * pageSize, page * pageSize);

  // Each signature is the SDK's positional one, so argument slots are compiler-checked.
  const api = {
    getInvoice: (...[, id]: Args<"getInvoice">) =>
      call("Invoices", () => ({ Invoices: invoices().filter(i => i.InvoiceID === id) })),
    getInvoices: (...[, , where, , iDs, , contactIDs, statuses, page, , , , , pageSize]: Args<"getInvoices">) => call("Invoices", () => {
      if (where !== undefined) throw new Error(`The Xero test transport does not model the where clause ${where}`);
      return { Invoices: paged(invoices().filter(i => (!iDs?.length || iDs.includes(i.InvoiceID)) && (!contactIDs?.length || contactIDs.includes(i.Contact.ContactID)) && (!statuses?.length || statuses.includes(i.Status))), page, pageSize) };
    }),
    createInvoices: (...[, body, , , idempotencyKey]: Args<"createInvoices">) => call("Invoices", () => {
      const input = one(body.invoices);
      if (String(input.type) !== "ACCREC" || String(input.status) !== "AUTHORISED") throw new Error("Only authorised ACCREC invoices are modelled");
      const invoice = fake.createInvoice(key(idempotencyKey), input.contact?.contactID ?? "", linesTotalCents(input));
      const recalculate = takeRecalculate();
      // A replay returns the original document, so only the first request's fields are kept.
      if (!invoiceInputs.has(invoice.invoiceID)) invoiceInputs.set(invoice.invoiceID, withLineTax(ObjectSerializer.serialize(input, "Invoice"), recalculate));
      return { Invoices: invoices().filter(i => i.InvoiceID === invoice.invoiceID) };
    }),
    updateInvoice: (...[, id, body]: Args<"updateInvoice">) => call("Invoices", () => {
      const input = one(body.invoices);
      const current = fake.snapshot().invoices.find(i => i.invoiceID === id);
      if (!current) throw new XeroValidationError("Object not found");
      if (current.status !== "AUTHORISED") throw new XeroValidationError("Invoice not of valid status for modification");
      if (linesTotalCents(input) !== current.totalCents) throw new Error("The Xero test transport models invoice updates that keep the total only");
      const recalculate = takeRecalculate();
      invoiceInputs.set(id, withLineTax({ ...invoiceInputs.get(id), ...ObjectSerializer.serialize(input, "Invoice") }, recalculate));
      return { Invoices: invoices().filter(i => i.InvoiceID === id) };
    }),
    getContact: (...[, id]: Args<"getContact">) =>
      call("Contacts", () => ({ Contacts: contacts().filter(c => c.ContactID === id) })),
    getContacts: (...[, , where, , iDs, page, , , searchTerm, pageSize]: Args<"getContacts">) => call("Contacts", () => {
      const matches = contactsWhere(where);
      const term = searchTerm?.toLowerCase();
      return { Contacts: paged(contacts().filter(c => matches(c) && (!iDs?.length || iDs.includes(c.ContactID)) && (!term || c.Name.toLowerCase().includes(term))), page, pageSize) };
    }),
    createContacts: (...[, body, , idempotencyKey]: Args<"createContacts">) => call("Contacts", () => {
      const input = one(body.contacts);
      const contact = fake.createContact(key(idempotencyKey), input.name ?? "");
      if (!contactInputs.has(contact.contactID)) contactInputs.set(contact.contactID, ObjectSerializer.serialize(input, "Contact"));
      return { Contacts: contacts().filter(c => c.ContactID === contact.contactID) };
    }),
    updateContact: (...[, id, body]: Args<"updateContact">) => call("Contacts", () => {
      if (!fake.snapshot().contacts.some(c => c.contactID === id)) throw new XeroValidationError("Object not found");
      contactInputs.set(id, { ...contactInputs.get(id), ...ObjectSerializer.serialize(one(body.contacts), "Contact") });
      return { Contacts: contacts().filter(c => c.ContactID === id) };
    }),
    createPayment: (...[, input, idempotencyKey]: Args<"createPayment">) => call("Payments", () => {
      const invoiceID = input.invoice?.invoiceID;
      const creditNoteID = input.creditNote?.creditNoteID;
      const payment = invoiceID
        ? fake.payInvoice(key(idempotencyKey), invoiceID, cents(input.amount))
        : fake.payCreditNote(key(idempotencyKey), creditNoteID ?? "", cents(input.amount));
      return { Payments: [paymentWire(payment)] };
    }),
    getPayment: (...[, id]: Args<"getPayment">) =>
      call("Payments", () => ({ Payments: fake.snapshot().payments.filter(p => p.paymentID === id).map(paymentWire) })),
    createCreditNotes: (...[, body, , , idempotencyKey]: Args<"createCreditNotes">) => call("CreditNotes", () => {
      const input = one(body.creditNotes);
      const note = fake.createCreditNote(key(idempotencyKey), input.contact?.contactID ?? "", linesTotalCents(input));
      if (!noteInputs.has(note.creditNoteID)) noteInputs.set(note.creditNoteID, ObjectSerializer.serialize(input, "CreditNote"));
      return { CreditNotes: notes().filter(n => n.CreditNoteID === note.creditNoteID) };
    }),
    getOverpayments: (...[, , where, , page, , pageSize]: Args<"getOverpayments">) =>
      call("Overpayments", () => ({ Overpayments: paged(cashCredits("OVERPAYMENT").filter(statusWhere(where)), page, pageSize) })),
    getPrepayments: (...[, , where, , page, , pageSize]: Args<"getPrepayments">) =>
      call("Prepayments", () => ({ Prepayments: paged(cashCredits("PREPAYMENT").filter(statusWhere(where)), page, pageSize) })),
    getOverpayment: (...[, id]: Args<"getOverpayment">) =>
      call("Overpayments", () => ({ Overpayments: cashCredits("OVERPAYMENT").filter(c => c.OverpaymentID === id) })),
    getPrepayment: (...[, id]: Args<"getPrepayment">) =>
      call("Prepayments", () => ({ Prepayments: cashCredits("PREPAYMENT").filter(c => c.PrepaymentID === id) })),
    getCreditNote: (...[, id]: Args<"getCreditNote">) =>
      call("CreditNotes", () => ({ CreditNotes: notes().filter(n => n.CreditNoteID === id) })),
    createCreditNoteAllocation: (...[, id, body, , idempotencyKey]: Args<"createCreditNoteAllocation">) => call("Allocations", () => {
      const input = one(body.allocations);
      const allocation = fake.allocate(key(idempotencyKey), id, input.invoice.invoiceID ?? "", cents(input.amount));
      return { Allocations: [allocationWire(allocation)] };
    }),
  } satisfies Partial<Record<keyof Api, unknown>>;

  return {
    tenantId: "test-tenant",
    xero: strictTestClient<XeroClient>("Xero", { accountingApi: strictTestClient<Api>("Xero", api) }),
    /** Queue an HTTP failure for the next call, e.g. a 429 with `x-rate-limit-problem: day`. */
    failNext(failure: XeroHttpFailure) { failures.push(failure); },
    /** Make the next invoice create or update work every line's tax out itself, ignoring any sent (#5208). */
    recalculateTaxNext() { recalculateTax = true; },
  };
}
