/**
 * How the bed board's rows are loaded and projected (#2688).
 *
 * The two range-scoped queries behind the board, the DTO serialisers over them,
 * and the planner-facing projections. Assembling the payload is
 * `bed-allocation-board.ts`; the shapes are `bed-allocation-board-payload.ts`.
 * The `Planner*` projections stay server-private — family membership is not a
 * board DTO.
 */
import type {
  BedAllocationBooking,
  BedAllocationRoom,
} from "@/lib/bed-allocation";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { bookingOwner } from "@/lib/booking-owner";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { bookingsOverlap, sameLodgeNullTolerant } from "@/lib/capacity";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import {
  guestName,
  memberName,
} from "@/lib/bed-allocation-display-names";
import type { BedAllocationDb } from "@/lib/bed-allocation-admin-contract";
import type { BedAllocationDateRange } from "@/lib/bed-allocation-date-range";
import type {
  DashboardAllocation,
  DashboardBooking,
  DashboardGuestNight,
} from "@/lib/bed-allocation-board-payload";
import { listBedAllocationRooms } from "@/lib/bed-allocation-rooms";

/** Server-private planner projection; family membership is not a board DTO. */
interface PlannerAllocation extends DashboardAllocation {
  familyGroupIds: string[];
}

/** Server-private planner projection; family membership is not a board DTO. */
interface PlannerGuestNight extends DashboardGuestNight {
  familyGroupIds: string[];
}

type DashboardBookingRecord = Awaited<
  ReturnType<typeof loadBookingRecords>
>[number];

type DashboardAllocationRecord = Awaited<
  ReturnType<typeof loadAllocationRecords>
>[number];

export async function loadBookingRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      checkIn: { lt: range.to },
      checkOut: { gt: range.from },
      // DELIBERATELY NOT consent-filtered, unlike the guest select below (owner
      // decision D-12, #2307). This `some` decides which bookings the BOARD
      // shows; the guest select decides who is placeable. An officer still needs
      // to see a booking that overlaps their window — its held nights, its
      // whole-lodge-hold flag, its existing allocations — even if every guest
      // currently on it is awaiting consent. What they must not get is an
      // unconsented guest in the awaiting-allocation queue, and that comes from
      // the filtered select.
      guests: {
        some: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
        },
      },
      // Null-tolerant: bookings still missing a lodgeId (expand-release
      // tolerance) show on every lodge's board.
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      requestedRoomId: true,
      parentBookingId: true,
      // Whether this booking is the converted booking of a BookingRequest — an
      // accepted-but-unpaid quote / approved request holds capacity even while
      // PENDING (#1254), which the Held/Provisional badge must reflect. The
      // request `type` marks SCHOOL groups for the planner's adults-together /
      // students-separate grouping (#1768) — including the pre-approval held
      // booking of a SCHOOL request (#1280).
      originBookingRequest: { select: { id: true, type: true } },
      heldForBookingRequest: { select: { type: true } },
      // Admin capacity hold (#1764): held PAYMENT_PENDING shows as Held too.
      adminCapacityHoldAt: true,
      // Exclusive whole-lodge hold (ADR-001, issues #119/#120): a held booking
      // implicitly occupies the whole lodge, so it is short-circuited out of
      // per-bed allocation, and overlapping bookings are flagged.
      wholeLodgeHold: true,
      requestedRoom: {
        select: {
          id: true,
          name: true,
          active: true,
        },
      },
      member: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      guests: {
        where: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
          // Owner decision D-12 (#2307): the board's guest list is what feeds
          // `buildGuestNightRows`, and from there the awaiting-allocation queue
          // and the planner's candidate set. A member guest whose consent is
          // still PENDING holds a bed under D-4 but is not somebody an officer
          // should be placing, so they never enter the queue. Occupancy on the
          // board is unaffected: `loadAllocationRecords` reads the BedAllocation
          // rows independently and names their guests from the allocation row.
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
          nights: {
            where: { stayDate: { gte: range.from, lt: range.to } },
            select: { stayDate: true },
            orderBy: { stayDate: "asc" },
          },
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
                orderBy: { familyGroupId: "asc" },
              },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function loadAllocationRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: range.from,
        lt: range.to,
      },
      // Allocations follow their bed's room; rooms without a lodgeId
      // (expand-release tolerance) show on every lodge's board.
      ...(lodgeId ? { room: lodgeNullTolerantScope(lodgeId) } : {}),
    },
    include: {
      booking: {
        select: {
          status: true,
          // Accepted-but-unpaid quote holds capacity while PENDING (#1254).
          originBookingRequest: { select: { id: true } },
          // Admin capacity hold (#1764): held PAYMENT_PENDING shows as Held.
          adminCapacityHoldAt: true,
        },
      },
      bookingGuest: {
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
                orderBy: { familyGroupId: "asc" },
              },
            },
          },
        },
      },
      room: {
        select: {
          id: true,
          name: true,
        },
      },
      bed: {
        select: {
          id: true,
          name: true,
        },
      },
      approvedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: [
      { stayDate: "asc" },
      { room: { sortOrder: "asc" } },
      { bed: { sortOrder: "asc" } },
      { id: "asc" },
    ],
  });
}

// The overlapping exclusive-hold spans, precomputed once per dashboard build so
// each booking's overlap flag (issue #119) is a cheap in-memory check.
export interface HeldSpan {
  id: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
}

