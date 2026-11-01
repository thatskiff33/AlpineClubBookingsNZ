import { providerAmountToCents } from "@/lib/money-provider-amount";
import { StripeFake } from "./stripe-fake";
import { XeroFake } from "./xero-fake";

/** Test model only; the production ledger and sync adapters belong to #4461. */
type Totals = { charged: number; bank: number; credit: number; allocated: number; card: number; refunded: number };
const empty = (): Totals => ({ charged: 0, bank: 0, credit: 0, allocated: 0, card: 0, refunded: 0 });
type Fact = { member: string; account: keyof Totals; cents: number };

/** Revisions append deltas. Redelivered facts produce no new posting. */
export class RoundTripJournal {
  private facts = new Map<string, Fact>();
  readonly postings: Fact[] = [];

  record(id: string, fact: Fact) {
    const previous = this.facts.get(id);
    if (previous && (previous.member !== fact.member || previous.account !== fact.account)) throw new Error("Provider fact changed owner or account");
    const cents = fact.cents - (previous?.cents ?? 0);
    if (cents !== 0) this.postings.push({ ...fact, cents });
    this.facts.set(id, { ...fact });
  }

  totals(members: readonly string[]) {
    const totals = Object.fromEntries(members.map(member => [member, empty()]));
    for (const p of this.postings) {
      const total = totals[p.member];
      if (!total) throw new Error(`Unknown member: ${p.member}`);
      total[p.account] += p.cents;
    }
    return totals;
  }
}

/** Read provider state independently of the renderer's commands/journal. */
export function ingestProviders(journal: RoundTripJournal, xero: XeroFake, stripe: StripeFake) {
  const x = xero.snapshot();
  const contacts = new Map(x.contacts.map(c => [c.contactID, c.memberId]));
  const invoices = new Map(x.invoices.map(i => [i.invoiceID, i]));
  const credits = new Map(x.creditNotes.map(c => [c.creditNoteID, c]));
  for (const i of x.invoices) journal.record(`xero:${i.invoiceID}`, { member: contacts.get(i.contactID)!, account: "charged", cents: i.status === "VOIDED" ? 0 : i.totalCents });
  for (const p of x.payments) {
    const contactID = p.invoiceID !== undefined ? invoices.get(p.invoiceID)!.contactID : credits.get(p.creditNoteID)!.contactID;
    journal.record(`xero:${p.paymentID}`, { member: contacts.get(contactID)!, account: "bank", cents: p.status === "DELETED" ? 0 : p.amountCents * (p.invoiceID !== undefined ? 1 : -1) });
  }
  for (const c of x.creditNotes) journal.record(`xero:${c.creditNoteID}`, { member: contacts.get(c.contactID)!, account: "credit", cents: c.status === "VOIDED" ? 0 : c.totalCents });
  // Allocation deletion is represented by absence from a complete snapshot.
  // Keep zeroed facts for every earlier allocation known to this test importer.
  const currentAllocations = new Map(x.allocations.map(a => [a.allocationID, a]));
  const allocationIds = allocationHistory.get(journal) ?? new Map<string, Fact>();
  for (const a of x.allocations) allocationIds.set(a.allocationID, { member: contacts.get(invoices.get(a.invoiceID)!.contactID)!, account: "allocated", cents: a.amountCents });
  for (const [id, fact] of allocationIds) journal.record(`xero:${id}`, { ...fact, cents: currentAllocations.has(id) ? fact.cents : 0 });
  allocationHistory.set(journal, allocationIds);
  const s = stripe.snapshot();
  const intents = new Map(s.intents.map(i => [i.id, i]));
  for (const i of s.intents) journal.record(`stripe:${i.id}`, { member: i.memberId, account: "card", cents: i.amount_received });
  for (const r of s.refunds) journal.record(`stripe:${r.id}`, { member: intents.get(r.payment_intent)!.memberId, account: "refunded", cents: r.status === "succeeded" ? r.amount : 0 });
}
const allocationHistory = new WeakMap<RoundTripJournal, Map<string, Fact>>();

