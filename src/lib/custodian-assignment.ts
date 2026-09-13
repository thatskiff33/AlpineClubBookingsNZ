import type { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import {
  computeNightOccupancy,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import {
  custodianHeldNightsForBed,
  findCustodianBedHolds,
  isCustodianHeldBedNight,
} from "@/lib/custodian-occupancy";
import {
  findBlockingWholeLodgeHolds,
  wholeLodgeHoldCoversNight,
} from "@/lib/exclusive-hold-occupancy";
import {
  eachDateOnlyInRange,
  addDaysDateOnly,
  formatDateOnly,
} from "@/lib/date-only";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

/**
 * Write-side validation for a custodian bed hold (#2286) — the other half of
 * `custodian-occupancy.ts`, which is read-side only.
 *
 * Kept out of that module deliberately: this one needs `capacity.ts` and
 * `lodge-capacity.ts`, and `capacity.ts` imports `custodian-occupancy.ts`.
 * Splitting the write side out is what keeps that a straight line rather than a
 * cycle.
 *
 * Every function here is designed to run INSIDE the caller's transaction, after
 * `acquireLodgeCapacityLock` — a custodian hold is a capacity-mutating write and
 * must serialize with booking admission and with the allocation chokepoints.
 */

type CustodianAssignmentDb = typeof prisma | Prisma.TransactionClient;

/** A night the hold would push past the lodge's ceiling. */
export interface CustodianOverCapacityNight {
  date: string;
  occupiedBeds: number;
  capacity: number;
}

/**
 * A live booking over those nights that the arithmetic above does NOT count
 * (#2286 review M5), following the #177 override-settle precedent.
 *
 * `occupiedBeds` is built from `capacityHoldingBookingFilter()`, so an overridden
 * PAYMENT_PENDING booking — which the settlement carve-out will later admit onto
 * exactly these nights — contributes nothing to the number the admin is asked to
 * confirm. Naming it makes the confirmation honest: the ceiling may be breached
 * by more than the figure shown. Informational only; it never refuses.
 */
export interface CustodianOverCapacityBooking {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
}

export class CustodianBedHoldError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Machine-readable discriminator for the admin UI. */
    readonly code:
      | "BED_NOT_FOUND"
      | "BED_WRONG_LODGE"
      | "BED_HELD_BY_ANOTHER_CUSTODIAN"
      | "BED_HAS_ALLOCATIONS"
      | "MODULE_DISABLED" = "BED_NOT_FOUND",
    /** The offending nights, when the refusal is per night. */
    readonly nights: string[] = [],
  ) {
    super(message);
    this.name = "CustodianBedHoldError";
  }
}

/**
 * Warn-and-confirm signal, following the #1668 over-capacity precedent: holding
 * this bed pushes at least one night past the lodge ceiling. The admin may
 * proceed by re-sending with `confirmOverCapacity: true`.
 *
 * Deliberately NOT reusing `overCapacityNights()`: that helper is only valid
 * over a `checkCapacityForGuestRanges` result (its `availableBeds` already bakes
 * in the proposed guests). A custodian hold proposes no guests, so this flow
 * computes its own small per-night list instead — the same pattern and error
 * shape, not the same helper.
 */
export class CustodianOverCapacityConfirmationRequiredError extends Error {
  readonly status = 409;
  readonly code = "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED";
  constructor(
    readonly nightDetails: CustodianOverCapacityNight[],
    /**
     * Live bookings over those nights that `nightDetails` does not count (#177
     * shape, #2286 review M5). Empty in the ordinary case.
     */
    readonly nonHoldingBookings: CustodianOverCapacityBooking[] = [],
  ) {
    super(
      "Holding that bed puts the lodge over capacity on at least one night. Confirm to proceed.",
    );
    this.name = "CustodianOverCapacityConfirmationRequiredError";
  }
}

