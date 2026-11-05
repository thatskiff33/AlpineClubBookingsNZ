import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  CREDIT_NOTE_SPEND_EVIDENCE_KEY,
  creditNoteSpendEvidenceMetadata,
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
const fundsLot = (lot: { id: string } | null) => {
  const findFirst = vi.fn().mockResolvedValue(lot);
  return { db: { memberCredit: { findFirst } } as never, findFirst };
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
