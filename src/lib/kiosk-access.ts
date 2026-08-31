import { prisma } from "./prisma";
import {
  addDaysDateOnly,
  formatDateOnly,
} from "./date-only";
import { LODGE_VISIBLE_BOOKING_STATUSES } from "./lodge-date-scoping";
import {
  hasAccessRole,
  hasAdminAccess,
  hasLodgeAccess,
  type AccessRoleInput,
} from "@/lib/access-roles";

export type KioskTier = "admin" | "hut-leader" | "lodge" | "staying-guest" | "none";

export interface KioskAccess {
  tier: KioskTier;
  dateRange: { minDate: string; maxDate: string } | null;
  canManageRoster: boolean;
  canMarkAttendance: boolean;
  canCompleteChores: boolean;
  /**
   * The two Group Trip disclosure capabilities (#3040, epic #2943). Reported
   * here so the kiosk client knows what it will be sent, and derived from the
   * ONE definition below so this endpoint and the guest-list route cannot
   * disagree about who may see what.
   */
  canViewGroupTripOrganiser: boolean;
  canViewAdultCoverSource: boolean;
}

/**
 * The two privileged Group Trip capabilities, carried separately because they
 * ARE separate (#3040).
 *
 * The issue requires organiser context and adult-cover source to be
 * "independently authorized", so they are two booleans, consulted at two
 * places, gating two payload keys and two database reads. They are granted to
 * the same tiers today; that is a policy coincidence and NOT a licence to
 * collapse them into one flag, because collapsing them would make it impossible
 * to grant one without the other later.
 * `src/lib/__tests__/kiosk-group-trip-privacy.test.ts` drives all four
 * combinations.
 */
export interface KioskGroupTripCapabilities {
  organiser: boolean;
  coverSource: boolean;
}

/**
 * Which kiosk tiers hold the two privileged Group Trip capabilities.
 *
 * `admin` and `hut-leader` only — deliberately the same set as
 * `canManageRoster`, the narrower of the two capability sets this module
 * already grants, and NOT the wider `canMarkAttendance` set that includes
 * `lodge`.
 *
 * The `lodge` tier is a shared, often unattended wall device: anybody who walks
 * up to it is that tier. Marking a guest arrived from it is an operational
 * action the club wants available that way; learning who organised another
 * member's trip, or which account's adult supplies a booking's cover, is
 * cross-account DISCLOSURE, and disclosure to an unattended screen is
 * disclosure to everybody in the room. `staying-guest` and `none` hold neither
 * capability — that is the ordinary tier the whole privacy split exists for,
 * and it sees Group Trip LINKAGE only.
 */
export function kioskGroupTripCapabilities(
  tier: KioskTier,
): KioskGroupTripCapabilities {
  const privileged = tier === "admin" || tier === "hut-leader";
  // Two fields, written out, rather than one shared boolean reference. A single
  // expression assigned to both would read as "these are the same capability",
  // which is exactly what this must not become.
  return { organiser: privileged, coverSource: privileged };
}

export type KioskAccessSubject = AccessRoleInput & {
  id: string;
};

/**
 * Returns the highest kiosk access tier for a user on a given date.
 */
export async function getKioskAccessTier(
  user: KioskAccessSubject,
  date: Date
): Promise<KioskTier> {
  if (hasAdminAccess(user)) return "admin";
  if (hasLodgeAccess(user)) return "lodge";

  if (hasAccessRole(user, "USER")) {
    // Check hut leader assignment: (startDate - 1 day) <= date <= endDate
    const nextDay = addDaysDateOnly(date, 1);

    const hutLeaderCount = await prisma.hutLeaderAssignment.count({
      where: {
        memberId: user.id,
        // startDate - 1 day <= date means startDate <= date + 1 day
        startDate: { lte: nextDay },
        endDate: { gte: date },
      },
    });

    if (hutLeaderCount > 0) return "hut-leader";

    // Check staying guest: booking owner or linked member guest where
    // (checkIn - 1 day) <= date <= checkOut.
    const stayingGuestCount = await prisma.booking.count({
      where: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        OR: [
          { memberId: user.id },
          {
            guests: {
              some: {
                memberId: user.id,
                stayStart: { lte: nextDay },
                stayEnd: { gte: date },
              },
            },
          },
        ],
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

// test seam
/**
 * Returns the date range the user can navigate within on the kiosk,
 * or null for unrestricted (ADMIN/LODGE).
 */
export async function getKioskDateRange(
  user: KioskAccessSubject,
  date?: Date
): Promise<{ minDate: string; maxDate: string } | null> {
  if (hasAdminAccess(user) || hasLodgeAccess(user)) return null;

  const nextDay = date ? addDaysDateOnly(date, 1) : null;

  // Gather all hut leader assignments
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      memberId: user.id,
      ...(date && nextDay
        ? {
            startDate: { lte: nextDay },
            endDate: { gte: date },
          }
        : {}),
    },
    select: { startDate: true, endDate: true },
  });

  // Gather all visible bookings where the signed-in member is staying.
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
      OR: [
        { memberId: user.id },
        {
          guests: {
            some: {
              memberId: user.id,
              ...(date && nextDay
                ? {
                    stayStart: { lte: nextDay },
                    stayEnd: { gte: date },
                  }
                : {}),
            },
          },
        },
      ],
      ...(date && nextDay
        ? {
            checkIn: { lte: nextDay },
            checkOut: { gte: date },
          }
        : {}),
    },
    select: {
      memberId: true,
      checkIn: true,
      checkOut: true,
      guests: {
        where: { memberId: user.id },
        select: {
          stayStart: true,
          stayEnd: true,
        },
      },
    },
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
    const guestRanges =
      b.memberId === user.id
        ? [{ stayStart: b.checkIn, stayEnd: b.checkOut }]
        : (b.guests ?? []);

    for (const range of guestRanges) {
      // Day-before access
      const start = addDaysDateOnly(range.stayStart, -1);
      const end = range.stayEnd;

      if (!minDate || start < minDate) minDate = start;
      if (!maxDate || end > maxDate) maxDate = end;
    }
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
  user: KioskAccessSubject,
  date: Date
): Promise<KioskAccess> {
  const tier = await getKioskAccessTier(user, date);
  const dateRange = await getKioskDateRange(user, date);
  const groupTrip = kioskGroupTripCapabilities(tier);

  return {
    tier,
    dateRange,
    canManageRoster: tier === "admin" || tier === "hut-leader",
    canMarkAttendance: tier === "admin" || tier === "hut-leader" || tier === "lodge",
    canCompleteChores: tier === "admin" || tier === "hut-leader" || tier === "lodge",
    canViewGroupTripOrganiser: groupTrip.organiser,
    canViewAdultCoverSource: groupTrip.coverSource,
  };
}