export type RoundTripStep = { member: string; amount: number; action: "charge" | "receipt" | "credit" | "allocate" | "remove-allocation" | "void-credit" | "void-invoice" | "delete-receipt" | "capture" | "refund" | "fail-refund" | "dashboard-refund" };

/** Outbound adapter: register source facts using the returned provider IDs. */
export function renderStep(step: RoundTripStep, key: string, journal: RoundTripJournal, xero: XeroFake, stripe: StripeFake) {
  const { member, amount, action } = step;
  const contact = xero.createContact(`contact:${member}`, member);
  const x = xero.snapshot();
  const invoice = x.invoices.find(i => i.contactID === contact.contactID && i.status === "AUTHORISED");
  const credit = x.creditNotes.find(c => c.contactID === contact.contactID && c.status === "AUTHORISED");
  const intents = stripe.snapshot().intents.filter(i => i.memberId === member);
  const intent = intents.at(-1);
  const record = (id: string, account: keyof Totals, cents: number) => journal.record(id, { member, account, cents });
  switch (action) {
    case "charge": {
      const i = xero.createInvoice(key, contact.contactID, amount);
      record(`xero:${i.invoiceID}`, "charged", amount); break;
    }
    case "receipt": if (invoice) {
      const p = xero.payInvoice(key, invoice.invoiceID, amount);
      record(`xero:${p.paymentID}`, "bank", amount);
    } break;
    case "credit": {
      const c = xero.createCreditNote(key, contact.contactID, amount);
      record(`xero:${c.creditNoteID}`, "credit", amount); break;
    }
    case "allocate": if (invoice && credit) {
      const a = xero.allocate(key, credit.creditNoteID, invoice.invoiceID, amount);
      record(`xero:${a.allocationID}`, "allocated", amount);
    } break;
    case "remove-allocation": {
      const a = x.allocations.find(a => x.invoices.find(i => i.invoiceID === a.invoiceID)?.contactID === contact.contactID);
      if (a) { xero.removeAllocation(a.allocationID); record(`xero:${a.allocationID}`, "allocated", 0); }
      break;
    }
    case "void-credit": if (credit) { xero.voidCreditNote(credit.creditNoteID); record(`xero:${credit.creditNoteID}`, "credit", 0); } break;
    case "void-invoice": if (invoice) { xero.voidInvoice(invoice.invoiceID); record(`xero:${invoice.invoiceID}`, "charged", 0); } break;
    case "delete-receipt": {
      const p = x.payments.find(p => p.status === "AUTHORISED" && x.invoices.find(i => i.invoiceID === p.invoiceID)?.contactID === contact.contactID);
      if (p) { xero.deletePayment(p.paymentID); record(`xero:${p.paymentID}`, "bank", 0); }
      break;
    }
    case "capture": {
      const i = stripe.createIntent(`${key}:intent`, member, amount);
      stripe.capture(key, i.id, amount);
      record(`stripe:${i.id}`, "card", amount); break;
    }
    case "refund": if (intent) {
      const r = stripe.refund(key, intent.id, amount);
      record(`stripe:${r.id}`, "refunded", amount);
    } break;
    case "dashboard-refund": if (intent) {
      // External facts are deliberately NOT registered by the outbound adapter.
      stripe.dashboardRefund(intent.id, amount);
    } break;
    case "fail-refund": {
      const r = stripe.snapshot().refunds.find(r => r.status !== "failed" && intents.some(i => i.id === r.payment_intent));
      if (r) stripe.failRefund(r.id);
      break;
    }
  }
}

/** Native wire boundary for the production invoice observer in scenario tests. */
export function invoiceWire(xero: XeroFake) {
  return { Invoices: xero.snapshot().invoices.map(i => ({ InvoiceID: i.invoiceID, InvoiceNumber: i.invoiceID, Type: "ACCREC", CurrencyCode: "NZD", Status: i.status, Total: i.totalCents / 100, AmountDue: i.amountDueCents / 100 })) };
}

/** Check the boundary uses the existing money converter, rather than another rounding rule. */
export function invoiceWireDueCents(xero: XeroFake) {
  return invoiceWire(xero).Invoices.map(i => providerAmountToCents(i.AmountDue));
}