/**
 * One existing whole-lodge hold a custodian bed hold would narrow, and the
 * nights on which it would (#2698).
 *
 * Deliberately carries the booking ID and the dates and NOTHING ELSE: the
 * officer is being asked about bed-nights, not about who is staying, and this
 * shape reaches an API response, an audit row and a screen. `INV-PRIV` — no
 * member name, no guest count, no party data (the exclusive-hold route records
 * overlapping booking ids the same way and for the same reason).
 */
export interface WholeLodgeHoldAmendment {
  /** The holding booking whose represented bed set would narrow. */
  bookingId: string;
  /** Sorted `YYYY-MM-DD` nights this bed would leave that hold's set. */
  nights: string[];
}

/**
 * The ordering case, refused pending an explicit officer choice (#2698, owner
 * decision 9 Aug 2026).
 *
 * A custodian bed hold created or changed over nights an EXISTING whole-lodge
 * hold already covers narrows that hold's represented bed set (`INV-CAP-038`).
 * That is somebody else's sole-occupancy booking, so it is not rewritten
 * silently: the write is refused, the officer is shown which nights and which
 * holds, and only an explicit `amendOverlappingHolds` re-send goes through — as
 * ONE transaction, so accept writes both facts or neither and decline writes
 * nothing at all.
 *
 * The reverse direction raises nothing: setting a whole-lodge hold over nights
 * a custodian already holds is correct by construction, because the exclusion is
 * derived at read time rather than stored on the hold.
 */
export class CustodianOverlapsWholeLodgeHoldError extends Error {
  readonly status = 409;
  readonly code = "CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD";
  constructor(
    /** The holds that would narrow, with the nights each would lose. */
    readonly amendments: WholeLodgeHoldAmendment[],
    /** Every affected night, de-duplicated and sorted, for a one-line message. */
    readonly nights: string[],
  ) {
    super(
      "The lodge is exclusively held for another booking on at least one of those nights. Holding this bed takes it out of that booking's sole occupancy — accept the amendment to do both together, or cancel and neither changes.",
    );
    this.name = "CustodianOverlapsWholeLodgeHoldError";
  }
}

/** Every night a `startDate..endDate` (inclusive) assignment covers. */
export function custodianAssignmentNights(
  startDate: Date,
  endDate: Date,
): Date[] {
  return eachDateOnlyInRange(startDate, addDaysDateOnly(endDate, 1));
}

/**
 * Validate an optional bed hold for a hut-leader assignment.
 *
 * Runs inside the caller's locked transaction. Throws on every hard refusal and
 * on the confirmable over-capacity signal; returns quietly when the hold is
 * fine (or when there is no bed, which is the pre-#2286 role-only case and is
 * always fine).
 */
