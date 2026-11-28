import { CAPTURED_PAYMENT_STATUS_LIST } from "@/lib/booking-payment-state";
import { loadClubTaxSchedule, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import {
  clubCalendarDateOf,
  clubToday,
  compareCalendarDates,
  dateOnlyInstantOf,
  requireInstant,
  type CalendarDate,
} from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { MAPPING_LABELS } from "@/lib/xero-account-mapping-keys";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

/**
 * CAN A REFUND CREDIT NOTE BE SENT ON AN EXPENSE ACCOUNT? (#5235). A club may
 * map Hut Fee Refunds to an expense account, and a refund note's line carries
 * the club's own sales tax code, the one in force on the booking's tax anchor
 * (`booking-tax-anchor.ts`, `xeroLineTax`), whichever kind of account it
 * names. Xero says per rate whether it may sit on an expense account, and
 * rejects a document that pairs one with an account it may not.
 *
 * So the question is asked of every tax code a refund note can still carry:
 * the code of each registered period in force on or after the earliest anchor
 * of a booking that can still be refunded, and every period from today on,
 * scheduled ones included. The account mapping save refuses on it
 * (`saveXeroAccountMappings`) and the Xero health check warns on it
 * (`readXeroTaxHealth`), so the two cannot disagree.
 */

/**
 * Bookings that can still be refunded: one whose stay has not ended, which can
 * be cancelled or edited, or one whose payment still holds money that has not
 * all been refunded. A refund outside both (an officer's hand-back long after
 * a stay on a payment already fully refunded) is not counted.
 */
const PAYMENT_STATUSES_HOLDING_MONEY = CAPTURED_PAYMENT_STATUS_LIST.filter((status) => status !== "REFUNDED");

/** The tax codes of the registered periods in force on any day from `from` on. Pure. */
function registeredTaxTypesFrom(schedule: ClubTaxSchedule, from: CalendarDate): string[] {
  const types = schedule.flatMap((period, index) => {
    const next = schedule[index + 1];
    const stillInForce = !next || compareCalendarDates(next.effectiveFrom, from) > 0;
    return stillInForce && period.gstRegistered && period.xeroTaxType ? [period.xeroTaxType] : [];
  });
  return [...new Set(types)];
}

/** The club day of the earliest tax anchor among bookings that can still be refunded, or null for none. */
async function readEarliestRefundableAnchorDate(today: CalendarDate, zone: Parameters<typeof clubCalendarDateOf>[1]) {
  const where = {
    OR: [
      { checkOut: { gte: dateOnlyInstantOf(today) } },
      { payment: { status: { in: [...PAYMENT_STATUSES_HOLDING_MONEY] } } },
    ],
  };
  // A group place's anchor is its organiser's booking's moment (`readBookingTaxAnchorInstant`).
  const [own, place] = await Promise.all([
    prisma.booking.findFirst({ where, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.booking.findFirst({
      where: { ...where, parentBookingId: { not: null } },
      orderBy: { parentBooking: { createdAt: "asc" } },
      select: { parentBooking: { select: { createdAt: true } } },
    }),
  ]);
  const instants = [own?.createdAt, place?.parentBooking?.createdAt].filter((value): value is Date => value != null);
  if (instants.length === 0) return null;
  const earliest = instants.reduce((a, b) => (a <= b ? a : b));
  return clubCalendarDateOf(requireInstant(earliest), zone);
}

/** Every Xero tax code a refund credit note can still carry, for a club registered in any such period. */
export async function readRefundableTaxTypes(): Promise<string[]> {
  const [schedule, zone] = await Promise.all([loadClubTaxSchedule(prisma), readClubTimeZoneOutsideRequest()]);
  const today = clubToday(zone);
  // Nothing to look up for a club never registered from today's period on and with no earlier one.
  if (!schedule.some((period) => period.gstRegistered)) return [];
  const earliest = await readEarliestRefundableAnchorDate(today, zone);
  const from = earliest && compareCalendarDates(earliest, today) < 0 ? earliest : today;
  return registeredTaxTypesFrom(schedule, from);
}

/**
 * The first of `taxTypes` Xero says cannot be used on expenses, or null. A
 * code Xero does not list is `xeroTaxCodeProblem`'s to report, not this one's.
 */
export function rateRefusedOnExpenses(
  taxTypes: readonly string[],
  rates: readonly XeroTaxRateOption[],
): XeroTaxRateOption | null {
  for (const taxType of taxTypes) {
    const rate = rates.find((candidate) => candidate.taxType === taxType);
    if (rate && !rate.expenses) return rate;
  }
  return null;
}

/** Why the rate cannot go with an expense account, in the words the save and the health check share. */
export function expenseRefundRateReason(rate: XeroTaxRateOption): string {
  return `Xero's tax rate ${rate.taxType} (${rate.name}), which refund credit notes carry, cannot be used on expenses, so Xero would reject them.`;
}

/** The sentence the save refuses with. */
export function hutFeeRefundsExpenseSaveRefusal(rate: XeroTaxRateOption): string {
  return `${MAPPING_LABELS.hutFeeRefunds} cannot use that expense account: ${expenseRefundRateReason(rate)} Choose a revenue account, or ask your accountant which account and tax rate refunds should use. No account mapping was saved.`;
}
