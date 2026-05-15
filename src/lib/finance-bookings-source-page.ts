import { BookingStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES,
  FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES,
  FINANCE_REALIZED_BOOKING_STATUSES,
} from "@/lib/finance-booking-metrics";
import {
  buildFinanceBookingsReportHref,
  resolveFinanceBookingsReportFilters,
  type FinanceBookingsReportFilters,
} from "@/lib/finance-bookings-report-page";
import { parseDateOnly } from "@/lib/date-only";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { bookingStatusLabel } from "@/lib/status-colors";
import { formatCents } from "@/lib/utils";

type FinanceBookingsSourceSearchParams = Record<
  string,
  string | string[] | undefined
>;

type SourceSection = "realized" | "forward";
type SourcePipeline = "realized" | "committed" | "at-risk";

interface EffectiveWindow {
  from: string | null;
  to: string | null;
  fromDate: Date | null;
  toDate: Date | null;
}

export interface FinanceBookingsSourceRow {
  id: string;
  memberName: string;
  memberEmail: string;
  checkIn: string;
  checkOut: string;
  status: BookingStatus;
  statusLabel: string;
  guestCount: string;
  contributingNights: string;
  guestNights: string;
  allocatedRevenue: string;
  bookingTotal: string;
  paymentStatus: PaymentStatus | "NONE";
  paymentStatusLabel: string;
}

export interface FinanceBookingsSourcePageModel {
  generatedOn: string;
  returnHref: string;
  filterWarnings: string[];
  loadError?: string;
  sectionLabel: string;
  pipelineLabel: string;
  statusLabel: string;
  requestedWindow: string;
  effectiveWindow: string;
  rows: FinanceBookingsSourceRow[];
  totals: {
    bookingCount: string;
    contributingNights: string;
    guestNights: string;
    allocatedRevenue: string;
  };
}

const PIPELINE_LABELS: Record<SourcePipeline, string> = {
  realized: "Realized",
  committed: "Committed",
  "at-risk": "At risk",
};

export async function buildFinanceBookingsSourcePageModel(input: {
  searchParams?: FinanceBookingsSourceSearchParams;
  today?: Date;
}): Promise<FinanceBookingsSourcePageModel> {
  const { filters, warnings } = resolveFinanceBookingsReportFilters({
    searchParams: input.searchParams,
    today: input.today,
  });
  const fallbackReturnHref = buildFinanceBookingsReportHref(filters);
  const returnHref = resolveInternalReturnPath(
    readSearchParam(input.searchParams, "returnTo"),
    fallbackReturnHref
  );
  const selection = resolveSourceSelection(input.searchParams);

  if (!selection) {
    return buildUnavailableModel({
      filters,
      warnings,
      returnHref,
      loadError: "This source booking drill-down is not valid for the report window.",
    });
  }

  const effectiveWindow = getEffectiveWindow(filters, selection.section);

  if (!effectiveWindow.fromDate || !effectiveWindow.toDate) {
    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      returnHref,
      filterWarnings: warnings,
      sectionLabel: sectionLabel(selection.section),
      pipelineLabel: PIPELINE_LABELS[selection.pipeline],
      statusLabel: bookingStatusLabel(selection.status),
      requestedWindow: requestedWindowLabel(filters, selection.section),
      effectiveWindow: "No effective dates after cutoff/as-of filters",
      rows: [],
      totals: emptyTotals(),
    };
  }

  const bookings = await prisma.booking.findMany({
    where: {
      status: selection.status,
      checkIn: { lte: effectiveWindow.toDate },
      checkOut: { gt: effectiveWindow.fromDate },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
      finalPriceCents: true,
      member: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      guests: {
        select: {
          id: true,
        },
      },
      payment: {
        select: {
          status: true,
        },
      },
    },
  });

  const rows = bookings
    .map((booking) => mapSourceBookingRow(booking, effectiveWindow))
    .filter((row): row is FinanceBookingsSourceRow => row !== null);

  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    returnHref,
    filterWarnings: warnings,
    sectionLabel: sectionLabel(selection.section),
    pipelineLabel: PIPELINE_LABELS[selection.pipeline],
    statusLabel: bookingStatusLabel(selection.status),
    requestedWindow: requestedWindowLabel(filters, selection.section),
    effectiveWindow: effectiveWindowLabel(effectiveWindow),
    rows,
    totals: summarizeRows(rows),
  };
}

