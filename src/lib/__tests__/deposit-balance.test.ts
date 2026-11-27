/**
 * #5008 (`INV-ADDPAY-053`): the part-paid predicate every "Paid" surface will ask first, and the
 * dates a deposit balance is chased on. Pure; today is the frozen test day, 2026-07-01.
 */
import { describe, expect, it } from "vitest";

import { balanceReminderSchedule, bookingPartPaid, type PartPaidAskRow } from "@/lib/additional-payment-chase";
import { requireCalendarDate } from "@/lib/club-time";
import { CREDIT_RELEASE_ASK_REASON, DEPOSIT_BALANCE_ASK_REASON } from "@/lib/credit-release-ask-keys";

const dueOn = (day: string) => new Date(`${day}T00:00:00.000Z`);
const balanceRow = (due = "2026-07-20", carriedAskCents = 0, withdrawnAt: Date | null = null): PartPaidAskRow => ({
  reason: DEPOSIT_BALANCE_ASK_REASON,
  carriedAskCents,
  withdrawnAt,
  balanceDueOn: dueOn(due),
});
const editRow = (carriedAskCents = 0): PartPaidAskRow => ({ reason: "booking_modification", carriedAskCents, withdrawnAt: null, balanceDueOn: null });

function partPaid(
  transactions: PartPaidAskRow[],
  { bookingStatus = "PAID", additionalAmountCents = 45_000, additionalPaymentStatus = "PENDING" as string | null } = {},
) {
  return bookingPartPaid({ bookingStatus, payment: { additionalAmountCents, additionalPaymentStatus, transactions } });
}

describe("bookingPartPaid (#5008, INV-ADDPAY-053)", () => {
  it("reads a PAID booking with an unpaid balance as part paid, with what is owing and by when", () => {
    expect(partPaid([balanceRow()])).toEqual({ owingCents: 45_000, dueOn: "2026-07-20" });
  });

  it("is not part paid once the balance is paid, or for a booking with no payment", () => {
    expect(partPaid([balanceRow()], { additionalPaymentStatus: "SUCCEEDED" })).toBeNull();
    expect(partPaid([balanceRow()], { additionalAmountCents: 0 })).toBeNull();
    expect(bookingPartPaid({ bookingStatus: "PAID", payment: null })).toBeNull();
  });

  it("still reads a declined card for the balance as owing", () => {
    expect(partPaid([balanceRow()], { additionalPaymentStatus: "FAILED" })).toEqual({ owingCents: 45_000, dueOn: "2026-07-20" });
  });

  it("is not part paid on a booking that no longer owes anything (cancelled, bumped)", () => {
    expect(partPaid([balanceRow()], { bookingStatus: "CANCELLED" })).toBeNull();
    expect(partPaid([balanceRow()], { bookingStatus: "BUMPED" })).toBeNull();
    expect(partPaid([balanceRow()], { bookingStatus: "COMPLETED" })).not.toBeNull();
  });

  it("is not part paid for an ordinary extra or a credit-release request", () => {
    expect(partPaid([editRow()])).toBeNull();
    expect(partPaid([{ reason: CREDIT_RELEASE_ASK_REASON, carriedAskCents: 0, withdrawnAt: null }])).toBeNull();
  });

  it("stays part paid when an edit folds into the balance, owing both, by the balance's date", () => {
    expect(partPaid([editRow(45_000), balanceRow()], { additionalAmountCents: 50_000 })).toEqual({ owingCents: 50_000, dueOn: "2026-07-20" });
  });

  it("keeps the earliest due date when balances fold into one another", () => {
    expect(partPaid([balanceRow("2026-07-25", 30_000), balanceRow("2026-07-15")])).toMatchObject({ dueOn: "2026-07-15" });
  });

  it("does not read a balance the newest request did not carry, or one an officer withdrew", () => {
    expect(partPaid([editRow(0), balanceRow()])).toBeNull();
    expect(partPaid([editRow(45_000), balanceRow("2026-07-20", 0, new Date("2026-07-01T00:00:00.000Z"))])).toBeNull();
  });
});

describe("balanceReminderSchedule (#5008, INV-ADDPAY-053)", () => {
  it("chases 14 and 3 days before the due date, and the day after it", () => {
    expect(balanceReminderSchedule(requireCalendarDate("2026-08-20"))).toEqual({
      reminders: ["2026-08-06", "2026-08-17"],
      overdue: "2026-08-21",
    });
  });

  it("counts club calendar days across a month end and a daylight-saving change", () => {
    // New Zealand daylight time starts on 27 September 2026.
    expect(balanceReminderSchedule(requireCalendarDate("2026-10-02"))).toEqual({
      reminders: ["2026-09-18", "2026-09-29"],
      overdue: "2026-10-03",
    });
  });
});