export async function validateCustodianBedHold(input: {
  bedId: string | null;
  lodgeId: string;
  /** Inclusive first covered date. */
  startDate: Date;
  /** Inclusive last covered date. */
  endDate: Date;
  /** Present when editing, so the assignment does not conflict with itself. */
  assignmentId?: string;
  /** #1668-style explicit override of the over-capacity warning. */
  confirmOverCapacity?: boolean;
  db: CustodianAssignmentDb;
}): Promise<void> {
  const { bedId, lodgeId, startDate, endDate, db } = input;
  // No bed = role only = exactly the behaviour that existed before #2286. Every
  // row the auto-assign cron creates lands here.
  if (!bedId) return;

  const nights = custodianAssignmentNights(startDate, endDate);
  if (nights.length === 0) return;
  const toExclusive = addDaysDateOnly(endDate, 1);

  const bed = await db.lodgeBed.findUnique({
    where: { id: bedId },
    select: {
      id: true,
      name: true,
      active: true,
      room: { select: { id: true, name: true, active: true, lodgeId: true } },
    },
  });
  if (!bed || !bed.active || !bed.room.active) {
    throw new CustodianBedHoldError(
      "That bed was not found, or it (or its room) is not active.",
      404,
      "BED_NOT_FOUND",
    );
  }
  if (bed.room.lodgeId !== lodgeId) {
    // Also the refusal an admin hits when they try to move an assignment to
    // another lodge without clearing the bed first — the message says so.
    throw new CustodianBedHoldError(
      "That bed belongs to a different lodge. Clear the bed before changing the lodge, then pick a bed at the new lodge.",
      400,
      "BED_WRONG_LODGE",
    );
  }

  // Another custodian on the SAME bed on any covered night. The one-day
  // handover overlap assignments already allow is fine — but only on different
  // beds; two people cannot sleep in one bed on handover night.
  const clashingNights = await custodianHeldNightsForBed({
    bedId,
    stayDates: nights,
    excludeAssignmentId: input.assignmentId,
    db,
  });
  if (clashingNights.length > 0) {
    throw new CustodianBedHoldError(
      `That bed is already held by another hut-leader assignment on ${clashingNights.join(", ")}. A handover overlap is allowed, but only on different beds.`,
      409,
      "BED_HELD_BY_ANOTHER_CUSTODIAN",
      clashingNights,
    );
  }

  // Existing guest allocations on the bed inside the range: a HARD refusal, not
  // an eviction. Displacing a guest a human already placed is not this form's
  // decision to make — the admin clears those nights on the board first.
  const allocations = await db.bedAllocation.findMany({
    where: { bedId, stayDate: { gte: startDate, lte: endDate } },
    select: { stayDate: true },
    orderBy: { stayDate: "asc" },
  });
  if (allocations.length > 0) {
    const dates = [
      ...new Set(allocations.map((row) => formatDateOnly(row.stayDate))),
    ];
    throw new CustodianBedHoldError(
      `That bed already has guests allocated on ${dates.join(", ")}. Clear those nights on the bed allocation page first.`,
      409,
      "BED_HAS_ALLOCATIONS",
      dates,
    );
  }

  if (input.confirmOverCapacity) return;

  // Over-capacity warn-and-confirm (#1668 precedent). Holding a bed removes it
  // from the bookable pool, so on an already-full night the lodge tips over its
  // ceiling. That is legitimate — the custodian is genuinely sleeping there —
  // but the admin should see it, not discover it later.
  const capacity = await getLodgeCapacity(lodgeId, db);
  if (capacity <= 0) return;

  // THE occupancy calculation (#2681), shared with the admission engines and
  // the capacity-warnings cron, so this warning cannot drift behind them. It
  // already counts OTHER custodians already holding beds on these nights —
  // three custodians on one night is three beds, so the arithmetic is a count —
  // and `excludeCustodianAssignmentId` drops this assignment's own hold so the
  // `+ 1` below adds it exactly once. Before #2681 this loop was its own copy
  // of the calculation and did not count provisional policy-exception
  // reservations (#2525), so a bed a held request had reserved was invisible
  // and the admin was not warned that the hold tips the lodge over.
  //
  // The whole-lodge hold flag is deliberately NOT pinned here, and since #2698
  // the reason is an arithmetic fact rather than a bare policy. A hold's
  // represented bed set EXCLUDES the bed-nights a custodian holds
  // (INV-CAP-038), so holding a bed on an exclusively held night takes that bed
  // out of the held group's set and adds it to the custodian's: the lodge's
  // occupancy is unchanged and there is nothing over-capacity about it. Pinning
  // would turn this advisory count into a hard "lodge is full" on every held
  // night and refuse a hut leader a bed the club fully intends them to occupy.
  //
  // The gap this comment used to state — that creating a custodian hold over an
  // exclusively held night raised no warning at all — was the ORDERING case,
  // and it is closed, but not here. It is not an over-capacity question, so it
  // does not belong in an over-capacity loop: narrowing somebody else's hold is
  // a decision for the officer, taken through
  // `findWholeLodgeHoldAmendments` below and refused with
  // `CustodianOverlapsWholeLodgeHoldError` until they accept it (#2698, owner
  // decision 9 Aug 2026). The reverse direction needs no prompt at all — a hold
  // set over an existing custodian night is correct by construction, because
  // the exclusion is derived at read time.
  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: startDate,
    toExclusive,
    nights,
    excludeCustodianAssignmentId: input.assignmentId,
    db,
  });

  const overCapacity: CustodianOverCapacityNight[] = [];
  for (const night of nights) {
    // + 1 for the hold being created/edited.
    const occupiedBeds = occupancy(night).occupiedBeds + 1;
    if (occupiedBeds > capacity) {
      overCapacity.push({ date: formatDateOnly(night), occupiedBeds, capacity });
    }
  }
  if (overCapacity.length > 0) {
    // The figures above come from the capacity-HOLDING population only, so an
    // overridden non-holding booking (chiefly PAYMENT_PENDING, #1764/#1771) is
    // invisible to them even though the settlement carve-out will admit it onto
    // exactly these nights. Mirror #177's companion query so the confirmation
    // names it: the admin is being asked to accept an over-capacity night, and
    // must be told the true figure could be higher still. Read only when we are
    // about to ask — an ordinary within-capacity hold pays nothing for this.
    const nonHoldingBookings = await findOverlappingOverriddenNonHoldingBookings(
      db,
      { lodgeId, checkIn: startDate, checkOut: toExclusive },
    );
    throw new CustodianOverCapacityConfirmationRequiredError(
      overCapacity,
      nonHoldingBookings.map((booking) => ({
        id: booking.id,
        memberName: booking.memberName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guestCount,
        status: booking.status,
      })),
    );
  }
}

