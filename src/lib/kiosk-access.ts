import { prisma } from "./prisma";
import {
  addDaysDateOnly,
  formatDateOnly,
} from "./date-only";

export type KioskTier = "admin" | "hut-leader" | "lodge" | "staying-guest" | "none";

export interface KioskAccess {
  tier: KioskTier;
  dateRange: { minDate: string; maxDate: string } | null;
  canManageRoster: boolean;
  canMarkAttendance: boolean;
  canCompleteChores: boolean;
}

/**
 * Returns the highest kiosk access tier for a user on a given date.
 */
export async function getKioskAccessTier(
  userId: string,
  userRole: string,
  date: Date
): Promise<KioskTier> {
  if (userRole === "ADMIN") return "admin";
  if (userRole === "LODGE") return "lodge";

  if (userRole === "MEMBER") {
    // Check hut leader assignment: (startDate - 1 day) <= date <= endDate
    const nextDay = addDaysDateOnly(date, 1);

    const hutLeaderCount = await prisma.hutLeaderAssignment.count({
      where: {
        memberId: userId,
        // startDate - 1 day <= date means startDate <= date + 1 day
        startDate: { lte: nextDay },
        endDate: { gte: date },
      },
    });

    if (hutLeaderCount > 0) return "hut-leader";

    // Check staying guest: PAID booking where (checkIn - 1 day) <= date <= checkOut
    const stayingGuestCount = await prisma.booking.count({
      where: {
        memberId: userId,
        status: "PAID",
        // checkIn - 1 day <= date means checkIn <= date + 1 day
        checkIn: { lte: nextDay },
        // date <= checkOut (using the date itself as the day)
        checkOut: { gte: date },
      },
    });

    if (stayingGuestCount > 0) return "staying-guest";
  }

  return "none";
}

/**
 * Returns whether a user can access the kiosk for a given date.
 */
export async function canAccessKiosk(
  userId: string,
  userRole: string,
  date: Date
): Promise<boolean> {
  const tier = await getKioskAccessTier(userId, userRole, date);
  return tier !== "none";
}

/**
 * Returns the date range the user can navigate within on the kiosk,
 * or null for unrestricted (ADMIN/LODGE).
 */
export async function getKioskDateRange(
  userId: string,
  userRole: string
): Promise<{ minDate: string; maxDate: string } | null> {
  if (userRole === "ADMIN" || userRole === "LODGE") return null;

  // Gather all hut leader assignments
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: { memberId: userId },
    select: { startDate: true, endDate: true },
  });

  // Gather all PAID bookings
  const bookings = await prisma.booking.findMany({
    where: { memberId: userId, status: "PAID" },
    select: { checkIn: true, checkOut: true },
  });

  if (assignments.length === 0 && bookings.length === 0) return null;

  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const a of assignments) {
    // Day-before access
    const start = addDaysDateOnly(a.startDate, -1);
    const end = a.endDate;

    if (!minDate || start < minDate) minDate = start;
    if (!maxDate || end > maxDate) maxDate = end;
  }

  for (const b of bookings) {
    // Day-before access
    const start = addDaysDateOnly(b.checkIn, -1);
    const end = b.checkOut;

    if (!minDate || start < minDate) minDate = start;
    if (!maxDate || end > maxDate) maxDate = end;
  }

  if (!minDate || !maxDate) return null;

  return {
    minDate: formatDateOnly(minDate),
    maxDate: formatDateOnly(maxDate),
  };
}

/**
 * Build the full kiosk access response for an API endpoint.
 */
export async function getKioskAccessInfo(
  userId: string,
  userRole: string,
  date: Date
): Promise<KioskAccess> {
  const tier = await getKioskAccessTier(userId, userRole, date);
  const dateRange = await getKioskDateRange(userId, userRole);

  return {
    tier,
    dateRange,
    canManageRoster: tier === "admin" || tier === "hut-leader",
    canMarkAttendance: tier === "admin" || tier === "hut-leader" || tier === "lodge",
    canCompleteChores: tier === "admin" || tier === "hut-leader" || tier === "lodge",
  };
}
