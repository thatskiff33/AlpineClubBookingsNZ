/**
 * #3954 review round 6 (F6), round 7 (F1): what Xero billed of the ask a
 * reduction retired is read from evidence - each row's own money by the asking
 * edit's own invoice answer (its recovery's, for a row a recovery minted; the
 * one its door stamped on the row otherwise), money a row carried in by the
 * re-issue or fold that names it - never from which supplementary invoices
 * happen to be parked yet, nor from when a row was written. Anything it cannot
 * establish is not credit-noted.
 */
import { describe, expect, it } from "vitest";

import type { UnpaidPriceAskRow } from "@/lib/additional-ask-reduction";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import { classifyUnpaidAskBilling, type IntentMinter } from "@/lib/unpaid-ask-billing-evidence";

const ASKED_AT = new Date("2026-06-20T00:00:00.000Z");
const AFTER = new Date("2026-06-25T00:00:00.000Z");
const NO_MINTERS = new Map<string, IntentMinter>();

function row(overrides: Partial<UnpaidPriceAskRow> = {}): UnpaidPriceAskRow {
  return {
    id: "txn_ask",
    amountCents: 5_000,
    carriedAskCents: 0,
    stripePaymentIntentId: "pi_ask",
    reason: "guest_add_price_increase",
    createdAt: ASKED_AT,
    hadIssuedXeroInvoice: true,
    bookingModificationId: null,
    ...overrides,
  };
}

const NOTHING_RETIRED = { invoicedCents: 0, parkedOps: [], invoiceEvidenceUnknown: false };
const increase = { id: "mod_increase", priceDiffCents: 5_000, changeFeeCents: 0, newData: {}, createdAt: new Date("2026-06-19T00:00:00.000Z") };
const reduction = (invoiceCents: number) => ({
  id: "mod_reduction",
  priceDiffCents: -2_000,
  changeFeeCents: 0,
  newData: invoiceCents > 0 ? { reissuedAskInvoiceCents: invoiceCents } : {},
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
});

