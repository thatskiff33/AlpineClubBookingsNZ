/**
 * Comparison report v1 (#4627): the JOURNAL identity and the
 * `UNBRIDGED_CHARGE_LINE` finding, judged from a census row. Pure. The same
 * comparison over real door postings on PostgreSQL is in
 * `booking-ledger-journal.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { journalChargeComparison, withJournalInactiveFinding } from "@/lib/booking-ledger-projection-census-journal";
import { summarizeBookingLedgerCensus } from "@/lib/booking-ledger-projection-census-report";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { bookingChargeIdentity, type BookingJournalCharges } from "@/lib/member-money";

const B = "census-4627";
const CHARGE = bookingChargeIdentity(B);
const AT = new Date("2026-06-01T00:00:00.000Z");

function line(id: string, overrides: Partial<CensusLedgerLine>): CensusLedgerLine {
  return {
    id, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: 0, amountCents: 0, bookingGuestId: null,
    nightStart: null, nightEndExclusive: null, anchorKind: "CONFIRMATION", anchorId: B, settlementMethod: null,
    reversesLineId: null, postingKey: `key-${id}`, postedAt: AT, ...overrides,
  };
}

function row(lines: CensusLedgerLine[], journal: Omit<BookingJournalCharges, "journalSince"> & { journalSince?: Date | null } | null, createdAt?: Date): BookingLedgerCensusRow {
  return {
    booking: { id: B, status: "PAID", deletedAt: null, organiserSettled: false, finalPriceCents: 0, ...(createdAt ? { createdAt } : {}) },
    payment: null, transactions: [], refunds: [], credits: [], tasks: [], modifications: [], recoveryOperations: [],
    cancellation: null, appeals: [], groupSettlement: null, groupChild: null, lines,
    journal: journal ? { journalSince: null, ...journal } : null,
  };
}

const nightA = line("n1", { amountCents: 6000, unitCents: 6000 });
const nightB = line("n2", { amountCents: 6000, unitCents: 6000 });
const promo = line("p1", { kind: "PROMOTION", sign: -1, unitCents: 1500, amountCents: -1500 });
const fee = line("f1", { kind: "CHANGE_FEE", amountCents: 2000, unitCents: 2000, anchorKind: "MODIFICATION", postingKey: "modification:m1:change-fee" });
const capture = line("c1", { side: "SETTLEMENT", kind: "CARD_CAPTURE", sign: -1, amountCents: -12500, settlementMethod: "CARD" });
const all = (ids: string[]) => new Set(ids);

describe("the JOURNAL comparison (#4627)", () => {
  it("does not compare a booking whose confirmation is not in the journal: M9 back-posts it", () => {
    expect(journalChargeComparison(row([nightA], null)).identity.status).toBe("NOT_APPLICABLE");
    expect(journalChargeComparison(row([nightA], { charged: false, components: [], bridgedLineIds: all([]) })).identity.status).toBe("NOT_APPLICABLE");
  });

  it("agrees when each live component equals its bridged lines, settlement lines aside", () => {
    const result = journalChargeComparison(row([nightA, nightB, promo, fee, capture], {
      charged: true,
      components: [
        { account: "BOOKING_REVENUE", chargeIdentity: CHARGE, liveGrossCents: 10500 },
        { account: "FEE_REVENUE", chargeIdentity: "modification:m1:change-fee", liveGrossCents: 2000 },
      ],
      bridgedLineIds: all(["n1", "n2", "p1", "f1"]),
    }));
    expect(result.identity).toMatchObject({ identity: "JOURNAL", status: "AGREE", columnCents: 12500, ledgerCents: 12500, deltaCents: 0 });
    expect(result.integrity).toEqual([]);
  });

  it("disagrees when the journal carries a different total from the bridged lines", () => {
    const result = journalChargeComparison(row([nightA, fee], {
      charged: true,
      components: [
        { account: "BOOKING_REVENUE", chargeIdentity: CHARGE, liveGrossCents: 6000 },
        { account: "FEE_REVENUE", chargeIdentity: "modification:m1:change-fee", liveGrossCents: 0 },
      ],
      bridgedLineIds: all(["n1", "f1"]),
    }));
    expect(result.identity).toMatchObject({ status: "DISAGREE", columnCents: 6000, ledgerCents: 8000, deltaCents: -2000 });
  });

  it("agrees when a give-back the charge could not absorb was taken from a change fee: the total is what counts", () => {
    const kept = line("k1", { kind: "CANCELLATION_FEE", anchorKind: "CANCELLATION", amountCents: 1000, unitCents: 1000 });
    const giveBack = line("a1", { side: "ADJUSTMENT", kind: "AGREED_ADJUSTMENT", sign: -1, amountCents: -1500, unitCents: 1500, anchorKind: "REVIEW_TASK" });
    const result = journalChargeComparison(row([kept, fee, giveBack], {
      charged: true,
      components: [
        { account: "BOOKING_REVENUE", chargeIdentity: CHARGE, liveGrossCents: 0 },
        { account: "FEE_REVENUE", chargeIdentity: "modification:m1:change-fee", liveGrossCents: 1500 },
      ],
      bridgedLineIds: all(["k1", "f1", "a1"]),
    }));
    expect(result.identity).toMatchObject({ status: "AGREE", columnCents: 1500, ledgerCents: 1500 });
  });

  it("names a fee reversal by the fee it reverses", () => {
    const back = line("f2", { kind: "CHANGE_FEE", sign: -1, amountCents: -2000, unitCents: 2000, reversesLineId: "f1", postingKey: "reversal:f1" });
    const result = journalChargeComparison(row([nightA, fee, back], {
      charged: true,
      components: [
        { account: "BOOKING_REVENUE", chargeIdentity: CHARGE, liveGrossCents: 6000 },
        { account: "FEE_REVENUE", chargeIdentity: "modification:m1:change-fee", liveGrossCents: 0 },
      ],
      bridgedLineIds: all(["n1", "f1", "f2"]),
    }));
    expect(result.identity.status).toBe("AGREE");
  });

  it("finds a charge line no batch links, as an integrity finding that holds the gate", () => {
    const result = journalChargeComparison(row([nightA, nightB, line("z1", { amountCents: 0 })], {
      charged: true,
      components: [{ account: "BOOKING_REVENUE", chargeIdentity: CHARGE, liveGrossCents: 6000 }],
      bridgedLineIds: all(["n1"]),
    }));
    expect(result.identity.status).toBe("AGREE");
    // The zero-cent line carries no money and is never bridged; the unbridged night is the finding.
    expect(result.integrity).toEqual([expect.objectContaining({ lineId: "n2", kind: "UNBRIDGED_CHARGE_LINE" })]);
  });

  it("raises CONFIRMED_WITHOUT_R01 for a booking created after the journal's first R01, confirmed on the ledger, with none", () => {
    const since = new Date("2026-06-01T00:00:00.000Z");
    const after = new Date("2026-06-02T00:00:00.000Z");
    const skipped = journalChargeComparison(row([nightA], { charged: false, components: [], bridgedLineIds: all([]), journalSince: since }, after));
    expect(skipped.identity.status).toBe("NOT_APPLICABLE");
    expect(skipped.integrity).toEqual([expect.objectContaining({ kind: "CONFIRMED_WITHOUT_R01", lineId: "n1" })]);
    // Created before the journal began: confirmed before M3b, for M9, no finding.
    const before = new Date("2026-05-01T00:00:00.000Z");
    expect(journalChargeComparison(row([nightA], { charged: false, components: [], bridgedLineIds: all([]), journalSince: since }, before)).integrity).toEqual([]);
    // Not confirmed on the ledger at all: nothing to say.
    expect(journalChargeComparison(row([], { charged: false, components: [], bridgedLineIds: all([]), journalSince: since }, after)).integrity).toEqual([]);
    // A journal with no R01 anywhere yet: no boundary, no finding.
    expect(journalChargeComparison(row([nightA], { charged: false, components: [], bridgedLineIds: all([]) }, after)).integrity).toEqual([]);
  });

  it("agrees on a booking whose R01 posted with no money (a ZERO event)", () => {
    const free = line("z0", { amountCents: 0 });
    expect(journalChargeComparison(row([free], { charged: true, components: [], bridgedLineIds: all([]) })).identity)
      .toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
  });

  it("reports an inactive journal as one integrity finding that closes the gate", () => {
    const report = withJournalInactiveFinding(summarizeBookingLedgerCensus([], null), "the club's stored currency (JPY) cannot be charged");
    expect(report.integrity.counts.JOURNAL_INACTIVE).toBe(1);
    expect(report.integrity.findings).toEqual([expect.objectContaining({ kind: "JOURNAL_INACTIVE" })]);
    expect(report.verdict).toBe("GATE_CLOSED");
    expect(report.gateClosedBecause.join(" ")).toMatch(/journal is inactive/);
  });
});