/**
 * Which existing whole-lodge holds this custodian bed hold would narrow
 * (#2698, `INV-CAP-038`) — the ordering case, and nothing else.
 *
 * Runs inside the caller's locked transaction, on the caller's client, so the
 * hold set it reads is the one the write commits against. The routes call it
 * AFTER `validateCustodianBedHold`, so a hold that is going to be refused
 * outright never raises an amendment question the officer would then have to
 * un-answer.
 *
 * ## Night semantics
 *
 * Custodian ranges are inclusive-inclusive covered DAYS; a whole-lodge hold's
 * nights are the half-open booking envelope `[checkIn, checkOut)`, because a
 * `checkOut` is a departure morning. Both conventions are applied by their own
 * module's predicate — `custodianAssignmentNights` here,
 * `wholeLodgeHoldCoversNight` there — rather than converted by hand, so a hold
 * departing on the morning of day D does not claim the night of D and a
 * custodian holding the bed that night is not reported as narrowing it.
 *
 * ## Why `excludeAssignmentId` matters, and is not merely an optimisation
 *
 * "New and amended holds only" (owner decision, 9 Aug 2026). A bed-night THIS
 * assignment already holds left the overlapping hold's represented set when it
 * was first created; re-asking about it on every unrelated edit — a date
 * tweak, a lodge move, a PIN reset that round-trips the form — would turn one
 * decided amendment into a prompt the officer has to re-accept for ever, and
 * would audit a second acceptance for a change that moved nothing. So the
 * nights already held by this same assignment on this same bed are subtracted,
 * through the one predicate (`isCustodianHeldBedNight`) rather than by
 * re-deriving coverage here.
 *
 * Returns an empty array when there is nothing to amend, which is the ordinary
 * case and costs one indexed query.
 */