describe("classifyUnpaidAskBilling", () => {
  it.each(["mod_a", "mod_b"])("counts nested folded invoices once when only %s is parked", (anchor) => {
    const entry = (modificationId: string, cents: number) => ({
      modificationId, askCents: cents, invoiceCents: cents,
      invoiceUnsure: false, hadIssuedXeroInvoice: true,
    });
    const modifications = [
      { ...increase, id: "mod_a", priceDiffCents: 3_000 },
      { ...increase, id: "mod_b", priceDiffCents: 2_000, newData: {
        foldedReissuedAskCents: 3_000, foldedReissuedAskInvoiceCents: 3_000,
        foldedIncreaseAsks: [entry("mod_a", 3_000)],
      } },
      { ...increase, id: "mod_c", priceDiffCents: 1_000, newData: {
        foldedReissuedAskCents: 5_000, foldedReissuedAskInvoiceCents: 5_000,
        foldedIncreaseAsks: [entry("mod_b", 5_000)],
      } },
    ];
    expect(classifyUnpaidAskBilling({
      rows: [row({ amountCents: 6_000, carriedAskCents: 5_000, bookingModificationId: "mod_c" })],
      retired: {
        invoicedCents: anchor === "mod_a" ? 3_000 : 2_000,
        parkedOps: [{ intentId: "pi_ask", anchorId: anchor }],
        invoiceEvidenceUnknown: false,
      },
      modifications, intentMinters: NO_MINTERS,
    })).toEqual({ supplementaryInvoicedCents: 6_000, established: true });
  });

  it("MUTATION: an increase whose door stamped 'invoice issued' is a supplementary invoice's to bill, parked or not yet", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [row()], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: NO_MINTERS }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: an increase whose door stamped 'no invoice yet' was billed by the primary invoice raised afterwards", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ hadIssuedXeroInvoice: false })],
        retired: NOTHING_RETIRED,
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 0, established: true });
  });

  /**
   * #3980 (round 3, the orchestrator's call): an increase that read no invoice
   * and landed mid-create has its money on the primary invoice's GAP invoice,
   * raised (never parked) by the create's check. A reduction that retires its
   * unpaid ask must read that money as already invoiced and credit the offset
   * - never re-invoice it: decision A's re-issue invoice bills only money a
   * PARKED invoice held and the retire cancelled, and the gap invoice is
   * neither parked nor cancelled. Counting it as supplementary money would
   * raise a second invoice for what the open gap invoice still bills.
   */
  it("MUTATION #3980: an ask whose money a raised gap invoice bills is credited by note, never invoiced again", async () => {
    const { splitUnpaidAskOffsetForXero } = await import("@/lib/additional-payment-ask");
    const asked = row({ amountCents: 10_000, hadIssuedXeroInvoice: false, bookingModificationId: "mod_increase" });
    const evidence = classifyUnpaidAskBilling({
      rows: [asked],
      retired: NOTHING_RETIRED,
      modifications: [{ ...increase, priceDiffCents: 10_000 }],
      intentMinters: NO_MINTERS,
    });
    expect(evidence).toEqual({ supplementaryInvoicedCents: 0, established: true });
    // A 40.00 reduction set against the 100.00 ask: the 40.00 is credited, the
    // smaller 60.00 ask is collected by card, and no second invoice is raised.
    expect(
      splitUnpaidAskOffsetForXero({
        offsetCents: 4_000,
        askLeftCents: 6_000,
        supplementaryInvoicedCents: evidence.supplementaryInvoicedCents,
        primaryInvoiceIssued: true,
        billedByPrimaryEstablished: evidence.established,
      }),
    ).toEqual({ reissuedAskInvoiceCents: 0, reissuedAskInvoiceUnsureCents: 0, billedOffsetCents: 4_000, billedOffsetUnsureCents: 0 });
  });

  it("MUTATION: a row a recovery minted reads that recovery's frozen answer, not the row's own or when it was written", () => {
    // The under-credit shape: the edit saw no invoice, its mint failed, the
    // primary invoice was raised (billing the edit), then the recovery minted.
    const minted = row({ hadIssuedXeroInvoice: null, createdAt: AFTER });
    const minters = (answer: boolean | null) =>
      new Map<string, IntentMinter>([["pi_ask", { modificationId: "mod_increase", hadIssuedXeroInvoice: answer }]]);
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(false) }),
    ).toEqual({ supplementaryInvoicedCents: 0, established: true });
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(true) }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(null) }).established,
    ).toBe(false);
  });

  it("a folded increase's parked invoice does not cover the later edit's own money", () => {
    const later = {
      ...increase,
      id: "mod_later",
      priceDiffCents: 1_000,
      newData: {
        foldedReissuedAskCents: 5_000,
        foldedReissuedAskInvoiceCents: 5_000,
        foldedIncreaseAsks: [
          {
            modificationId: "mod_increase",
            askCents: 5_000,
            invoiceCents: 5_000,
            invoiceUnsure: false,
            hadIssuedXeroInvoice: true,
          },
        ],
      },
    };
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ amountCents: 6_000, carriedAskCents: 5_000, bookingModificationId: "mod_later" })],
        retired: { invoicedCents: 5_000, parkedOps: [{ intentId: "pi_ask", anchorId: "mod_increase" }], invoiceEvidenceUnknown: false },
        modifications: [increase, later],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 6_000, established: true });
  });

  it("a parked invoice covers its row: counted once, by the retire", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row()],
        retired: { invoicedCents: 5_000, parkedOps: [{ intentId: "pi_ask", anchorId: "mod_increase" }], invoiceEvidenceUnknown: false },
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: a door-minted row with no answer recorded (minted before round 7) is not established", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ hadIssuedXeroInvoice: null })],
        retired: NOTHING_RETIRED,
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }).established,
    ).toBe(false);
  });

  it("MUTATION: a re-issue row's money is billed by its reduction's recorded invoice, found through the recovery that minted it; the rest by the primary", () => {
    const reissue = row({ reason: REISSUED_ASK_REASON, amountCents: 3_000, carriedAskCents: 3_000, stripePaymentIntentId: "pi_reissue" });
    expect(
      classifyUnpaidAskBilling({
        rows: [reissue],
        retired: NOTHING_RETIRED,
        modifications: [reduction(1_000)],
        intentMinters: new Map([["pi_reissue", { modificationId: "mod_reduction", hadIssuedXeroInvoice: true }]]),
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000, established: true });
    // Nothing names it: not guessed.
    expect(
      classifyUnpaidAskBilling({ rows: [reissue], retired: NOTHING_RETIRED, modifications: [reduction(1_000)], intentMinters: NO_MINTERS }).established,
    ).toBe(false);
  });

  it("MUTATION: an increase that folded a re-issue in carries its invoice, found through the fold its history records", () => {
    const folding = {
      ...increase,
      priceDiffCents: 1_000,
      newData: { foldedReissuedAskCents: 3_000, foldedReissuedAskInvoiceCents: 1_000, foldedReissuedAskModificationIds: ["mod_reduction"] },
    };
    const folded = row({ amountCents: 4_000, carriedAskCents: 3_000 });
    expect(
      classifyUnpaidAskBilling({
        rows: [folded],
        retired: NOTHING_RETIRED,
        modifications: [folding, reduction(1_000)],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000 + 1_000, established: true });
  });

  it("round 8: a re-issue row its door minted names its reduction by the edit stamped on it, with no recovery to find", () => {
    const reissue = row({
      reason: REISSUED_ASK_REASON,
      amountCents: 3_000,
      carriedAskCents: 3_000,
      stripePaymentIntentId: "pi_reissue",
      bookingModificationId: "mod_reduction",
    });
    expect(
      classifyUnpaidAskBilling({ rows: [reissue], retired: NOTHING_RETIRED, modifications: [reduction(1_000)], intentMinters: NO_MINTERS }),
    ).toEqual({ supplementaryInvoicedCents: 1_000, established: true });
  });

  it("MUTATION (round 8): a carried-in re-issue whose reduction was unsure of its invoice is not established - parked or not", () => {
    const unsure = { ...reduction(1_000), newData: { reissuedAskInvoiceCents: 1_000, reissuedAskInvoiceUnsureCents: 500 } };
    const reissue = row({ reason: REISSUED_ASK_REASON, amountCents: 3_000, carriedAskCents: 3_000, stripePaymentIntentId: "pi_reissue" });
    const minters = new Map([["pi_reissue", { modificationId: "mod_reduction", hadIssuedXeroInvoice: true }]]);
    expect(
      classifyUnpaidAskBilling({ rows: [reissue], retired: NOTHING_RETIRED, modifications: [unsure], intentMinters: minters }),
    ).toEqual({ supplementaryInvoicedCents: 1_000, established: false });
    expect(
      classifyUnpaidAskBilling({
        rows: [reissue],
        retired: { invoicedCents: 1_000, parkedOps: [{ intentId: "pi_reissue", anchorId: "mod_reduction" }], invoiceEvidenceUnknown: false },
        modifications: [unsure],
        intentMinters: minters,
      }).established,
    ).toBe(false);
  });

  it("MUTATION (round 8): an increase that folded in a re-issue its reduction was unsure of is not established", () => {
    const folding = {
      ...increase,
      priceDiffCents: 1_000,
      newData: { foldedReissuedAskCents: 3_000, foldedReissuedAskInvoiceCents: 1_000, foldedReissuedAskModificationIds: ["mod_reduction"] },
    };
    const unsure = { ...reduction(1_000), newData: { reissuedAskInvoiceCents: 1_000, reissuedAskInvoiceUnsureCents: 500 } };
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ amountCents: 4_000, carriedAskCents: 3_000, bookingModificationId: "mod_increase" })],
        retired: NOTHING_RETIRED,
        modifications: [folding, unsure],
        intentMinters: NO_MINTERS,
      }).established,
    ).toBe(false);
  });

  it("a carried figure that does not add up (a row written before carried asks were recorded) is not established", () => {
    const first = row({ id: "txn_1", amountCents: 5_000 });
    const legacy = row({ id: "txn_2", amountCents: 8_000, carriedAskCents: 0, stripePaymentIntentId: "pi_2", createdAt: AFTER });
    expect(
      classifyUnpaidAskBilling({ rows: [first, legacy], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: NO_MINTERS }).established,
    ).toBe(false);
  });

  it("a waiting increase whose invoice answer was never recorded is not established", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [], retired: { ...NOTHING_RETIRED, invoiceEvidenceUnknown: true }, modifications: [], intentMinters: NO_MINTERS }).established,
    ).toBe(false);
  });
});
