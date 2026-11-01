import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/superseded-ask-invoice-carry", () => ({ readAskInvoicesForCarry: vi.fn() }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({ findActiveSupplementaryInvoiceLink: vi.fn() }));
vi.mock("@/lib/xero-primary-invoice-gap-anchors", () => ({ findPrimaryInvoiceGapInvoice: vi.fn(), readPrimaryInvoiceFeeAtLink: vi.fn() }));

import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";
import { CREDIT_RELEASE_MERGE_WAIT_WORDS, decideCreditReleaseMerge, unpaidRequestRows, type CreditReleaseMergeRow } from "@/lib/credit-release-merge";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import type { AskInvoiceForCarry } from "@/lib/superseded-ask-invoice-carry";

/*
  #4491 (`INV-ADDPAY-052`): whether a credit release merges into the unpaid request open on
  its booking, or waits behind it. Synthetic amounts: an edit asked $30.00 by card.
*/
function row(over: Partial<CreditReleaseMergeRow> & { id: string }): CreditReleaseMergeRow {
  return {
    source: PaymentSource.STRIPE,
    status: PaymentStatus.PENDING,
    reason: "guest_add_price_increase",
    amountCents: 3000,
    carriedAskCents: 0,
    stripePaymentIntentId: `pi_${over.id}`,
    withdrawnAt: null,
    hadIssuedXeroInvoice: true,
    bookingModificationId: `mod_${over.id}`,
    ...over,
  };
}

const waitingFor = (id: string, over: Partial<AskInvoiceForCarry> = {}): AskInvoiceForCarry => ({
  anchorId: `mod_${id}`,
  firstWaitedOn: `pi_${id}`,
  carriable: true,
  refusal: null,
  ...over,
});

const decide = (rowsOldestFirst: CreditReleaseMergeRow[], invoices: AskInvoiceForCarry[], editsWithOwnInvoice?: Set<string>) => {
  const live = rowsOldestFirst.at(-1)!;
  return decideCreditReleaseMerge({
    rowsOldestFirst,
    live: { paymentIntentId: live.stripePaymentIntentId!, amountCents: live.amountCents },
    invoices,
    ...(editsWithOwnInvoice ? { editsWithOwnInvoice } : {}),
  });
};

