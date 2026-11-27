/**
 * A DEPOSIT BALANCE, as every surface reads it (#5008, `INV-ADDPAY-053`). Pure: no client, no
 * clock. A booking settled by a deposit is `PAID` and holds its beds; the rest of what it owes is
 * one request with cause `balance` and a due date on its row. "Part paid" is derived here from
 * that request, never stored, and the dates the balance is chased on come from its due date.
 *
 * The request's cause is read by `additional-ask-cause.ts`, and whether it is still owed by
 * `isAdditionalPaymentOwed`, so this module adds no second reading of either.
 */
import { balanceRowsOfChain, type AdditionalAskCauseRow } from "@/lib/additional-ask-cause";
import { isAdditionalPaymentOwed, type AdditionalPaymentChasePayment } from "@/lib/additional-payment-chase";
import { addCalendarDays, calendarDateOfDateOnlyInstant, compareCalendarDates, type CalendarDate } from "@/lib/club-time";
import { DEPOSIT_BALANCE_ASK_REASON } from "@/lib/credit-release-ask-keys";

/** A request row as the part-paid predicate reads it: its cause, what it carried, and its due date. */
export type PartPaidAskRow = AdditionalAskCauseRow & { balanceDueOn?: Date | null };

export type BookingPartPaid = {
  /** What is still owed on the booking's one live request, in integer cents. */
  owingCents: number;
  /**
   * The balance's due date, a club calendar date. The earliest of the request's balance rows,
   * so folding an edit into a balance keeps the earlier date. Null only for a balance row written
   * without one, which the deposit settle never does.
   */
  dueOn: CalendarDate | null;
};

/**
 * IS THIS BOOKING PART PAID, HOW MUCH IS OWING AND BY WHEN (#5008, `INV-ADDPAY-053`). The one
 * predicate every surface that would say "Paid" asks first: a booking settled by a deposit is
 * `PAID` and holds its beds, and "part paid" is derived from its live request, never stored.
 *
 * Part paid means the request is still owed (`isAdditionalPaymentOwed`: an owing booking status
 * and money not collected) AND that request carries a deposit balance, alone or folded into a later
 * request (`mixed`). Any other owed request is an ordinary extra, and null here. `transactions` are
 * the payment's ADDITIONAL rows, newest first (`ASK_CAUSE_ROWS` of them).
 */
export function bookingPartPaid(input: {
  bookingStatus: string | null | undefined;
  payment:
    | (Pick<AdditionalPaymentChasePayment, "additionalAmountCents" | "additionalPaymentStatus"> & {
        transactions: readonly PartPaidAskRow[];
      })
    | null
    | undefined;
}): BookingPartPaid | null {
  const { payment } = input;
  if (!payment || !isAdditionalPaymentOwed({ bookingStatus: input.bookingStatus, payment })) return null;
  const balanceRows = balanceRowsOfChain(payment.transactions);
  if (balanceRows.length === 0) return null;
  const dueDates = balanceRows
    .flatMap((row) => (row.balanceDueOn ? [calendarDateOfDateOnlyInstant(row.balanceDueOn)] : []))
    .sort(compareCalendarDates);
  return { owingCents: payment.additionalAmountCents, dueOn: dueDates[0] ?? null };
}

/** Days before a balance's due date that its two reminders fall on, and the day after it for the overdue one. */
export const BALANCE_REMINDER_DAYS_BEFORE_DUE = [14, 3] as const;
export const BALANCE_OVERDUE_REMINDER_DAYS_AFTER_DUE = 1;

/**
 * The club calendar dates a deposit balance is chased on (#5008, `INV-ADDPAY-053`): 14 and 3 days
 * before its due date, and the day after it while it is unpaid. Pure: which of them are still to
 * come, and the stamps that make each one go out once, are the reminder job's (#5008 child C).
 */
export function balanceReminderSchedule(dueOn: CalendarDate): {
  reminders: CalendarDate[];
  overdue: CalendarDate;
} {
  return {
    reminders: BALANCE_REMINDER_DAYS_BEFORE_DUE.map((days) => addCalendarDays(dueOn, -days)),
    overdue: addCalendarDays(dueOn, BALANCE_OVERDUE_REMINDER_DAYS_AFTER_DUE),
  };
}

/**
 * A booking settled by a deposit is not reversed by Record manual payment's reversal, which would
 * put the booking back to unpaid while its balance request stood. The server's refusal and the
 * admin page share this sentence and the row filter that finds the balance (any status, never
 * withdrawn).
 */
export const DEPOSIT_SETTLE_REVERSAL_REFUSAL =
  "This booking was settled by a deposit with a balance requested, so the payment cannot be reversed here.";
export const DEPOSIT_BALANCE_REQUEST_WHERE = { kind: "ADDITIONAL", reason: DEPOSIT_BALANCE_ASK_REASON, withdrawnAt: null } as const;
