import { describe, expect, it } from "vitest";
import { spendIsExplained, xeroAllocationsOf, xeroPaymentsOf } from "@/lib/xero-credit-note-outside-spend";
import { creditNoteMirrorEvidenceFrom } from "@/lib/xero-credit-note-mirror";
import { writtenDownCentsByCreditNote } from "@/lib/xero-credit-note-write-down";

describe("the shared reading of a credit note's spend (#4270, #4219)", () => {
  it("skips deleted allocations and payments, and amounts that are not exact cents", () => {
    expect(
      xeroAllocationsOf([
        { invoice: { invoiceID: "a" }, amount: 20 },
        { invoice: { invoiceID: "b" }, amount: 5, isDeleted: true },
        { invoice: { invoiceID: "c" }, amount: 1.005 },
        { invoice: null, amount: 3 },
      ]),
    ).toEqual([{ invoiceId: "a", cents: 2_000 }]);
    expect(
      xeroPaymentsOf([
        { paymentID: "p1", amount: 10 },
        { paymentID: "p2", amount: 4, status: "DELETED" },
        { amount: 4 },
      ]),
    ).toEqual([{ paymentId: "p1", cents: 1_000 }]);
    expect(xeroAllocationsOf(undefined)).toEqual([]);
    expect(xeroPaymentsOf(null)).toEqual([]);
  });

  it("explains a note only when the list adds up to what it lost", () => {
    const allocations = [{ invoiceId: "a", cents: 3_000 }];
    const payments = [{ paymentId: "p", cents: 2_250 }];
    expect(spendIsExplained({ allocations, payments, totalCents: 5_250, remainingCents: 0 })).toBe(true);
    expect(spendIsExplained({ allocations, payments, totalCents: 5_250, remainingCents: 100 })).toBe(false);
    expect(spendIsExplained({ allocations: [], payments: [], totalCents: 5_250, remainingCents: 5_250 })).toBe(true);
    expect(spendIsExplained({ allocations, payments, totalCents: null, remainingCents: 0 })).toBe(false);
    expect(spendIsExplained({ allocations, payments, totalCents: 5_250, remainingCents: null })).toBe(false);
  });

  it("reads a Xero note into evidence, parsing the change time defensively", () => {
    const note = {
      creditNoteID: "n1",
      status: "authorised ",
      total: 52.5,
      remainingCredit: 32.5,
      allocations: [{ invoice: { invoiceID: "i1" }, amount: 20 }],
      payments: [],
    };
    const date = new Date("2026-06-30T23:00:00.000Z");
    expect(creditNoteMirrorEvidenceFrom({ ...note, updatedDateUTC: date })).toEqual({
      creditNoteId: "n1",
      status: "AUTHORISED",
      totalCents: 5_250,
      remainingCents: 3_250,
      allocations: [{ invoiceId: "i1", cents: 2_000 }],
      payments: [],
      updatedAt: date,
    });
    expect(creditNoteMirrorEvidenceFrom({ ...note, updatedDateUTC: "2026-06-30T23:00:00.000Z" })?.updatedAt).toEqual(date);
    expect(creditNoteMirrorEvidenceFrom({ ...note, updatedDateUTC: "not a date" })?.updatedAt).toBeNull();
    expect(creditNoteMirrorEvidenceFrom({ ...note, updatedDateUTC: new Date("nope") })?.updatedAt).toBeNull();
    expect(creditNoteMirrorEvidenceFrom({ ...note })?.updatedAt).toBeNull();
    expect(creditNoteMirrorEvidenceFrom({ ...note, creditNoteID: undefined })).toBeNull();
  });
});

describe("the write-down is the signed net of its rows (#4270)", () => {
  const groupBy = (sum: number | null) => ({ memberCredit: { groupBy: async () => [{ xeroCreditNoteId: "n1", _sum: { amountCents: sum } }] } }) as never;

  it("nets a restore against a write-down", async () => {
    expect((await writtenDownCentsByCreditNote(groupBy(-5_250 + 3_250), "m", ["n1"])).get("n1")).toBe(2_000);
    expect((await writtenDownCentsByCreditNote(groupBy(0), "m", ["n1"])).get("n1")).toBe(0);
  });

  it("never reads below zero, so a surplus restore cannot make a lot look freer than it is", async () => {
    expect((await writtenDownCentsByCreditNote(groupBy(1_000), "m", ["n1"])).get("n1")).toBe(0);
  });

  it("asks for rows of either sign", async () => {
    let where: unknown;
    const db = { memberCredit: { groupBy: async (args: { where: unknown }) => { where = args.where; return []; } } } as never;
    await writtenDownCentsByCreditNote(db, "m", ["n1"]);
    expect(where).not.toHaveProperty("amountCents");
    expect(where).toMatchObject({ outsideSpendConvergedAt: { not: null }, type: "ADMIN_ADJUSTMENT" });
  });
});
