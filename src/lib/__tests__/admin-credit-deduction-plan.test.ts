import { describe, expect, it } from "vitest";
import { planAdminCreditDeduction, type DeductionLot } from "@/lib/admin-credit-deduction-plan";

const lot = (overrides: Partial<DeductionLot> = {}): DeductionLot => ({
  memberCreditId: "lot-a", xeroCreditNoteId: "note-a", remainingCents: 1000,
  totalCents: 1000, hasSlices: false, writtenDownCents: 0, ...overrides,
});

describe("admin credit deduction plan", () => {
  it("voids a whole untouched note", () => {
    expect(planAdminCreditDeduction(1000, 1000, 0, [lot()])).toEqual({
      notelessCents: 0, lines: [{ memberCreditId: "lot-a", xeroCreditNoteId: "note-a", amountCents: 1000, mode: "VOID" }],
    });
  });
  it("uses unbacked net credit before correcting a note", () => {
    const plan = planAdminCreditDeduction(700, 1500, 0, [lot()]);
    expect(plan.notelessCents).toBe(500);
    expect(plan.lines[0]).toMatchObject({ amountCents: 200, mode: "INVOICE" });
  });
  it("does not offer already deducted noteless credit again", () => {
    expect(planAdminCreditDeduction(1000, 1000, 0, [lot()]).notelessCents).toBe(0);
  });
  it("uses an invoice when a note has already been part spent", () => {
    expect(planAdminCreditDeduction(600, 600, 0, [lot({ remainingCents: 600, hasSlices: true })]).lines[0])
      .toMatchObject({ amountCents: 600, mode: "INVOICE" });
  });
  it("uses an invoice after an earlier write-down", () => {
    expect(planAdminCreditDeduction(600, 600, 0, [lot({ remainingCents: 600, writtenDownCents: 400 })]).lines[0]?.mode)
      .toBe("INVOICE");
  });
  it("keeps loader order between noted lots", () => {
    expect(planAdminCreditDeduction(1200, 2000, 0, [lot(), lot({ memberCreditId: "lot-b", xeroCreditNoteId: "note-b" })]).lines)
      .toMatchObject([{ memberCreditId: "lot-a", amountCents: 1000 }, { memberCreditId: "lot-b", amountCents: 200 }]);
  });
  it("never takes cash-backed credit as noteless money", () => {
    expect(() => planAdminCreditDeduction(600, 1000, 500, [lot({ remainingCents: 500, totalCents: 500 })]))
      .toThrow(/overpayment|prepayment/);
  });
  it("leaves cents already promised to a booking unavailable", () => {
    expect(() => planAdminCreditDeduction(601, 600, 0, [lot()])).toThrow(/balance/);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid cents %s", (cents) => {
    expect(() => planAdminCreditDeduction(cents, 1000, 0, [lot()])).toThrow();
  });
});