function resolveSourceSelection(searchParams?: FinanceBookingsSourceSearchParams) {
  const section = readSearchParam(searchParams, "section");
  const pipeline = readSearchParam(searchParams, "pipeline");
  const status = readSearchParam(searchParams, "status");

  if (!isSourceSection(section) || !isSourcePipeline(pipeline) || !isBookingStatus(status)) {
    return null;
  }

  if (section === "realized") {
    if (
      pipeline !== "realized" ||
      !FINANCE_REALIZED_BOOKING_STATUSES.includes(status as never)
    ) {
      return null;
    }
  } else if (
    pipeline === "committed" &&
    !FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES.includes(status as never)
  ) {
    return null;
  } else if (
    pipeline === "at-risk" &&
    !FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES.includes(status as never)
  ) {
    return null;
  } else if (pipeline === "realized") {
    return null;
  }

  return { section, pipeline, status };
}

function mapSourceBookingRow(
  booking: {
    id: string;
    checkIn: Date;
    checkOut: Date;
    status: BookingStatus;
    finalPriceCents: number;
    member: { firstName: string; lastName: string; email: string };
    guests: Array<{ id: string }>;
    payment: { status: PaymentStatus } | null;
  },
  window: EffectiveWindow
) {
  if (!window.fromDate || !window.toDate) {
    return null;
  }

  const contribution = getContribution({
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    finalPriceCents: booking.finalPriceCents,
    window,
  });

  if (contribution.nights < 1) {
    return null;
  }

  const guestNights = contribution.nights * booking.guests.length;

  return {
    id: booking.id,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    memberEmail: booking.member.email,
    checkIn: formatDisplayDate(booking.checkIn.toISOString()),
    checkOut: formatDisplayDate(booking.checkOut.toISOString()),
    status: booking.status,
    statusLabel: bookingStatusLabel(booking.status),
    guestCount: formatWholeNumber(booking.guests.length),
    contributingNights: formatWholeNumber(contribution.nights),
    guestNights: formatWholeNumber(guestNights),
    allocatedRevenue: formatCents(contribution.allocatedRevenueCents),
    bookingTotal: formatCents(booking.finalPriceCents),
    paymentStatus: booking.payment?.status ?? "NONE",
    paymentStatusLabel: booking.payment?.status.replace(/_/g, " ") ?? "No payment row",
  };
}

function getContribution(input: {
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  window: EffectiveWindow;
}) {
  const checkInDate = parseBookingDate(input.checkIn);
  const checkOutDate = parseBookingDate(input.checkOut);
  const totalStayNights = differenceInUtcDays(checkInDate, checkOutDate);

  if (!input.window.fromDate || !input.window.toDate || totalStayNights < 1) {
    return { nights: 0, allocatedRevenueCents: 0 };
  }

  const effectiveEndExclusive = addUtcDays(input.window.toDate, 1);
  const overlapStart = maxDate(checkInDate, input.window.fromDate);
  const overlapEndExclusive = minDate(checkOutDate, effectiveEndExclusive);

  if (overlapStart.getTime() >= overlapEndExclusive.getTime()) {
    return { nights: 0, allocatedRevenueCents: 0 };
  }

  const nights = differenceInUtcDays(overlapStart, overlapEndExclusive);
  const offset = differenceInUtcDays(checkInDate, overlapStart);
  const revenueByNight = allocateCentsEvenly(
    input.finalPriceCents,
    totalStayNights
  );
  const allocatedRevenueCents = revenueByNight
    .slice(offset, offset + nights)
    .reduce((total, cents) => total + cents, 0);

  return { nights, allocatedRevenueCents };
}