export function serializeBookings(
  bookings: DashboardBookingRecord[],
  heldSpans: HeldSpan[],
): DashboardBooking[] {
  return bookings.map((booking) => ({
    id: booking.id,

    status: booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: booking.status,
      isRequestConverted: Boolean(booking.originBookingRequest),
      hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
    }),
    createdAt: booking.createdAt.toISOString(),
    checkIn: formatDateOnly(booking.checkIn),
    checkOut: formatDateOnly(booking.checkOut),
    memberName: memberName(bookingOwner(booking).member),
    guests: booking.guests.map((guest) => ({
      id: guest.id,
      bookingId: guest.bookingId,
      name: guestName(guest),
      ageTier: guest.ageTier,
      stayStart: formatDateOnly(guest.stayStart),
      stayEnd: formatDateOnly(guest.stayEnd),
    })),
    requestedRoom: booking.requestedRoom,
    parentBookingId: booking.parentBookingId,
    wholeLodgeHold: Boolean(booking.wholeLodgeHold),
    // A held booking never flags itself; an ordinary booking flags when it
    // overlaps ANY held booking's nights at the same lodge (issue #119).
    overlapsExclusiveHold:
      !booking.wholeLodgeHold &&
      heldSpans.some(
        (held) =>
          held.id !== booking.id &&
          sameLodgeNullTolerant(held.lodgeId, booking.lodgeId) &&
          bookingsOverlap(held, booking),
      ),
  }));
}

export function serializePlannerAllocations(
  allocations: DashboardAllocationRecord[],
): PlannerAllocation[] {
  return allocations.map((allocation) => ({
    id: allocation.id,
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    guestName: guestName(allocation.bookingGuest),
    guestAgeTier: allocation.bookingGuest.ageTier,
    roomId: allocation.roomId,
    roomName: allocation.room.name,
    bedId: allocation.bedId,
    bedName: allocation.bed.name,
    stayDate: formatDateOnly(allocation.stayDate),
    source: allocation.source,
    approvedAt: allocation.approvedAt?.toISOString() ?? null,
    approvedByName: allocation.approvedBy
      ? memberName(allocation.approvedBy)
      : null,
    bookingStatus: allocation.booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: allocation.booking.status,
      isRequestConverted: Boolean(allocation.booking.originBookingRequest),
      hasAdminCapacityHold: Boolean(allocation.booking.adminCapacityHoldAt),
    }),
    isSecondOccupant: allocation.isSecondOccupant,
    familyGroupIds:
      allocation.bookingGuest.member?.familyGroupMemberships.map(
        (membership) => membership.familyGroupId,
      ) ?? [],
  }));
}

export function toDashboardAllocation(
  allocation: PlannerAllocation,
): DashboardAllocation {
  return {
    id: allocation.id,
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    guestName: allocation.guestName,
    guestAgeTier: allocation.guestAgeTier,
    roomId: allocation.roomId,
    roomName: allocation.roomName,
    bedId: allocation.bedId,
    bedName: allocation.bedName,
    stayDate: allocation.stayDate,
    source: allocation.source,
    approvedAt: allocation.approvedAt,
    approvedByName: allocation.approvedByName,
    isSecondOccupant: allocation.isSecondOccupant,
    bookingStatus: allocation.bookingStatus,
    holdsCapacity: allocation.holdsCapacity,
  };
}

export function toDashboardGuestNight(
  guestNight: PlannerGuestNight,
): DashboardGuestNight {
  return {
    bookingId: guestNight.bookingId,
    bookingGuestId: guestNight.bookingGuestId,
    guestName: guestNight.guestName,
    guestAgeTier: guestNight.guestAgeTier,
    memberName: guestNight.memberName,
    stayDate: guestNight.stayDate,
  };
}

export function buildGuestNightRows(
  bookings: DashboardBookingRecord[],
): PlannerGuestNight[] {
  const rows: PlannerGuestNight[] = [];

  for (const booking of bookings) {
    const bookingMemberName = memberName(bookingOwner(booking).member);

    for (const guest of booking.guests) {
      for (const night of guest.nights) {
        rows.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          guestName: guestName(guest),
          guestAgeTier: guest.ageTier,
          memberName: bookingMemberName,
          stayDate: formatDateOnly(night.stayDate),
          familyGroupIds:
            guest.member?.familyGroupMemberships.map(
              (membership) => membership.familyGroupId,
            ) ?? [],
        });
      }
    }
  }

  return rows;
}

export function guestNightKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

export function candidateGuestBookings(
  bookings: DashboardBookingRecord[],
  guestNights: PlannerGuestNight[],
): BedAllocationBooking[] {
  const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
  const guestsByBooking = new Map<string, BedAllocationBooking["guests"]>();

  for (const guestNight of guestNights) {
    const booking = bookingById.get(guestNight.bookingId);
    if (!booking) continue;

    const stayStart = parseDateOnly(guestNight.stayDate);
    const stayEnd = addDaysDateOnly(stayStart, 1);
    const guests = guestsByBooking.get(booking.id) ?? [];

    guests.push({
      id: guestNight.bookingGuestId,
      bookingId: booking.id,
      ageTier: guestNight.guestAgeTier,
      stayStart,
      stayEnd,
      nights: [guestNight.stayDate],
      familyGroupIds: guestNight.familyGroupIds,
    });
    guestsByBooking.set(booking.id, guests);
  }

  return [...guestsByBooking.entries()]
    .map(([bookingId, guests]): BedAllocationBooking | null => {
      const booking = bookingById.get(bookingId);
      if (!booking) return null;
      return {
        id: booking.id,
        createdAt: booking.createdAt,
        lodgeId: booking.lodgeId,
        requestedRoomId: booking.requestedRoomId,
        // SCHOOL request bookings (#1768): adults room together, students
        // separately — covers both the converted booking and a SCHOOL
        // request's pre-approval held booking.
        isSchoolGroup:
          booking.originBookingRequest?.type === "SCHOOL" ||
          booking.heldForBookingRequest?.type === "SCHOOL",
        guests,
      };
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));
}

export function buildPlannerRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    lodgeId: room.lodgeId,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];
}
