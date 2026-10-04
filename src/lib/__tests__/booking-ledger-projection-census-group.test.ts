/**
 * The census's reading of a group organiser's settlement (#3854): a settled
 * child's share and plan refund agree with its columns and its settlement, a
 * corrupted one disagrees, and the shapes the back-post has not reached yet
 * read as coverage or a named in-flight refund, never as an unexplained
 * disagreement. Rows are built from the real planners.
 */
import { describe, expect, it } from "vitest";

import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { planGroupSettlementRefundLine, planGroupSettlementShareLines } from "@/lib/booking-ledger-group-settlement-posting";
import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import { refundKey } from "@/lib/booking-ledger-posting-keys";
import { evaluateBookingLedgerIdentities } from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";

const B = "child-1";
const D1 = new Date("2027-09-01T00:00:00.000Z");
const D2 = new Date("2027-09-02T00:00:00.000Z");
let seq = 0;

function toLines(postings: readonly BookingLedgerPosting[]): CensusLedgerLine[] {
  return postings.map((posting) => ({
    id: `line-${(seq += 1)}`,
    side: posting.side,
    kind: posting.kind,
    sign: posting.sign,
    quantity: posting.quantity,
    unitCents: posting.unitCents,
    amountCents: ledgerLineAmountCents(posting),
    bookingGuestId: posting.bookingGuestId ?? null,
    nightStart: posting.nightStart ?? null,
    nightEndExclusive: posting.nightEndExclusive ?? null,
    anchorKind: posting.anchorKind,
    anchorId: posting.anchorId,
    settlementMethod: posting.settlementMethod ?? null,
    reversesLineId: posting.reversesLineId ?? null,
    postingKey: posting.postingKey,
    postedAt: new Date(1_000 * seq),
  }));
}

/** A $45 child its organiser settled, confirmed and its share posted by the settle's own planners. */
function settledChild(source: "STRIPE" | "INTERNET_BANKING"): { row: BookingLedgerCensusRow; settlement: { id: string; source: typeof source } } {
  const settlement = { id: "gs1", source };
  const charges = planConfirmationChargeLines({
    id: B,
    lodgeId: "l1",
    totalPriceCents: 4_500,
    promoAdjustmentCents: 0,
    guests: [
      {
        id: "g1",
        firstName: "Joiner",
        lastName: "One",
        ageTier: "ADULT",
        rateMembershipTypeId: null,
        nights: [
          { stayDate: D1, priceCents: 2_250 },
          { stayDate: D2, priceCents: 2_250 },
        ],
      },
    ],
  }).postings;
  const share = planGroupSettlementShareLines({
    settlement: { ...settlement, amountCents: 4_500 },
    children: [{ bookingId: B, lodgeId: "l1", shareCents: 4_500 }],
  }).postings;
  return {
    settlement,
    row: {
      booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: true, finalPriceCents: 4_500 },
      payment: {
        id: "pay-1",
        source,
        status: "SUCCEEDED",
        amountCents: 4_500,
        creditAppliedCents: 0,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: null,
        manuallyMarkedPaidAt: null,
      },
      transactions: [],
      refunds: [],
      credits: [],
      tasks: [],
      modifications: [],
      recoveryOperations: [],
      cancellation: null,
      groupSettlement: { id: "gs1", source, status: "SUCCEEDED", refundPlan: null, refundRecoveryInFlight: false },
      lines: toLines([...charges, ...share]),
    },
  };
}

/** The organiser cancel under a mirror plan: the refund beside the mirror, the stay reversed, the rest kept. */
function cancelledUnderPlan(source: "STRIPE" | "INTERNET_BANKING", options: { refundPosted: boolean }): BookingLedgerCensusRow {
  const { row, settlement } = settledChild(source);
  const refund = planGroupSettlementRefundLine({ settlement, bookingId: B, lodgeId: "l1", refundCents: 2_250 });
  const cancellation = planCancellationChargeLines({
    bookingId: B,
    lodgeId: "l1",
    keptCents: 2_250,
    chargeLines: row.lines
      .filter((line) => line.kind === "GUEST_NIGHT")
      .map((line) => ({ ...line, kind: "GUEST_NIGHT" as const, sign: line.sign === -1 ? -1 : 1, rateMembershipTypeId: null, ageTier: "ADULT", guestNames: ["Joiner One"], narration: "night" })),
    adjustmentLines: [],
  });
  if (cancellation.kind !== "lines") throw new Error("expected cancellation lines");
  return {
    ...row,
    booking: { ...row.booking, status: "CANCELLED" },
    payment: { ...row.payment!, status: "PARTIALLY_REFUNDED", refundedAmountCents: options.refundPosted ? 2_250 : 0 },
    groupSettlement: { ...row.groupSettlement!, refundPlan: { [B]: 2_250 }, refundRecoveryInFlight: !options.refundPosted },
    lines: [...row.lines, ...toLines([...(options.refundPosted && refund ? [refund] : []), ...cancellation.postings])],
  };
}

