import { bookingHoldsCapacity, capacityHoldingBookingFilter } from "@/lib/booking-status";
import { sameLodgeNullTolerant } from "@/lib/capacity";
import {
  type CustodianBedHold,
  isCustodianHeldBedNight,
} from "@/lib/custodian-occupancy";
import { formatDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

/**
 * Exclusive whole-lodge hold occupancy (#2317, epic #2245) — THE single source
 * of truth for "which bed-nights are taken by a whole-lodge hold" as far as the
 * two bed-allocation PLANNERS are concerned.
 *
 * ADR-001 says an exclusive whole-lodge hold means the group implicitly
 * occupies every bed in the lodge for its nights. Until #2317 that occupancy
 * lived in exactly one place — the capacity rule, which blocks new admissions —
 * so neither planner could see it: a held lodge looked like a lodge full of
 * free beds, and another booking's guests could be auto-placed onto beds the
 * held group is physically sleeping in (and the cross-booking age-mix invariant
 * of #1768 could not see the held group's minors either).
 *
 * Owner decision, 1 Aug 2026 (issue #2317, option (a)): both planners now
 * synthesise the held group's nights as **unattributed, non-displaceable**
 * occupancy — every active bed, every held night — without ever creating
 * `BedAllocation` rows for it.
 *
 * ## Unattributed, non-displaceable — and why that falls out of the row shape
 *
 * The rows this module emits carry `bookingId: null` and `bookingGuestId:
 * null`: they are #1768 "unknown occupant" rows, exactly like a custodian bed
 * hold (`custodian-occupancy.ts`). That single choice buys all three
 * properties the decision asks for:
 *
 * - **Unattributed.** No member or guest name and no booking id reaches the
 *   planner, so a hold can never leak who is behind it into a placement, a
 *   suggestion, or a warning. Holds can originate from a public school request,
 *   so this is a privacy property, not only a tidiness one.
 * - **Non-displaceable.** `buildFirstFitBedAllocationPlan` only registers an
 *   evictable occupant (`setOccupant`) for rows that name BOTH a booking and a
 *   guest. An unknown-occupant row is added to the `occupied` set and to the
 *   room-night composition index and to nothing else, so no `MOVE` and no
 *   `UNALLOCATE` can ever target it — there is no row for the planner to move.
 *   That protects the ROW; the BED-NIGHT needs one thing more, because a real
 *   `BedAllocation` row may legitimately sit on the same bed on the same night
 *   (decision 1 never refuses the overlapping booking, the hold prune only
 *   sweeps the held booking's own rows, and manual placement stays open) and
 *   planner occupancy is keyed `bedId:stayDate`. So the planner also pins every
 *   null-booking bed-night in `state.permanentlyOccupied`: evicting the
 *   co-located booking releases that booking's claim and never the hold's.
 * - **Conservative for room mix.** A tierless unknown occupant counts as an
 *   ADULT, so auto-placement keeps another booking's unaccompanied minors out
 *   of a held lodge's rooms. That is the intended reading: an unrelated group
 *   really is sleeping there.
 *
 * ## The blocking predicate is the capacity engine's, not a parallel list
 *
 * A hold blocks when `wholeLodgeHold` is set AND the booking actually holds
 * capacity — {@link bookingHoldsCapacity} in memory, `capacityHoldingBookingFilter()`
 * in SQL — scoped to the lodge. That is the population `getLodgeHeldNights`
 * (`src/lib/capacity.ts`) uses, so the planners can never report a night as
 * held that the capacity engine would admit into, nor miss one it would refuse.
 * A stale `wholeLodgeHold = true` on a booking that has left a capacity-holding
 * status blocks nothing here for the same reason it blocks nothing there.
 *
 * One deliberate asymmetry, and it is direction-safe: the SQL scope is the
 * engine's exact `lodgeId` equality, but the in-memory night predicate below is
 * null-TOLERANT, so a hold or a room whose lodge cannot be resolved blocks
 * rather than being ignored. That refuses a bed the engine would have admitted
 * — never the reverse — and `Booking.lodgeId` / `LodgeRoom.lodgeId` are both
 * NOT NULL, so it is a dead branch kept conservative rather than removed.
 *
 * This is deliberately NOT the same predicate as the #2285 short-circuit, which
 * asks a different question — "may this booking own per-bed rows?" — and is
 * keyed on the raw flag alone. The two are consistent: a booking whose status
 * stopped holding capacity owns no rows anyway (the reconcile sweep removes
 * them on a non-allocatable status), while a still-allocatable booking carrying
 * a stale hold flag simply stops blocking OTHER bookings, exactly as it stopped
 * blocking new admissions.
 *
 * ## Night semantics (pinned)
 *
 * A hold covers `checkIn <= night < checkOut` — the half-open booking envelope,
 * because `checkOut` is a departure MORNING. This matches
 * `buildWholeLodgeHoldIndex` in `capacity.ts` exactly, so a held group leaving
 * on day D does not block another booking arriving that night (back-to-back
 * handovers stay correct). It deliberately differs from the custodian hold's
 * inclusive-inclusive range, which bands covered DAYS rather than a stay.
 *
 * Every date key here is `YYYY-MM-DD` from {@link formatDateOnly} — the ONE
 * date-only convention the bed-allocation and capacity domain uses.
 *
 * ## The custodian exclusion is imported, not restated (#2698)
 *
 * A hold's represented bed set excludes a bed-night a custodian holds
 * (`INV-CAP-035`). That rule is decided in exactly one place —
 * `isCustodianHeldBedNight` in `custodian-occupancy.ts` — and this module
 * subtracts through it rather than re-deriving "is this bed the custodian's
 * tonight" from an inclusive-inclusive assignment range a second time. The
 * night-span note above is still a hand-match with `buildWholeLodgeHoldIndex`
 * and stays one; #2698 did not widen into unifying that, and says so.
 *
 * ## What this module deliberately does NOT do
 *
 * It never refuses a MANUAL placement. ADR-001 decision 1 admits overlapping
 * bookings on held nights on purpose and hands the clash to the booking officer
 * to resolve by hand (#119/#177); a hard write-time refusal would take away the
 * very resolution path the ADR requires. The effect of #2317 is that the
 * officer's clash now sits in the awaiting-allocation list instead of being
 * hidden inside a bad automatic placement.
 *
 * It also adds nothing to the BOARD's payload, so nothing here changes what an
 * officer sees on the bed grid: a held night's cells are drawn like empty ones
 * and stay droppable, which is what keeps manual placement possible. The
 * officer-facing explanation of a hold remains the board's exclusive-hold
 * banner and the "Overlaps exclusive hold" chip — both derived from
 * `loadBookingRecords`, which requires a guest row overlapping the window.
 * This query deliberately requires no such thing (see
 * {@link findBlockingWholeLodgeHolds}), so a hold whose guest rows have not been
 * entered yet blocks every bed without appearing in either. That is the
 * intended direction — blocking must not depend on data entry — but it means
 * the blocking population is wider than the explaining one; the officer guide's
 * troubleshooting table names the symptom.
 */

type PrismaClient = typeof prisma;
type ExclusiveHoldDb = Pick<PrismaClient, "booking">;

/**
 * A whole-lodge hold that BLOCKS, resolved for planner use. Date keys are
 * `YYYY-MM-DD`; `checkOutKey` is EXCLUSIVE (a departure morning).
 */
export interface WholeLodgeHoldSpan {
  bookingId: string;
  lodgeId: string | null;
  checkInKey: string;
  checkOutKey: string;
}

/** The booking fields the blocking predicate reads. */
export interface WholeLodgeHoldCandidate {
  id: string;
  status: string;
  /**
   * Nullable exactly as in `buildWholeLodgeHoldIndex` (`src/lib/capacity.ts`):
   * a hold with no stay window spans no nights, so it blocks nothing.
   */
  checkIn?: Date | null;
  checkOut?: Date | null;
  lodgeId?: string | null;
  wholeLodgeHold?: boolean | null;
  /** Present when the booking was converted from a BookingRequest (#1254). */
  originBookingRequest?: { id: string } | null;
  /** Admin capacity hold (#1764). */
  adminCapacityHoldAt?: Date | null;
}

/**
 * Does THIS booking's whole-lodge hold block other bookings' beds?
 *
 * The flag intersected with the capacity engine's own holding predicate — see
 * the note at the top of the file for why the intersection, and not the flag
 * alone, is the right question for a planner.
 */
export function isBlockingWholeLodgeHold(
  booking: WholeLodgeHoldCandidate,
): boolean {
  if (!booking.wholeLodgeHold) return false;
  return bookingHoldsCapacity({
    status: booking.status,
    isRequestConverted: Boolean(booking.originBookingRequest),
    hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
  });
}

/**
 * Narrow a set of already-loaded bookings to the blocking whole-lodge holds
 * among them, as planner spans. Pure — the planners that already hold the rows
 * use this instead of a second query.
 */
export function toWholeLodgeHoldSpans(
  bookings: readonly WholeLodgeHoldCandidate[],
): WholeLodgeHoldSpan[] {
  const spans: WholeLodgeHoldSpan[] = [];
  for (const booking of bookings) {
    if (!isBlockingWholeLodgeHold(booking)) continue;
    // Same guard, same order as `buildWholeLodgeHoldIndex` in capacity.ts.
    if (!booking.checkIn || !booking.checkOut) continue;
    spans.push({
      bookingId: booking.id,
      lodgeId: booking.lodgeId ?? null,
      checkInKey: formatDateOnly(booking.checkIn),
      checkOutKey: formatDateOnly(booking.checkOut),
    });
  }
  return spans;
}

/**
 * Load the blocking whole-lodge holds overlapping a half-open date window.
 *
 * A dedicated query rather than a filter over the planner's own booking load,
 * on purpose: both planners restrict their booking loads by
 * `BED_ALLOCATABLE_BOOKING_STATUSES` and by "has at least one guest overlapping
 * the window", and a hold's blocking power depends on neither. A held booking
 * whose guest rows have not been entered yet still takes the lodge. Coupling
 * the block to those filters would let a hold vanish from the planners for
 * reasons the capacity engine does not recognise — the exact class of
 * under-reporting #2317 exists to remove.
 *
 * `toExclusive` is EXCLUSIVE, so callers pass the booking-shaped
 * `[checkIn, checkOut)` window they already hold.
 */
export async function findBlockingWholeLodgeHolds(input: {
  lodgeId?: string;
  from: Date;
  toExclusive: Date;
  db?: ExclusiveHoldDb;
}): Promise<WholeLodgeHoldSpan[]> {
  const db = input.db ?? prisma;
  if (input.from >= input.toExclusive) return [];

  const rows = await db.booking.findMany({
    where: {
      checkIn: { lt: input.toExclusive },
      checkOut: { gt: input.from },
      wholeLodgeHold: true,
      // The capacity engine's population, spread at top level exactly as
      // `getLodgeHeldNights` does — see the module note. Deliberately no
      // `deletedAt` clause and no bed-allocatable-status clause: matching the
      // engine is what makes "the planner never under-reports a held night"
      // true by construction rather than by inspection.
      ...capacityHoldingBookingFilter(),
      ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
    },
    select: {
      id: true,
      status: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      wholeLodgeHold: true,
      originBookingRequest: { select: { id: true } },
      adminCapacityHoldAt: true,
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
  });

  // The SQL filter and the in-memory predicate are the same rule; running the
  // predicate over the result keeps the two provably in step (and keeps a test
  // double that ignores `where` from fabricating a hold).
  return toWholeLodgeHoldSpans(rows);
}

/** Does this hold cover the night of `nightKey` (`YYYY-MM-DD`)? */
export function wholeLodgeHoldCoversNight(
  hold: Pick<WholeLodgeHoldSpan, "checkInKey" | "checkOutKey">,
  nightKey: string,
): boolean {
  return hold.checkInKey <= nightKey && nightKey < hold.checkOutKey;
}

/**
 * A ready-to-use `(lodgeId, nightKey) => boolean` closure: is that lodge's
 * whole bed stock taken by a hold on that night? Null-tolerant on either side,
 * mirroring `sameLodgeNullTolerant` — a hold with no lodge blocks every lodge
 * rather than none, which is the conservative direction.
 */
export function buildWholeLodgeHeldNightPredicate(
  holds: readonly WholeLodgeHoldSpan[],
): (lodgeId: string | null | undefined, nightKey: string) => boolean {
  if (holds.length === 0) return () => false;
  return (lodgeId, nightKey) =>
    holds.some(
      (hold) =>
        sameLodgeNullTolerant(hold.lodgeId, lodgeId) &&
        wholeLodgeHoldCoversNight(hold, nightKey),
    );
}

/** The room/bed shape the planner feed needs. Rooms carry their own lodge. */
export interface WholeLodgeHoldPlannerRoom {
  id: string;
  active: boolean;
  lodgeId?: string | null;
  beds: readonly { id: string; active: boolean }[];
}

/** An unattributed planner occupancy row — #1768 "unknown occupant" shape. */
export interface WholeLodgeHoldOccupiedBedNight {
  bedId: string;
  roomId: string;
  stayDate: string;
  bookingId: null;
  bookingGuestId: null;
}

/**
 * Expand blocking whole-lodge holds into planner `occupiedBedNights` rows —
 * every ACTIVE bed of the held lodge on every held night in `nights`, EXCEPT
 * the bed-nights a custodian holds.
 *
 * `bookingId`/`bookingGuestId` are null by construction (see the module note):
 * that is what makes the occupancy unattributed and non-displaceable. `ageTier`
 * is deliberately omitted, so the planner reads the occupant as an adult — the
 * conservative choice for the #1768 room-mix guard, and one that leaks nothing
 * about who the held group actually is.
 *
 * ## The custodian exclusion (`INV-CAP-035`, #2698)
 *
 * `custodianHolds` is REQUIRED rather than optional, and that is the point: a
 * caller that forgets it is a compile error rather than a hold quietly
 * re-claiming the custodian's bed. Both planners already load the identical
 * hold set on the identical window to feed
 * `custodianOccupiedBedNightsForPlanner`, so passing it costs no query.
 *
 * The decision it implements is the owner's, 9 Aug 2026: a whole-lodge hold
 * represents every bed of its lodge EXCEPT one a custodian holds that night.
 * Before it, the custodian's bed-night was emitted TWICE into
 * `occupiedBedNights` — once here and once by the custodian expansion — and
 * while the planner's `bedId:stayDate` keying made that harmless arithmetically,
 * "the same bed-night is claimed by two different occupants" is exactly the
 * double-held bed-night the rule forbids. The bed-night is still occupied after
 * the exclusion; it is occupied by the CUSTODIAN, once, which is who is
 * actually sleeping in it. Nothing about which beds are available to a third
 * booking changes, by design — the rule is about representation, not admission.
 *
 * The predicate is imported, never restated: `isCustodianHeldBedNight` in
 * `custodian-occupancy.ts` is its one home.
 *
 * Inactive rooms and inactive beds are skipped: they are not in the planner's
 * bed stock at all, so a row for one would be occupancy on a bed that cannot be
 * allocated either way.
 *
 * De-duplicated on `(bedId, night)`, so two overlapping holds on one lodge
 * contribute one row per bed-night rather than two.
 */
export function wholeLodgeHoldOccupiedBedNightsForPlanner(
  holds: readonly WholeLodgeHoldSpan[],
  rooms: readonly WholeLodgeHoldPlannerRoom[],
  nights: readonly Date[],
  custodianHolds: readonly CustodianBedHold[],
): WholeLodgeHoldOccupiedBedNight[] {
  if (holds.length === 0) return [];
  const isHeld = buildWholeLodgeHeldNightPredicate(holds);
  const rows: WholeLodgeHoldOccupiedBedNight[] = [];
  const seen = new Set<string>();

  for (const night of nights) {
    const nightKey = formatDateOnly(night);
    for (const room of rooms) {
      if (!room.active) continue;
      if (!isHeld(room.lodgeId ?? null, nightKey)) continue;
      for (const bed of room.beds) {
        if (!bed.active) continue;
        // INV-CAP-035: this bed-night is the custodian's, not the held group's.
        if (isCustodianHeldBedNight(custodianHolds, bed.id, nightKey)) continue;
        const key = `${bed.id}:${nightKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          bedId: bed.id,
          roomId: room.id,
          stayDate: nightKey,
          bookingId: null,
          bookingGuestId: null,
        });
      }
    }
  }
  return rows;
}
