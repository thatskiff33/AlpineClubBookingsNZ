/**
 * The gate between an edit's stored lines and a Xero document (#3530 stage
 * 2b, `INV-MOD-058`): itemised only when the lines explain exactly what the
 * document bills; every other case is today's single line with a named reason.
 */
import { describe, expect, it } from "vitest";
import { selectModificationDocumentLines } from "@/lib/booking-modification-document-lines";
import type { ModificationLine } from "@/lib/booking-modification-lines";

const removed: ModificationLine = {
  v: 1,
  kind: "GUEST_NIGHTS",
  sign: -1,
  ageTier: "ADULT",
  isMember: false,
  rateMembershipTypeId: "type-non-member",
  unitCents: 8000,
  nightCount: 2,
  guestCount: 2,
  quantity: 4,
  startDate: "2026-08-14",
  endExclusive: "2026-08-16",
  guestNames: ["Guest a", "Guest b"],
  amountCents: -32000,
};
const added: ModificationLine = {
  ...removed,
  sign: 1,
  nightCount: 1,
  guestCount: 1,
  quantity: 1,
  startDate: "2026-08-16",
  endExclusive: "2026-08-17",
  guestNames: ["Guest c"],
  amountCents: 8000,
};
const promo: ModificationLine = { v: 1, kind: "PROMO_DELTA", sign: 1, promoCode: "SUMMER25", amountCents: 1000 };

describe("selectModificationDocumentLines", () => {
  it("itemises a supplementary invoice whose lines sum to the price delta it bills plus the fee", () => {
    const selection = selectModificationDocumentLines({
      storedPriceLines: [added, promo],
      priceDiffCents: 9000,
      changeFeeCents: 2500,
      billedCents: 11500,
      document: "SUPPLEMENTARY_INVOICE",
    });
    expect(selection).toEqual({ source: "STORED", lines: [added, promo], storedSumCents: 9000, billedCents: 11500 });
  });

  it("itemises a credit note that returns the whole reduction net of the fee", () => {
    const selection = selectModificationDocumentLines({
      storedPriceLines: [removed, added],
      priceDiffCents: -24000,
      changeFeeCents: 2500,
      billedCents: 21500,
      document: "MODIFICATION_CREDIT_NOTE",
    });
    expect(selection).toMatchObject({ source: "STORED", storedSumCents: -24000, billedCents: 21500 });
  });

  it("NO_STORED_LINES: a row that stores none (parked, inexact, legacy)", () => {
    expect(
      selectModificationDocumentLines({
        storedPriceLines: null,
        priceDiffCents: 8000,
        changeFeeCents: 0,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toEqual({ source: "FALLBACK_SINGLE_LINE", reason: "NO_STORED_LINES", storedSumCents: null, billedCents: 8000 });
  });

  it("UNPARSEABLE: a column this version cannot read as a whole, including one perturbed line", () => {
    // The parser's own rule refuses a line whose money is not sign x unit x
    // quantity, so a stored unit price perturbed by one cent never renders.
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [{ ...added, unitCents: 8001 }],
        priceDiffCents: 8000,
        changeFeeCents: 0,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toMatchObject({ source: "FALLBACK_SINGLE_LINE", reason: "UNPARSEABLE" });
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [],
        priceDiffCents: 8000,
        changeFeeCents: 0,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toMatchObject({ reason: "UNPARSEABLE" });
  });

  it("STORED_LINES_DO_NOT_SUM: a restated operation bills a raised figure the lines were never about (INV-PAY-070)", () => {
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [added],
        priceDiffCents: 9000,
        changeFeeCents: 0,
        billedCents: 9000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toEqual({ source: "FALLBACK_SINGLE_LINE", reason: "STORED_LINES_DO_NOT_SUM", storedSumCents: 8000, billedCents: 9000 });
    // A consistently perturbed line (unit and amount together) sums wrong too.
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [{ ...added, unitCents: 8001, amountCents: 8001 }],
        priceDiffCents: 8000,
        changeFeeCents: 0,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toMatchObject({ reason: "STORED_LINES_DO_NOT_SUM", storedSumCents: 8001 });
    // The invoice's own net disagreeing with its components is the same defect.
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [added],
        priceDiffCents: 8000,
        changeFeeCents: 2500,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
      }),
    ).toMatchObject({ reason: "STORED_LINES_DO_NOT_SUM" });
  });

  it("SECOND_ASK: #3193's follow-on bills one settled share, never the edit", () => {
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [added],
        priceDiffCents: 8000,
        changeFeeCents: 0,
        billedCents: 8000,
        document: "SUPPLEMENTARY_INVOICE",
        secondAsk: true,
      }),
    ).toEqual({ source: "FALLBACK_SINGLE_LINE", reason: "SECOND_ASK", storedSumCents: null, billedCents: 8000 });
  });

  it("POLICY_RETAINED: a credit note that returns less than the reduction", () => {
    expect(
      selectModificationDocumentLines({
        storedPriceLines: [removed],
        priceDiffCents: -32000,
        changeFeeCents: 0,
        billedCents: 16000,
        document: "MODIFICATION_CREDIT_NOTE",
      }),
    ).toEqual({ source: "FALLBACK_SINGLE_LINE", reason: "POLICY_RETAINED", storedSumCents: -32000, billedCents: 16000 });
  });
});
