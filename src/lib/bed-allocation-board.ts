/**
 * Assembling the bed board's payload, and the officer card's counter (#2688).
 *
 * This is the orchestration layer: settings, inventory, the range-scoped
 * records, custodian and whole-lodge holds, the first-fit planner preview and
 * the warnings, composed into one response. The queries and serialisers are
 * `bed-allocation-board-records.ts`.
 */
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import { buildFirstFitBedAllocationPlan } from "@/lib/bed-allocation";
import { getExplicitGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { reportBedAllocationInvariantViolation } from "@/lib/bed-allocation-diagnostics";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import {
  custodianOccupiedBedNightsForPlanner,
  findCustodianBedHolds,
} from "@/lib/custodian-occupancy";
import {
  findBlockingWholeLodgeHolds,
  wholeLodgeHoldOccupiedBedNightsForPlanner,
} from "@/lib/exclusive-hold-occupancy";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import type { BedAllocationDb } from "@/lib/bed-allocation-admin-contract";
import {
  clampGuestToRange,
  type BedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import { getEffectiveBedAllocationSettings } from "@/lib/bed-allocation-admin-settings";
import { memberName } from "@/lib/bed-allocation-display-names";
import type {
  BedAllocationDashboardPayload,
  DashboardCustodianHold,
  DashboardExclusiveHold,
} from "@/lib/bed-allocation-board-payload";
import {
  listBedAllocationRooms,
  serializeRooms,
} from "@/lib/bed-allocation-rooms";
import {
  buildGuestNightRows,
  buildPlannerRooms,
  candidateGuestBookings,
  guestNightKey,
  loadAllocationRecords,
  loadBookingRecords,
  serializeBookings,
  serializePlannerAllocations,
  toDashboardAllocation,
  toDashboardGuestNight,
  type HeldSpan,
} from "@/lib/bed-allocation-board-records";
import { buildBedAllocationWarnings } from "@/lib/bed-allocation-warnings";

export async function getBedAllocationDashboard(input: {
  range: BedAllocationDateRange;
  // Scope the whole board — rooms, bookings, allocations, and therefore the
  // first-fit suggestions — to one lodge (ADR-003). Omitted = club-wide,
  // preserving single-lodge behaviour.
  lodgeId?: string;
  // Deep-linked focused booking (?bookingId=…). When set and out of range, the
  // response carries its stay window so the board can snap onto it (#1302).
  bookingId?: string | null;
  db?: BedAllocationDb;
}): Promise<BedAllocationDashboardPayload> {
  const db = input.db ?? prisma;
  const [settings, rooms, bookings, allocationRecords] = await Promise.all([
    getEffectiveBedAllocationSettings(db, input.lodgeId),
    listBedAllocationRooms(db, input.lodgeId),
    loadBookingRecords(input.range, db, input.lodgeId),
    loadAllocationRecords(input.range, db, input.lodgeId),
  ]);
  const visiblePlannerAllocations =
    serializePlannerAllocations(allocationRecords);
  const serializedAllocations = visiblePlannerAllocations.map(
    toDashboardAllocation,
  );

  // Planner-only continuity context: the board still returns and renders only
  // the requested window, but a guest allocated just outside it must influence
  // STAY_CONTINUITY when an adjacent visible night is suggested. Load only the
  // overlapping board bookings' full envelopes and keep those extra rows out
  // of `serializedAllocations` and every response collection.
  let plannerAllocationRecords = allocationRecords;
  if (settings.autoAllocationEnabled && bookings.length > 0) {
    const contextFrom = bookings.reduce(
      (earliest, booking) =>
        booking.checkIn < earliest ? booking.checkIn : earliest,
      input.range.from,
    );
    const contextTo = bookings.reduce(
      (latest, booking) =>
        booking.checkOut > latest ? booking.checkOut : latest,
      input.range.to,
    );
    if (contextFrom < input.range.from || contextTo > input.range.to) {
      const bookingIds = new Set(bookings.map((booking) => booking.id));
      const visibleIds = new Set(allocationRecords.map((row) => row.id));
      const contextRecords = await loadAllocationRecords(
        {
          from: contextFrom,
          to: contextTo,
          fromDate: formatDateOnly(contextFrom),
          toDate: formatDateOnly(contextTo),
        },
        db,
        input.lodgeId,
      );
      plannerAllocationRecords = [
        ...allocationRecords,
        ...contextRecords.filter(
          (row) => bookingIds.has(row.bookingId) && !visibleIds.has(row.id),
        ),
      ];
    }
  }
  const serializedPlannerAllocations = serializePlannerAllocations(
    plannerAllocationRecords,
  );

  // Exclusive whole-lodge holds (ADR-001, issues #119/#120). A held booking
  // implicitly occupies every bed, so it is short-circuited OUT of per-bed
  // allocation: its guest-nights are excluded from the awaiting-allocation set
  // and never fed to the planner (so it can never appear as an allocation gap /
  // stuck state). It is represented distinctly on the board instead, and its
  // span flags overlapping ordinary bookings (#119).
  const heldSpans: HeldSpan[] = bookings
    .filter((booking) => booking.wholeLodgeHold)
    .map((booking) => ({
      id: booking.id,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
    }));
  const heldBookingIds = new Set(heldSpans.map((held) => held.id));

  const allGuestNights = buildGuestNightRows(bookings);
  const allocatedGuestNights = new Set(
    serializedAllocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, allocation.stayDate),
    ),
  );
  const unallocatedPlannerGuestNights = allGuestNights.filter(
    (guestNight) =>
      // A held booking needs no per-bed placement (#120): keep its guests out
      // of the awaiting-allocation bucket AND out of the planner entirely.
      !heldBookingIds.has(guestNight.bookingId) &&
      !allocatedGuestNights.has(
        guestNightKey(guestNight.bookingGuestId, guestNight.stayDate),
      ),
  );
  const unallocatedGuestNights = unallocatedPlannerGuestNights.map(
    toDashboardGuestNight,
  );

  // Board representation for each hold (#120): the group + the held nights that
  // fall inside the current range, so staff understand the lodge is taken.
  const exclusiveHolds: DashboardExclusiveHold[] = bookings
    .filter((booking) => booking.wholeLodgeHold)
    .map((booking) => {
      const clamped = clampGuestToRange(
        { stayStart: booking.checkIn, stayEnd: booking.checkOut },
        input.range,
      );
      return {
        bookingId: booking.id,
        memberName: memberName(booking.member),
        checkIn: formatDateOnly(booking.checkIn),
        checkOut: formatDateOnly(booking.checkOut),
        guestCount: booking.guests.length,
        nights: eachDateOnlyInRange(clamped.stayStart, clamped.stayEnd).map(
          formatDateOnly,
        ),
      };
    });
  // Custodian bed holds (#2286): loaded for the board's range and fed to the
  // planner as #1768 "unknown occupant" rows — blocking, never evictable, and
  // conservative for room mix — so no suggestion can ever target a held
  // bed-night. `toExclusive` is the day AFTER the board's inclusive last night.
  // The board's range is HALF-OPEN — `toDate` is the date-out column, not the
  // last night (parseBedAllocationDateRange derives its night count with
  // eachDateOnlyInRange(from, to)). The custodian API takes the same shape, so
  // `to` passes straight through as the exclusive end; adding a day here would
  // hold a bed on a night the board never renders.
  const rangeNights = eachDateOnlyInRange(input.range.from, input.range.to);
  // Blocking whole-lodge holds (#2317): loaded on the SAME half-open window as
  // the custodian holds, and for the same reason — a hold takes every bed of
  // its lodge for its nights but owns no `BedAllocation` row anywhere, so it is
  // invisible to `serializedAllocations` above. Its own query, not a filter
  // over `bookings`: a hold blocks whether or not its guest rows have been
  // entered yet, and the board's booking load demands an overlapping guest.
  const [custodianBedHolds, blockingWholeLodgeHolds] = await Promise.all([
    findCustodianBedHolds({
      lodgeId: input.lodgeId,
      from: input.range.from,
      toExclusive: input.range.to,
      db,
    }),
    findBlockingWholeLodgeHolds({
      lodgeId: input.lodgeId,
      from: input.range.from,
      toExclusive: input.range.to,
      db,
    }),
  ]);
  const custodianHolds: DashboardCustodianHold[] = custodianBedHolds.map(
    (hold) => ({
      assignmentId: hold.assignmentId,
      memberName: hold.memberName,
      bedId: hold.bedId,
      bedName: hold.bedName,
      roomId: hold.roomId,
      roomName: hold.roomName,
      startDate: hold.startDate,
      endDate: hold.endDate,
      nights: rangeNights
        .map(formatDateOnly)
        .filter((night) => hold.startDate <= night && night <= hold.endDate),
    }),
  );

  const plannerRooms = buildPlannerRooms(rooms);
  const plannerBookings = candidateGuestBookings(
    bookings,
    unallocatedPlannerGuestNights,
  );
  const plan = settings.autoAllocationEnabled
    ? buildFirstFitBedAllocationPlan({
        enabled: true,
        // #2656: the planner is pure, so it hands a detected bookkeeping
        // divergence back rather than logging it itself. Test runs still throw;
        // a live board render logs and breadcrumbs instead of staying silent.
        onInvariantViolation: (message) =>
          reportBedAllocationInvariantViolation(message, {
            lodgeId: input.lodgeId ?? null,
            source: "getBedAllocationDashboard",
          }),
        allocationPriorityOrder: settings.allocationPriorityOrder,
        rooms: plannerRooms,
        bookings: plannerBookings,
        occupiedBedNights: [
          ...serializedPlannerAllocations.map((allocation) => ({
            bedId: allocation.bedId,
            bookingId: allocation.bookingId,
            bookingGuestId: allocation.bookingGuestId,
            roomId: allocation.roomId,
            stayDate: allocation.stayDate,
            ageTier: allocation.guestAgeTier,
            familyGroupIds: allocation.familyGroupIds ?? [],
          })),
          ...custodianOccupiedBedNightsForPlanner(
            custodianBedHolds,
            rangeNights,
          ),
          // Exclusive whole-lodge holds (#2317, owner decision option (a)):
          // every active bed of the held lodge, on every held night, as
          // unattributed (null booking / null guest) non-displaceable
          // occupancy. The held group's own guests are already excluded from
          // `plannerBookings` (the #120/#2285 short-circuit above), so this
          // only ever stops ANOTHER booking's guests being auto-placed onto
          // beds the held group is physically using — the clash surfaces as
          // NO_BED_AVAILABLE in the awaiting-allocation list instead.
          // #2698 (INV-CAP-035): the SAME hold set the custodian expansion
          // above was built from, so the hold's represented beds exclude the
          // bed-nights a custodian holds and no bed-night is claimed twice.
          ...wholeLodgeHoldOccupiedBedNightsForPlanner(
            blockingWholeLodgeHolds,
            rooms,
            rangeNights,
            custodianBedHolds,
          ),
        ],
      })
    : { allocations: [], unallocatedGuestNights: [] };

  // Resolve a deep-linked focused booking that falls outside the current range
  // (#1302). It is absent from `bookings` (range-filtered), so the client cannot
  // snap onto it without its stay window. Look it up only when it is not already
  // in range, and only if it is an allocatable, non-deleted booking.
  let focusedBooking: BedAllocationDashboardPayload["focusedBooking"] = null;
  if (input.bookingId && !bookings.some((booking) => booking.id === input.bookingId)) {
    const found = await db.booking.findFirst({
      where: {
        id: input.bookingId,
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      },
      select: { id: true, checkIn: true, checkOut: true },
    });
    if (found) {
      focusedBooking = {
        id: found.id,
        checkIn: formatDateOnly(found.checkIn),
        checkOut: formatDateOnly(found.checkOut),
      };
    }
  }

  return {
    settings,
    range: {
      fromDate: input.range.fromDate,
      toDate: input.range.toDate,
    },
    rooms: serializeRooms(rooms),
    bookings: serializeBookings(bookings, heldSpans),
    allocations: serializedAllocations,
    unallocatedGuestNights,
    exclusiveHolds,
    custodianHolds,
    suggestedAllocations: plan.allocations,
    suggestedUnallocatedGuestNights: plan.unallocatedGuestNights,
    warnings: buildBedAllocationWarnings({
      allocations: serializedAllocations,
      custodianHolds,
    }),
    focusedBooking,
  };
}

