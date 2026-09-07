/**
 * The shared write chokepoint every manual bed placement passes through
 * (#2688).
 *
 * One guest, one bed, one night: validate the pairing, decide whether it is a
 * shared-double second occupant, write the row, and repair the bed-night the
 * move vacated. Single-night, bulk, board-move and range assignment all funnel
 * through here, which is why the custodian-hold guard, the whole-lodge-hold
 * refusal (ADR-001) and the consent refusal (D-12, #2307) are enforced at this
 * level rather than once per caller.
 *
 * ## Locking precondition — the acquire is in another module now
 *
 * `allocateBedNightWithLocksHeld` and the two assertions it composes read and
 * write bed-nights, and what makes the custodian/whole-lodge guards non-racy is
 * the global `pg_advisory_xact_lock(1)` then `acquireLodgeCapacityLock` pair
 * (`INV-LOCK-002`). Neither lock is taken here. Before #2688 the acquire and
 * the funnel were the same file; now the acquire lives in
 * `bed-allocation-manual-writes.ts` and `bed-allocation-range-assign.ts`, so
 * the precondition has to be written down rather than seen. Every export in
 * this module except `resolveBedLodgeIdForLock` must be called with BOTH locks
 * already held, on the transaction client that holds them — which is what the
 * `WithLocksHeld` suffix means everywhere else in this family, and why the
 * funnel now carries it.
 *
 * `resolveBedLodgeIdForLock` is the deliberate exception: it derives the lodge
 * key and therefore runs OUTSIDE the transaction, before either lock exists.
 *
 * `custodian-write-path-contract.test.ts` machine-checks the order at each of
 * the five self-wrapped writers, so a caller that drops the lodge tier fails
 * CI rather than becoming a race nobody can see from here.
 */
import type { BedAllocation, BedType } from "@prisma/client";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import {
  BED_ALLOCATABLE_BOOKING_STATUSES,
  promoteOrphanedSecondOccupants,
} from "@/lib/bed-allocation-lifecycle";
import { isCapacityHoldingBookingStatus } from "@/lib/booking-status";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";
import { assertBedNightsFreeOfCustodianHold } from "@/lib/custodian-occupancy";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import { overlapsDateRange } from "@/lib/bed-allocation-date-range";