export async function findWholeLodgeHoldAmendments(input: {
  bedId: string;
  lodgeId: string;
  /** Inclusive first covered date. */
  startDate: Date;
  /** Inclusive last covered date. */
  endDate: Date;
  /** Present when editing, so nights this assignment already holds do not re-prompt. */
  assignmentId?: string;
  db: CustodianAssignmentDb;
}): Promise<WholeLodgeHoldAmendment[]> {
  const nights = custodianAssignmentNights(input.startDate, input.endDate);
  if (nights.length === 0) return [];
  const toExclusive = addDaysDateOnly(input.endDate, 1);

  const holds = await findBlockingWholeLodgeHolds({
    lodgeId: input.lodgeId,
    from: input.startDate,
    toExclusive,
    db: input.db,
  });
  if (holds.length === 0) return [];

  // What this bed already takes out of those holds' sets — this assignment's
  // own coverage only. Another custodian's hold on the same bed is impossible
  // on a night this one covers (validateCustodianBedHold refuses it), so the
  // filter is exact rather than approximate.
  const ownHolds = input.assignmentId
    ? (
        await findCustodianBedHolds({
          bedIds: [input.bedId],
          from: input.startDate,
          toExclusive,
          db: input.db,
        })
      ).filter((hold) => hold.assignmentId === input.assignmentId)
    : [];

  const amendments: WholeLodgeHoldAmendment[] = [];
  for (const hold of holds) {
    const affected: string[] = [];
    for (const night of nights) {
      const nightKey = formatDateOnly(night);
      if (!wholeLodgeHoldCoversNight(hold, nightKey)) continue;
      // Already outside this hold's set, so nothing changes tonight.
      if (isCustodianHeldBedNight(ownHolds, input.bedId, nightKey)) continue;
      affected.push(nightKey);
    }
    if (affected.length > 0) {
      amendments.push({ bookingId: hold.bookingId, nights: affected });
    }
  }
  return amendments;
}

/** Every affected night across a set of amendments, de-duplicated and sorted. */
export function wholeLodgeHoldAmendmentNights(
  amendments: readonly WholeLodgeHoldAmendment[],
): string[] {
  return [
    ...new Set(amendments.flatMap((amendment) => amendment.nights)),
  ].sort();
}

/**
 * Record the officer's explicit acceptance that a custodian bed hold narrows
 * one or more existing whole-lodge holds (#2698).
 *
 * **This audit row IS the amendment.** Coverage is derived at read time — the
 * hold's represented bed set is computed from the live custodian holds every
 * time anything asks (`INV-CAP-038`) — so there is no bed set on the hold row
 * to edit and no column to write. What the decision requires to be durable and
 * atomic is therefore the officer's acceptance itself, and it is written on the
 * SAME transaction as the custodian assignment that caused it: accept commits
 * both, decline or failure commits neither.
 *
 * Category `booking`, matching the exclusive-hold writer
 * (`booking.exclusiveHold.set/cleared`) that owns the other half of this
 * conversation — docs/guides/audit-log.md's `booking` row is "Member-facing and
 * automatic booking events, and the booking rules themselves", and what
 * narrowed here is a BOOKING's sole occupancy, not the lodge roster. The
 * roster half of the same action is audited separately under `lodge`, so each
 * reader's Category filter finds the half that belongs to them.
 *
 * `INV-PRIV`: booking IDs and dates only. No member name, no guest count and
 * no party data — a hold can begin life as a public school request, and the
 * officer is deciding about bed-nights.
 */
