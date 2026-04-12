import { BookingStatus } from "@prisma/client";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export type RevenueGranularity = "daily" | "weekly" | "monthly";

export interface RevenueBookingLike {
  createdAt: Date;
  finalPriceCents: number;
  status: BookingStatus;
}

export interface RevenueDataPoint {
  periodStart: string;
  periodEnd: string;
  label: string;
  tooltipLabel: string;
  revenueCents: number;
  bookingCount: number;
}

const MONDAY_WEEK = { weekStartsOn: 1 as const };

export function getRevenueGranularity(rangeStart: Date, rangeEnd: Date): RevenueGranularity {
  const daySpan = differenceInCalendarDays(rangeEnd, rangeStart) + 1;
  if (daySpan <= 14) {
    return "daily";
  }
  if (daySpan <= 90) {
    return "weekly";
  }
  return "monthly";
}

export function getRevenueGranularityLabel(granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return "Day";
  }
  if (granularity === "weekly") {
    return "Week";
  }
  return "Month";
}

export function buildRevenueSeries(
  bookings: RevenueBookingLike[],
  rangeStart: Date,
  rangeEnd: Date
): { granularity: RevenueGranularity; data: RevenueDataPoint[] } {
  const granularity = getRevenueGranularity(rangeStart, rangeEnd);
  const buckets = initializeBuckets(rangeStart, rangeEnd, granularity);

  for (const booking of bookings) {
    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.BUMPED) {
      continue;
    }

    const key = getBucketKey(booking.createdAt, granularity);
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }

    bucket.revenueCents += booking.finalPriceCents;
    bucket.bookingCount += 1;
  }

  return {
    granularity,
    data: Array.from(buckets.values()),
  };
}

function initializeBuckets(
  rangeStart: Date,
  rangeEnd: Date,
  granularity: RevenueGranularity
): Map<string, RevenueDataPoint> {
  const buckets = new Map<string, RevenueDataPoint>();

  if (granularity === "daily") {
    for (let cursor = new Date(rangeStart); !isAfter(cursor, rangeEnd); cursor = addDays(cursor, 1)) {
      buckets.set(toDateKey(cursor), createBucket(cursor, cursor, granularity));
    }
    return buckets;
  }

  if (granularity === "weekly") {
    for (
      let cursor = startOfWeek(rangeStart, MONDAY_WEEK);
      !isAfter(cursor, rangeEnd);
      cursor = addWeeks(cursor, 1)
    ) {
      const periodEnd = clampToRangeEnd(endOfWeek(cursor, MONDAY_WEEK), rangeEnd);
      buckets.set(toDateKey(cursor), createBucket(cursor, periodEnd, granularity));
    }
    return buckets;
  }

  for (
    let cursor = startOfMonth(rangeStart);
    !isAfter(cursor, rangeEnd);
    cursor = addMonths(cursor, 1)
  ) {
    const periodEnd = clampToRangeEnd(endOfMonth(cursor), rangeEnd);
    buckets.set(toDateKey(cursor), createBucket(cursor, periodEnd, granularity));
  }

  return buckets;
}

function createBucket(
  periodStart: Date,
  periodEnd: Date,
  granularity: RevenueGranularity
): RevenueDataPoint {
  return {
    periodStart: toDateKey(periodStart),
    periodEnd: toDateKey(periodEnd),
    label: formatBucketLabel(periodStart, granularity),
    tooltipLabel: formatBucketTooltip(periodStart, periodEnd, granularity),
    revenueCents: 0,
    bookingCount: 0,
  };
}

function formatBucketLabel(periodStart: Date, granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return format(periodStart, "EEE d MMM");
  }
  if (granularity === "weekly") {
    return `Week of ${format(periodStart, "d MMM")}`;
  }
  return format(periodStart, "MMM yyyy");
}

function formatBucketTooltip(
  periodStart: Date,
  periodEnd: Date,
  granularity: RevenueGranularity
): string {
  if (granularity === "daily") {
    return format(periodStart, "EEEE d MMMM yyyy");
  }
  if (granularity === "weekly") {
    return `Week of ${format(periodStart, "d MMM yyyy")} to ${format(periodEnd, "d MMM yyyy")}`;
  }
  return format(periodStart, "MMMM yyyy");
}

function getBucketKey(date: Date, granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return toDateKey(date);
  }
  if (granularity === "weekly") {
    return toDateKey(startOfWeek(date, MONDAY_WEEK));
  }
  return toDateKey(startOfMonth(date));
}

function clampToRangeEnd(periodEnd: Date, rangeEnd: Date): Date {
  return isAfter(periodEnd, rangeEnd) ? rangeEnd : periodEnd;
}

function toDateKey(value: Date): string {
  return format(value, "yyyy-MM-dd");
}