function getEffectiveWindow(
  filters: FinanceBookingsReportFilters,
  section: SourceSection
): EffectiveWindow {
  if (section === "realized") {
    const fromDate = parseDateOnly(filters.realizedFrom);
    const toDate = parseDateOnly(filters.realizedTo);
    const cutoffDate = parseDateOnly(filters.realizedCutoff);
    const effectiveToDate =
      cutoffDate.getTime() < fromDate.getTime()
        ? null
        : minDate(toDate, cutoffDate);

    return {
      from: effectiveToDate ? filters.realizedFrom : null,
      to: effectiveToDate ? toIsoDate(effectiveToDate) : null,
      fromDate: effectiveToDate ? fromDate : null,
      toDate: effectiveToDate,
    };
  }

  const fromDate = parseDateOnly(filters.forwardFrom);
  const toDate = parseDateOnly(filters.forwardTo);
  const asOfDate = parseDateOnly(filters.forwardAsOf);
  const effectiveFromDate = maxDate(fromDate, addUtcDays(asOfDate, 1));
  const hasWindow = effectiveFromDate.getTime() <= toDate.getTime();

  return {
    from: hasWindow ? toIsoDate(effectiveFromDate) : null,
    to: hasWindow ? filters.forwardTo : null,
    fromDate: hasWindow ? effectiveFromDate : null,
    toDate: hasWindow ? toDate : null,
  };
}

function summarizeRows(rows: FinanceBookingsSourceRow[]) {
  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.contributingNights += parseWholeNumber(row.contributingNights);
      accumulator.guestNights += parseWholeNumber(row.guestNights);
      accumulator.allocatedRevenueCents += parseMoney(row.allocatedRevenue);
      return accumulator;
    },
    {
      contributingNights: 0,
      guestNights: 0,
      allocatedRevenueCents: 0,
    }
  );

  return {
    bookingCount: formatWholeNumber(rows.length),
    contributingNights: formatWholeNumber(totals.contributingNights),
    guestNights: formatWholeNumber(totals.guestNights),
    allocatedRevenue: formatCents(totals.allocatedRevenueCents),
  };
}

function emptyTotals() {
  return {
    bookingCount: "0",
    contributingNights: "0",
    guestNights: "0",
    allocatedRevenue: "$0.00",
  };
}

function buildUnavailableModel(input: {
  filters: FinanceBookingsReportFilters;
  warnings: string[];
  returnHref: string;
  loadError: string;
}): FinanceBookingsSourcePageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    returnHref: input.returnHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    sectionLabel: "Source bookings",
    pipelineLabel: "Unavailable",
    statusLabel: "Unavailable",
    requestedWindow: requestedWindowLabel(input.filters, "realized"),
    effectiveWindow: "Unavailable",
    rows: [],
    totals: emptyTotals(),
  };
}

function requestedWindowLabel(
  filters: FinanceBookingsReportFilters,
  section: SourceSection
) {
  return section === "realized"
    ? `${formatDisplayDate(filters.realizedFrom)} to ${formatDisplayDate(filters.realizedTo)}`
    : `${formatDisplayDate(filters.forwardFrom)} to ${formatDisplayDate(filters.forwardTo)}`;
}

function effectiveWindowLabel(window: EffectiveWindow) {
  if (!window.from || !window.to) {
    return "Unavailable";
  }

  return `${formatDisplayDate(window.from)} to ${formatDisplayDate(window.to)}`;
}

function sectionLabel(section: SourceSection) {
  return section === "realized" ? "Realized stays" : "Forward pipeline";
}

function readSearchParam(
  searchParams: FinanceBookingsSourceSearchParams | undefined,
  key: string
) {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function isSourceSection(value: string | undefined): value is SourceSection {
  return value === "realized" || value === "forward";
}

function isSourcePipeline(value: string | undefined): value is SourcePipeline {
  return value === "realized" || value === "committed" || value === "at-risk";
}

function isBookingStatus(value: string | undefined): value is BookingStatus {
  return Object.values(BookingStatus).includes(value as BookingStatus);
}

function parseBookingDate(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function differenceInUtcDays(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function maxDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? left : right;
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function allocateCentsEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0) {
    return [];
  }

  const base = Math.floor(totalCents / parts);
  let remainder = totalCents - base * parts;

  return Array.from({ length: parts }, () => {
    if (remainder > 0) {
      remainder -= 1;
      return base + 1;
    }

    return base;
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDisplayDate(value: string) {
  return new Date(value).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatWholeNumber(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    maximumFractionDigits: 0,
  }).format(value);
}

function parseMoney(value: string) {
  return Math.round(Number(value.replace(/[^0-9.-]/g, "")) * 100);
}

function parseWholeNumber(value: string) {
  return Number(value.replace(/,/g, ""));
}