export async function assertGuestAndBedForAllocation(input: {
  bookingGuestId: string;
  bedId: string;
  db: BedAllocationDb;
  // ADR-001 short-circuit (#120/#2285): a whole-lodge-held booking owns NO
  // per-bed rows. Every manual write path refuses by default; the range path
  // (#2251) passes true so it can report the hold as its own refusal category
  // instead of a bare 409.
  reportWholeLodgeHold?: boolean;
}) {
  const [guest, bed] = await Promise.all([
    input.db.bookingGuest.findUnique({
      where: { id: input.bookingGuestId },
      include: {
        // Explicit night set (#713): a stay can be NON-CONTIGUOUS — 1-5 and
        // 8-10, with nothing on the 6th and 7th. Without this the manual paths
        // saw only stayStart..stayEnd and happily placed a guest on a gap night
        // the lifecycle then pruned again, so the bed looked taken until the
        // next reconcile quietly emptied it. guestIsStayingOn() prefers this set
        // whenever it is non-empty, exactly as the lifecycle's
        // getGuestNightDatesInRange does.
        nights: { select: { stayDate: true } },
        booking: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            lodgeId: true,
            // ADR-001 (#120/#2285): a held booking implicitly occupies every
            // bed, so it must never collect per-bed rows — the lifecycle now
            // prunes any it finds, which would silently undo a manual
            // placement. Refused here at the write chokepoint instead.
            wholeLodgeHold: true,
          },
        },
      },
    }),
    input.db.lodgeBed.findUnique({
      where: { id: input.bedId },
      include: { room: true },
    }),
  ]);

  if (!guest) {
    throw new BedAllocationAdminError("Guest not found", 404);
  }
  if (!bed || bed.active === false || bed.room.active === false) {
    throw new BedAllocationAdminError("Active bed not found", 404);
  }
  if (guest.booking.deletedAt) {
    throw new BedAllocationAdminError("Cannot allocate deleted booking", 409);
  }
  // ADR-001 (#120), write half of #2285: the lifecycle prunes every per-bed row
  // a held booking owns, so a manual placement here would be silently swept on
  // the next reconcile. Refuse it at the write chokepoint. The range path
  // (#2251) opts out of the throw to report it as its own category.
  if (guest.booking.wholeLodgeHold && !input.reportWholeLodgeHold) {
    throw new BedAllocationAdminError(
      "This booking holds the whole lodge for its nights, so it needs no per-bed allocation.",
      409,
    );
  }
  if (
    !BED_ALLOCATABLE_BOOKING_STATUSES.includes(
      guest.booking.status as (typeof BED_ALLOCATABLE_BOOKING_STATUSES)[number],
    )
  ) {
    throw new BedAllocationAdminError(
      "Booking status is not allocatable",
      409,
    );
  }
  // Owner decision D-12 (#2307), the WRITE half. Every read surface filters
  // unconsented member guests out with OPERATIONALLY_PRESENT_GUEST_WHERE, so an
  // officer never sees one in the awaiting-allocation queue — but the manual
  // paths take a bookingGuestId from the request, not from the queue, so a
  // pending guest's id supplied by hand (or left in a stale browser tab) would
  // still write bed rows here. Those rows are exactly what
  // `pruneAllocationsForBooking` sweeps on the next reconcile, so the officer's
  // work would quietly disappear and the bed would look free again.
  //
  // Refused at the write chokepoint for the same reason as the whole-lodge hold
  // above: it is the one place all three manual paths — single night, bulk, and
  // the #2251 range path — pass through. `consentStatus` comes back on the
  // `include` above and is read inside the caller's transaction, so it cannot be
  // a stale pre-transaction snapshot.
  if (!isOperationallyPresentConsent(guest.consentStatus)) {
    throw new BedAllocationAdminError(
      "This guest has not consented to being on this booking, so they cannot be given a bed yet.",
      409,
    );
  }
  // Lodge-scoping contract: a booking's bed allocations must belong to the
  // booking's lodge. Rows still missing a lodgeId (expand-release tolerance)
  // pass on either side.
  if (
    guest.booking.lodgeId &&
    bed.room.lodgeId &&
    guest.booking.lodgeId !== bed.room.lodgeId
  ) {
    throw new BedAllocationAdminError(
      "Bed belongs to a different lodge than the booking",
      409,
    );
  }

  return { guest, bed };
}

/**
 * Whether a guest actually stays on a night.
 *
 * Prefers the EXPLICIT night set when the caller loaded one and it is non-empty
 * (#713 non-contiguous stays), because stayStart..stayEnd is only an envelope:
 * a guest booked 1-5 and 8-10 has that envelope spanning the 6th and 7th, which
 * they are not booked on. Falls back to the envelope when no night rows were
 * selected or the guest has none — the pre-#713 behaviour, and the same rule the
 * lifecycle's getGuestNightDatesInRange applies.
 */
export function guestIsStayingOn(
  guest: { stayStart: Date; stayEnd: Date; nights?: { stayDate: Date }[] },
  stayDate: Date,
): boolean {
  if (guest.nights && guest.nights.length > 0) {
    const wanted = formatDateOnly(stayDate);
    return guest.nights.some((night) => formatDateOnly(night.stayDate) === wanted);
  }
  return overlapsDateRange(guest.stayStart, guest.stayEnd, {
    from: stayDate,
    to: addDaysDateOnly(stayDate, 1),
    fromDate: formatDateOnly(stayDate),
    toDate: formatDateOnly(addDaysDateOnly(stayDate, 1)),
  });
}

export async function assertManualAllocationInput(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: Date;
  db: BedAllocationDb;
}) {
  const { guest, bed } = await assertGuestAndBedForAllocation(input);

  if (!guestIsStayingOn(guest, input.stayDate)) {
    throw new BedAllocationAdminError(
      "Guest is not staying on the selected date",
      400,
    );
  }

  return { guest, bed };
}