export async function recordWholeLodgeHoldAmendment(
  db: CustodianAssignmentDb,
  input: {
    actorMemberId: string;
    assignmentId: string;
    lodgeId: string;
    bedId: string;
    amendments: readonly WholeLodgeHoldAmendment[];
    requestId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  const nights = wholeLodgeHoldAmendmentNights(input.amendments);
  await createAuditLog(
    {
      action: "booking.wholeLodgeHold.custodianAmended",
      memberId: input.actorMemberId,
      actorMemberId: input.actorMemberId,
      targetId: input.assignmentId,
      entityType: "HutLeaderAssignment",
      entityId: input.assignmentId,
      category: "booking",
      severity: "important",
      outcome: "success",
      summary: "Whole-lodge hold narrowed for a custodian bed",
      details:
        "An officer accepted that holding a bed for a hut leader takes that bed out of an existing whole-lodge hold's sole occupancy on the nights listed. The holding booking's nights, price and every other booking on the lodge are unchanged.",
      metadata: {
        lodgeId: input.lodgeId,
        bedId: input.bedId,
        nights,
        amendedBookingIds: input.amendments.map(
          (amendment) => amendment.bookingId,
        ),
        amendments: input.amendments.map((amendment) => ({
          bookingId: amendment.bookingId,
          nights: amendment.nights,
        })),
      },
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
}

/**
 * Per-bed availability for the Hut Leaders bed picker, over the assignment's
 * own inclusive night range.
 *
 * Every active bed at the lodge is returned with the reason it cannot be picked
 * (if any), rather than filtering the unavailable ones out: an admin who cannot
 * see why "Bunk 3" is missing has no way to fix it.
 */
export interface CustodianBedOption {
  bedId: string;
  bedName: string;
  bedType: string;
  roomId: string;
  roomName: string;
  available: boolean;
  /** Nights blocked by an existing guest allocation. */
  allocatedNights: string[];
  /** Nights blocked by another custodian's hold on this same bed. */
  custodianHeldNights: string[];
  /** Set when THIS assignment already holds the bed (so it stays selectable). */
  heldByThisAssignment: boolean;
}

export async function listCustodianBedOptions(input: {
  lodgeId: string;
  startDate: Date;
  endDate: Date;
  assignmentId?: string;
  db?: CustodianAssignmentDb;
}): Promise<CustodianBedOption[]> {
  const db = input.db ?? prisma;
  const nights = custodianAssignmentNights(input.startDate, input.endDate);
  const nightKeys = new Set(nights.map(formatDateOnly));
  const toExclusive = addDaysDateOnly(input.endDate, 1);

  const rooms = await db.lodgeRoom.findMany({
    where: { active: true, ...lodgeNullTolerantScope(input.lodgeId) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      beds: {
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, bedType: true },
      },
    },
  });

  const bedIds = rooms.flatMap((room) => room.beds.map((bed) => bed.id));
  if (bedIds.length === 0) return [];

  const [allocations, holds] = await Promise.all([
    db.bedAllocation.findMany({
      where: {
        bedId: { in: bedIds },
        stayDate: { gte: input.startDate, lte: input.endDate },
      },
      select: { bedId: true, stayDate: true },
    }),
    findCustodianBedHolds({
      lodgeId: input.lodgeId,
      from: input.startDate,
      toExclusive,
      db,
    }),
  ]);

  const allocatedByBed = new Map<string, Set<string>>();
  for (const row of allocations) {
    const key = formatDateOnly(row.stayDate);
    if (!nightKeys.has(key)) continue;
    const set = allocatedByBed.get(row.bedId) ?? new Set<string>();
    set.add(key);
    allocatedByBed.set(row.bedId, set);
  }

  const heldByBed = new Map<string, Set<string>>();
  const ownBedIds = new Set<string>();
  for (const hold of holds) {
    if (input.assignmentId && hold.assignmentId === input.assignmentId) {
      ownBedIds.add(hold.bedId);
      continue;
    }
    const set = heldByBed.get(hold.bedId) ?? new Set<string>();
    for (const key of nightKeys) {
      if (hold.startDate <= key && key <= hold.endDate) set.add(key);
    }
    if (set.size > 0) heldByBed.set(hold.bedId, set);
  }

  const options: CustodianBedOption[] = [];
  for (const room of rooms) {
    for (const bed of room.beds) {
      const allocatedNights = [...(allocatedByBed.get(bed.id) ?? [])].sort();
      const custodianHeldNights = [...(heldByBed.get(bed.id) ?? [])].sort();
      options.push({
        bedId: bed.id,
        bedName: bed.name,
        bedType: bed.bedType,
        roomId: room.id,
        roomName: room.name,
        available:
          allocatedNights.length === 0 && custodianHeldNights.length === 0,
        allocatedNights,
        custodianHeldNights,
        heldByThisAssignment: ownBedIds.has(bed.id),
      });
    }
  }
  return options;
}