const statuses = (subject: BookingLedgerCensusRow) =>
  Object.fromEntries(evaluateBookingLedgerIdentities(subject).identities.map((result) => [result.identity, result.status]));
const integrity = (subject: BookingLedgerCensusRow) => evaluateBookingLedgerIdentities(subject).integrity.map((finding) => finding.kind);

describe("the census on a group-settled child (#3854)", () => {
  it.each(["STRIPE", "INTERNET_BANKING"] as const)("a %s settlement's child agrees on every identity, with no integrity finding", (source) => {
    const { row } = settledChild(source);
    expect(statuses(row)).toMatchObject({ PRICE: "AGREE", CAPTURED: "AGREE", REFUNDED: "AGREE", OWED: "AGREE" });
    expect(integrity(row)).toEqual([]);
    expect(evaluateBookingLedgerIdentities(row).bookingClass).toBeNull();
  });

  it("a share that no longer matches the child's payment, or under another settlement, is SOURCE_DRIFT", () => {
    const { row } = settledChild("STRIPE");
    expect(integrity({ ...row, payment: { ...row.payment!, amountCents: 4_400 } })).toContain("SOURCE_DRIFT");
    expect(integrity({ ...row, groupSettlement: { ...row.groupSettlement!, id: "gs-other" } })).toContain("SOURCE_DRIFT");
    expect(integrity({ ...row, groupSettlement: { ...row.groupSettlement!, status: "FAILED" } })).toContain("SOURCE_DRIFT");
  });

  it("an Internet Banking plan's BANK_REFUND counts on REFUNDED, and the cancelled child's owed(b) is zero", () => {
    const subject = cancelledUnderPlan("INTERNET_BANKING", { refundPosted: true });
    expect(statuses(subject)).toMatchObject({ PRICE: "AGREE", CAPTURED: "AGREE", REFUNDED: "AGREE" });
    expect(integrity(subject)).toEqual([]);
  });

  it("a plan refund line that disagrees with the frozen plan is SOURCE_DRIFT", () => {
    const subject = cancelledUnderPlan("INTERNET_BANKING", { refundPosted: true });
    expect(integrity({ ...subject, groupSettlement: { ...subject.groupSettlement!, refundPlan: { [B]: 2_000 } } })).toContain("SOURCE_DRIFT");
  });

  it("a pre-#3653 card plan whose one group retry is still in flight names the child's share of it IN_FLIGHT_REFUND", () => {
    const subject = cancelledUnderPlan("STRIPE", { refundPosted: false });
    const price = evaluateBookingLedgerIdentities(subject).identities.find((result) => result.identity === "PRICE")!;
    expect(price).toMatchObject({ status: "CLASSIFIED", deltaCents: 2_250, explainedBy: [{ name: "IN_FLIGHT_REFUND", cents: 2_250 }] });
    // Without the retry in flight, the same gap is a disagreement.
    expect(statuses({ ...subject, groupSettlement: { ...subject.groupSettlement!, refundRecoveryInFlight: false } }).PRICE).toBe("DISAGREE");
  });

  it("a child settled before #3854 that holds only a #3653 refund line is coverage, not a PRICE disagreement", () => {
    const { row } = settledChild("STRIPE");
    const refundLine = toLines([
      {
        bookingId: B,
        lodgeId: "l1",
        side: "SETTLEMENT",
        kind: "CARD_REFUND",
        sign: -1,
        quantity: 1,
        unitCents: 2_250,
        anchorKind: "PAYMENT_REFUND",
        anchorId: "re-1",
        settlementMethod: "CARD",
        narration: "Card refund",
        postingKey: refundKey("re-1"),
      },
    ]);
    const subject: BookingLedgerCensusRow = {
      ...row,
      booking: { ...row.booking, status: "CANCELLED" },
      payment: { ...row.payment!, refundedAmountCents: 2_250, status: "PARTIALLY_REFUNDED" },
      refunds: [{ id: "re-1", status: "succeeded", amountCents: 2_250, paymentTransactionId: null }],
      lines: refundLine,
    };
    const result = evaluateBookingLedgerIdentities(subject);
    expect(result.identities.find((identity) => identity.identity === "PRICE")).toMatchObject({ status: "COVERAGE" });
    expect(result.coverage).toContain("NOT_CONFIRMED_ON_LEDGER");
  });
});
