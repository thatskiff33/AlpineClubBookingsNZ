import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  CREDIT_NOTE_SPEND_EVIDENCE_KEY,
  compareSpendReadings,
  creditNoteSpendEvidenceMetadata,
  newestSpendReadings,
  readStoredSpendEvidence,
  storedSpendEvidenceFrom,
  withCreditNoteSpendEvidence,
} from "@/lib/xero-credit-note-spend-evidence";
import type { XeroObjectLinkInput } from "@/lib/xero-sync";

/** #4220: the reading of a credit note's spend kept with its link at ingest. */

const OBSERVED = new Date("2026-07-01T00:00:00.000Z");
const CHANGED = new Date("2026-06-30T22:00:00.000Z");
const note = {
  creditNoteID: "N1",
  status: "AUTHORISED",
  total: 100,
  remainingCredit: 30,
  updatedDateUTC: CHANGED,
  allocations: [{ invoice: { invoiceID: "inv_a" }, amount: 40 }, { invoice: { invoiceID: "inv_b" }, amount: 30 }],
  payments: [],
};
const stored = {
  status: "AUTHORISED",
  totalCents: 10_000,
  remainingCents: 3_000,
  allocations: [{ invoiceId: "inv_a", cents: 4_000 }, { invoiceId: "inv_b", cents: 3_000 }],
  payments: [],
  noteUpdatedAt: CHANGED.toISOString(),
  observedAt: OBSERVED.toISOString(),
};
const fundsLot = (lot: { id: string } | null, keptLinks: Array<{ xeroObjectId: string; metadata: unknown }> = []) => {
  const findFirst = vi.fn().mockResolvedValue(lot);
  const findMany = vi.fn().mockResolvedValue(keptLinks);
  return { db: { memberCredit: { findFirst }, xeroObjectLink: { findMany } } as never, findFirst, findMany };
};

describe("the stored spend reading (#4220)", () => {
  it("keeps the reading of a note that funds a lot, in exact cents, from the note the reconcile already holds", async () => {
    const { db, findFirst } = fundsLot({ id: "L1" });
    expect(await creditNoteSpendEvidenceMetadata(note, db, OBSERVED)).toEqual({ [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored });
    // A funding lot is a positive row that is not one of the converge's own.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { xeroCreditNoteId: "N1", amountCents: { gt: 0 }, outsideSpendConvergedAt: null } }),
    );
  });

  it("keeps nothing for a note that funds no lot, or a note with no id", async () => {
    expect(await creditNoteSpendEvidenceMetadata(note, fundsLot(null).db, OBSERVED)).toEqual({});
    const { db, findFirst } = fundsLot({ id: "L1" });
    expect(await creditNoteSpendEvidenceMetadata({ ...note, creditNoteID: undefined }, db, OBSERVED)).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("reads back what it stored", () => {
    const evidence = { creditNoteId: "N1", status: "PAID", totalCents: 500, remainingCents: 0, allocations: [{ invoiceId: "i", cents: 500 }], payments: [{ paymentId: "p", cents: 0 }], updatedAt: null };
    const back = readStoredSpendEvidence({ other: 1, [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(evidence, OBSERVED) });
    expect(back).toEqual({ ...evidence, creditNoteId: undefined, observedAt: OBSERVED });
  });

  it.each([
    ["no metadata", null],
    ["no reading", { status: "AUTHORISED" }],
    ["a reading that is not an object", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: [stored] }],
    ["a non-integer amount", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, remainingCents: 30.5 } }],
    ["a negative amount", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, totalCents: -1 } }],
    ["an amount as text", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, totalCents: "10000" } }],
    ["a status that is not text", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, status: 1 } }],
    ["allocations that are not a list", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, allocations: {} } }],
    ["an allocation with no invoice", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, allocations: [{ cents: 1 }] } }],
    ["a payment with a fractional amount", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, payments: [{ paymentId: "p", cents: 0.5 }] } }],
    ["an unreadable change time", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, noteUpdatedAt: "soon" } }],
    ["no observation time", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, observedAt: null } }],
  ])("refuses a reading it cannot trust: %s", (_label, metadata) => {
    expect(readStoredSpendEvidence(metadata)).toBeNull();
  });

  it("accepts a reading Xero sent without a change time (the gate then defers it)", () => {
    expect(readStoredSpendEvidence({ [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, noteUpdatedAt: null } })?.updatedAt).toBeNull();
  });
});

