/**
 * Range assignment: "put this guest in this bed from X to Y" (#2251, extracted
 * #2688).
 *
 * Parses and bounds the range before any transaction opens, classifies every
 * night into exactly one refusal category, then writes all-or-nothing (or
 * exactly the night list the admin consented to) under global -> lodge locks
 * with one audit entry. The shapes it reports are
 * `bed-allocation-range-report.ts`; the record it writes is
 * `bed-allocation-range-audit.ts`.
 */
import { Prisma, type BedType } from "@prisma/client";
import {
  countNightsDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { promoteOrphanedSecondOccupantsBatch } from "@/lib/bed-allocation-lifecycle";
import {
  bookingHoldsCapacity,
  isCapacityHoldingBookingStatus,
} from "@/lib/booking-status";
import { mayShareDoubleBedWith } from "@/lib/double-bed-sharing";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { custodianHeldNightsForBed } from "@/lib/custodian-occupancy";
import { prisma } from "@/lib/prisma";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import {
  guestName,
  memberName,
} from "@/lib/bed-allocation-display-names";
import {
  assertGuestAndBedForAllocation,
  guestIsStayingOn,
  resolveBedLodgeIdForLock,
} from "@/lib/bed-allocation-placement";
import {
  MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS,
  type AssignBedRangeResult,
  type BedRangeRefusal,
  type ParsedBedAssignRange,
} from "@/lib/bed-allocation-range-report";
import { recordRangeAssignAudit } from "@/lib/bed-allocation-range-audit";

/*
 * Range assignment (#2251)
 * ------------------------
 * "Put this guest in this bed from X to Y" for a stay of ANY length, written
 * all-or-nothing in one transaction with ONE audit entry (owner decision,
 * 26 Jul 2026) — the audit row is written INSIDE that transaction, so rows and
 * record commit or roll back together. There is deliberately NO dry-run/preview
 * endpoint: the assign is attempted, and if any night is blocked NOTHING is
 * written and the refusal itself carries the evidence. The admin's second action
 * sends back the EXPLICIT night list it was shown (`nights`); the server writes
 * exactly that set or refuses it with a fresh report. A partial result is
 * reachable only because a human chose those nights, never as a silent default,
 * and never as a set the server re-derived behind them.
 *
 * The three blocker categories are kept distinct (never merged into "skipped"):
 *   - EXCLUSIVE_HOLD  — the guest's OWN booking holds the whole lodge (ADR-001):
 *                       a held booking owns no per-bed rows at all, so this is
 *                       structural, not a clash, and it blocks the whole range.
 *                       ANOTHER booking's hold is deliberately NOT a blocker
 *                       here: ADR-001's short-circuit is scoped to the held
 *                       booking's own guests, the planner and every other
 *                       allocation path still place ordinary bookings over an
 *                       overlapping hold, and the board surfaces such a hold as
 *                       a banner/`overlapsExclusiveHold` badge rather than a
 *                       refusal. This endpoint must not invent a stricter rule
 *                       than the domain enforces anywhere else (#2251 review).
 *   - GUEST_NOT_BOOKED — a BAD REQUEST, not a conflict: the range or the guest is
 *                       wrong. Never silently skipped, because skipping hides the
 *                       mistake. Includes a GAP night in a non-contiguous stay
 *                       (#713), which the lifecycle would prune again anyway.
 *   - BED_TAKEN       — a genuine clash; the occupying guest is named, and a
 *                       provisional (non-capacity-holding) occupant still counts
 *                       as a conflict so nothing is silently overwritten.
 * One category per night, RESOLVED in that precedence order, so the report is
 * unambiguous. The dialog DISPLAYS them in a different order (most actionable
 * first: BED_TAKEN, GUEST_NOT_BOOKED, EXCLUSIVE_HOLD) — resolution precedence
 * and display order are deliberately independent.
 *
 * Range assignments AUTO-APPROVE (owner decision, 28 Jul 2026): rows land with
 * approvedAt/approvedByMemberId stamped rather than as drafts. That is what
 * makes the FIRST range assign flip isBookingBedAllocationLocked for the
 * booking, locking the member out of editing their requested room (#776) — the
 * dialog says so before the admin commits. Single-night board placements are
 * deliberately NOT auto-approved: draft-vs-approved remains the domain's
 * suggestion-vs-confirmation distinction.
 */

/**
 * Validate and materialise a requested range — called BEFORE any transaction is
 * opened, so a malformed or absurd range never holds a database connection.
 *
 * The night cap is checked ARITHMETICALLY first (#2251 review): enumerating
 * "2026-06-01 → 9999-06-01" to discover it is too long would build nearly three
 * million Date objects before the refusal, which is a denial of service handed
 * to any admin with a slipped keystroke.
 */
function parseBedAssignRange(input: {
  from: string;
  to: string;
}): ParsedBedAssignRange {
  if (!isDateOnlyString(input.from)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }
  if (!isDateOnlyString(input.to)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const from = parseDateOnly(input.from);
  const to = parseDateOnly(input.to);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nightCount = countNightsDateOnly(from, to);
  if (nightCount > MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS) {
    // Refuse, never truncate (#2251 requirement 4): shortening the request
    // silently would write a different assignment from the one the admin asked
    // for and call it a success.
    throw new BedAllocationAdminError(
      `A range assignment covers at most ${MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS} nights; that range is ${nightCount}. Split it into shorter ranges.`,
      400,
    );
  }

  return { from, to, nights: eachDateOnlyInRange(from, to).map(formatDateOnly) };
}

/**
 * The explicit night list the admin consented to, checked against the range.
 *
 * The second action is "assign these N nights, the ones you just showed me".
 * The server therefore takes the list rather than recomputing "whatever is free
 * now": between the refusal and the click, a night can be freed by someone else,
 * and re-deriving would write a night the admin never saw (#2251 review A6/B5).
 */
function parseConsentedNights(
  nights: string[],
  range: ParsedBedAssignRange,
): string[] {
  if (nights.length === 0) {
    throw new BedAllocationAdminError(
      "Choose at least one night to assign",
      400,
    );
  }
  const requested = new Set(range.nights);
  const chosen = new Set<string>();
  for (const night of nights) {
    if (!isDateOnlyString(night) || !requested.has(night)) {
      throw new BedAllocationAdminError(
        "Those nights are not all inside the requested range — reload the board and try again.",
        400,
      );
    }
    chosen.add(night);
  }
  // Range order, so the written set reads the same way everywhere.
  return range.nights.filter((night) => chosen.has(night));
}

async function classifyBedTakenNights(input: {
  db: BedAllocationDb;
  bed: { id: string; bedType: BedType };
  guest: { id: string; memberId: string | null };
  candidateNights: string[];
}): Promise<{
  refusals: BedRangeRefusal[];
  secondOccupantNights: Set<string>;
}> {
  const refusals: BedRangeRefusal[] = [];
  const secondOccupantNights = new Set<string>();
  if (input.candidateNights.length === 0) {
    return { refusals, secondOccupantNights };
  }

  const occupantRows = await input.db.bedAllocation.findMany({
    where: {
      bedId: input.bed.id,
      stayDate: { in: input.candidateNights.map(parseDateOnly) },
      bookingGuestId: { not: input.guest.id },
    },
    // The PRIMARY of a shared DOUBLE must sort first, deterministically (#2669
    // review). `byNight` below preserves this order and the `BED_TAKEN` refusal
    // names `occupants[0]`; without an ORDER BY, `(bedId, stayDate)` is not
    // unique on a shared double (#1701/#2656) so PostgreSQL could return the
    // SECOND occupant first and the refusal would name the partner rather than
    // the guest who actually holds the bed. `false` sorts before `true`, and
    // `bookingGuestId` is a total order within a bed-night.
    orderBy: [{ isSecondOccupant: "asc" }, { bookingGuestId: "asc" }],
    select: {
      stayDate: true,
      isSecondOccupant: true,
      bookingGuest: {
        select: {
          memberId: true,
          firstName: true,
          lastName: true,
          booking: {
            select: {
              id: true,
              status: true,
              originBookingRequest: { select: { id: true } },
              adminCapacityHoldAt: true,
              member: {
                select: { firstName: true, lastName: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  const byNight = new Map<string, typeof occupantRows>();
  for (const row of occupantRows) {
    const key = formatDateOnly(row.stayDate);
    const existing = byNight.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byNight.set(key, [row]);
    }
  }

  // Partner eligibility is a DB lookup, and a long range can meet a different
  // occupying member on every night. Ask ONCE for every distinct occupant
  // instead of per night, so the statement count stays fixed however long the
  // range is (#2251 review A1). Only DOUBLE beds can share at all.
  const shareEligibleMemberIds =
    input.bed.bedType === "DOUBLE" && input.guest.memberId
      ? await mayShareDoubleBedWith(
          input.guest.memberId,
          occupantRows
            .map((row) => row.bookingGuest.memberId)
            .filter((id): id is string => Boolean(id)),
          input.db,
        )
      : new Set<string>();

  for (const stayDate of input.candidateNights) {
    // Reading the first occupant is what says the bed-night has one; an empty
    // night is not taken and needs no refusal (#2800).
    const occupants = byNight.get(stayDate) ?? [];
    const primary = occupants[0];
    if (primary === undefined) continue;
    const describe = (): BedRangeRefusal => ({
      stayDate,
      category: "BED_TAKEN",
      occupiedBy: {
        guestName: guestName(primary.bookingGuest),
        memberName: memberName(primary.bookingGuest.booking.member),
        bookingId: primary.bookingGuest.booking.id,
        holdsCapacity: bookingHoldsCapacity({
          status: primary.bookingGuest.booking.status,
          isRequestConverted: Boolean(
            primary.bookingGuest.booking.originBookingRequest,
          ),
          hasAdminCapacityHold: Boolean(
            primary.bookingGuest.booking.adminCapacityHoldAt,
          ),
        }),
      },
    });

    // Mirrors resolveSecondOccupant()'s rules exactly, batched: only a DOUBLE
    // holding exactly one PRIMARY occupant from a capacity-holding booking, both
    // member-linked and confirmed partners, may be shared (#1701/#1744).
    if (
      input.bed.bedType !== "DOUBLE" ||
      occupants.length >= 2 ||
      occupants.some((row) => row.isSecondOccupant) ||
      !isCapacityHoldingBookingStatus(primary.bookingGuest.booking.status) ||
      !input.guest.memberId ||
      !primary.bookingGuest.memberId
    ) {
      refusals.push(describe());
      continue;
    }

    if (!shareEligibleMemberIds.has(primary.bookingGuest.memberId)) {
      refusals.push(describe());
      continue;
    }
    secondOccupantNights.add(stayDate);
  }

  return { refusals, secondOccupantNights };
}

async function runAssignBedRangeAttempt(input: {
  bookingGuestId: string;
  bedId: string;
  range: ParsedBedAssignRange;
  approvedByMemberId: string;
  consentedNights?: string[];
  db: BedAllocationDb;
}): Promise<AssignBedRangeResult> {
  const db = input.db;
  const range = input.range;
  const { guest, bed } = await assertGuestAndBedForAllocation({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    db,
    reportWholeLodgeHold: true,
  });

  const base = {
    partialByConsent: input.consentedNights !== undefined,
    bookingId: guest.bookingId,
    bookingGuestId: guest.id,
    guestName: guestName(guest),
    bedId: bed.id,
    bedName: bed.name,
    roomName: bed.room.name,
    fromDate: formatDateOnly(range.from),
    toDate: formatDateOnly(range.to),
    requestedNights: range.nights,
  };

  const refusalByNight = new Map<string, BedRangeRefusal>();

  // 1. EXCLUSIVE_HOLD — the guest's OWN booking holds the lodge (ADR-001): it
  //    implicitly occupies every bed, so no night of the range is allocatable
  //    and the free-nights action has nothing to offer either. The flag is read
  //    inside this transaction (assertGuestAndBedForAllocation selects it on the
  //    booking above), so it cannot be a stale pre-transaction snapshot.
  //
  //    ANOTHER booking's overlapping hold is NOT refused here. ADR-001 scopes
  //    the bed-allocation short-circuit to the held booking's own guests; the
  //    planner, the auto-allocator, the single-night and bulk manual paths and
  //    the lifecycle all still place ordinary bookings on beds across an
  //    overlapping hold, and the hold-set flow surfaces those bookings as
  //    conflicts rather than blocking them. Refusing only here would make this
  //    one endpoint stricter than the rule the rest of the domain enforces.
  if (guest.booking.wholeLodgeHold) {
    const ownBooking = await db.booking.findUnique({
      where: { id: guest.bookingId },
      select: {
        member: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    for (const stayDate of range.nights) {
      refusalByNight.set(stayDate, {
        stayDate,
        category: "EXCLUSIVE_HOLD",
        hold: {
          bookingId: guest.bookingId,
          memberName: ownBooking
            ? memberName(ownBooking.member)
            : "Unknown member",
          ownBooking: true,
        },
      });
    }
  }

  // 2. GUEST_NOT_BOOKED — a bad request, reported rather than skipped.
  for (const stayDate of range.nights) {
    if (refusalByNight.has(stayDate)) continue;
    if (guestIsStayingOn(guest, parseDateOnly(stayDate))) continue;
    refusalByNight.set(stayDate, { stayDate, category: "GUEST_NOT_BOOKED" });
  }

  // 3. CUSTODIAN_HOLD (#2286) — the bed is held for a season by a custodian on
  //    that night, with no booking anywhere. Classified BEFORE BED_TAKEN: it is
  //    the harder block (there is no occupying guest to negotiate with, and no
  //    second-occupant sharing can ever apply to a bed with no primary row), and
  //    the admin's fix is on the Hut Leaders page, not the board. Read inside
  //    this transaction, under the lodge lock the caller took.
  const custodianHeld = new Set(
    await custodianHeldNightsForBed({
      bedId: bed.id,
      stayDates: range.nights
        .filter((stayDate) => !refusalByNight.has(stayDate))
        .map(parseDateOnly),
      db,
    }),
  );
  for (const stayDate of range.nights) {
    if (refusalByNight.has(stayDate)) continue;
    if (!custodianHeld.has(stayDate)) continue;
    refusalByNight.set(stayDate, { stayDate, category: "CUSTODIAN_HOLD" });
  }

  // 4. BED_TAKEN — a genuine clash on the remaining nights.
  const { refusals: bedTaken, secondOccupantNights } =
    await classifyBedTakenNights({
      db,
      bed,
      guest,
      candidateNights: range.nights.filter(
        (stayDate) => !refusalByNight.has(stayDate),
      ),
    });
  for (const refusal of bedTaken) {
    refusalByNight.set(refusal.stayDate, refusal);
  }

  const refusals = range.nights
    .filter((stayDate) => refusalByNight.has(stayDate))
    .map((stayDate) => refusalByNight.get(stayDate) as BedRangeRefusal);
  const freeNights = range.nights.filter(
    (stayDate) => !refusalByNight.has(stayDate),
  );

  // Atomic by default: any blocker refuses the WHOLE range and writes nothing.
  // The refusal report is the evidence the admin acts on; an explicit night list
  // is their second action, not a fallback this code may take itself. That list
  // is honoured EXACTLY — if any night on it has since been blocked, the whole
  // attempt refuses with a FRESH report rather than quietly writing the rest, and
  // no night outside the list is ever written.
  const targetNights = input.consentedNights ?? range.nights;
  const blockedTargets = targetNights.filter((stayDate) =>
    refusalByNight.has(stayDate),
  );
  if (blockedTargets.length > 0 || targetNights.length === 0) {
    return recordRangeAssignAudit(db, input.approvedByMemberId, {
      ...base,
      applied: false,
      freeNights,
      writtenNights: [],
      refusals,
      promotedPartners: [],
    });
  }

  const existingRows = await db.bedAllocation.findMany({
    where: {
      bookingGuestId: guest.id,
      stayDate: { in: targetNights.map(parseDateOnly) },
    },
    select: { id: true, bedId: true, stayDate: true, isSecondOccupant: true },
  });
  const existingByNight = new Map(
    existingRows.map((row) => [formatDateOnly(row.stayDate), row]),
  );

  // AUTO-APPROVE (#2251 decision 4): a range assignment is a deliberate
  // confirmation, so it lands approved rather than draft.
  const approvedAt = new Date();
  const approval = {
    approvedAt,
    approvedByMemberId: input.approvedByMemberId,
  };

  // Batched by (already exists?, is second occupant?): at most two updateMany +
  // two createMany however long the range is — the whole reason a 366-night
  // assign can be atomic at all. The real bound for ONE attempt is AT MOST 14
  // statements, whatever the night count: guest + bed (2), the occupant scan
  // (1), up to two partner-eligibility lookups (2), the existing-row scan (1),
  // up to two updateMany + two createMany (4), the batched promotion's findMany
  // + updateMany (2), the range audit row (1), and — only when this move strands
  // partners on shared doubles — ONE batched partner-promotion audit row for all
  // of them (1, #2251 residual R4). (The own-hold member lookup is on the
  // mutually exclusive refusal path, which runs 4 statements and writes nothing.)
  // Nothing in this transaction, statement or audit row, may grow with the night
  // count.
  for (const isSecondOccupant of [false, true]) {
    const nights = targetNights.filter(
      (stayDate) => secondOccupantNights.has(stayDate) === isSecondOccupant,
    );
    const updateIds = nights
      .map((stayDate) => existingByNight.get(stayDate)?.id)
      .filter((id): id is string => Boolean(id));
    if (updateIds.length > 0) {
      await db.bedAllocation.updateMany({
        where: { id: { in: updateIds } },
        data: {
          roomId: bed.roomId,
          bedId: bed.id,
          source: "MANUAL",
          isSecondOccupant,
          bedType: bed.bedType,
          ...approval,
        },
      });
    }

    const createNights = nights.filter(
      (stayDate) => !existingByNight.has(stayDate),
    );
    if (createNights.length > 0) {
      await db.bedAllocation.createMany({
        data: createNights.map((stayDate) => ({
          bookingId: guest.bookingId,
          bookingGuestId: guest.id,
          roomId: bed.roomId,
          bedId: bed.id,
          stayDate: parseDateOnly(stayDate),
          source: "MANUAL" as const,
          isSecondOccupant,
          bedType: bed.bedType,
          ...approval,
        })),
      });
    }
  }

  // #1750: moving a PRIMARY off its old bed can strand a partner there. The
  // rows above already vacated those bed-nights, so promote afterwards, exactly
  // as the single-night path does — but through the BATCHED promoter: the
  // per-night helper runs two statements per vacated bed-night, which is the one
  // place a long range could still make this transaction grow with its length.
  const vacatedBedNights = targetNights.flatMap((stayDate) => {
    const previous = existingByNight.get(stayDate);
    if (!previous || previous.isSecondOccupant || previous.bedId === bed.id) {
      return [];
    }
    return [{ bedId: previous.bedId, stayDate: previous.stayDate }];
  });
  const promotedPartners = await promoteOrphanedSecondOccupantsBatch(
    db,
    vacatedBedNights,
  );

  return recordRangeAssignAudit(db, input.approvedByMemberId, {
    ...base,
    applied: true,
    freeNights,
    writtenNights: targetNights,
    refusals,
    promotedPartners,
  });
}

// A concurrent write that cost us the transaction. Both are retryable ONCE
// against fresh state, and both must end in a plain-English 409 rather than a
// generic 500 if the retry loses too (#2251 review A3):
//   P2002 — someone claimed one of the bed-nights between our scan and our write
//           (the unique index on bed/night did its job).
//   P2034 — the database aborted this transaction to break a write conflict or
//           deadlock. Prisma surfaces it as a distinct code; without an arm here
//           it fell through to "Bed allocation request failed", a 500 for what is
//           really "try again".
const RETRYABLE_RANGE_WRITE_CODES: Record<string, string> = {
  P2002:
    "Another admin claimed one of those bed-nights while this range was being assigned. Nothing was written — reload the board and try again.",
  P2034:
    "That range collided with another change being saved at the same moment, twice. Nothing was written — reload the board and try again.",
};

/**
 * The operator wording for a retryable write conflict, or `null` when the error
 * is not one. Returning the MESSAGE rather than the code makes the table lookup
 * and its answer one read, so the caller cannot look the code up again and find
 * nothing (#2800).
 */
function retryableRangeWriteMessage(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  return RETRYABLE_RANGE_WRITE_CODES[error.code] ?? null;
}

/**
 * Assign one guest to one bed across a range of any length, atomically.
 *
 * Returns a result rather than throwing when the range is BLOCKED: `applied`
 * false with the per-night refusals. It throws BedAllocationAdminError only for
 * genuinely malformed input (bad dates, unknown guest/bed, non-allocatable or
 * deleted booking, over the range cap, nights outside the range) and for a lost
 * write race.
 *
 * `nights`, when given, is the EXPLICIT set the admin consented to after seeing
 * a refusal report — assigned exactly, or refused with a fresh report. Omit it
 * for the ordinary all-or-nothing attempt.
 */
interface AssignBedRangeInput {
  bookingGuestId: string;
  bedId: string;
  from: string;
  to: string;
  approvedByMemberId: string;
  nights?: string[];
}

export async function assignBedRangeWithLocksHeld(
  input: AssignBedRangeInput & { db: BedAllocationDb },
): Promise<AssignBedRangeResult> {
  const range = parseBedAssignRange({ from: input.from, to: input.to });
  const consentedNights = input.nights
    ? parseConsentedNights(input.nights, range)
    : undefined;
  return runAssignBedRangeAttempt({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    range,
    approvedByMemberId: input.approvedByMemberId,
    consentedNights,
    db: input.db,
  });
}

export async function assignBedRange(
  input: AssignBedRangeInput,
): Promise<AssignBedRangeResult> {
  // Parsed and validated BEFORE any transaction opens (#2251 review C2): a
  // malformed range, or one absurd enough to blow the night cap, must never
  // occupy a database connection to be told so.
  const range = parseBedAssignRange({ from: input.from, to: input.to });
  if (input.nights) {
    parseConsentedNights(input.nights, range);
  }

  // The scan, the writes and the audit row share one transaction so the refusal
  // report, the rows written from it and the record of both describe the same
  // instant. The default 5s interactive timeout is raised because the statement
  // count is fixed (see runAssignBedRangeAttempt) but a 366-night createMany is
  // a big single statement — generous headroom, not a licence to grow the
  // statement count with nights.
  // #2286: the transaction takes global first and then the lodge key before the
  // custodian scan, so a hold cannot race the scan and write.
  const lockLodgeId = await resolveBedLodgeIdForLock(input.bedId, prisma);
  const runAttempt = () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        if (lockLodgeId) await acquireLodgeCapacityLock(tx, lockLodgeId);
        return assignBedRangeWithLocksHeld({ ...input, db: tx });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

  try {
    return await runAttempt();
  } catch (error) {
    if (!retryableRangeWriteMessage(error)) {
      throw error;
    }
    // Nothing was written (the transaction rolled back), so re-attempt once
    // against fresh state: the second scan sees the new occupant and returns it
    // as an ordinary BED_TAKEN refusal instead of an opaque error.
    try {
      return await runAttempt();
    } catch (retryError) {
      const retryableMessage = retryableRangeWriteMessage(retryError);
      if (retryableMessage) {
        throw new BedAllocationAdminError(retryableMessage, 409);
      }
      throw retryError;
    }
  }
}
