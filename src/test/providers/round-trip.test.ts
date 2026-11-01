import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { StripeFake, StripeFakeError } from "./stripe-fake";
import { XeroFake, XeroValidationError } from "./xero-fake";
import { ingestProviders, renderStep, RoundTripJournal, type RoundTripStep } from "./round-trip-harness";

const members = ["member-a", "member-b", "member-c"];
const step = fc.record({
  member: fc.constantFrom(...members), amount: fc.integer({ min: 1, max: 10000 }),
  action: fc.constantFrom<RoundTripStep["action"]>("charge", "receipt", "credit", "allocate", "remove-allocation", "void-credit", "void-invoice", "delete-receipt", "capture", "refund"),
});

describe("provider round trip (test-only adapter for #4461)", () => {
  it("random outbound prefixes ingest without a new posting and preserve each member's totals", () => {
    fc.assert(fc.property(fc.array(step, { minLength: 1, maxLength: 80 }), steps => {
      const xero = new XeroFake(); const stripe = new StripeFake();
      const source = new RoundTripJournal(); const imported = new RoundTripJournal();
      for (const [index, event] of steps.entries()) {
        const before = { xero: xero.snapshot(), stripe: stripe.snapshot(), postings: [...source.postings] };
        try { renderStep(event, `step:${index}`, source, xero, stripe); }
        catch (error) {
          if (!(error instanceof XeroValidationError || error instanceof StripeFakeError)) throw error;
          // Contact setup is an independent operation; rejected money writes are atomic.
          expect(xero.snapshot()).toEqual({ ...before.xero, contacts: xero.snapshot().contacts });
          expect(stripe.snapshot()).toEqual(before.stripe);
          expect(source.postings).toEqual(before.postings);
        }
        const totals = source.totals(members); const count = source.postings.length;
        ingestProviders(source, xero, stripe);
        expect(source.postings).toHaveLength(count);
        expect(source.totals(members)).toEqual(totals);
        ingestProviders(imported, xero, stripe);
        expect(imported.totals(members)).toEqual(totals);
        const importedCount = imported.postings.length;
        ingestProviders(imported, xero, stripe);
        expect(imported.postings).toHaveLength(importedCount);
      }
    }), { seed: 4460, numRuns: 150 });
  });

  it("external dashboard refunds and failed-later refunds append one correction, redelivery appends none", () => {
    const xero = new XeroFake(); const stripe = new StripeFake(); const journal = new RoundTripJournal();
    renderStep({ member: "member-a", action: "capture", amount: 8000 }, "capture", journal, xero, stripe);
    renderStep({ member: "member-a", action: "refund", amount: 2000 }, "refund", journal, xero, stripe);
    ingestProviders(journal, xero, stripe);
    const before = journal.postings.length;
    renderStep({ member: "member-a", action: "fail-refund", amount: 0 }, "failure", journal, xero, stripe);
    ingestProviders(journal, xero, stripe);
    expect(journal.postings).toHaveLength(before + 1);
    expect(journal.totals(members)["member-a"].refunded).toBe(0);
    renderStep({ member: "member-a", action: "dashboard-refund", amount: 2000 }, "dashboard", journal, xero, stripe);
    ingestProviders(journal, xero, stripe);
    expect(journal.postings).toHaveLength(before + 2);
    expect(journal.totals(members)["member-a"]).toMatchObject({ card: 8000, refunded: 2000 });
    ingestProviders(journal, xero, stripe);
    expect(journal.postings).toHaveLength(before + 2);
  });
});

it("random external refunds converge to independent member cash totals on every delivery", () => {
  fc.assert(fc.property(fc.array(fc.record({
    member: fc.constantFrom(...members), amount: fc.integer({ min: 1, max: 5000 }), fail: fc.boolean(),
  }), { maxLength: 60 }), events => {
    const xero = new XeroFake(); const stripe = new StripeFake(); const journal = new RoundTripJournal();
    const expected = new Map(members.map(member => [member, 0]));
    const intents = new Map(members.map(member => {
      const i = stripe.createIntent(member, member, 10000);
      stripe.capture(`capture:${member}`, i.id, 10000);
      return [member, i.id];
    }));
    const refunds: { id: string; member: string; amount: number; failed: boolean }[] = [];
    ingestProviders(journal, xero, stripe);
    for (const event of events) {
      if (event.fail) {
        const r = refunds.find(r => r.member === event.member && !r.failed);
        if (r) { stripe.failRefund(r.id); r.failed = true; expected.set(r.member, expected.get(r.member)! - r.amount); }
      } else if (expected.get(event.member)! + event.amount <= 10000) {
        const r = stripe.dashboardRefund(intents.get(event.member)!, event.amount);
        refunds.push({ id: r.id, member: event.member, amount: event.amount, failed: false });
        expected.set(event.member, expected.get(event.member)! + event.amount);
      }
      ingestProviders(journal, xero, stripe);
      for (const member of members) expect(journal.totals(members)[member]).toMatchObject({ card: 10000, refunded: expected.get(member) });
      const count = journal.postings.length;
      ingestProviders(journal, xero, stripe);
      expect(journal.postings).toHaveLength(count);
    }
  }), { seed: 4461, numRuns: 100 });
});