/**
 * Count the distinct guests with at least one bed-night still awaiting
 * allocation inside a bounded window — the "work to do" headline for the admin
 * dashboard's Bed Allocation officer card (#2091). This is a window-scoped
 * mirror of `getBedAllocationDashboard`'s `unallocatedGuestNights` construction
 * (the board's own awaiting-allocation set), kept cheap by the bounded window
 * (the dashboard passes today..+7, the board's own landing window):
 *   - loads only BED_ALLOCATABLE_BOOKING_STATUSES bookings with ≥1 guest
 *     overlapping the window (`loadBookingRecords`'s guest-existence rule), and
 *   - excludes whole-lodge holds up front (a held lodge implicitly occupies
 *     every bed and needs no per-bed placement — ADR-001/#120 — so the board
 *     drops its guests from the awaiting-allocation set entirely), then
 *   - treats a guest-night as awaiting when no BedAllocation row exists for that
 *     (guest, night), counting each guest ONCE if any of their window nights is
 *     unallocated (the board renders one bucket card per such guest).
 *
 * Because the diff is at guest-night granularity, a booking with guest A placed
 * and guest B pending still contributes B here — exactly the guest the board
 * lists in its bucket — instead of the whole booking dropping out the moment one
 * guest is allocated. Club-wide (no lodge scope) for the dashboard.
 */