/**
 * Decide whether allocating `guest` to `bed` on `stayDate` creates a SECOND
 * occupant on a shared DOUBLE bed (#1701), enforcing every sharing rule, or a
 * normal (primary) allocation. Returns the `isSecondOccupant` flag to persist,
 * or throws a BedAllocationAdminError when the bed-night is already taken and
 * sharing is not permitted.
 *
 * Sharing is allowed only when the bed is a DOUBLE that currently holds exactly
 * one PRIMARY occupant (a different guest), AND:
 *   - that occupant's booking holds capacity (a capacity-holding booking is
 *     never wholly-displaceable, so auto-allocation can never move the primary
 *     out from under the partner and pair the second occupant with an unrelated
 *     booking — the #1701 displacement-safety pin);
 *   - both guests are linked to a member; and
 *   - mayShareDoubleBed() says the two members may share (a CONFIRMED partner
 *     link between two adults, #1744 — the single source of truth for the
 *     who-may-share rule).
 *
 * The composite @@unique([bedId, stayDate, isSecondOccupant]) and the non-double
 * partial index are the DB backstop against races and non-double beds.
 */
async function resolveSecondOccupant(input: {
  bed: { id: string; bedType: BedType };
  guest: { id: string; memberId: string | null };
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<{ isSecondOccupant: boolean }> {
  const { bed, guest, stayDate, db } = input;

  const occupants = await db.bedAllocation.findMany({
    where: {
      bedId: bed.id,
      stayDate,
      bookingGuestId: { not: guest.id },
    },
    select: {
      isSecondOccupant: true,
      bookingGuest: {
        select: {
          memberId: true,
          booking: { select: { status: true } },
        },
      },
    },
  });

  // Free bed-night → normal primary allocation. Reading the sole occupant is
  // what says the night is taken and by whom, and the rest of this function
  // works from that occupant rather than from the count (#2800).
  const [primary, ...extraOccupants] = occupants;
  if (primary === undefined) {
    return { isSecondOccupant: false };
  }

  if (bed.bedType !== "DOUBLE") {
    throw new BedAllocationAdminError(
      "That bed is already allocated for the selected date.",
      409,
    );
  }
  if (extraOccupants.length > 0 || occupants.some((row) => row.isSecondOccupant)) {
    throw new BedAllocationAdminError(
      "This double bed already has two occupants for the selected date.",
      409,
    );
  }

  if (!isCapacityHoldingBookingStatus(primary.bookingGuest.booking.status)) {
    throw new BedAllocationAdminError(
      "A partner can only be added to a confirmed booking's double bed.",
      409,
    );
  }
  if (!guest.memberId || !primary.bookingGuest.memberId) {
    throw new BedAllocationAdminError(
      "Both guests must be linked to a member to share a double bed.",
      409,
    );
  }
  const eligible = await mayShareDoubleBed(
    primary.bookingGuest.memberId,
    guest.memberId,
    db,
  );
  if (!eligible) {
    throw new BedAllocationAdminError(
      "Only two adults with a confirmed partner relationship may share a double bed.",
      409,
    );
  }

  return { isSecondOccupant: true };
}

// Only a genuine move of a PRIMARY off its bed can strand a partner on the OLD
// bed-night, so promote the surviving second occupant there (#1750). Skips when:
//   - previous == null: a fresh CREATE, no old bed-night to repair;
//   - previous.isSecondOccupant: moving a second occupant leaves the primary in
//     place, so nothing is orphaned;
//   - previous.bedId === newBedId: a same-bed re-upsert can't orphan a partner.
//     If the double is shared, resolveSecondOccupant 409s before the upsert (the
//     partner left on the bed reads as a second occupant → "already has two
//     occupants"), so this code is never reached; if it isn't shared there is no
//     partner to strand. Either way the old bed-night is not vacated.
async function promoteVacatedOldBedNight(input: {
  previous: { bedId: string; isSecondOccupant: boolean } | null;
  newBedId: string;
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<BedAllocation | null> {
  const { previous, newBedId, stayDate, db } = input;
  if (!previous || previous.isSecondOccupant || previous.bedId === newBedId) {
    return null;
  }
  const [promoted] = await promoteOrphanedSecondOccupants(db, [
    { bedId: previous.bedId, stayDate },
  ]);
  return promoted ?? null;
}

// Allocate one guest-night to a bed via upsert, promoting any partner stranded
// on the guest's OLD bed-night by the move (#1750). Reads the pre-move row,
// upserts, then repairs the old bed-night — the caller wraps this in a
// transaction so the three writes are atomic and no transient
// @@unique([bedId, stayDate, isSecondOccupant]) collision can occur (the move
// vacates the old bed-night before the partner is flipped). Throws P2002 on a
// taken bed-night for the caller to classify (409 vs bulk conflict).
export async function allocateBedNightWithLocksHeld(input: {
  guest: { id: string; bookingId: string; memberId: string | null };
  bed: { id: string; roomId: string; bedType: BedType };
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<{ allocation: BedAllocation; promotedPartner: BedAllocation | null }> {
  const { guest, bed, stayDate, db } = input;

  // Custodian occupancy (#2286), THE manual-placement chokepoint. Every manual
  // placement — single night, bulk drop, board move — funnels through this
  // upsert, so one guard call covers all of them. The callers hold the
  // per-lodge advisory lock, so a hold created concurrently either commits
  // before this read (and is seen here) or waits behind the allocation.
  //
  // Thrown as CustodianHoldConflictError, not BedAllocationAdminError: each
  // caller maps it to its own refusal shape (a 409 for the single-night path,
  // a per-night CUSTODIAN_HOLD conflict entry for the bulk path).
  await assertBedNightsFreeOfCustodianHold({
    bedId: bed.id,
    stayDates: [stayDate],
    db,
  });

  const { isSecondOccupant } = await resolveSecondOccupant({
    bed,
    guest,
    stayDate,
    db,
  });

  const previous = await db.bedAllocation.findUnique({
    where: {
      bookingGuestId_stayDate: { bookingGuestId: guest.id, stayDate },
    },
    select: { bedId: true, isSecondOccupant: true },
  });

  const allocation = await db.bedAllocation.upsert({
    where: {
      bookingGuestId_stayDate: { bookingGuestId: guest.id, stayDate },
    },
    create: {
      bookingId: guest.bookingId,
      bookingGuestId: guest.id,
      roomId: bed.roomId,
      bedId: bed.id,
      stayDate,
      source: "MANUAL",
      isSecondOccupant,
      bedType: bed.bedType,
    },
    update: {
      roomId: bed.roomId,
      bedId: bed.id,
      source: "MANUAL",
      approvedAt: null,
      approvedByMemberId: null,
      isSecondOccupant,
      bedType: bed.bedType,
    },
  });

  const promotedPartner = await promoteVacatedOldBedNight({
    previous,
    newBedId: bed.id,
    stayDate,
    db,
  });

  return { allocation, promotedPartner };
}

/**
 * Resolve the lodge a bed belongs to, purely to derive the advisory-lock key
 * (#2286). Read OUTSIDE the transaction so `acquireLodgeCapacityLock` can be
 * the FIRST statement inside it — one xact-scoped lock, always taken first, is
 * what keeps this deadlock-free against every other capacity writer.
 *
 * A missing bed returns null and the caller skips the lock: the authoritative
 * validation inside the transaction answers 404 for it anyway, and locking a
 * lodge we could not identify would buy nothing.
 */
export async function resolveBedLodgeIdForLock(
  bedId: string,
  db: BedAllocationDb,
): Promise<string | null> {
  const bed = await db.lodgeBed.findUnique({
    where: { id: bedId },
    select: { room: { select: { lodgeId: true } } },
  });
  return bed?.room.lodgeId ?? null;
}