describe("decideCreditReleaseMerge", () => {
  it("merges an unpaid edit request whose supplementary invoice waits on it", () => {
    expect(decide([row({ id: "e" })], [waitingFor("e")])).toEqual({ merge: true });
  });

  it("merges an edit billed on the booking's own invoice (made before it was raised), with no supplementary invoice", () => {
    expect(decide([row({ id: "e", hadIssuedXeroInvoice: false })], [])).toEqual({ merge: true });
  });

  it("merges an edit that already merged an earlier release (both orders compose)", () => {
    const release = row({ id: "r0", reason: CREDIT_RELEASE_ASK_REASON, amountCents: 1000, status: PaymentStatus.FAILED, hadIssuedXeroInvoice: false, bookingModificationId: null });
    const edit = row({ id: "e", amountCents: 4000, carriedAskCents: 1000 });
    expect(decide([release, edit], [waitingFor("e")])).toEqual({ merge: true });
  });

  it("merges a chain of edits whose earlier invoice was already moved onto the later request", () => {
    const first = row({ id: "a", status: PaymentStatus.FAILED });
    const second = row({ id: "b", amountCents: 5000, carriedAskCents: 3000 });
    expect(decide([first, second], [waitingFor("a", { firstWaitedOn: "pi_a" }), waitingFor("b")])).toEqual({ merge: true });
  });

  it("matches an older edit row with no edit stamp by the intent its invoice first waited on", () => {
    expect(decide([row({ id: "e", bookingModificationId: null })], [waitingFor("e", { anchorId: "mod_other" })])).toEqual({ merge: true });
  });

  it("a request made only of released credit is superseded as before, even one whose first row carried a release captured late", () => {
    const late = row({ id: "r0", reason: CREDIT_RELEASE_ASK_REASON, status: PaymentStatus.REFUNDED, amountCents: 1000, hadIssuedXeroInvoice: false, bookingModificationId: null });
    const live = row({ id: "r1", reason: CREDIT_RELEASE_ASK_REASON, amountCents: 2500, carriedAskCents: 1000, hadIssuedXeroInvoice: false, bookingModificationId: null });
    expect(decide([late, live], [])).toEqual({ merge: true });
  });

  it("reads the request after the last capture: an earlier paid request is not part of it", () => {
    const paid = row({ id: "old", status: PaymentStatus.SUCCEEDED, hadIssuedXeroInvoice: null });
    expect(decide([paid, row({ id: "e" })], [waitingFor("e")])).toEqual({ merge: true });
  });

  describe("waits behind the edit, and says why", () => {
    it.each([
      ["the edit's invoice is not queued yet", [row({ id: "e" })], [], "edit-invoice-not-waiting"],
      ["the edit's invoice waits but the move would refuse it", [row({ id: "e" })], [waitingFor("e", { carriable: false, refusal: "invoice-already-linked" })], "edit-invoice-not-waiting"],
      ["another invoice naming the request was already sent", [row({ id: "e" })], [waitingFor("e"), waitingFor("x", { carriable: false, refusal: "not-waiting" })], "invoice-cannot-follow"],
      ["the edit never recorded which invoice bills it", [row({ id: "e", hadIssuedXeroInvoice: null })], [], "edit-billing-unknown"],
      ["a re-issued ask", [row({ id: "e", reason: REISSUED_ASK_REASON })], [], "not-an-edit-request"],
      ["primary-billed edit money beside a supplementary invoice", [row({ id: "a", hadIssuedXeroInvoice: false, status: PaymentStatus.FAILED }), row({ id: "b", amountCents: 5000, carriedAskCents: 3000 })], [waitingFor("b")], "mixed-billing"],
      ["a row that did not carry all of the one before it", [row({ id: "a", status: PaymentStatus.FAILED }), row({ id: "b", amountCents: 5000, carriedAskCents: 2000 })], [waitingFor("a"), waitingFor("b")], "ledger-unreadable"],
      ["a first row carrying money from outside the request", [row({ id: "e", carriedAskCents: 500 })], [waitingFor("e")], "ledger-unreadable"],
      ["a bank row inside the request", [row({ id: "e", source: PaymentSource.INTERNET_BANKING })], [waitingFor("e")], "ledger-unreadable"],
      ["an edit made before the booking's invoice, with no edit stamp to check its own invoice by", [row({ id: "e", hadIssuedXeroInvoice: false, bookingModificationId: null })], [], "edit-billing-unknown"],
    ] as const)("%s", (_label, rows, invoices, reason) => {
      expect(decide([...rows], [...invoices])).toEqual({ merge: false, reason });
    });

    it("an edit made before the booking's invoice that a #3980 gap invoice (or any invoice of its own) bills", () => {
      const edit = row({ id: "e", hadIssuedXeroInvoice: false });
      expect(decide([edit], [], new Set(["mod_e"]))).toEqual({ merge: false, reason: "edit-billed-on-its-own-invoice" });
      // Another edit's invoice is not this one's.
      expect(decide([edit], [], new Set(["mod_other"]))).toEqual({ merge: true });
    });

    it("every reason has the officers' words", () => {
      for (const words of Object.values(CREDIT_RELEASE_MERGE_WAIT_WORDS)) expect(words.length).toBeGreaterThan(20);
    });

    it("the mirror names a request that is not the newest row", () => {
      const rows = [row({ id: "e" })];
      expect(
        decideCreditReleaseMerge({ rowsOldestFirst: rows, live: { paymentIntentId: "pi_other", amountCents: 3000 }, invoices: [waitingFor("e")] }),
      ).toEqual({ merge: false, reason: "ledger-unreadable" });
      expect(
        decideCreditReleaseMerge({ rowsOldestFirst: rows, live: { paymentIntentId: "pi_e", amountCents: 2999 }, invoices: [waitingFor("e")] }),
      ).toEqual({ merge: false, reason: "ledger-unreadable" });
    });
  });
});

describe("unpaidRequestRows", () => {
  it("starts after the last capture and passes over officer-withdrawn rows", () => {
    const rows = [
      row({ id: "a", status: PaymentStatus.SUCCEEDED }),
      row({ id: "b", withdrawnAt: new Date("2026-06-30T00:00:00.000Z") }),
      row({ id: "c" }),
    ];
    expect(unpaidRequestRows(rows).map((r) => r.id)).toEqual(["c"]);
  });
});