export async function countGuestsAwaitingBed(input: {
  from: Date;
  to: Date;
  lodgeId?: string;
  db?: BedAllocationDb;
}): Promise<number> {
  const db = input.db ?? prisma;
  const { from, to } = input;

  const [bookings, allocations] = await Promise.all([
    db.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
        wholeLodgeHold: false,
        checkIn: { lt: to },
        checkOut: { gt: from },
        // Left broad for the same reason as `loadBookingRecords`' `some` above
        // (D-12, #2307): this mirrors the board's booking-existence rule, and the
        // exclusion that matters is on the guest select below. A booking whose
        // only overlapping guests are unconsented loads here and contributes
        // nobody, which is the right answer either way.
        guests: {
          some: {
            stayStart: { lt: to },
            stayEnd: { gt: from },
          },
        },
        ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
      },
      select: {
        id: true,
        guests: {
          where: {
            stayStart: { lt: to },
            stayEnd: { gt: from },
            // D-12 (#2307): this counter is a window-scoped mirror of the
            // board's own awaiting-allocation construction, so it has to apply
            // the same exclusion — otherwise the officer card advertises work
            // the board itself does not list.
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
          select: {
            id: true,
            // The board builds its awaiting-allocation set from these rows and
            // nothing else (`buildGuestNightRows`), so this counter must too
            // (#2628). It used to expand `stayStart`/`stayEnd` instead, which
            // filled a sparse stay's internal gaps with nights no allocator will
            // ever place — reporting that guest as awaiting a bed forever, on a
            // card the board itself does not list. Window-scoped exactly like
            // `loadBookingRecords`' own night load.
            nights: {
              where: { stayDate: { gte: from, lt: to } },
              select: { stayDate: true },
            },
          },
        },
      },
    }),
    db.bedAllocation.findMany({
      where: {
        stayDate: { gte: from, lt: to },
        ...(input.lodgeId ? { room: lodgeNullTolerantScope(input.lodgeId) } : {}),
      },
      select: {
        bookingGuestId: true,
        stayDate: true,
      },
    }),
  ]);

  const allocatedGuestNights = new Set(
    allocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, formatDateOnly(allocation.stayDate)),
    ),
  );

  const awaitingGuestIds = new Set<string>();
  for (const booking of bookings) {
    for (const guest of booking.guests) {
      // `?? []` is the board's rule, stated (#2628): a guest carrying no
      // `BookingGuestNight` rows has no placeable nights, so the board never
      // lists them and this card must not count them either.
      for (const night of getExplicitGuestBedNightKeys(guest) ?? []) {
        if (!allocatedGuestNights.has(guestNightKey(guest.id, night))) {
          awaitingGuestIds.add(guest.id);
          // One unallocated night makes the guest awaiting; count them once.
          break;
        }
      }
    }
  }

  return awaitingGuestIds.size;
}
