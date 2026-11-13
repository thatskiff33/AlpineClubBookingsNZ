import "server-only";

import { BookingStatus } from "@prisma/client";

import { clubTaxPeriodOn, loadClubTaxSchedule, type ClubTaxPeriod } from "@/lib/club-tax-settings";
import { earliestClubTaxChangeDate } from "@/lib/club-tax-settings-write";
import { addCalendarDays, dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import { prisma } from "@/lib/prisma";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRatesOrNull } from "@/lib/xero-tax-rates";

/**
 * What the "GST / tax treatment" card on the Xero page shows (#4632), served by
 * `GET /api/admin/club-tax` to any admin with `finance:view`. Every read here
 * runs outside any transaction (`INV-LOCK-004`), and nothing in it names a
 * member: the schedule, Xero's revenue tax rates, and counts.
 */
export interface ClubTaxAdminPeriod extends ClubTaxPeriod {
  /** "past" ended, "current" is in force today, "scheduled" starts after today and may still be cancelled. */
  status: "past" | "current" | "scheduled";
}

export interface ClubTaxAdminState {
  periods: ClubTaxAdminPeriod[];
  /** The first date a new change may start on: tomorrow, in club time. */
  earliestChangeDate: CalendarDate;
  /** Xero's active revenue tax rates, for the code picker; null when Xero could not be read. */
  xeroRevenueRates: XeroTaxRateOption[] | null;
}

export async function readClubTaxAdminState(): Promise<ClubTaxAdminState> {
  const [schedule, earliestChangeDate, rates] = await Promise.all([
    loadClubTaxSchedule(prisma),
    earliestClubTaxChangeDate(),
    readXeroTaxRatesOrNull(),
  ]);
  const today = addCalendarDays(earliestChangeDate, -1);
  const current = clubTaxPeriodOn(schedule, today);
  const currentIndex = schedule.indexOf(current);
  return {
    periods: schedule.map((period, index) => ({
      ...period,
      status: index < currentIndex ? "past" : index === currentIndex ? "current" : "scheduled",
    })),
    earliestChangeDate,
    xeroRevenueRates: rates?.filter((rate) => rate.active && rate.revenue) ?? null,
  };
}

/**
 * How many bookings already made have a night on or after `from`. A change
 * starting then leaves them on the treatment they were made under for their
 * whole life (owner decision A), so their later invoices, edits and credit notes
 * keep the old treatment; the card says so before the change is saved. A draft
 * counts, because it is invoiced under its creation date if it goes ahead.
 */
export async function countBookingsKeepingTreatmentFrom(from: CalendarDate): Promise<number> {
  return prisma.booking.count({
    where: {
      checkOut: { gt: dateOnlyInstantOf(from) },
      status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
    },
  });
}