describe("keeping the reading on the note's links (#4220)", () => {
  const link = (role: string, metadata: unknown = { status: "AUTHORISED", amountCents: 9_700 }): XeroObjectLinkInput => ({
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "N1",
    role,
    metadata,
    mergeMetadata: true,
  });
  const evidence = { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored };

  it("adds the reading beside the link's other keys, which the merge keeps", () => {
    expect(withCreditNoteSpendEvidence(link("ACCOUNT_CREDIT_NOTE"), evidence)).toEqual({
      ...link("ACCOUNT_CREDIT_NOTE"),
      metadata: { status: "AUTHORISED", amountCents: 9_700, [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored },
    });
    expect(withCreditNoteSpendEvidence(link("ACCOUNT_CREDIT_NOTE", null), evidence).metadata).toEqual(evidence);
  });

  it("never puts it on a refund note's link, and changes nothing when there is no reading", () => {
    for (const role of ["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE"]) {
      expect(withCreditNoteSpendEvidence(link(role), evidence)).toEqual(link(role));
    }
    expect(withCreditNoteSpendEvidence(link("ACCOUNT_CREDIT_NOTE"), {})).toEqual(link("ACCOUNT_CREDIT_NOTE"));
  });
});

describe("which reading of a note wins (#4220, review round 1 item 3)", () => {
  const at = (iso: string | null) => (iso === null ? null : new Date(iso));
  const r = (updatedAt: string | null, observedAt: string) => ({ updatedAt: at(updatedAt), observedAt: new Date(observedAt) });

  it("orders by Xero's change time first, then by when the app took the reading", () => {
    // A later change read earlier beats an earlier change read later (an event processed out of order).
    expect(compareSpendReadings(r("2026-06-30T22:00:00Z", "2026-06-30T22:05:00Z"), r("2026-06-30T21:00:00Z", "2026-07-01T00:00:00Z"))).toBeGreaterThan(0);
    expect(compareSpendReadings(r("2026-06-30T22:00:00Z", "2026-06-30T23:00:00Z"), r("2026-06-30T22:00:00Z", "2026-06-30T22:30:00Z"))).toBeGreaterThan(0);
    // A reading with no change time is the oldest; two without fall back to when they were taken.
    expect(compareSpendReadings(r(null, "2026-07-01T00:00:00Z"), r("2026-06-30T21:00:00Z", "2026-06-30T21:05:00Z"))).toBeLessThan(0);
    expect(compareSpendReadings(r(null, "2026-07-01T00:00:00Z"), r(null, "2026-06-30T21:05:00Z"))).toBeGreaterThan(0);
  });

  it("picks the newest trustworthy reading per note across its active links", async () => {
    const later = { ...stored, remainingCents: 2_000, allocations: [{ invoiceId: "inv_a", cents: 8_000 }], noteUpdatedAt: "2026-06-30T23:00:00.000Z", observedAt: "2026-06-30T23:05:00.000Z" };
    const { db, findMany } = fundsLot(null, [
      { xeroObjectId: "N1", metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: later } },
      // Observed after, but of an older change: it must not win.
      { xeroObjectId: "N1", metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored } },
      { xeroObjectId: "N1", metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...stored, totalCents: "x" } } },
    ]);
    const readings = await newestSpendReadings(db, { xeroObjectId: "N1" });
    expect(readings.get("N1")?.remainingCents).toBe(2_000);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { xeroObjectId: "N1", xeroObjectType: "CREDIT_NOTE", active: true } }));
  });

  it("does not put an older change's reading back over a newer one kept already", async () => {
    const newer = { ...stored, noteUpdatedAt: "2026-06-30T23:00:00.000Z", observedAt: "2026-06-30T23:01:00.000Z" };
    const { db } = fundsLot({ id: "L1" }, [{ xeroObjectId: "N1", metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: newer } }]);
    // `note` changed at 22:00, before the kept reading's 23:00.
    expect(await creditNoteSpendEvidenceMetadata(note, db, OBSERVED)).toEqual({});
  });

  it("replaces an older or equal change's reading, and keeps the first one", async () => {
    for (const noteUpdatedAt of ["2026-06-30T21:00:00.000Z", CHANGED.toISOString()]) {
      const older = { ...stored, noteUpdatedAt, observedAt: "2026-06-30T22:30:00.000Z" };
      const { db } = fundsLot({ id: "L1" }, [{ xeroObjectId: "N1", metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: older } }]);
      expect(await creditNoteSpendEvidenceMetadata(note, db, OBSERVED)).toEqual({ [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored });
    }
    expect(await creditNoteSpendEvidenceMetadata(note, fundsLot({ id: "L1" }).db, OBSERVED)).toEqual({ [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored });
  });
});
